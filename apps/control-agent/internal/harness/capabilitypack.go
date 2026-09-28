package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// ManagedProjectionDirectory is the one definition of the Barista-owned managed projection's
// directory name. It is a single path segment placed directly beneath a vendor's own skills root —
// for Codex, $CODEX_HOME/skills/coffee-shop-barista. It is Barista's name, not a vendor convention,
// and it is the one path acceptance criterion 9 excludes from the byte-for-byte guarantee. Every
// adapter and every test derives the name from here rather than restating it.
const ManagedProjectionDirectory = "coffee-shop-barista"

// managedProjectionTemporarySuffix names the Barista-created sibling a managed projection is written
// to before it is renamed into place. It is derived from ManagedProjectionDirectory so the only two
// paths Barista ever creates inside a vendor's skills root share one definition.
const managedProjectionTemporarySuffix = ".barista-incoming"

// RunScopedProjectionDirectory is the Barista-owned prefix beneath the data root that every
// run-scoped projection lives under. It is never inside a run workspace and never inside vendor
// configuration, so a run-scoped projection is deletable state Barista alone created.
const RunScopedProjectionDirectory = "capability-pack-projections"

// ProjectionMarkerName is the ownership marker Barista writes at the root of a managed projection.
// A managed subtree is Barista-owned if and only if this file parses and declares ProjectionOwner.
const ProjectionMarkerName = "barista-projection.json"

// ProjectionOwner is the fixed owner identifier Barista stamps into every projection it writes, and
// ProjectionSchemaVersion is the projection layout generation this build understands. A marker
// declaring another owner is foreign and is never adopted; a marker declaring another generation is
// replaced wholesale rather than merged or partially read.
const (
	ProjectionOwner         = "cafecito-games/CoffeeShop/barista"
	ProjectionSchemaVersion = "1"
)

// maximumForeignSkillBytes bounds one foreign SKILL.md read during collision enumeration, and
// maximumForeignSkillFiles bounds how many are read at all. Operator content is untrusted input:
// enumeration reads a bounded prefix of a bounded number of files and never follows a symlink.
const (
	maximumForeignSkillBytes = 64 << 10
	maximumForeignSkillFiles = 512
)

// ProjectionShape is the closed vocabulary of projection shapes an activation adapter may use. The
// owner's decision authorizes exactly these two and no third: a run-scoped projection under the
// Barista data root, handed to the vendor CLI for one session, and a managed Barista-owned subtree
// inside the vendor's own configuration, atomically replaced and explicitly owned.
type ProjectionShape string

const (
	// ProjectionRunScoped is handed to the harness for one session only and leaves vendor
	// configuration untouched. It is used wherever the vendor CLI offers a session-only surface.
	ProjectionRunScoped ProjectionShape = "run-scoped"
	// ProjectionManaged is the versioned Barista-owned subtree inside the vendor's own configuration,
	// used only where no session-only surface exists.
	ProjectionManaged ProjectionShape = "managed"
)

// ProjectionShapes is the whole vocabulary, which every consumer must handle or reject.
var ProjectionShapes = []ProjectionShape{ProjectionRunScoped, ProjectionManaged}

// Validate refuses a shape outside the vocabulary rather than letting it default to either one.
func (shape ProjectionShape) Validate() error {
	if !slices.Contains(ProjectionShapes, shape) {
		return errors.New("unknown capability pack projection shape")
	}
	return nil
}

// PackRequirement is the closed vocabulary of how strictly a run needs the capability pack. It is
// the node administrator's policy, never the run's or the hub's: nothing in the control protocol
// carries it, so a node that has not opted in keeps the optional reading.
type PackRequirement string

const (
	// PackOptional lets a run proceed unskilled, with the reason reported, when the pack cannot be
	// projected for a reason that does not compromise integrity.
	PackOptional PackRequirement = "optional"
	// PackRequired refuses the run before the prompt whenever the guarantee cannot be established.
	PackRequired PackRequirement = "required"
)

// PackRequirements is the whole vocabulary, which every consumer must handle or reject.
var PackRequirements = []PackRequirement{PackOptional, PackRequired}

// ParsePackRequirement resolves a configured requirement. An empty or unknown value is rejected
// rather than defaulted, so a typo can never silently weaken the node's policy.
func ParsePackRequirement(value string) (PackRequirement, error) {
	requirement := PackRequirement(value)
	if !slices.Contains(PackRequirements, requirement) {
		return "", fmt.Errorf("capability pack requirement must be one of %s", strings.Join(packRequirementNames(), ", "))
	}
	return requirement, nil
}

// Validate refuses a requirement outside the vocabulary rather than letting it default to either one.
func (requirement PackRequirement) Validate() error {
	if !slices.Contains(PackRequirements, requirement) {
		return errors.New("unknown capability pack requirement")
	}
	return nil
}

func packRequirementNames() []string {
	names := make([]string, 0, len(PackRequirements))
	for _, requirement := range PackRequirements {
		names = append(names, string(requirement))
	}
	return names
}

// PackActivationOutcome is the closed vocabulary of how one run's pack activation resolved. It is
// reported locally; it adds no field to the control protocol.
type PackActivationOutcome string

const (
	// PackProjected means the run discovered exactly the active pack's skills through a projection
	// Barista created and owns.
	PackProjected PackActivationOutcome = "projected"
	// PackUnskilled means a pack-optional run proceeded with no projection and no claim of pack
	// activation, for a named reason.
	PackUnskilled PackActivationOutcome = "unskilled"
	// PackUnconfirmed means a pack-optional run proceeded while a managed projection remained
	// installed in the vendor's own configuration and its guarantee could not be confirmed. It is
	// deliberately distinct from PackUnskilled: such a run does discover the projected skills.
	PackUnconfirmed PackActivationOutcome = "unconfirmed"
	// PackRefused means the run terminated before the prompt with a named reason.
	PackRefused PackActivationOutcome = "refused"
)

// PackActivationOutcomes is the whole vocabulary, which every consumer must handle or reject.
var PackActivationOutcomes = []PackActivationOutcome{PackProjected, PackUnskilled, PackUnconfirmed, PackRefused}

// ErrPackActivation is what every refusal of a pack-required run wraps, so a caller can tell a
// capability-pack refusal from a transport failure without matching on message text.
var ErrPackActivation = errors.New("Coffee Shop capability pack activation failed")

// ActivePack is the one verified active capability pack this daemon adopted at startup: the
// identity and digest of the bytes it read, the parsed manifest, and the expanded tree. Only the
// in-memory tree is ever written out; nothing on disk is copied, linked, or followed.
//
// internal/setup is the only package that parses either ledger, so the harness package receives a
// resolved ActivePack and never a data-root path to interpret for activation purposes.
type ActivePack struct {
	ID            string
	Version       string
	ArchiveDigest string
	Manifest      capabilitypack.PackManifest
	Tree          capabilitypack.Tree
	// Build is the Barista build that resolved the pack, recorded in every ownership marker.
	Build string
	// Reread re-verifies the installed artifact's bytes and returns what they currently declare. It
	// is called again immediately before projecting, so a digest or ownership change between
	// resolution and launch aborts the run rather than projecting partially verified bytes. A nil
	// Reread is a refusal, never an assumption that the bytes are still good.
	Reread func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error)
}

// Ref is the pack identity one run binds to.
func (pack ActivePack) Ref() string { return pack.ID + "@" + pack.Version }

// Identity is the full identity recorded before the prompt and stamped into every marker: the pack
// id, its version, and the digest of the archive bytes Barista actually read.
func (pack ActivePack) Identity() string { return pack.Ref() + "@" + pack.ArchiveDigest }

// SkillNamesByDirectory is the projected skills keyed by the directory each skill occupies inside
// the projection. The two vendors disagree about which of those two strings identifies a skill, so
// each adapter picks; neither re-derives the layout, which SkillPathFor owns.
func (pack ActivePack) SkillNamesByDirectory() (map[string]string, error) {
	names := map[string]string{}
	for _, skill := range pack.Manifest.Skills {
		path := skill.Path
		if path != capabilitypack.SkillPathFor(skill.ID) {
			return nil, fmt.Errorf("pack skill %s does not live at the one packaged skill location", skill.ID)
		}
		content, present := pack.Tree[path]
		if !present {
			return nil, fmt.Errorf("pack skill %s is absent from the active pack tree", skill.ID)
		}
		document, err := capabilitypack.ParseSkillDocument(path, content)
		if err != nil {
			return nil, err
		}
		names[skill.ID] = document.Name
	}
	return names, nil
}

// ProjectionMarker is the ownership marker at the root of a projection. It is written by Barista and
// by nothing else, and it is the only evidence that makes a subtree Barista's.
type ProjectionMarker struct {
	Owner                   string `json:"owner"`
	ProjectionSchemaVersion string `json:"projectionSchemaVersion"`
	Shape                   string `json:"shape"`
	PackID                  string `json:"packId"`
	PackVersion             string `json:"packVersion"`
	ArchiveDigest           string `json:"archiveDigest"`
	BaristaBuild            string `json:"baristaBuild"`
}

// Identity is the pack identity the marker claims, in the same shape ActivePack.Identity produces,
// so a comparison is one string equality and cannot compare only two of the three fields.
func (marker ProjectionMarker) Identity() string {
	return marker.PackID + "@" + marker.PackVersion + "@" + marker.ArchiveDigest
}

// markerFor is the marker a projection of shape for pack carries.
func markerFor(pack ActivePack, shape ProjectionShape) ProjectionMarker {
	return ProjectionMarker{
		Owner:                   ProjectionOwner,
		ProjectionSchemaVersion: ProjectionSchemaVersion,
		Shape:                   string(shape),
		PackID:                  pack.ID,
		PackVersion:             pack.Version,
		ArchiveDigest:           pack.ArchiveDigest,
		BaristaBuild:            pack.Build,
	}
}

// ParseProjectionMarker strictly decodes an ownership marker. A malformed marker, an unknown field,
// trailing data, or an owner that is not Barista's is "foreign or corrupt" — never "absent", and
// never a subtree to adopt. An unrecognized projection generation parses but is reported so the
// caller replaces the subtree wholesale instead of reading any of it.
func ParseProjectionMarker(data []byte) (ProjectionMarker, error) {
	var marker ProjectionMarker
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&marker); err != nil {
		return ProjectionMarker{}, errors.New("the projection ownership marker could not be decoded")
	}
	if decoder.More() {
		return ProjectionMarker{}, errors.New("the projection ownership marker carries trailing data")
	}
	if marker.Owner != ProjectionOwner {
		return ProjectionMarker{}, errors.New("the projection ownership marker declares a different owner")
	}
	if marker.PackID == "" || marker.PackVersion == "" || marker.ArchiveDigest == "" || marker.ProjectionSchemaVersion == "" {
		return ProjectionMarker{}, errors.New("the projection ownership marker does not record a complete pack identity")
	}
	return marker, nil
}

// Current reports whether this build understands the marker's projection generation. A marker whose
// generation this build does not recognize is never merged with and never partially read.
func (marker ProjectionMarker) Current() bool {
	return marker.ProjectionSchemaVersion == ProjectionSchemaVersion
}

// marshalMarker renders the marker deterministically, so the same pack produces the same marker
// bytes on every node and a projection's identity is reproducible.
func marshalMarker(marker ProjectionMarker) ([]byte, error) {
	data, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// SkillCollision is one projected skill name a vendor already offers from outside the managed
// subtree, together with the effective winner precedence verification established. An empty Winner
// means the winner could not be confirmed, which is treated as unconfirmed discovery.
type SkillCollision struct {
	// Name is the string the vendor keys the skill by — a directory name for one vendor and the
	// SKILL.md metadata name for the other, which is why the adapter supplies it.
	Name string
	// Offered is the foreign path that offers the same name.
	Offered string
	// Winner names the effective winner, or "" when verification could not confirm one.
	Winner string
}

// PackProjection is what an adapter produced for one run: the launch inputs the harness needs, the
// projected skills, the collisions precedence enumeration found, and the cleanup that removes only
// what this run created.
type PackProjection struct {
	Shape ProjectionShape
	// Root is the projection root the harness is pointed at.
	Root string
	// Arguments are appended to the harness's own argument list, never shell-interpreted.
	Arguments []string
	// Environment are variables appended to the child environment. They never carry a credential.
	Environment []string
	// SkillNames are the names the vendor will key the projected skills by, sorted.
	SkillNames []string
	// Collisions are the projected names the vendor already offers from outside the projection.
	Collisions []SkillCollision
	// Files are the paths the projection wrote, relative to Root, sorted. Barista-owned metadata is
	// listed in Metadata instead, so a test can hold the content set to exactly the pack's files.
	Files []string
	// Metadata are the Barista-owned files the projection shape requires, relative to Root, sorted.
	Metadata []string

	cleanup func() error
}

// launchArguments and launchEnvironment are nil-safe readers, so a run with no projection needs no
// branch at the launch site and can never be given a partially assembled one.
func (projection *PackProjection) launchArguments() []string {
	if projection == nil {
		return nil
	}
	return projection.Arguments
}

func (projection *PackProjection) launchEnvironment() []string {
	if projection == nil {
		return nil
	}
	return projection.Environment
}

// Cleanup removes only the paths this run created, and is idempotent: running it twice, or on a path
// already gone, succeeds.
func (projection *PackProjection) Cleanup() error {
	if projection == nil || projection.cleanup == nil {
		return nil
	}
	cleanup := projection.cleanup
	projection.cleanup = nil
	return cleanup()
}

// unavailablePack marks a pack activation failure a pack-optional run may proceed past. Every other
// failure refuses the run whatever the requirement, because it means Barista could not establish the
// integrity of what it was about to project.
//
// installed distinguishes the two ways a pack-optional run may proceed, which must never be reported
// as each other. When nothing of Barista's is in place — no adapter, a foreign occupant at the
// managed path, a run-scoped projection that was written and then removed — the run genuinely
// proceeds unskilled. When a managed projection is already installed in the vendor's own
// configuration, the run will still discover it, so calling that run "unskilled" would be false: it
// proceeds with the projection installed and the guarantee unconfirmed, and it is reported that way.
type unavailablePack struct {
	reason    string
	installed bool
}

func (failure unavailablePack) Error() string { return failure.reason }

func packUnavailablef(format string, arguments ...any) error {
	return unavailablePack{reason: fmt.Sprintf(format, arguments...)}
}

// packUnconfirmedf is packUnavailablef for a managed projection that is already installed and that
// this run will therefore discover whatever Barista decides.
func packUnconfirmedf(format string, arguments ...any) error {
	return unavailablePack{reason: fmt.Sprintf(format, arguments...), installed: true}
}

func isPackUnavailable(err error) bool {
	var failure unavailablePack
	return errors.As(err, &failure)
}

// withInstalledProjection re-tags an unavailable failure that was raised while a Barista-owned managed
// projection was installed at root, so a pack-optional run that proceeds past it is never described as
// unskilled. Every managed projection failure passes through it — it is a chokepoint on the projection
// function's own error return, not a convention applied per site — so a failure raised anywhere after
// establishment cannot reach the report unclassified.
//
// It answers from the filesystem rather than from where in the code the failure came, on two pieces of
// evidence. The ownership marker is the first: mere existence at root is not enough, because a foreign
// occupant is not a projection the run discovers as Coffee Shop's. The daemon's own record that it
// established a projection at root during this lifetime is the second, and it is ground truth a
// tampered marker cannot contradict — deleting or corrupting a marker does not un-install the content
// the run's vendor CLI is about to read. Only the subtree actually being gone makes the run unskilled.
//
// A failure of any other kind is returned unchanged.
func withInstalledProjection(err error, root string, established bool) error {
	var failure unavailablePack
	if !errors.As(err, &failure) || failure.installed {
		return err
	}
	if _, markerErr := readProjectionMarker(root); markerErr == nil {
		failure.installed = true
		return failure
	}
	if established {
		if _, statErr := os.Lstat(root); statErr == nil {
			failure.installed = true
		}
	}
	return failure
}

// projectionRemainsInstalled reports whether a pack-optional run that proceeds past err will still
// discover a projection Barista installed.
func projectionRemainsInstalled(err error) bool {
	var failure unavailablePack
	return errors.As(err, &failure) && failure.installed
}

// packAdapterKey identifies one harness and transport combination. An adapter exists for a
// combination only when its skill-discovery surface was verified against the real binary at the
// pinned version.
type packAdapterKey struct {
	HarnessID string
	Transport string
}

// packProjectionContext is everything an adapter is given. It deliberately carries no MCP URL and no
// run token: the run-scoped Coffee Shop MCP server remains the only live action and authorization
// layer, and a projected skill never becomes a second authorization path.
type packProjectionContext struct {
	Pack     ActivePack
	RunID    string
	DataRoot string
	// Binary is the vendor executable this run will launch, which is also the executable a discovery
	// confirmation asks. It is the resolved profile's path, never a PATH lookup of its own.
	Binary string
	// Environment is the environment the harness will actually launch with. An adapter reads the
	// vendor's own configuration root from here and never from Barista's process environment.
	Environment []string
	// established records, per harness, that this daemon already wrote its managed projection. The
	// daemon adopts one pack selection per lifetime, so the projection is written once and every
	// later run reuses it without opening a single file inside it for writing.
	established *establishedProjections
	// hooks are the injection points a test uses to interrupt a replacement. Production leaves them
	// zero, so no production path can be diverted through one.
	hooks projectionHooks
	// inventory replaces the vendor inventory subprocess in a test. Production leaves it nil, so a
	// production discovery confirmation always asks the real executable the run will launch.
	inventory func(context.Context, string, []string) (string, error)
}

// packActivationAdapter is the harness activation adapter interface: it takes one verified pack plus
// a Barista-owned projection root, writes the projection, and returns the launch inputs and a
// cleanup func. Confirm proves the vendor actually resolved the projected skills before the prompt.
type packActivationAdapter struct {
	// Surface names the verified skill-discovery surface this adapter drives, for the log line that
	// records what a run was actually given.
	Surface string
	Shape   ProjectionShape
	Project func(packProjectionContext) (*PackProjection, error)
	Confirm func(context.Context, packProjectionContext, *PackProjection) error
}

// packActivationAdapters is the adapter registry. A combination absent from it ships no adapter,
// is never advertised as pack-ready, and refuses a pack-required run before the prompt.
//
// Neither ACP adapter is installed in this checkout, so no skill-discovery surface has been verified
// for claude-acp 0.79.0 or codex-acp 1.12.0: no option id, environment variable, config key, or path
// has been read from either real adapter, and it is not known whether either forwards or suppresses
// the per-session arguments the native surfaces use. An unverified surface is the missing-adapter
// case, never a "probably works" case, so acp-v1 has no entry here for either harness.
var packActivationAdapters = map[packAdapterKey]packActivationAdapter{
	{HarnessID: "claude-cli", Transport: TransportNative}: claudePluginDirectoryAdapter(),
	{HarnessID: "codex-cli", Transport: TransportNative}:  codexManagedSkillsAdapter(),
}

// packAdapterFor resolves the activation adapter for one harness and transport.
func packAdapterFor(harnessID, transport string) (packActivationAdapter, bool) {
	if transport == "" {
		transport = TransportNative
	}
	adapter, registered := packActivationAdapters[packAdapterKey{HarnessID: harnessID, Transport: transport}]
	return adapter, registered
}

// PackReadyCombinations lists the harness and transport combinations this build ships an activation
// adapter for, in a stable order. It is what a readiness presentation may report; a combination
// absent from it is never advertised as pack-ready.
func PackReadyCombinations() [][2]string {
	combinations := make([][2]string, 0, len(packActivationAdapters))
	for key := range packActivationAdapters {
		combinations = append(combinations, [2]string{key.HarnessID, key.Transport})
	}
	slices.SortFunc(combinations, func(a, b [2]string) int {
		if a[0] != b[0] {
			return strings.Compare(a[0], b[0])
		}
		return strings.Compare(a[1], b[1])
	})
	return combinations
}

// CapabilityPackReadiness reports only what this running Barista can prove on this socket. It is
// deliberately independent of the durable, informational component inventory.
func (r *Runner) CapabilityPackReadiness(nodeID, observedAt string) protocol.CapabilityPackReadinessReport {
	report := protocol.CapabilityPackReadinessReport{NodeID: nodeID, ObservedAt: observedAt, Status: "unavailable", Surfaces: []protocol.CapabilityPackSurface{}}
	if r.pack == nil {
		report.ReasonCode = string(r.packUnavailability.ReasonCode)
		if !slices.Contains(protocol.CapabilityPackReadinessReasonCodes, report.ReasonCode) {
			report.ReasonCode = "active-unverified"
		}
		return report
	}
	if r.pack.Reread == nil {
		report.ReasonCode = "active-unverified"
		return report
	}
	_, manifest, digest, err := r.pack.Reread()
	if err != nil || digest != r.pack.ArchiveDigest || manifest.ID != r.pack.ID || manifest.Version != r.pack.Version {
		report.ReasonCode = "active-unverified"
		return report
	}
	for _, combination := range PackReadyCombinations() {
		profile, available := r.advertisedProfile(combination[0])
		if !available || !slices.Contains(profile.Transports, combination[1]) {
			continue
		}
		report.Surfaces = append(report.Surfaces, protocol.CapabilityPackSurface{HarnessID: combination[0], Transport: combination[1]})
	}
	if len(report.Surfaces) == 0 {
		report.ReasonCode = string(PackNoSupportedSurface)
		return report
	}
	skills := slices.Sorted(slices.Values(manifest.SkillIDs()))
	report.Status = "available"
	report.Pack = &protocol.CapabilityPackIdentity{ID: r.pack.ID, Version: r.pack.Version, Skills: skills}
	return report
}

// AdmitCapabilityPack verifies immutable allocation evidence against this process before a
// resident is accepted. Activation repeats this proof immediately before the prompt.
func (r *Runner) AdmitCapabilityPack(expected *protocol.ExpectedCapabilityPack, harnessID, transport string) error {
	if expected == nil {
		return nil
	}
	if err := expected.Validate(); err != nil {
		return err
	}
	if r.pack == nil || r.pack.ID != expected.ID || r.pack.Version != expected.Version {
		return errors.New("the expected capability pack is not the active verified pack on this Barista")
	}
	available := slices.Sorted(slices.Values(r.pack.Manifest.SkillIDs()))
	for _, required := range expected.RequiredSkills {
		if !slices.Contains(available, required) {
			return fmt.Errorf("the expected capability pack does not provide required skill %s", required)
		}
	}
	if _, supported := packAdapterFor(harnessID, transport); !supported {
		return fmt.Errorf("the expected capability pack has no verified activation surface for %s over %s", harnessID, transport)
	}
	return nil
}

func (r *Runner) effectiveCapabilityPack(projection *PackProjection) *protocol.EffectiveCapabilityPack {
	if projection == nil || r.pack == nil {
		return nil
	}
	return &protocol.EffectiveCapabilityPack{ID: r.pack.ID, Version: r.pack.Version, Skills: slices.Sorted(slices.Values(r.pack.Manifest.SkillIDs()))}
}

// establishedProjections records which harnesses this daemon already wrote a managed projection for,
// and what identity it wrote. It is what makes "never mutate an in-flight projection" structural: a
// managed projection is written exactly once per daemon lifetime, and every later run of the same
// daemon reuses it after confirming the marker still records that identity.
type establishedProjections struct {
	mutex   sync.Mutex
	written map[string]string
}

func newEstablishedProjections() *establishedProjections {
	return &establishedProjections{written: map[string]string{}}
}

// begin serializes establishment for one harness and reports the identity this daemon already wrote,
// if any. The caller must call the returned release exactly once.
func (established *establishedProjections) begin(harnessID string) (string, func(string)) {
	established.mutex.Lock()
	identity := established.written[harnessID]
	return identity, func(written string) {
		if written != "" {
			established.written[harnessID] = written
		}
		established.mutex.Unlock()
	}
}

// warningCapabilityPackUnavailable is the normalized event code one refused pack-required run emits.
// protocol.HarnessEvent.Code is validated only as an identifier, so this adds no closed-vocabulary
// change to the control protocol.
const warningCapabilityPackUnavailable = "capability-pack-unavailable"

// WithCapabilityPackReport records where the per-run activation lines go. Without one they are
// dropped rather than printed from a library package.
func (r *Runner) WithCapabilityPackReport(report func(string)) *Runner {
	r.packReport = report
	return r
}

func (r *Runner) reportPack(format string, arguments ...any) {
	if r.packReport != nil {
		r.packReport(fmt.Sprintf(format, arguments...))
	}
}

// activatePack decides one invocation's capability pack fate before the prompt is composed. It
// returns the projection when the run discovered exactly the active pack's skills, nil when a
// pack-optional run proceeds unskilled, and an error that refuses the run before the prompt
// otherwise. Every reason is named; silence is never an option.
func (r *Runner) activatePack(ctx context.Context, invocation Invocation, transport, binary string) (*PackProjection, error) {
	requirement := r.CapabilityPackRequirement()
	harnessID := invocation.Run.HarnessID
	if err := r.AdmitCapabilityPack(invocation.ExpectedCapabilityPack, harnessID, transport); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	if r.pack == nil {
		reason := r.packUnavailability.Detail
		if reason == "" {
			reason = "no capability pack is selected on this node"
		}
		return nil, r.unskilled(invocation, requirement, packUnavailablef("%s", reason))
	}
	adapter, registered := packAdapterFor(harnessID, transport)
	if !registered {
		return nil, r.unskilled(invocation, requirement, packUnavailablef(
			"no capability pack activation adapter ships for harness %s over transport %s, because no skill-discovery surface has been verified for it at the pinned version",
			harnessID, transport))
	}
	if r.pack.Reread == nil {
		return nil, fmt.Errorf("%w: the active capability pack cannot be re-verified before the prompt", ErrPackActivation)
	}
	// The bytes are re-read and re-validated immediately before projecting, so a digest, identity, or
	// ownership change between startup resolution and this launch aborts the run rather than
	// projecting partially verified bytes.
	tree, manifest, digest, err := r.pack.Reread()
	if err != nil {
		return nil, fmt.Errorf("%w: the active capability pack no longer verifies: %s", ErrPackActivation, err.Error())
	}
	if digest != r.pack.ArchiveDigest || manifest.ID != r.pack.ID || manifest.Version != r.pack.Version {
		return nil, fmt.Errorf("%w: the active capability pack's bytes changed after Barista verified them, so nothing was projected", ErrPackActivation)
	}
	pack := *r.pack
	pack.Tree = tree
	pack.Manifest = manifest

	projectionContext := packProjectionContext{
		Pack:        pack,
		RunID:       invocation.Run.ID,
		DataRoot:    r.packDataRoot,
		Binary:      binary,
		Environment: invocation.packEnvironment,
		established: r.packProjections,
		hooks:       r.packHooks,
		inventory:   r.packInventory,
	}
	projection, err := adapter.Project(projectionContext)
	if err != nil {
		if isPackUnavailable(err) {
			return nil, r.unskilled(invocation, requirement, err)
		}
		return nil, err
	}
	for _, collision := range projection.Collisions {
		if collision.Winner == "" {
			shape := projection.Shape
			projection.Cleanup()
			return nil, r.unskilled(invocation, requirement, packUnconfirmedForShape(shape, fmt.Sprintf(
				"the projected capability pack skill %s collides with a skill %s already offers, and the effective precedence winner cannot be confirmed for %s at its pinned version",
				collision.Name, collision.Offered, harnessID)))
		}
		r.reportPack("capability pack %s: projected skill %s collides with %s; the effective winner is %s", pack.Ref(), collision.Name, collision.Offered, collision.Winner)
	}
	if adapter.Confirm != nil {
		if err := adapter.Confirm(ctx, projectionContext, projection); err != nil {
			shape := projection.Shape
			projection.Cleanup()
			if isPackUnavailable(err) {
				return nil, r.unskilled(invocation, requirement, packUnconfirmedForShape(shape, err.Error()))
			}
			return nil, err
		}
	}
	for _, skill := range pack.Manifest.Skills {
		if len(skill.DelegationTools) > 0 && !invocation.MCP.CanDelegate {
			// The projection is not narrowed and the run's grant is never widened: the skill ships as
			// authored and the unavailability of its delegation path is recorded for this run.
			r.reportPack("capability pack %s: skill %s declares delegation-only tools that this run was not served, so its delegation path is unavailable", pack.Ref(), skill.ID)
		}
	}
	r.reportPack("capability pack activation %s: %s (%s) for run %s on %s over %s through %s: %s",
		PackProjected, pack.Ref(), pack.ArchiveDigest, invocation.Run.ID, harnessID, transport, adapter.Surface, strings.Join(projection.SkillNames, ", "))
	return projection, nil
}

// packUnconfirmedForShape classifies a pack-optional run's remaining exposure. A managed projection
// is already installed in the vendor's own configuration by the time a collision or a discovery
// confirmation can fail, and Barista does not tear a shared managed projection down for one run, so
// such a run is never described as unskilled. A run-scoped projection is removed, so it is.
func packUnconfirmedForShape(shape ProjectionShape, reason string) error {
	if shape == ProjectionManaged {
		return packUnconfirmedf("%s", reason)
	}
	return packUnavailablef("%s", reason)
}

// unskilled resolves a named reason the pack could not be projected against the node's requirement:
// a pack-required run is refused before the prompt with one warning event, and a pack-optional run
// proceeds with the reason reported. The two ways a pack-optional run may proceed are reported as the
// distinct things they are — with no projection at all, or with a managed projection still installed
// and its guarantee unconfirmed — because claiming the second is the first would be false.
func (r *Runner) unskilled(invocation Invocation, requirement PackRequirement, cause error) error {
	reason := cause.Error()
	if requirement == PackRequired {
		if invocation.Events != nil {
			invocation.Events(protocol.HarnessEvent{
				Type: "warning", RunID: invocation.Run.ID, At: r.now().UTC().Format(time.RFC3339Nano),
				Code:    warningCapabilityPackUnavailable,
				Message: "this node requires an active Coffee Shop capability pack and the run was refused before the prompt: " + reason,
			})
		}
		r.reportPack("capability pack activation %s: run %s was refused before the prompt (%s)", PackRefused, invocation.Run.ID, reason)
		return fmt.Errorf("%w: %s", ErrPackActivation, reason)
	}
	if projectionRemainsInstalled(cause) {
		r.reportPack("capability pack activation %s: run %s proceeds with the managed Coffee Shop capability pack projection still installed and its guarantee unconfirmed (%s)",
			PackUnconfirmed, invocation.Run.ID, reason)
		return nil
	}
	r.reportPack("capability pack activation %s: run %s proceeds with no Coffee Shop capability pack (%s)", PackUnskilled, invocation.Run.ID, reason)
	return nil
}

// runScopedProjectionRoot is the deterministic Barista-owned root one run's run-scoped projection
// occupies: derived from the data root, the run id, and the pack identity, and never from the run
// workspace or from vendor configuration.
func runScopedProjectionRoot(dataRoot, runID, packID, packVersion string) (string, error) {
	if !filepath.IsAbs(dataRoot) {
		return "", errors.New("the Barista data root must be an absolute path")
	}
	for name, value := range map[string]string{"run id": runID, "pack id": packID, "pack version": packVersion} {
		if err := validateProjectionSegment(value); err != nil {
			return "", fmt.Errorf("%s is not usable in a projection path: %w", name, err)
		}
	}
	return filepath.Join(dataRoot, RunScopedProjectionDirectory, runID, packID+"@"+packVersion, ManagedProjectionDirectory), nil
}

// runScopedRunRoot is the per-run directory the whole run-scoped projection lives under, which is
// also the only path this run's cleanup removes.
func runScopedRunRoot(dataRoot, runID string) (string, error) {
	if !filepath.IsAbs(dataRoot) {
		return "", errors.New("the Barista data root must be an absolute path")
	}
	if err := validateProjectionSegment(runID); err != nil {
		return "", fmt.Errorf("run id is not usable in a projection path: %w", err)
	}
	return filepath.Join(dataRoot, RunScopedProjectionDirectory, runID), nil
}

// validateProjectionSegment holds every value Barista interpolates into a projection path to one
// safe single-segment grammar, so a hostile run id can never escape the Barista-owned prefix. It is
// the packaged-path grammar restricted to a single segment, which capabilitypack already owns.
func validateProjectionSegment(value string) error {
	if value == "" {
		return errors.New("value is empty")
	}
	if strings.Contains(value, "/") || strings.Contains(value, `\`) {
		return errors.New("value is not a single path segment")
	}
	return capabilitypack.ValidatePackPath(value)
}

// writeProjection writes a complete projection into a directory this call creates: the pack tree
// verbatim through the packaged-path grammar, the ownership marker, and whatever extra
// Barista-owned metadata the shape requires. It never writes into an existing directory, so it can
// never merge with content Barista did not just create.
func writeProjection(root string, pack ActivePack, shape ProjectionShape, metadata map[string][]byte) (*PackProjection, error) {
	if err := shape.Validate(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return nil, fmt.Errorf("create the capability pack projection's parent directory: %w", err)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		return nil, fmt.Errorf("create the capability pack projection directory: %w", err)
	}
	// The ownership marker is written first, before any content. A directory Barista created is then
	// identifiable as Barista's from the moment it exists, so an interrupted write leaves a leftover
	// that later cleanup can recognize rather than one it must refuse to touch.
	marker, err := marshalMarker(markerFor(pack, shape))
	if err != nil {
		return nil, err
	}
	written := map[string][]byte{ProjectionMarkerName: marker}
	for path, content := range metadata {
		written[path] = content
	}
	names := make([]string, 0, len(written))
	for path, content := range written {
		if err := writeProjectionMetadata(root, path, content); err != nil {
			return nil, fmt.Errorf("write the capability pack projection metadata: %w", err)
		}
		names = append(names, path)
	}
	slices.Sort(names)
	if err := capabilitypack.WriteTree(root, pack.Tree); err != nil {
		return nil, fmt.Errorf("write the capability pack projection: %w", err)
	}
	return &PackProjection{Shape: shape, Root: root, Files: pack.Tree.Paths(), Metadata: names}, nil
}

// projectionMetadataPaths is the closed set of Barista-owned files a projection may carry besides the
// pack's own content: the ownership marker every projection has, and the vendor plugin manifest the
// Claude CLI requires. Pack content goes through the packaged-path grammar, which deliberately
// refuses a dot-led segment like `.claude-plugin`, so the metadata paths are an explicit, compiled-in
// allowlist rather than a relaxation of that grammar. No value here is ever derived from input.
var projectionMetadataPaths = []string{ProjectionMarkerName, claudePluginManifestPath}

// writeProjectionMetadata writes one Barista-owned metadata file into a projection root this call's
// caller just created. A path outside the allowlist is refused, so there is no way to write an
// arbitrary path through this function even if a caller passed one.
func writeProjectionMetadata(root, path string, content []byte) error {
	if !slices.Contains(projectionMetadataPaths, path) {
		return fmt.Errorf("%q is not a Barista projection metadata path", path)
	}
	target := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, content, 0o644)
}

// readProjectionMarker reads the ownership marker at the root of an existing projection. A subtree
// whose marker is absent, unreadable, not a regular file, or malformed is foreign or corrupt — the
// caller must neither adopt nor clobber it.
func readProjectionMarker(root string) (ProjectionMarker, error) {
	path := filepath.Join(root, ProjectionMarkerName)
	information, err := os.Lstat(path)
	if err != nil {
		return ProjectionMarker{}, errors.New("the subtree carries no Barista ownership marker")
	}
	if !information.Mode().IsRegular() {
		return ProjectionMarker{}, errors.New("the subtree's ownership marker is not a regular file")
	}
	if information.Size() > maximumForeignSkillBytes {
		return ProjectionMarker{}, errors.New("the subtree's ownership marker is larger than any marker Barista writes")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ProjectionMarker{}, errors.New("the subtree's ownership marker could not be read")
	}
	return ParseProjectionMarker(data)
}

// inspectManagedPath classifies whatever already occupies the managed projection path. The three
// answers are distinct and none of them is ever confused with another: nothing is there, a
// Barista-owned projection is there and this is its marker, or something foreign is there and
// Barista must neither read it as its own nor replace it.
func inspectManagedPath(root string) (present bool, marker ProjectionMarker, err error) {
	information, statErr := os.Lstat(root)
	if errors.Is(statErr, fs.ErrNotExist) {
		return false, ProjectionMarker{}, nil
	}
	if statErr != nil {
		return true, ProjectionMarker{}, packUnavailablef("the managed capability pack projection path %s could not be inspected", root)
	}
	if information.Mode()&os.ModeSymlink != 0 {
		return true, ProjectionMarker{}, packUnavailablef("the managed capability pack projection path %s is a symlink, which Barista neither adopts nor replaces", root)
	}
	if !information.IsDir() {
		return true, ProjectionMarker{}, packUnavailablef("the managed capability pack projection path %s is not a directory, which Barista neither adopts nor replaces", root)
	}
	marker, markerErr := readProjectionMarker(root)
	if markerErr != nil {
		return true, ProjectionMarker{}, packUnavailablef("the managed capability pack projection path %s is not Barista-owned (%s), so Barista neither adopts nor replaces it", root, markerErr.Error())
	}
	return true, marker, nil
}

// replaceManagedProjection installs a complete new managed projection by writing it to a
// Barista-created sibling temporary path and renaming it into place. Nothing is ever mutated in
// place, there is no per-file or in-place fallback, and a failure anywhere leaves the previous
// complete projection exactly as it was and removes only the temporary path Barista created.
func replaceManagedProjection(parent, root string, pack ActivePack, metadata map[string][]byte, hooks projectionHooks) (*PackProjection, error) {
	information, err := os.Lstat(parent)
	if err != nil || information.Mode()&os.ModeSymlink != 0 || !information.IsDir() {
		return nil, packUnavailablef("the vendor skills root %s is not an existing directory, so Barista has nowhere it owns to project into", parent)
	}
	// Exactly one temporary sibling is created, and both of the paths a replacement needs live inside
	// it: the complete incoming subtree, and the slot the outgoing one is moved to. That is what keeps
	// the set of paths Barista ever creates in a vendor's skills root to the two acceptance criterion 9
	// names — the managed subtree and this one sibling — rather than a third.
	temporary := managedTemporarySibling(parent)
	incoming := filepath.Join(temporary, "incoming")
	outgoing := filepath.Join(temporary, "outgoing")
	// A leftover from an interrupted replacement is removed before the new one is written, never
	// adopted: it is by definition an incomplete or superseded subtree. Content at that reserved name
	// that is not Barista's is neither adopted nor clobbered, exactly as at the managed path itself.
	if err := removeBaristaTemporarySibling(temporary); err != nil {
		// A refusal here leaves whatever is already installed at the managed path in place. The caller's
		// chokepoint classifies that, so there is no per-site classification to get wrong.
		return nil, err
	}
	projection, err := writeProjection(incoming, pack, ProjectionManaged, metadata)
	if err != nil {
		os.RemoveAll(temporary)
		return nil, err
	}
	if hooks.beforeRename != nil {
		if hookErr := hooks.beforeRename(incoming); hookErr != nil {
			os.RemoveAll(temporary)
			return nil, fmt.Errorf("%w: the managed capability pack projection could not be atomically replaced: %s", ErrPackActivation, hookErr.Error())
		}
	}
	movedAside := false
	if _, statErr := os.Lstat(root); statErr == nil {
		if renameErr := os.Rename(root, outgoing); renameErr != nil {
			os.RemoveAll(temporary)
			return nil, fmt.Errorf("%w: the previous managed capability pack projection could not be moved aside, so it was left intact", ErrPackActivation)
		}
		movedAside = true
	}
	if renameErr := os.Rename(incoming, root); renameErr != nil {
		if movedAside {
			// Put the previous complete projection back; the operator's state is what it was.
			os.Rename(outgoing, root)
		}
		os.RemoveAll(temporary)
		return nil, fmt.Errorf("%w: the managed capability pack projection could not be atomically replaced, so the previous projection was left intact", ErrPackActivation)
	}
	if removeErr := os.RemoveAll(temporary); removeErr != nil {
		return nil, fmt.Errorf("%w: the previous managed capability pack projection could not be removed after the replacement succeeded", ErrPackActivation)
	}
	projection.Root = root
	return projection, nil
}

// managedTemporarySibling is the one Barista-created temporary path inside a vendor's skills root. It
// is derived from ManagedProjectionDirectory so the two names acceptance criterion 9 excludes share
// one definition.
func managedTemporarySibling(parent string) string {
	return filepath.Join(parent, ManagedProjectionDirectory+managedProjectionTemporarySuffix)
}

// projectionHooks are the injection points a test uses to interrupt a replacement exactly where a
// crash or a full disk would. Production passes the zero value.
type projectionHooks struct {
	beforeRename func(temporary string) error
}

// removeIfOwned removes a path Barista created, refusing to follow a symlink while cleaning and
// succeeding when the path is already gone.
func removeIfOwned(path string) error {
	information, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("the Barista-created path %s could not be inspected for removal", path)
	}
	if information.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("the Barista-created path %s is now a symlink and was not followed while cleaning", path)
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("the Barista-created path %s could not be removed", path)
	}
	return nil
}

// foreignSkillNames enumerates the skill names a vendor already offers from outside the managed
// subtree, so a projected name that collides with one is recorded rather than silently served. It
// reads a bounded number of bounded files, never follows a symlink, and never writes.
//
// name extracts the vendor's own key for one SKILL.md, because the two vendors disagree: one keys a
// skill by the directory it lives in and the other by the name its metadata declares.
func foreignSkillNames(root string, exclude []string, name func(directory string, content []byte) string) (map[string]string, error) {
	offered := map[string]string{}
	excluded := make([]string, 0, len(exclude))
	for _, path := range exclude {
		excluded = append(excluded, filepath.Clean(path))
	}
	files := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if slices.Contains(excluded, filepath.Clean(path)) {
			return fs.SkipDir
		}
		if entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		if !entry.Type().IsRegular() {
			// A non-regular entry is never read and never followed, and it is not silently ignored
			// either: a name Barista could not read is a name it cannot prove does not collide.
			return fmt.Errorf("the vendor skills root carries a SKILL.md that is not a regular file")
		}
		files++
		if files > maximumForeignSkillFiles {
			return fmt.Errorf("the vendor skills root carries more than %d skill documents", maximumForeignSkillFiles)
		}
		information, statErr := entry.Info()
		if statErr != nil {
			return statErr
		}
		if information.Size() > maximumForeignSkillBytes {
			return fmt.Errorf("the vendor skills root carries a skill document larger than %d bytes", maximumForeignSkillBytes)
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		key := name(filepath.Base(filepath.Dir(path)), content)
		if key == "" {
			return fmt.Errorf("the vendor skills root carries a skill document whose name could not be determined")
		}
		if _, seen := offered[key]; !seen {
			offered[key] = path
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	return offered, nil
}

// frontMatterName reads the name a SKILL.md's metadata block declares, leniently: the document was
// written by an operator, not by Barista, so it is read for one key and nothing else, and a document
// that declares none yields "" rather than an error the caller could mistake for absence.
func frontMatterName(content []byte) string {
	// Operator documents may be CRLF-authored. Carriage returns are removed before the block is read,
	// so a well-formed Windows-authored skill still yields its name instead of failing enumeration.
	text := strings.ReplaceAll(string(content), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return ""
	}
	remainder := text[4:]
	closing := strings.Index(remainder, "\n---")
	if closing < 0 {
		return ""
	}
	for _, line := range strings.Split(remainder[:closing], "\n") {
		key, value, separated := strings.Cut(line, ":")
		if !separated || strings.TrimSpace(key) != "name" {
			continue
		}
		return strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return ""
}

// removeBaristaTemporarySibling removes the one reserved temporary path inside a vendor's skills
// root, but only when it is Barista's. Because writeProjection writes the ownership marker before any
// content, every directory Barista ever creates there is identifiable as Barista's from the moment it
// exists, so an interrupted replacement is still recognized. Content at that reserved name that is
// not Barista's is neither adopted nor clobbered, exactly as at the managed path itself.
func removeBaristaTemporarySibling(temporary string) error {
	information, err := os.Lstat(temporary)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return packUnavailablef("the Barista temporary path %s could not be inspected", temporary)
	}
	if information.Mode()&os.ModeSymlink != 0 || !information.IsDir() {
		return packUnavailablef("the path %s reserved for Barista's atomic replacement is a symlink or not a directory, so Barista neither adopted nor replaced it", temporary)
	}
	entries, err := os.ReadDir(temporary)
	if err != nil {
		return packUnavailablef("the Barista temporary path %s could not be read", temporary)
	}
	for _, entry := range entries {
		if owned, _ := carriesOwnershipMarker(filepath.Join(temporary, entry.Name())); !owned {
			return packUnavailablef("the path %s reserved for Barista's atomic replacement holds content Barista did not write, so Barista neither adopted nor replaced it", temporary)
		}
	}
	if err := removeIfOwned(temporary); err != nil {
		return fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	return nil
}

// ReconcileManagedProjections repairs a managed projection an interrupted atomic replacement left
// behind, and is called once at daemon start and nowhere else. There is one unavoidable window in a
// POSIX directory replacement — between moving the outgoing subtree aside and renaming the incoming
// one into place — and a crash inside it leaves the managed path absent with both complete subtrees
// inside the one temporary sibling. Without this, a vendor that discovers skills recursively would
// keep offering both copies indefinitely.
//
// It restores the more recent of the two complete subtrees and removes the temporary sibling, and it
// touches nothing that does not carry Barista's ownership marker.
func ReconcileManagedProjections(environment []string) ([]string, error) {
	var repaired []string
	var failures []string
	for _, key := range managedProjectionRoots(environment) {
		parent, err := key.root(environment)
		if err != nil {
			// A vendor configuration root Barista cannot resolve has nothing for Barista to reconcile.
			continue
		}
		root := filepath.Join(parent, ManagedProjectionDirectory)
		temporary := managedTemporarySibling(parent)
		if _, err := os.Lstat(temporary); errors.Is(err, fs.ErrNotExist) {
			continue
		}
		incoming := filepath.Join(temporary, "incoming")
		outgoing := filepath.Join(temporary, "outgoing")
		_, rootErr := os.Lstat(root)
		// Only the two-rename window is repaired, and its signature is exact: the managed path is
		// absent and *both* slots are present. That is the only state in which the incoming subtree is
		// known to be complete, because a replacement writes it in full and confirms it before it moves
		// the outgoing subtree aside. A crash during the very first write leaves a marker-carrying but
		// incomplete incoming subtree and no outgoing one, and it is removed rather than installed: a
		// partial skill set is worse than none, and the next run establishes the projection in full.
		_, incomingErr := os.Lstat(incoming)
		_, outgoingErr := os.Lstat(outgoing)
		if errors.Is(rootErr, fs.ErrNotExist) && incomingErr == nil && outgoingErr == nil {
			restored := false
			for _, candidate := range []string{incoming, outgoing} {
				if owned, _ := carriesOwnershipMarker(candidate); !owned {
					continue
				}
				if renameErr := os.Rename(candidate, root); renameErr == nil {
					repaired = append(repaired, root)
					restored = true
					break
				}
			}
			if !restored {
				failures = append(failures, "the managed capability pack projection at "+root+" is absent and no complete Barista-owned subtree could be restored")
			}
		}
		if err := removeBaristaTemporarySibling(temporary); err != nil {
			failures = append(failures, err.Error())
		}
	}
	slices.Sort(repaired)
	if len(failures) > 0 {
		return repaired, errors.New(strings.Join(failures, "; "))
	}
	return repaired, nil
}

// managedProjectionRoots lists the vendor skills roots this build's managed adapters project into, in
// a stable order, so reconciliation covers exactly the adapters that ship and no path they do not use.
func managedProjectionRoots(environment []string) []managedRootResolver {
	resolvers := make([]managedRootResolver, 0, len(packActivationAdapters))
	seen := map[string]bool{}
	for key, adapter := range packActivationAdapters {
		if adapter.Shape != ProjectionManaged || seen[key.HarnessID] {
			continue
		}
		resolver, known := managedRootResolvers[key.HarnessID]
		if !known {
			continue
		}
		seen[key.HarnessID] = true
		resolvers = append(resolvers, resolver)
	}
	slices.SortFunc(resolvers, func(a, b managedRootResolver) int { return strings.Compare(a.harnessID, b.harnessID) })
	return resolvers
}

// managedRootResolver names how one harness's own skills root is resolved from a launch environment.
type managedRootResolver struct {
	harnessID string
	root      func([]string) (string, error)
}

// managedRootResolvers is the one mapping from a managed adapter to its vendor skills root. A managed
// adapter added without an entry here is simply not reconciled, never reconciled against a guessed
// path.
var managedRootResolvers = map[string]managedRootResolver{
	"codex-cli": {harnessID: "codex-cli", root: codexSkillsRoot},
}

// carriesOwnershipMarker reports whether path is a real directory whose subtree carries a Barista
// ownership marker, which is the only evidence that makes a leftover Barista's to remove. It never
// follows a symlink and reads a bounded number of bounded marker files.
func carriesOwnershipMarker(path string) (bool, string) {
	information, err := os.Lstat(path)
	if err != nil {
		return false, "it could not be inspected"
	}
	if information.Mode()&os.ModeSymlink != 0 {
		return false, "it is a symlink, which is never followed while cleaning"
	}
	if !information.IsDir() {
		return false, "it is not a directory Barista created"
	}
	owned := false
	inspected := 0
	filepath.WalkDir(path, func(candidate string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || owned {
			return nil
		}
		if entry.IsDir() || entry.Name() != ProjectionMarkerName || !entry.Type().IsRegular() {
			return nil
		}
		inspected++
		if inspected > maximumForeignSkillFiles {
			return fs.SkipAll
		}
		if _, err := readProjectionMarker(filepath.Dir(candidate)); err == nil {
			owned = true
		}
		return nil
	})
	if !owned {
		return false, "it carries no Barista ownership marker"
	}
	return true, ""
}

// reconcileStaleProjections removes run-scoped projections a crashed daemon left behind. It runs at
// daemon start and nowhere else, it only ever removes entries directly beneath the one Barista-owned
// run-scoped prefix, and it never follows a symlink. Managed projections are deliberately untouched:
// they are versioned, owned, and atomically replaced, so a stale one is replaced by the next
// establishment rather than deleted out from under a concurrently starting run.
func ReconcileStaleProjections(dataRoot string) ([]string, error) {
	if !filepath.IsAbs(dataRoot) {
		return nil, errors.New("the Barista data root must be an absolute path")
	}
	prefix := filepath.Join(dataRoot, RunScopedProjectionDirectory)
	entries, err := os.ReadDir(prefix)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	removed := make([]string, 0, len(entries))
	var failures []string
	for _, entry := range entries {
		path := filepath.Join(prefix, entry.Name())
		// Only a directory that actually carries Barista's ownership marker is removed. Anything else
		// under the prefix — a file an operator left there, a directory Barista did not write, a
		// symlink — is retained and reported, because Barista never deletes a path it did not create.
		owned, reason := carriesOwnershipMarker(path)
		if !owned {
			failures = append(failures, fmt.Sprintf("%s was retained because %s", path, reason))
			continue
		}
		if err := removeIfOwned(path); err != nil {
			failures = append(failures, err.Error())
			continue
		}
		removed = append(removed, path)
	}
	slices.Sort(removed)
	if len(failures) > 0 {
		return removed, errors.New(strings.Join(failures, "; "))
	}
	return removed, nil
}
