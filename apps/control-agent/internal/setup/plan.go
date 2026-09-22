package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type OperationKind string

const (
	// OperationInstallArchive downloads (or, in tests, reads from a pre-populated local path
	// supplied through ApplyOptions — see applier.go) an archive, verifies it, extracts exactly
	// Source.ExecutablePath, and installs it at TargetPath.
	OperationInstallArchive OperationKind = "install-archive"
	// OperationManualPlacementCheck verifies that the operator has already placed and correctly
	// identified a manual artifact at TargetPath; it performs no download and no copy, only a
	// checksum/executability verification against ExpectedChecksum.
	OperationManualPlacementCheck OperationKind = "manual-placement-check"
)

// ExpectedCurrentState is what the planner observed (or asserted absent) at TargetPath when the
// plan was built. Apply refuses to proceed the instant reality no longer matches this, rather
// than silently recomputing a new expectation.
type ExpectedCurrentState string

const (
	ExpectedAbsent        ExpectedCurrentState = "absent"
	ExpectedOwnedMatch    ExpectedCurrentState = "owned-match"    // an owned file already at the target, matching digest — apply is then a no-op for this operation (idempotent re-apply)
	ExpectedUnownedExists ExpectedCurrentState = "unowned-exists" // something exists at the target that this tool did not create — always refused, never overwritten
)

// postconditionMaximumBytes bounds each human-readable postcondition string.
const postconditionMaximumBytes = 256

// Operation is one planned, individually verifiable mutation.
type Operation struct {
	Kind                 OperationKind        `json:"kind"`
	AdapterID            string               `json:"adapterId"`
	AdapterVersion       string               `json:"adapterVersion"`
	TargetPath           string               `json:"targetPath"` // absolute, always inside the plan's DataRoot
	ExpectedChecksum     string               `json:"expectedChecksum"`
	ExpectedCurrentState ExpectedCurrentState `json:"expectedCurrentState"`
	Source               PlatformDistribution `json:"source"`
}

// Plan is a fully serializable, replayable description of the exact mutations one setup apply
// would perform. It contains no timestamp and no machine-local temporary path, so two planning
// runs against unchanged manifest+platform+observed-state produce byte-identical JSON. The
// serialized shape is deliberately free of maps: json.Marshal orders struct fields and slice
// elements deterministically but map keys only lexically, and lexical order can differ from the
// semantic order the planner walked — slices only keeps plan JSON canonical by construction.
// Platforms lookups therefore happen before building the plan, never inside it.
type Plan struct {
	ManifestVersion string      `json:"manifestVersion"`
	ManifestDigest  string      `json:"manifestDigest"` // sha256 of the exact manifest bytes the plan was built from
	Platform        string      `json:"platform"`       // "GOOS-GOARCH"
	DataRoot        string      `json:"dataRoot"`
	Operations      []Operation `json:"operations"`
	Postconditions  []string    `json:"postconditions"` // human-readable, e.g. "claude-cli ACP adapter verified at <path>"
	Digest          string      `json:"digest"`         // sha256 over the canonical JSON of every field above, computed with Digest itself omitted
}

// BuildPlan produces a deterministic plan for every adapter entry in manifest whose HarnessID has
// a PlatformDistribution for platform ("GOOS-GOARCH"). Adapters with no entry for platform are
// skipped (not an error — planning is best-effort across a mixed-support manifest) and reported
// back in the second return value so a caller (doctor, CLI output) can say why an adapter has no
// operation. existingLedger supplies ExpectedCurrentState by checking, for each computed
// TargetPath, whether a matching-digest owned file, a mismatched/foreign file, or nothing exists
// on the real filesystem at planning time (BuildPlan does touch the filesystem to *observe*
// current state — it is read-only, never mutating).
//
// ManifestDigest is taken over the exact manifest bytes rather than the parsed structure, so even
// a formatting-only manifest change invalidates every plan built from the previous bytes: "the
// manifest source changed" must always fail a later apply closed, per the issue's contract.
func BuildPlan(manifestBytes []byte, manifest Manifest, platform string, dataRoot string, existingLedger OwnershipLedger) (plan Plan, skipped []string, err error) {
	if err := manifest.Validate(); err != nil {
		return Plan{}, nil, err
	}
	if !filepath.IsAbs(dataRoot) {
		return Plan{}, nil, errors.New("data root must be an absolute path")
	}
	if !platformKeyPattern.MatchString(platform) {
		return Plan{}, nil, errors.New("platform must be GOOS-GOARCH shaped")
	}
	manifestSum := sha256.Sum256(manifestBytes)
	plan = Plan{
		ManifestVersion: manifest.ManifestVersion,
		ManifestDigest:  hex.EncodeToString(manifestSum[:]),
		Platform:        platform,
		DataRoot:        dataRoot,
	}
	for index := range manifest.Adapters {
		entry := manifest.Adapters[index]
		distribution, supported := entry.Platforms[platform]
		if !supported {
			skipped = append(skipped, entry.HarnessID)
			continue
		}
		targetPath := AdapterTargetPath(dataRoot, entry, distribution)
		operation := Operation{
			AdapterID:            entry.ID,
			AdapterVersion:       entry.Version,
			TargetPath:           targetPath,
			ExpectedCurrentState: observeCurrentState(targetPath, existingLedger),
			Source:               distribution,
		}
		switch distribution.Kind {
		case DistributionKindArchive:
			operation.Kind = OperationInstallArchive
			operation.ExpectedChecksum = distribution.SHA256
		case DistributionKindManual:
			// A manual entry intentionally carries no checksum in the manifest; the operator
			// asserts one at apply time through ApplyOptions.ManualChecksums.
			operation.Kind = OperationManualPlacementCheck
		}
		plan.Operations = append(plan.Operations, operation)
		postcondition := fmt.Sprintf("%s (%s) ACP adapter verified at %s", entry.Label, entry.HarnessID, targetPath)
		plan.Postconditions = append(plan.Postconditions, truncateAtRuneBoundary(postcondition, postconditionMaximumBytes))
	}
	plan.Digest = ComputePlanDigest(plan)
	return plan, skipped, nil
}

// ComputePlanDigest returns the plan's content digest, recomputing it fresh from every field
// except Digest — used both to fill Plan.Digest in BuildPlan and, by the applier, to verify that
// a supplied plan has not been hand-edited or gone stale.
func ComputePlanDigest(plan Plan) string {
	digestInput := plan
	digestInput.Digest = ""
	// Plan holds only strings, structs, and slices of both, so encoding cannot fail; an impossible
	// failure still surfaces as an all-zero-matching digest no honest plan would carry.
	encoded, err := json.Marshal(digestInput)
	if err != nil {
		return ""
	}
	summed := sha256.Sum256(encoded)
	return hex.EncodeToString(summed[:])
}

// AdapterTargetPath is the single deterministic install location for one adapter entry at one
// pinned version: <dataRoot>/adapters/<harnessId>/<adapterId>/<version>/<executablePath>. The
// version segment guarantees two adapters or two versions never collide, and a version bump
// naturally targets a new path so the old version's files are left for explicit rollback rather
// than silently replaced.
func AdapterTargetPath(dataRoot string, entry AdapterManifestEntry, distribution PlatformDistribution) string {
	return filepath.Join(dataRoot, "adapters", entry.HarnessID, entry.ID, entry.Version, filepath.FromSlash(distribution.ExecutablePath))
}

// observeCurrentState classifies what currently exists at targetPath against the ledger. Anything
// ambiguous — a read error, a non-regular file, a symlink, a digest the ledger cannot vouch for —
// classifies as unowned-exists so the fail-closed paths (never overwrite, never follow) are the
// default. It is read-only and shared by BuildPlan (to record expectations) and Apply (to
// re-verify them immediately before mutating).
func observeCurrentState(targetPath string, ledger OwnershipLedger) ExpectedCurrentState {
	information, err := os.Lstat(targetPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ExpectedAbsent
		}
		return ExpectedUnownedExists
	}
	if !information.Mode().IsRegular() {
		return ExpectedUnownedExists
	}
	record, owned := ledger.RecordFor(targetPath)
	if !owned {
		return ExpectedUnownedExists
	}
	digest, err := fileChecksum(targetPath)
	if err != nil || !strings.EqualFold(digest, record.ContentSHA256) {
		return ExpectedUnownedExists
	}
	return ExpectedOwnedMatch
}

func fileChecksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// truncateAtRuneBoundary truncates to at most maximumBytes without splitting a multi-byte UTF-8
// sequence. A byte-index slice alone can cut a rune in half; Go's JSON encoder then replaces the
// orphaned trailing bytes with the 3-byte U+FFFD replacement character, which can grow the
// encoded string past the very byte limit this function exists to enforce.
func truncateAtRuneBoundary(value string, maximumBytes int) string {
	if len(value) <= maximumBytes {
		return value
	}
	truncated := value[:maximumBytes]
	for len(truncated) > 0 {
		r, size := utf8.DecodeLastRuneInString(truncated)
		if r != utf8.RuneError || size > 1 {
			break
		}
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
}
