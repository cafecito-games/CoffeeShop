package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RollbackResult reports what Uninstall removed and what it left in place because it was no
// longer safely identifiable as owned.
type RollbackResult struct {
	Removed  []OwnershipRecord
	Retained []OwnershipRecord // present in the ledger but no longer safe to delete
}

// Uninstall removes every file recorded in ledger for the given adapterID (all versions, or a
// single version when adapterVersion is non-empty) whose on-disk content still matches its
// recorded digest exactly. A record whose target is missing, whose digest no longer matches, or
// whose path has become a symlink is retained (never deleted, never silently dropped from the
// ledger either — Uninstall returns an updated ledger with only the actually-removed records
// dropped) and reported back for operator action. Uninstall never deletes a directory, only the
// exact recorded files, and never touches anything outside dataRoot.
func Uninstall(dataRoot string, ledger OwnershipLedger, adapterID string, adapterVersion string) (RollbackResult, OwnershipLedger, error) {
	result := RollbackResult{}
	updated := OwnershipLedger{Records: make([]OwnershipRecord, 0, len(ledger.Records))}
	for _, record := range ledger.Records {
		if record.AdapterID != adapterID || (adapterVersion != "" && record.AdapterVersion != adapterVersion) {
			updated.Records = append(updated.Records, record)
			continue
		}
		if !recordIsSafelyRemovable(record, dataRoot) {
			result.Retained = append(result.Retained, record)
			updated.Records = append(updated.Records, record)
			continue
		}
		if err := os.Remove(record.Path); err != nil {
			// A removal that fails between the safety check and the unlink is reported as
			// retained, not as a hard failure: the file may simply be gone already.
			result.Retained = append(result.Retained, record)
			updated.Records = append(updated.Records, record)
			continue
		}
		result.Removed = append(result.Removed, record)
	}
	if err := updated.Save(dataRoot); err != nil {
		return RollbackResult{}, OwnershipLedger{}, fmt.Errorf("persist ownership ledger after uninstall: %w", err)
	}
	return result, updated, nil
}

// recordIsSafelyRemovable applies the same containment and identity rules the applier enforces,
// on the read/delete side: the recorded path must resolve inside dataRoot, must not itself be a
// symlink, must be a regular file, and must still hash to the digest recorded at install time.
// Anything else is ambiguous and therefore not ours to delete.
func recordIsSafelyRemovable(record OwnershipRecord, dataRoot string) bool {
	if !filepath.IsAbs(record.Path) {
		return false
	}
	if _, err := verifyDirectoryWithinRoot(dataRoot, filepath.Dir(record.Path)); err != nil {
		return false
	}
	information, err := os.Lstat(record.Path)
	if err != nil || !information.Mode().IsRegular() {
		return false
	}
	digest, err := fileChecksum(record.Path)
	if err != nil || !strings.EqualFold(digest, record.ContentSHA256) {
		return false
	}
	return true
}
