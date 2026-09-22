package setup

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sha256Hex(data []byte) string {
	summed := sha256.Sum256(data)
	return hex.EncodeToString(summed[:])
}

func buildTarGzipArchive(t *testing.T, executablePath string, content []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	header := &tar.Header{Typeflag: tar.TypeReg, Name: executablePath, Mode: 0o755, Size: int64(len(content))}
	if err := tarWriter.WriteHeader(header); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tarWriter.Write(content); err != nil {
		t.Fatalf("write tar content: %v", err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	return buffer.Bytes()
}

func buildZipArchive(t *testing.T, executablePath string, content []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	zipWriter := zip.NewWriter(&buffer)
	entry, err := zipWriter.Create(executablePath)
	if err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if _, err := entry.Write(content); err != nil {
		t.Fatalf("write zip content: %v", err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatalf("close zip writer: %v", err)
	}
	return buffer.Bytes()
}

func archiveServerFixture(t *testing.T, alphaArchive []byte, betaArchive []byte) *httptest.Server {
	t.Helper()
	multiplexer := http.NewServeMux()
	multiplexer.HandleFunc("/alpha/adapter.tar.gz", func(writer http.ResponseWriter, request *http.Request) {
		writer.Write(alphaArchive)
	})
	multiplexer.HandleFunc("/beta/adapter.zip", func(writer http.ResponseWriter, request *http.Request) {
		writer.Write(betaArchive)
	})
	server := httptest.NewTLSServer(multiplexer)
	t.Cleanup(server.Close)
	return server
}

func archiveManifestFixture(t *testing.T, serverURL string, alphaChecksum string, betaChecksum string, alphaSize int, betaSize int) ([]byte, Manifest) {
	t.Helper()
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "alpha-acp", "harnessId": "alpha-cli", "provider": "alpha-vendor",
				"label": "Alpha ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "archive", "url": "%s/alpha/adapter.tar.gz", "sha256": "%s", "sizeBytes": %d, "executablePath": "bin/adapter"}}
			},
			{
				"id": "beta-acp", "harnessId": "beta-cli", "provider": "beta-vendor",
				"label": "Beta ACP adapter", "version": "2.0.0",
				"platforms": {"darwin-arm64": {"kind": "archive", "url": "%s/beta/adapter.zip", "sha256": "%s", "sizeBytes": %d, "executablePath": "bin/adapter"}}
			}
		]
	}`, serverURL, alphaChecksum, alphaSize, serverURL, betaChecksum, betaSize)
	manifestBytes := []byte(manifestJSON)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	return manifestBytes, manifest
}

func manualManifestFixture(t *testing.T) ([]byte, Manifest) {
	t.Helper()
	manifestJSON := []byte(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "manual-acp", "harnessId": "manual-cli", "provider": "manual-vendor",
				"label": "Manual ACP adapter", "version": "0.4.0",
				"platforms": {"darwin-arm64": {"kind": "manual", "executablePath": "bin/adapter"}}
			}
		]
	}`)
	manifest, err := ParseManifest(manifestJSON)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	return manifestJSON, manifest
}

func applyOptions(server *httptest.Server) ApplyOptions {
	return ApplyOptions{HTTPClient: server.Client(), AllowedHosts: []string{"127.0.0.1"}}
}

func assertInstalledExecutable(t *testing.T, path string, content []byte) {
	t.Helper()
	information, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("stat installed adapter %s: %v", path, err)
	}
	if !information.Mode().IsRegular() {
		t.Fatalf("installed adapter %s is not a regular file: %s", path, information.Mode())
	}
	if information.Mode().Perm()&0o111 == 0 {
		t.Fatalf("installed adapter %s is not executable: %s", path, information.Mode().Perm())
	}
	installed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read installed adapter %s: %v", path, err)
	}
	if !bytes.Equal(installed, content) {
		t.Fatalf("installed adapter %s content mismatch", path)
	}
}

// strayTemporaryArtifacts walks dataRoot for anything a failed apply should have cleaned up.
func strayTemporaryArtifacts(t *testing.T, dataRoot string) []string {
	t.Helper()
	var strays []string
	err := filepath.WalkDir(dataRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if strings.HasPrefix(entry.Name(), "setup-staging-") || strings.HasPrefix(entry.Name(), "setup-download-") {
			strays = append(strays, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk data root: %v", err)
	}
	return strays
}

func TestApplyInstallsTarGzipAndZipArchives(t *testing.T) {
	alphaContent := []byte("#!/bin/sh\necho alpha\n")
	betaContent := []byte("#!/bin/sh\necho beta\n")
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", alphaContent)
	betaArchive := buildZipArchive(t, "bin/adapter", betaContent)
	server := archiveServerFixture(t, alphaArchive, betaArchive)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), sha256Hex(betaArchive), len(alphaArchive), len(betaArchive))
	dataRoot := t.TempDir()
	plan, skipped, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(skipped) != 0 {
		t.Fatalf("BuildPlan() skipped = %v, want none", skipped)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(result.Applied) != 2 || len(result.Skipped) != 0 {
		t.Fatalf("Apply() applied %d, skipped %d, want 2 applied", len(result.Applied), len(result.Skipped))
	}
	assertInstalledExecutable(t, plan.Operations[0].TargetPath, alphaContent)
	assertInstalledExecutable(t, plan.Operations[1].TargetPath, betaContent)
	ledger, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	if len(ledger.Records) != 2 {
		t.Fatalf("ledger holds %d records after apply, want 2", len(ledger.Records))
	}
	for index, operation := range plan.Operations {
		record, ok := ledger.RecordFor(operation.TargetPath)
		if !ok {
			t.Fatalf("ledger has no record for %s", operation.TargetPath)
		}
		wantDigest := sha256Hex([][]byte{alphaContent, betaContent}[index])
		if record.ContentSHA256 != wantDigest {
			t.Fatalf("ledger digest for %s = %s, want %s", operation.TargetPath, record.ContentSHA256, wantDigest)
		}
	}

	// Re-planning against the installed state and re-applying must be a pure no-op.
	replanned, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, ledger)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	second, err := Apply(context.Background(), replanned, manifestBytes, ledger, dataRoot, applyOptions(server))
	if err != nil {
		t.Fatalf("Apply() re-run error = %v", err)
	}
	if len(second.Applied) != 0 || len(second.Skipped) != 2 {
		t.Fatalf("Apply() re-run applied %d, skipped %d, want 0 applied and 2 skipped", len(second.Applied), len(second.Skipped))
	}
}

func TestApplyRejectsStalePlan(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	server := archiveServerFixture(t, alphaArchive, nil)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), strings.Repeat("0", 64), len(alphaArchive), 1)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	plan.Platform = "linux-amd64"
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted a hand-edited plan, want rejection")
	}
	if !strings.Contains(err.Error(), "digest") {
		t.Fatalf("Apply() error = %v, want it to name the plan digest", err)
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a stale plan", len(result.Applied))
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("stale apply mutated the data root: %v", err)
	}
}

func TestApplyRejectsChangedManifestBytes(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	server := archiveServerFixture(t, alphaArchive, nil)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), strings.Repeat("0", 64), len(alphaArchive), 1)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	changedManifestBytes := append(append([]byte{}, manifestBytes...), ' ')
	result, err := Apply(context.Background(), plan, changedManifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted different manifest bytes than the plan was built from, want rejection")
	}
	if !strings.Contains(err.Error(), "manifest changed") {
		t.Fatalf("Apply() error = %v, want it to name the manifest change", err)
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a stale manifest", len(result.Applied))
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("stale apply mutated the data root: %v", err)
	}
}

func TestApplyRejectsConflictingState(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	betaArchive := buildZipArchive(t, "bin/adapter", []byte("beta"))
	server := archiveServerFixture(t, alphaArchive, betaArchive)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), sha256Hex(betaArchive), len(alphaArchive), len(betaArchive))
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	// A foreign file lands at the first target between planning and apply.
	if err := os.MkdirAll(filepath.Dir(plan.Operations[0].TargetPath), 0o755); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	if err := os.WriteFile(plan.Operations[0].TargetPath, []byte("not ours"), 0o644); err != nil {
		t.Fatalf("write conflicting file: %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() proceeded over a conflicting target, want rejection")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations despite the conflict", len(result.Applied))
	}
	// The conflict stops the whole apply: the second operation never ran either.
	if _, err := os.Stat(plan.Operations[1].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("Apply() proceeded past a conflict to a later operation: %v", err)
	}
	conflicting, err := os.ReadFile(plan.Operations[0].TargetPath)
	if err != nil || string(conflicting) != "not ours" {
		t.Fatalf("conflicting file was mutated: %q, %v", conflicting, err)
	}
}

func TestApplyRejectsArchiveChecksumMismatch(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	server := archiveServerFixture(t, alphaArchive, nil)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, strings.Repeat("0", 64), strings.Repeat("0", 64), len(alphaArchive), 1)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted an archive with the wrong checksum, want rejection")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations despite the checksum mismatch", len(result.Applied))
	}
	if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("target exists after a failed install: %v", err)
	}
	if strays := strayTemporaryArtifacts(t, dataRoot); len(strays) != 0 {
		t.Fatalf("failed install left temporary artifacts behind: %v", strays)
	}
}

func TestApplyRejectsUnsupportedArchiveExtension(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte("raw binary"))
	}))
	defer server.Close()
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "alpha-acp", "harnessId": "alpha-cli", "provider": "alpha-vendor",
				"label": "Alpha ACP adapter", "version": "1.0.0",
				"platforms": {"darwin-arm64": {"kind": "archive", "url": "%s/alpha/adapter.bin", "sha256": "%s", "sizeBytes": 10, "executablePath": "bin/adapter"}}
			}
		]
	}`, server.URL, sha256Hex([]byte("raw binary")))
	manifestBytes := []byte(manifestJSON)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted an unsupported archive extension, want rejection")
	}
	if !strings.Contains(err.Error(), ".tar.gz or .zip") {
		t.Fatalf("Apply() error = %v, want it to name the supported extensions", err)
	}
}

func TestApplyManualPlacementCheck(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	sourceDirectory := t.TempDir()
	artifactContent := []byte("#!/bin/sh\necho manual\n")
	source := filepath.Join(sourceDirectory, "operator-placed-adapter")
	if err := os.WriteFile(source, artifactContent, 0o755); err != nil {
		t.Fatalf("write manual source: %v", err)
	}
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if plan.Operations[0].Kind != OperationManualPlacementCheck {
		t.Fatalf("planned kind = %s, want %s", plan.Operations[0].Kind, OperationManualPlacementCheck)
	}
	if plan.Operations[0].ExpectedChecksum != "" {
		t.Fatalf("manual operation carries checksum %q in the plan, want empty", plan.Operations[0].ExpectedChecksum)
	}

	t.Run("matching checksum installs by copying", func(t *testing.T) {
		result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
			ManualChecksums:       map[string]string{"manual-acp": sha256Hex(artifactContent)},
		})
		if err != nil {
			t.Fatalf("Apply() error = %v", err)
		}
		if len(result.Applied) != 1 {
			t.Fatalf("Apply() applied %d operations, want 1", len(result.Applied))
		}
		assertInstalledExecutable(t, plan.Operations[0].TargetPath, artifactContent)
		ledger, err := LoadOwnershipLedger(dataRoot)
		if err != nil {
			t.Fatalf("LoadOwnershipLedger() error = %v", err)
		}
		if record, ok := ledger.RecordFor(plan.Operations[0].TargetPath); !ok || record.ContentSHA256 != sha256Hex(artifactContent) {
			t.Fatalf("ledger record after manual install = %+v, %v", record, ok)
		}
	})

	t.Run("missing checksum fails naming only the adapter", func(t *testing.T) {
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
		})
		if err == nil {
			t.Fatal("Apply() accepted a manual install without an operator checksum, want rejection")
		}
		if !strings.Contains(err.Error(), "manual-acp") {
			t.Fatalf("Apply() error = %v, want it to name the adapter id", err)
		}
		if strings.Contains(err.Error(), source) || strings.Contains(err.Error(), sourceDirectory) {
			t.Fatalf("Apply() error leaked the operator source path: %v", err)
		}
		if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
			t.Fatalf("manual install mutated the target despite refusing: %v", err)
		}
	})

	t.Run("checksum mismatch fails without copying", func(t *testing.T) {
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
			ManualChecksums:       map[string]string{"manual-acp": strings.Repeat("0", 64)},
		})
		if err == nil {
			t.Fatal("Apply() accepted a manual artifact with the wrong checksum, want rejection")
		}
		if strings.Contains(err.Error(), source) {
			t.Fatalf("Apply() error leaked the operator source path: %v", err)
		}
		if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
			t.Fatalf("mismatched manual install reached the target: %v", err)
		}
	})
}

func TestApplyRejectsTargetOutsideDataRoot(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	plan.Operations[0].TargetPath = filepath.Join(dataRoot, "..", "escaped-adapter")
	plan.Digest = ComputePlanDigest(plan)
	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": "/nonexistent/source"},
		ManualChecksums:       map[string]string{"manual-acp": strings.Repeat("0", 64)},
	})
	if err == nil {
		t.Fatal("Apply() accepted a target outside the data root, want rejection")
	}
	if !strings.Contains(err.Error(), "not safely installable") {
		t.Fatalf("Apply() error = %v, want it to name the containment refusal", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dataRoot), "escaped-adapter")); !os.IsNotExist(err) {
		t.Fatalf("escaping target was created: %v", err)
	}
}

func TestApplyRejectsSymlinkAtTarget(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	target := plan.Operations[0].TargetPath
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	outsider := filepath.Join(t.TempDir(), "symlink-target")
	sentinel := []byte("sentinel content")
	if err := os.WriteFile(outsider, sentinel, 0o644); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink(outsider, target); err != nil {
		t.Fatalf("create symlink at install target: %v", err)
	}
	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": outsider},
		ManualChecksums:       map[string]string{"manual-acp": sha256Hex(sentinel)},
	})
	if err == nil {
		t.Fatal("Apply() accepted a symlink at the install target, want rejection")
	}
	throughLink, err := os.ReadFile(outsider)
	if err != nil || !bytes.Equal(throughLink, sentinel) {
		t.Fatalf("install wrote through the symlink: %q, %v", throughLink, err)
	}
}

func TestApplyPartialFailurePersistsCompletedOperations(t *testing.T) {
	alphaContent := []byte("alpha bytes")
	betaContent := []byte("beta bytes")
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", alphaContent)
	betaArchive := buildZipArchive(t, "bin/adapter", betaContent)
	server := archiveServerFixture(t, alphaArchive, betaArchive)
	// The beta pin is wrong on purpose: the first operation must succeed and persist before the
	// second fails its checksum verification.
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), strings.Repeat("0", 64), len(alphaArchive), len(betaArchive))
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() succeeded despite a failing second operation, want partial failure")
	}
	if len(result.Applied) != 1 {
		t.Fatalf("Apply() reported %d applied operations, want the first one only", len(result.Applied))
	}
	assertInstalledExecutable(t, plan.Operations[0].TargetPath, alphaContent)
	if _, err := os.Stat(plan.Operations[1].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("second target exists despite its failed operation: %v", err)
	}
	ledger, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	if len(ledger.Records) != 1 {
		t.Fatalf("persisted ledger holds %d records after partial failure, want exactly 1", len(ledger.Records))
	}
	if _, ok := ledger.RecordFor(plan.Operations[0].TargetPath); !ok {
		t.Fatal("persisted ledger is missing the completed operation's record")
	}
	if _, ok := ledger.RecordFor(plan.Operations[1].TargetPath); ok {
		t.Fatal("persisted ledger holds a record for the failed operation")
	}
	if strays := strayTemporaryArtifacts(t, dataRoot); len(strays) != 0 {
		t.Fatalf("partial failure left temporary artifacts behind: %v", strays)
	}
}
