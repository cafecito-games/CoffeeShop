package setup

import (
	"os"
	"path/filepath"
	"testing"
)

// writeOwnedArtifact creates a real file at dataRoot/relativePath and returns the ledger record
// describing it, so tests can install ledger state without going through Apply.
func writeOwnedArtifact(t *testing.T, dataRoot string, relativePath string, adapterID string, adapterVersion string, content []byte) OwnershipRecord {
	t.Helper()
	path := filepath.Join(dataRoot, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create artifact directory: %v", err)
	}
	if err := os.WriteFile(path, content, 0o755); err != nil {
		t.Fatalf("write artifact: %v", err)
	}
	return OwnershipRecord{
		Path:           path,
		AdapterID:      adapterID,
		AdapterVersion: adapterVersion,
		ContentSHA256:  sha256Hex(content),
		SizeBytes:      int64(len(content)),
		InstalledAt:    "2026-01-01T00:00:00Z",
	}
}

func recordPaths(records []OwnershipRecord) []string {
	paths := make([]string, 0, len(records))
	for _, record := range records {
		paths = append(paths, record.Path)
	}
	return paths
}

func TestUninstallRemovesOnlyMatchingArtifacts(t *testing.T) {
	dataRoot := t.TempDir()
	intact := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/1.0.0/bin/adapter", "alpha-acp", "1.0.0", []byte("intact bytes"))
	drifted := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/1.1.0/bin/adapter", "alpha-acp", "1.1.0", []byte("original bytes"))
	missing := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/1.2.0/bin/adapter", "alpha-acp", "1.2.0", []byte("missing bytes"))
	unrelated := writeOwnedArtifact(t, dataRoot, "adapters/beta-cli/beta-acp/1.0.0/bin/adapter", "beta-acp", "1.0.0", []byte("beta bytes"))
	// A record pointing outside the data root must never be followed to a delete, even when the
	// file it names really exists and matches its digest.
	outsideParent := t.TempDir()
	outsidePath := filepath.Join(outsideParent, "outside-artifact")
	if err := os.WriteFile(outsidePath, []byte("outside bytes"), 0o755); err != nil {
		t.Fatalf("write outside artifact: %v", err)
	}
	outside := OwnershipRecord{
		Path:           outsidePath,
		AdapterID:      "alpha-acp",
		AdapterVersion: "1.3.0",
		ContentSHA256:  sha256Hex([]byte("outside bytes")),
		SizeBytes:      int64(len("outside bytes")),
		InstalledAt:    "2026-01-01T00:00:00Z",
	}
	// Simulate post-install drift on the 1.1.0 artifact and delete the 1.2.0 one entirely.
	if err := os.WriteFile(drifted.Path, []byte("modified after install"), 0o755); err != nil {
		t.Fatalf("rewrite drifted artifact: %v", err)
	}
	if err := os.Remove(missing.Path); err != nil {
		t.Fatalf("remove missing artifact: %v", err)
	}
	ledger := OwnershipLedger{Records: []OwnershipRecord{intact, drifted, missing, unrelated, outside}}
	if err := ledger.Save(dataRoot); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	result, updated, err := Uninstall(dataRoot, ledger, "alpha-acp", "")
	if err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if len(result.Removed) != 1 || result.Removed[0].Path != intact.Path {
		t.Fatalf("Uninstall() removed %v, want only the intact artifact", recordPaths(result.Removed))
	}
	retained := map[string]bool{}
	for _, record := range result.Retained {
		retained[record.Path] = true
	}
	if !retained[drifted.Path] || !retained[missing.Path] || !retained[outside.Path] {
		t.Fatalf("Uninstall() retained %v, want the drifted, missing, and out-of-root records", recordPaths(result.Retained))
	}
	if _, err := os.Stat(intact.Path); !os.IsNotExist(err) {
		t.Fatalf("intact artifact still exists after uninstall: %v", err)
	}
	for _, path := range []string{drifted.Path, outsidePath, unrelated.Path} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("artifact %s should have been left in place: %v", path, err)
		}
	}
	if len(updated.Records) != 4 {
		t.Fatalf("updated ledger holds %d records, want the 3 retained alpha records plus beta", len(updated.Records))
	}
	persisted, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	if len(persisted.Records) != len(updated.Records) {
		t.Fatalf("ledger on disk holds %d records, want %d", len(persisted.Records), len(updated.Records))
	}
	if _, ok := persisted.RecordFor(unrelated.Path); !ok {
		t.Fatal("uninstall dropped the unrelated adapter's record from the ledger")
	}
}

func TestUninstallVersionScoped(t *testing.T) {
	dataRoot := t.TempDir()
	first := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/1.0.0/bin/adapter", "alpha-acp", "1.0.0", []byte("first bytes"))
	second := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/2.0.0/bin/adapter", "alpha-acp", "2.0.0", []byte("second bytes"))
	ledger := OwnershipLedger{Records: []OwnershipRecord{first, second}}

	result, updated, err := Uninstall(dataRoot, ledger, "alpha-acp", "1.0.0")
	if err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if len(result.Removed) != 1 || result.Removed[0].Path != first.Path {
		t.Fatalf("Uninstall() removed %v, want only the 1.0.0 artifact", recordPaths(result.Removed))
	}
	if _, err := os.Stat(second.Path); err != nil {
		t.Fatalf("uninstall removed the 2.0.0 artifact despite the version scope: %v", err)
	}
	if _, ok := updated.RecordFor(second.Path); !ok {
		t.Fatal("uninstall dropped the out-of-scope version's ledger record")
	}
}

func TestUninstallRetainsSymlinkedTarget(t *testing.T) {
	dataRoot := t.TempDir()
	record := writeOwnedArtifact(t, dataRoot, "adapters/alpha-cli/alpha-acp/1.0.0/bin/adapter", "alpha-acp", "1.0.0", []byte("symlinked bytes"))
	if err := os.Remove(record.Path); err != nil {
		t.Fatalf("remove original artifact: %v", err)
	}
	outsider := filepath.Join(t.TempDir(), "pivot")
	if err := os.WriteFile(outsider, []byte("symlinked bytes"), 0o755); err != nil {
		t.Fatalf("write pivot file: %v", err)
	}
	if err := os.Symlink(outsider, record.Path); err != nil {
		t.Fatalf("create symlink over artifact path: %v", err)
	}
	ledger := OwnershipLedger{Records: []OwnershipRecord{record}}
	if err := ledger.Save(dataRoot); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	result, _, err := Uninstall(dataRoot, ledger, "alpha-acp", "")
	if err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if len(result.Removed) != 0 {
		t.Fatalf("Uninstall() removed %v through a symlink, want none", recordPaths(result.Removed))
	}
	if len(result.Retained) != 1 {
		t.Fatalf("Uninstall() retained %d records, want the symlinked one", len(result.Retained))
	}
	if _, err := os.Stat(outsider); err != nil {
		t.Fatalf("uninstall deleted through the symlink: %v", err)
	}
}
