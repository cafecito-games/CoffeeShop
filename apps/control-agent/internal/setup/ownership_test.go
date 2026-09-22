package setup

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func fixtureLedger() OwnershipLedger {
	return OwnershipLedger{Records: []OwnershipRecord{
		{
			Path:           "/data/adapters/claude-cli/claude-acp/0.1.0/bin/adapter",
			AdapterID:      "claude-acp",
			AdapterVersion: "0.1.0",
			ContentSHA256:  strings.Repeat("a", 64),
			SizeBytes:      1234,
			InstalledAt:    time.Now().UTC().Format(time.RFC3339Nano),
		},
		{
			Path:           "/data/adapters/codex-cli/codex-acp/0.1.0/bin/adapter",
			AdapterID:      "codex-acp",
			AdapterVersion: "0.1.0",
			ContentSHA256:  strings.Repeat("b", 64),
			SizeBytes:      4321,
			InstalledAt:    time.Now().UTC().Format(time.RFC3339Nano),
		},
	}}
}

func TestOwnershipLedgerRoundTrip(t *testing.T) {
	dataRoot := t.TempDir()
	ledger := fixtureLedger()
	if err := ledger.Save(dataRoot); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	if !reflect.DeepEqual(loaded, ledger) {
		t.Fatalf("LoadOwnershipLedger() = %+v, want %+v", loaded, ledger)
	}
}

func TestLoadOwnershipLedgerMissingFile(t *testing.T) {
	loaded, err := LoadOwnershipLedger(t.TempDir())
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() on a missing ledger error = %v, want none", err)
	}
	if len(loaded.Records) != 0 {
		t.Fatalf("LoadOwnershipLedger() on a missing ledger = %+v, want empty", loaded)
	}
}

func TestOwnershipLedgerSaveLeavesNoTemporaryFile(t *testing.T) {
	dataRoot := t.TempDir()
	if err := fixtureLedger().Save(dataRoot); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	entries, err := os.ReadDir(dataRoot)
	if err != nil {
		t.Fatalf("read data root: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != ownershipLedgerFilename {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("data root holds %v after Save(), want only %s", names, ownershipLedgerFilename)
	}
}

func TestOwnershipLedgerSaveMissingDirectory(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "does-not-exist")
	if err := fixtureLedger().Save(dataRoot); err == nil {
		t.Fatal("Save() into a missing directory succeeded, want rejection")
	}
	if _, err := os.Stat(filepath.Join(dataRoot, ownershipLedgerFilename)); !os.IsNotExist(err) {
		t.Fatalf("ownership.json exists after a failed Save(): %v", err)
	}
}

func TestOwnershipLedgerRecordFor(t *testing.T) {
	ledger := fixtureLedger()
	record, ok := ledger.RecordFor("/data/adapters/claude-cli/claude-acp/0.1.0/bin/adapter")
	if !ok || record.AdapterID != "claude-acp" {
		t.Fatalf("RecordFor() = %+v, %v, want the claude-acp record", record, ok)
	}
	if _, ok := ledger.RecordFor("/data/adapters/elsewhere"); ok {
		t.Fatal("RecordFor() found a record for an unknown path")
	}
}

func TestOwnershipLedgerWithRecord(t *testing.T) {
	ledger := fixtureLedger()
	replacement := ledger.Records[0]
	replacement.ContentSHA256 = strings.Repeat("c", 64)
	updated := ledger.WithRecord(replacement)
	if len(updated.Records) != 2 {
		t.Fatalf("WithRecord() produced %d records, want 2", len(updated.Records))
	}
	if updated.Records[0].ContentSHA256 != strings.Repeat("c", 64) {
		t.Fatalf("WithRecord() did not replace the record for the same path: %+v", updated.Records[0])
	}
	if updated.Records[1].AdapterID != "codex-acp" {
		t.Fatalf("WithRecord() disturbed an unrelated record: %+v", updated.Records[1])
	}
	added := updated.WithRecord(OwnershipRecord{Path: "/data/adapters/new", AdapterID: "new-adapter"})
	if len(added.Records) != 3 || added.Records[2].AdapterID != "new-adapter" {
		t.Fatalf("WithRecord() did not append a record for a new path: %+v", added.Records)
	}
}
