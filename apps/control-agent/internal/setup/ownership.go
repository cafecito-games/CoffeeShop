package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// ownershipLedgerFilename is the ledger's fixed location under the data root.
const ownershipLedgerFilename = "ownership.json"

// OwnershipRecord is one file this tool created and is therefore responsible for on rollback.
// ContentSHA256 lets rollback and doctor detect drift: if the file's current digest no longer
// matches, it is no longer safely ours to delete.
type OwnershipRecord struct {
	Path           string `json:"path"` // absolute path, must be inside the owning data root
	AdapterID      string `json:"adapterId"`
	AdapterVersion string `json:"adapterVersion"`
	ContentSHA256  string `json:"contentSha256"`
	SizeBytes      int64  `json:"sizeBytes"`
	InstalledAt    string `json:"installedAt"` // RFC3339Nano, stamped once at write time
}

// OwnershipLedger is the durable record of every artifact this tool has installed under one data
// root, persisted as JSON at <dataRoot>/ownership.json.
type OwnershipLedger struct {
	Records []OwnershipRecord `json:"records"`
}

// LoadOwnershipLedger reads the ledger at dataRoot, returning an empty ledger (not an error) when
// the file does not yet exist.
func LoadOwnershipLedger(dataRoot string) (OwnershipLedger, error) {
	data, err := os.ReadFile(filepath.Join(dataRoot, ownershipLedgerFilename))
	if errors.Is(err, fs.ErrNotExist) {
		return OwnershipLedger{}, nil
	}
	if err != nil {
		return OwnershipLedger{}, fmt.Errorf("read ownership ledger: %w", err)
	}
	var ledger OwnershipLedger
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ledger); err != nil {
		return OwnershipLedger{}, fmt.Errorf("decode ownership ledger: %w", err)
	}
	return ledger, nil
}

// Save writes the ledger atomically: encode to a temporary file in dataRoot, fsync, then rename
// over the destination. A crash mid-write must never leave a truncated or corrupt ledger file in
// place of a valid one.
func (ledger OwnershipLedger) Save(dataRoot string) error {
	encoded, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		return fmt.Errorf("encode ownership ledger: %w", err)
	}
	destination := filepath.Join(dataRoot, ownershipLedgerFilename)
	temporaryFile, err := os.CreateTemp(dataRoot, ".ownership-*")
	if err != nil {
		return fmt.Errorf("create ownership ledger temporary file: %w", err)
	}
	temporaryPath := temporaryFile.Name()
	if _, err := temporaryFile.Write(encoded); err != nil {
		temporaryFile.Close()
		os.Remove(temporaryPath)
		return fmt.Errorf("write ownership ledger temporary file: %w", err)
	}
	if err := temporaryFile.Sync(); err != nil {
		temporaryFile.Close()
		os.Remove(temporaryPath)
		return fmt.Errorf("sync ownership ledger temporary file: %w", err)
	}
	if err := temporaryFile.Close(); err != nil {
		os.Remove(temporaryPath)
		return fmt.Errorf("close ownership ledger temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		os.Remove(temporaryPath)
		return fmt.Errorf("replace ownership ledger: %w", err)
	}
	// Best-effort directory sync so the rename itself survives a crash; a failure here does not
	// invalidate the already-renamed ledger.
	if directory, err := os.Open(dataRoot); err == nil {
		directory.Sync()
		directory.Close()
	}
	return nil
}

// RecordFor returns the ownership record for path and whether one exists.
func (ledger OwnershipLedger) RecordFor(path string) (OwnershipRecord, bool) {
	for _, record := range ledger.Records {
		if record.Path == path {
			return record, true
		}
	}
	return OwnershipRecord{}, false
}

// WithRecord returns a copy of the ledger with record added or replacing any existing record for
// the same Path.
func (ledger OwnershipLedger) WithRecord(record OwnershipRecord) OwnershipLedger {
	updated := OwnershipLedger{Records: make([]OwnershipRecord, 0, len(ledger.Records)+1)}
	replaced := false
	for _, existing := range ledger.Records {
		switch {
		case existing.Path == record.Path && !replaced:
			updated.Records = append(updated.Records, record)
			replaced = true
		case existing.Path == record.Path:
			// A duplicate ledger entry for the same path collapses into the new record.
		default:
			updated.Records = append(updated.Records, existing)
		}
	}
	if !replaced {
		updated.Records = append(updated.Records, record)
	}
	return updated
}
