package setup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// RollbackResult reports what Uninstall removed and what it left in place because it was no
// longer safely identifiable as owned.
type RollbackResult struct {
	Removed  []OwnershipRecord
	Retained []OwnershipRecord // present in the ledger but no longer safe to delete
}

// ComponentSelector names which ledger records one rollback addresses. Kind and ID are required —
// an empty field is a rejection, never a wildcard that would sweep every component — while an empty
// Version deliberately means every installed version of that component.
type ComponentSelector struct {
	Kind    ComponentKind
	ID      string
	Version string
}

// Validate refuses a selector that does not name exactly one component, so a zero-value selector can
// never be read as "everything".
func (selector ComponentSelector) Validate() error {
	if !selector.Kind.Valid() {
		return errors.New("component kind is unknown")
	}
	if selector.ID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(selector.ID) {
		return errors.New("component id is not kebab-case")
	}
	if selector.Version != "" && !protocol.IsNormalizedVersion(selector.Version) {
		return errors.New("component version is not a normalized dotted version")
	}
	return nil
}

// Matches reports whether ref is addressed by the selector.
func (selector ComponentSelector) Matches(ref ComponentRef) bool {
	if ref.Kind != selector.Kind || ref.ID != selector.ID {
		return false
	}
	return selector.Version == "" || ref.Version == selector.Version
}

// Uninstall removes every file recorded in ledger for the component the selector names (all
// versions, or a single version when the selector pins one) whose on-disk content still matches its
// recorded digest exactly. A record whose target is missing, whose digest no longer matches, or
// whose path has become a symlink is retained (never deleted, never silently dropped from the
// ledger either — Uninstall returns an updated ledger with only the actually-removed records
// dropped) and reported back for operator action. Uninstall never deletes a directory, only the
// exact recorded files, and never touches anything outside dataRoot.
func Uninstall(dataRoot string, ledger OwnershipLedger, selector ComponentSelector) (RollbackResult, OwnershipLedger, error) {
	if err := selector.Validate(); err != nil {
		return RollbackResult{}, OwnershipLedger{}, fmt.Errorf("uninstall selector: %w", err)
	}
	result := RollbackResult{}
	updated := OwnershipLedger{LedgerVersion: OwnershipLedgerVersion, Records: make([]OwnershipRecord, 0, len(ledger.Records))}
	for _, record := range ledger.Records {
		if !selector.Matches(record.Component) {
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
