package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// ownershipLedgerFilename is the ledger's fixed location under the data root.
const ownershipLedgerFilename = "ownership.json"

const (
	// OwnershipLedgerVersion is the current ledger schema generation: records carry a full
	// ComponentRef. Save always writes this generation.
	OwnershipLedgerVersion = "2"
	// LegacyOwnershipLedgerVersion is the adapter-only generation. It was written without any
	// "ledgerVersion" field at all, so both "" and "1" name it on input; neither is ever written
	// again.
	LegacyOwnershipLedgerVersion = "1"
	// OwnershipLedgerGenerationAbsent is reported for a data root with no ledger file yet.
	OwnershipLedgerGenerationAbsent = ""
)

// OwnershipRecord is one file this tool created and is therefore responsible for on rollback.
// Component is the same identity value the plan operation carried, so a record can never describe a
// component the plan did not install. ContentSHA256 lets rollback and doctor detect drift: if the
// file's current digest no longer matches, it is no longer safely ours to delete.
type OwnershipRecord struct {
	Path          string       `json:"path"` // absolute path, must be inside the owning data root
	Component     ComponentRef `json:"component"`
	HarnessID     string       `json:"harnessId"`
	ContentSHA256 string       `json:"contentSha256"`
	SizeBytes     int64        `json:"sizeBytes"`
	InstalledAt   string       `json:"installedAt"` // RFC3339Nano, stamped once at write time
}

// OwnershipLedger is the durable record of every artifact this tool has installed under one data
// root, persisted as JSON at <dataRoot>/ownership.json.
type OwnershipLedger struct {
	LedgerVersion string            `json:"ledgerVersion"`
	Records       []OwnershipRecord `json:"records"`
}

// LedgerRecordRejection names one legacy record that could not be migrated, by slice index and a
// fixed structural reason. It never carries the record's own field values: a ledger may have been
// edited by hand into something attacker-influenced, and the rejection message must not become an
// echo of it.
type LedgerRecordRejection struct {
	RecordIndex int
	Reason      string
}

// LedgerMigrationError reports that a legacy ownership ledger could not be migrated to the current
// generation. Every rejected record is listed. Nothing is written and nothing is dropped: the
// ledger file and every target file stay exactly as they were, and no record is claimed as owned
// under the new schema, because a record whose legacy invariants are no longer provable must not be
// silently converted into an ownership claim.
type LedgerMigrationError struct {
	Rejections []LedgerRecordRejection
}

func (err *LedgerMigrationError) Error() string {
	reasons := make([]string, 0, len(err.Rejections))
	for _, rejection := range err.Rejections {
		reasons = append(reasons, fmt.Sprintf("record %d: %s", rejection.RecordIndex, rejection.Reason))
	}
	return "legacy ownership ledger cannot be migrated to generation " + OwnershipLedgerVersion +
		"; it was left unchanged and no record is treated as owned: " + strings.Join(reasons, "; ")
}

// ownershipDocument is the wire shape of a ledger file. Both generations' record fields are decoded
// together so strict decoding can see, and reject, a record that mixes them rather than quietly
// ignoring whichever set does not belong to the declared generation.
type ownershipDocument struct {
	LedgerVersion string                    `json:"ledgerVersion,omitempty"`
	Records       []ownershipRecordDocument `json:"records"`
}

type ownershipRecordDocument struct {
	Path string `json:"path"`
	// Generation 2 identity.
	Component *ComponentRef `json:"component,omitempty"`
	HarnessID string        `json:"harnessId,omitempty"`
	// Generation 1 identity.
	AdapterID      string `json:"adapterId,omitempty"`
	AdapterVersion string `json:"adapterVersion,omitempty"`

	ContentSHA256 string `json:"contentSha256"`
	SizeBytes     int64  `json:"sizeBytes"`
	InstalledAt   string `json:"installedAt"`
}

// LoadOwnershipLedger reads the ledger at dataRoot, returning an empty current-generation ledger
// (not an error) when the file does not yet exist. A legacy ledger is migrated in memory; a legacy
// ledger that cannot be migrated is an error and the file is left untouched.
func LoadOwnershipLedger(dataRoot string) (OwnershipLedger, error) {
	ledger, _, err := LoadOwnershipLedgerGeneration(dataRoot)
	return ledger, err
}

// LoadOwnershipLedgerGeneration is LoadOwnershipLedger plus the generation the ledger was stored in
// on disk ("" when absent), which is what lets a caller decide whether a migration still needs to be
// persisted. Reading never writes.
func LoadOwnershipLedgerGeneration(dataRoot string) (OwnershipLedger, string, error) {
	data, err := os.ReadFile(filepath.Join(dataRoot, ownershipLedgerFilename))
	if errors.Is(err, fs.ErrNotExist) {
		return OwnershipLedger{LedgerVersion: OwnershipLedgerVersion}, OwnershipLedgerGenerationAbsent, nil
	}
	if err != nil {
		return OwnershipLedger{}, "", fmt.Errorf("read ownership ledger: %w", err)
	}
	ledger, generation, err := ParseOwnershipLedger(data, dataRoot)
	if err != nil {
		return OwnershipLedger{}, "", err
	}
	return ledger, generation, nil
}

// MigrateOwnershipLedgerFile loads the ledger at dataRoot and, when it was stored in the legacy
// generation, rewrites it atomically in the current generation. It reports whether a write
// happened. The write occurs only after every legacy record has validated, so a ledger with any
// unmappable record is rejected with the previous bytes still readable. Running it again on an
// already-migrated ledger is a no-op, which makes repeated migration produce byte-equivalent state.
func MigrateOwnershipLedgerFile(dataRoot string) (OwnershipLedger, bool, error) {
	ledger, generation, err := LoadOwnershipLedgerGeneration(dataRoot)
	if err != nil {
		return OwnershipLedger{}, false, err
	}
	if generation != LegacyOwnershipLedgerVersion {
		return ledger, false, nil
	}
	if err := ledger.Save(dataRoot); err != nil {
		return OwnershipLedger{}, false, err
	}
	return ledger, true, nil
}

// ParseOwnershipLedger strictly decodes ledger bytes belonging to dataRoot and returns the ledger in
// the current generation together with the generation the bytes declared. An unknown generation,
// trailing data, an unknown field, or a record whose identity fields do not belong to the declared
// generation is rejected before any record is treated as owned.
func ParseOwnershipLedger(data []byte, dataRoot string) (OwnershipLedger, string, error) {
	var document ownershipDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return OwnershipLedger{}, "", fmt.Errorf("decode ownership ledger: %w", err)
	}
	if decoder.More() {
		return OwnershipLedger{}, "", errors.New("decode ownership ledger: trailing data after the ledger object")
	}
	switch document.LedgerVersion {
	case OwnershipLedgerVersion:
		ledger, err := document.current()
		if err != nil {
			return OwnershipLedger{}, "", err
		}
		return ledger, OwnershipLedgerVersion, nil
	case "", LegacyOwnershipLedgerVersion:
		ledger, err := document.migratedFromLegacy(dataRoot)
		if err != nil {
			return OwnershipLedger{}, "", err
		}
		return ledger, LegacyOwnershipLedgerVersion, nil
	default:
		return OwnershipLedger{}, "", fmt.Errorf("ownership ledger schema generation is unknown; supported generations are %q and legacy %q", OwnershipLedgerVersion, LegacyOwnershipLedgerVersion)
	}
}

// current validates a ledger already stored in the current generation. A record that also carries
// legacy identity fields is rejected rather than having one of the two identities preferred.
func (document ownershipDocument) current() (OwnershipLedger, error) {
	rejections := []LedgerRecordRejection{}
	records := make([]OwnershipRecord, 0, len(document.Records))
	seenPaths := make(map[string]bool, len(document.Records))
	for index, record := range document.Records {
		reason := ""
		switch {
		case record.AdapterID != "" || record.AdapterVersion != "":
			reason = "carries legacy adapter identity fields under the current generation"
		case record.Component == nil:
			reason = "has no component identity"
		case record.HarnessID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(record.HarnessID):
			reason = "harnessId is not kebab-case"
		case seenPaths[record.Path]:
			reason = "duplicates an earlier record's path"
		}
		if reason == "" {
			if err := record.Component.Validate(); err != nil {
				reason = err.Error()
			}
		}
		if reason == "" {
			reason = validateRecordIntegrityFields(record)
		}
		if reason != "" {
			rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: reason})
			continue
		}
		seenPaths[record.Path] = true
		records = append(records, OwnershipRecord{
			Path:          record.Path,
			Component:     *record.Component,
			HarnessID:     record.HarnessID,
			ContentSHA256: strings.ToLower(record.ContentSHA256),
			SizeBytes:     record.SizeBytes,
			InstalledAt:   record.InstalledAt,
		})
	}
	if len(rejections) > 0 {
		return OwnershipLedger{}, &LedgerMigrationError{Rejections: rejections}
	}
	return OwnershipLedger{LedgerVersion: OwnershipLedgerVersion, Records: records}, nil
}

// migratedFromLegacy maps every generation-1 record to an acp-adapter component record, and only
// when every old invariant remains provable for every record: the path is the exact deterministic
// adapter install location under dataRoot for the record's own adapter id and version, the identity
// and digest grammars still hold, and no two records claim one path. A single unprovable record
// rejects the whole migration — a partially migrated ledger would claim ownership of files whose
// provenance is no longer established.
func (document ownershipDocument) migratedFromLegacy(dataRoot string) (OwnershipLedger, error) {
	rejections := []LedgerRecordRejection{}
	records := make([]OwnershipRecord, 0, len(document.Records))
	seenPaths := make(map[string]bool, len(document.Records))
	for index, record := range document.Records {
		harnessID, reason := legacyRecordHarnessID(record, dataRoot)
		if reason == "" && seenPaths[record.Path] {
			reason = "duplicates an earlier record's path"
		}
		if reason == "" {
			reason = validateRecordIntegrityFields(record)
		}
		if reason != "" {
			rejections = append(rejections, LedgerRecordRejection{RecordIndex: index, Reason: reason})
			continue
		}
		seenPaths[record.Path] = true
		records = append(records, OwnershipRecord{
			Path: record.Path,
			Component: ComponentRef{
				Kind:    ComponentKindACPAdapter,
				ID:      record.AdapterID,
				Version: record.AdapterVersion,
			},
			HarnessID:     harnessID,
			ContentSHA256: strings.ToLower(record.ContentSHA256),
			SizeBytes:     record.SizeBytes,
			InstalledAt:   record.InstalledAt,
		})
	}
	if len(rejections) > 0 {
		return OwnershipLedger{}, &LedgerMigrationError{Rejections: rejections}
	}
	return OwnershipLedger{LedgerVersion: OwnershipLedgerVersion, Records: records}, nil
}

// legacyRecordHarnessID recovers the one harness a legacy record can belong to from its path, which
// is the only place the old schema recorded it. The path must be exactly
// <dataRoot>/adapters/<harnessId>/<adapterId>/<version>/<rest...> with the record's own adapter id
// and version in their own segments; anything else maps to zero or more than one adapter and is
// therefore not uniquely migratable.
func legacyRecordHarnessID(record ownershipRecordDocument, dataRoot string) (string, string) {
	if record.Component != nil || record.HarnessID != "" {
		return "", "carries current-generation component identity under the legacy generation"
	}
	if record.AdapterID == "" || !protocol.LabelOrAcceleratorPattern.MatchString(record.AdapterID) {
		return "", "adapterId is not kebab-case"
	}
	if !protocol.IsNormalizedVersion(record.AdapterVersion) {
		return "", "adapterVersion is not a normalized dotted version"
	}
	if !filepath.IsAbs(dataRoot) {
		return "", "the owning data root is not an absolute path"
	}
	if !filepath.IsAbs(record.Path) || filepath.Clean(record.Path) != record.Path {
		return "", "path is not an absolute, already-clean path"
	}
	relative, err := filepath.Rel(dataRoot, record.Path)
	if err != nil {
		return "", "path is not inside the owning data root"
	}
	segments := strings.Split(filepath.ToSlash(relative), "/")
	if len(segments) < 5 || segments[0] != componentKindDirectories[ComponentKindACPAdapter] {
		return "", "path is not an adapter install location inside the owning data root"
	}
	if !protocol.LabelOrAcceleratorPattern.MatchString(segments[1]) {
		return "", "path does not name a kebab-case harness"
	}
	if segments[2] != record.AdapterID || segments[3] != record.AdapterVersion {
		return "", "path does not match the record's own adapter id and version"
	}
	return segments[1], ""
}

// validateRecordIntegrityFields checks the fields both generations share and that rollback and
// doctor rely on to decide a file is still safely ours. A digest is compared case-insensitively
// everywhere, so an uppercase digest is lowered rather than rejected; anything that is not a
// SHA-256 at all is rejected.
func validateRecordIntegrityFields(record ownershipRecordDocument) string {
	if !ChecksumPattern.MatchString(strings.ToLower(record.ContentSHA256)) {
		return "contentSha256 is not a sha256 digest"
	}
	if record.SizeBytes < 0 {
		return "sizeBytes is negative"
	}
	if record.InstalledAt == "" {
		return "installedAt is empty"
	}
	if _, err := time.Parse(time.RFC3339, record.InstalledAt); err != nil {
		return "installedAt is not an RFC3339 timestamp"
	}
	return ""
}

// Save writes the ledger atomically in the current generation: encode to a temporary file in
// dataRoot, fsync, then rename over the destination. A crash mid-write must never leave a truncated
// or corrupt ledger file in place of a valid one.
func (ledger OwnershipLedger) Save(dataRoot string) error {
	ledger.LedgerVersion = OwnershipLedgerVersion
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

// RecordFor returns the ownership record for path and whether one exists. Path is the ledger's
// primary key: exactly one record may describe one absolute path, which parsing enforces, so this
// lookup has no precedence question to resolve.
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
	updated := OwnershipLedger{
		LedgerVersion: OwnershipLedgerVersion,
		Records:       make([]OwnershipRecord, 0, len(ledger.Records)+1),
	}
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
