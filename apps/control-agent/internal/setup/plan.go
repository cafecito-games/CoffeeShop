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
	"runtime"
	"slices"
	"strings"
	"unicode/utf8"
)

// CurrentPlatform is the single definition of this node's platform key ("GOOS-GOARCH"), used both
// to build a plan and, in Apply, to verify a supplied plan was built for the node it is being
// applied on rather than trusting whatever platform value the plan file itself claims.
func CurrentPlatform() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

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

// OperationKinds is the single enumeration of every supported OperationKind. installOperation must
// handle each value or refuse it; a value outside this set never reaches a mutation.
var OperationKinds = []OperationKind{OperationInstallArchive, OperationManualPlacementCheck}

// Valid reports whether kind is in the closed vocabulary.
func (kind OperationKind) Valid() bool {
	return slices.Contains(OperationKinds, kind)
}

// operationKindForDistribution maps a distribution kind to the one operation kind that can satisfy
// it. A distribution kind with no mapping produces no operation at all rather than a defaulted one.
func operationKindForDistribution(kind DistributionKind) (OperationKind, error) {
	switch kind {
	case DistributionKindArchive:
		return OperationInstallArchive, nil
	case DistributionKindManual:
		return OperationManualPlacementCheck, nil
	default:
		return "", fmt.Errorf("distribution kind %q has no install operation", kind)
	}
}

// ExpectedCurrentState is what the planner observed (or asserted absent) at TargetPath when the
// plan was built. Apply refuses to proceed the instant reality no longer matches this, rather
// than silently recomputing a new expectation.
type ExpectedCurrentState string

const (
	ExpectedAbsent        ExpectedCurrentState = "absent"
	ExpectedOwnedMatch    ExpectedCurrentState = "owned-match"    // an owned file already at the target, matching digest — apply is then a no-op for this operation (idempotent re-apply)
	ExpectedUnownedExists ExpectedCurrentState = "unowned-exists" // something exists at the target that this tool did not create — always refused, never overwritten
)

// ExpectedCurrentStates is the single enumeration of every observable target state. Apply switches
// on all three and refuses anything else rather than treating an unrecognized state as "absent",
// which would install over a target whose state it never actually established.
var ExpectedCurrentStates = []ExpectedCurrentState{ExpectedAbsent, ExpectedOwnedMatch, ExpectedUnownedExists}

// Valid reports whether state is in the closed vocabulary.
func (state ExpectedCurrentState) Valid() bool {
	return slices.Contains(ExpectedCurrentStates, state)
}

// postconditionMaximumBytes bounds each human-readable postcondition string.
const postconditionMaximumBytes = 256

// Operation is one planned, individually verifiable mutation. Component carries the full shared
// identity (kind, id, version) so a plan operation, the ownership record it produces, and doctor's
// installed check all compare the same value; because Component is a plain struct field it is part
// of the canonical plan JSON and therefore of the plan digest.
type Operation struct {
	Kind                 OperationKind        `json:"kind"`
	Component            ComponentRef         `json:"component"`
	HarnessID            string               `json:"harnessId"`  // the harness this component belongs to; identity, so digested
	TargetPath           string               `json:"targetPath"` // absolute, always inside the plan's DataRoot
	ExpectedChecksum     string               `json:"expectedChecksum"`
	ExpectedCurrentState ExpectedCurrentState `json:"expectedCurrentState"`
	Source               PlatformDistribution `json:"source"`
}

// IdempotencyKey is the stable identity of the mutation this operation performs: the same key means
// the same component version being placed at the same path by the same mechanism, which is exactly
// the condition under which a completed apply may be replayed as a no-op. It deliberately excludes
// ExpectedCurrentState and Source, which describe *when* the operation is still valid rather than
// what it is, and it is used for within-plan collision detection and for naming an operation in an
// error without echoing manifest free text.
func (operation Operation) IdempotencyKey() string {
	return string(operation.Kind) + "|" + operation.Component.String() + "|" + operation.TargetPath
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
	Postconditions  []string    `json:"postconditions"` // human-readable, e.g. "<label> (acp-adapter for claude-cli) verified at <path>"
	// Digest is sha256 over the canonical JSON of every field above, computed with Digest itself
	// omitted. It is also the plan's idempotency key: two planning runs that bind the same manifest
	// bytes, platform, data root, component identities, and observed target state produce the same
	// digest, and applying a plan whose digest still matches a freshly derived plan is a no-op for
	// every operation already satisfied.
	Digest string `json:"digest"`
}

// BuildPlan produces a deterministic plan for every component entry in manifest — harness or ACP
// adapter — that has a PlatformDistribution for platform ("GOOS-GOARCH"). Components with no entry
// for platform are skipped (not an error — planning is best-effort across a mixed-support manifest)
// and reported back in the second return value so a caller (doctor, CLI output) can say why a
// component has no operation. existingLedger supplies ExpectedCurrentState by checking, for each
// computed TargetPath, whether a matching-digest owned file, a mismatched/foreign file, or nothing
// exists on the real filesystem at planning time (BuildPlan does touch the filesystem to *observe*
// current state — it is read-only, never mutating).
//
// ManifestDigest is taken over the exact manifest bytes rather than the parsed structure, so even
// a formatting-only manifest change invalidates every plan built from the previous bytes: "the
// manifest source changed" must always fail a later apply closed, per the issue's contract.
func BuildPlan(manifestBytes []byte, manifest Manifest, platform string, dataRoot string, existingLedger OwnershipLedger) (plan Plan, skipped []ComponentRef, err error) {
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
	// seenOperations is defense in depth behind Manifest.Validate's duplicate-target rejection: two
	// operations that would perform the same mutation must never coexist in one plan, because the
	// second would observe state the first created and could not be replayed.
	seenOperations := make(map[string]bool, len(manifest.Components))
	for index := range manifest.Components {
		entry := manifest.Components[index]
		distribution, supported := entry.Platforms[platform]
		if !supported {
			skipped = append(skipped, entry.Ref())
			continue
		}
		targetPath, err := ComponentTargetPath(dataRoot, entry, distribution)
		if err != nil {
			return Plan{}, nil, fmt.Errorf("component at index %d: %w", index, err)
		}
		operationKind, err := operationKindForDistribution(distribution.Kind)
		if err != nil {
			return Plan{}, nil, fmt.Errorf("component at index %d: %w", index, err)
		}
		operation := Operation{
			Kind:                 operationKind,
			Component:            entry.Ref(),
			HarnessID:            entry.HarnessID,
			TargetPath:           targetPath,
			ExpectedCurrentState: observeCurrentState(targetPath, existingLedger),
			Source:               distribution,
		}
		// An archive pins its checksum in the manifest; a manual entry intentionally carries none
		// there and the operator asserts one at apply time through ApplyOptions.ManualChecksums.
		if distribution.Kind == DistributionKindArchive {
			operation.ExpectedChecksum = distribution.SHA256
		}
		if seenOperations[operation.IdempotencyKey()] {
			return Plan{}, nil, fmt.Errorf("component at index %d: duplicate install operation", index)
		}
		seenOperations[operation.IdempotencyKey()] = true
		plan.Operations = append(plan.Operations, operation)
		postcondition := fmt.Sprintf("%s (%s for harness %s) verified at %s", entry.Label, entry.Kind, entry.HarnessID, targetPath)
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

// componentKindDirectories is the data-root layout: one fixed directory per component kind. ACP
// adapters keep the "adapters" segment they were installed under before the schema generalized, so
// an already-installed adapter and its existing ownership record still resolve to the same path and
// migration never silently relocates or orphans an installed file. A kind absent from this map has
// no install location at all, which fails planning closed rather than inventing one.
var componentKindDirectories = map[ComponentKind]string{
	ComponentKindACPAdapter:     "adapters",
	ComponentKindHarness:        "harnesses",
	ComponentKindCapabilityPack: "capability-packs",
}

// componentRelativeTargetPath is the data-root-relative install location for one component entry at
// one pinned version: <kindDirectory>/<harnessId>/<componentId>/<version>/<executablePath>. The
// version segment guarantees two components or two versions never collide, and a version bump
// naturally targets a new path so the old version's files are left for explicit rollback rather
// than silently replaced.
func componentRelativeTargetPath(entry ComponentManifestEntry, distribution PlatformDistribution) (string, error) {
	directory, known := componentKindDirectories[entry.Kind]
	if !known {
		return "", fmt.Errorf("component kind %q has no install location", entry.Kind)
	}
	return filepath.Join(directory, entry.HarnessID, entry.ID, entry.Version, filepath.FromSlash(distribution.ExecutablePath)), nil
}

// componentVersionDirectory is the deterministic absolute directory every file of one component
// version lives under, derived from the same layout componentRelativeTargetPath uses so there is
// still only one definition of where a component version is installed. It takes the version
// explicitly because a retained version is no longer the entry's own declared one.
func componentVersionDirectory(dataRoot string, entry ComponentManifestEntry, version string) (string, error) {
	directory, known := componentKindDirectories[entry.Kind]
	if !known {
		return "", fmt.Errorf("component kind %q has no install location", entry.Kind)
	}
	return filepath.Join(dataRoot, directory, entry.HarnessID, entry.ID, version), nil
}

// ComponentTargetPath is the single deterministic absolute install location for one component entry
// at one pinned version under dataRoot.
func ComponentTargetPath(dataRoot string, entry ComponentManifestEntry, distribution PlatformDistribution) (string, error) {
	relative, err := componentRelativeTargetPath(entry, distribution)
	if err != nil {
		return "", err
	}
	return filepath.Join(dataRoot, relative), nil
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
