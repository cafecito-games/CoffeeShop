package harness

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// codexSkillsDirectory is the single segment beneath the Codex configuration home that Codex 0.147.0
// — exactly the pinned version — discovers skills under. Verified from the shipped binary's own
// strings, which name `$CODEX_HOME/skills`, `${CODEX_HOME:-$HOME/.codex}/skills`, and `~/.codex/skills`
// as the discovery roots, and confirmed by running the binary (see codexManagedSkillsAdapter).
const codexSkillsDirectory = "skills"

// codexHomeVariable and homeVariable are how Codex resolves its own configuration home, in that
// order. Barista reads them from the environment the child will actually launch with so the
// projection is written under exactly the root the run will read.
const (
	codexHomeVariable = "CODEX_HOME"
	homeVariable      = "HOME"
)

// codexDefaultHomeDirectory is the segment Codex appends to $HOME when CODEX_HOME is unset.
const codexDefaultHomeDirectory = ".codex"

// packDiscoveryTimeout bounds one discovery confirmation. An unconfirmable discovery within the
// bound fails exactly like a discovery that never happened.
const packDiscoveryTimeout = 60 * time.Second

// maximumInventoryBytes bounds what a vendor inventory command may return before it is refused. The
// output is untrusted once it is parsed for a decision.
const maximumInventoryBytes = 4 << 20

// codexManagedSkillsAdapter drives the managed Barista-owned subtree beneath the Codex configuration
// home's own skills root, because Codex 0.147.0 offers no session-only skill surface at all.
//
// Surface verification, against the installed codex-cli 0.147.0 — exactly the pinned version:
//
//   - `codex exec --help` exposes no skills or plugin root flag;
//   - `codex exec --strict-config -c 'skills.roots=["/tmp/x"]' 'hi'` fails with
//     "Error loading config.toml: unknown configuration field `skills.roots` in -c/--config override",
//     so there is no configuration key either;
//   - `codex plugin` (add/list/marketplace/remove) is marketplace-snapshot based and mutates local
//     configuration, so it is not a run-scoped projection surface;
//   - the only discovery roots the binary names are `$CODEX_HOME/skills` and `<project>/.codex/skills`,
//     and the project root is rejected because it would dirty the operator's git working tree.
//
// Nesting and precedence were both read from real output rather than assumed. With a skill at
// `$CODEX_HOME/skills/coffee-shop-barista/<id>/SKILL.md`, `codex debug prompt-input 'hi'` lists it,
// so the managed subtree is discovered recursively. With the same name offered from inside and from
// outside the subtree, that same command lists *both* entries, with no de-duplication and no visible
// precedence — so for this version the effective winner of a collision cannot be confirmed, and a
// pack-required run with a collision is refused rather than served an operator's skill under a Coffee
// Shop skill's name.
//
// The same command established that Codex keys a skill by the name its SKILL.md metadata declares,
// not by the directory it occupies — the opposite of Claude. A directory named `dirname-alpha` whose
// metadata declared `name: frontmatter-beta` was listed as `frontmatter-beta`.
func codexManagedSkillsAdapter() packActivationAdapter {
	return packActivationAdapter{
		Surface: "$CODEX_HOME/skills/" + ManagedProjectionDirectory + " (managed, verified on codex-cli 0.147.0)",
		Shape:   ProjectionManaged,
		Project: projectCodexManagedSkills,
		Confirm: confirmCodexSkillDiscovery,
	}
}

// codexSkillsRoot resolves the vendor's own skills root from the environment the child will launch
// with, exactly as Codex resolves it. A relative or absent root is refused rather than guessed.
func codexSkillsRoot(environment []string) (string, error) {
	home := environmentValue(environment, codexHomeVariable)
	if home == "" {
		userHome := environmentValue(environment, homeVariable)
		if userHome == "" {
			return "", errors.New("neither CODEX_HOME nor HOME is set, so the Codex skills root cannot be resolved")
		}
		home = filepath.Join(userHome, codexDefaultHomeDirectory)
	}
	if !filepath.IsAbs(home) {
		return "", errors.New("the Codex configuration home is not an absolute path")
	}
	return filepath.Join(filepath.Clean(home), codexSkillsDirectory), nil
}

func environmentValue(environment []string, name string) string {
	for index := len(environment) - 1; index >= 0; index-- {
		key, value, separated := strings.Cut(environment[index], "=")
		if separated && key == name {
			return value
		}
	}
	return ""
}

func projectCodexManagedSkills(projectionContext packProjectionContext) (*PackProjection, error) {
	pack := projectionContext.Pack
	parent, err := codexSkillsRoot(projectionContext.Environment)
	if err != nil {
		return nil, packUnavailablef("%s", err.Error())
	}
	root := filepath.Join(parent, ManagedProjectionDirectory)

	established, release := projectionContext.established.begin("codex-cli")
	projection, err := establishManagedProjection(parent, root, pack, established, projectionContext.hooks)
	if err != nil {
		release("")
		return nil, err
	}
	release(pack.Identity())

	names, err := pack.SkillNamesByDirectory()
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	// Codex keys a skill by the name its metadata declares, so those are the names a collision is
	// enumerated against.
	declared := make([]string, 0, len(names))
	for _, name := range names {
		declared = append(declared, name)
	}
	slices.Sort(declared)
	projection.SkillNames = declared

	collisions, err := codexSkillCollisions(parent, root, declared)
	if err != nil {
		return nil, err
	}
	projection.Collisions = collisions
	// The managed projection is shared by every run of this daemon lifetime, so a run never removes
	// it. The only path a run's cleanup may remove is the Barista-created temporary sibling, which a
	// successful replacement already consumed and a failed one already removed.
	projection.cleanup = func() error {
		return removeIfOwned(filepath.Join(parent, ManagedProjectionDirectory+managedProjectionTemporarySuffix))
	}
	return projection, nil
}

// establishManagedProjection writes the managed projection the first time this daemon needs it and
// reuses it every later time. Reuse performs no write at all — not one file inside a live projection
// is ever opened for writing — and it requires the marker to still record exactly the identity this
// daemon established, so foreign or stale content refuses the run instead of being served.
func establishManagedProjection(parent, root string, pack ActivePack, established string, hooks projectionHooks) (*PackProjection, error) {
	present, marker, err := inspectManagedPath(root)
	if err != nil {
		return nil, err
	}
	if established != "" {
		// This daemon already wrote its projection. A marker that no longer records that identity
		// means something else changed the subtree while runs were live.
		if !present || marker.Identity() != established {
			return nil, packUnavailablef("the managed capability pack projection at %s no longer records the pack this Barista established, so it was not re-projected under live runs", root)
		}
		if !marker.Current() {
			return nil, packUnavailablef("the managed capability pack projection at %s records projection generation %s, which this Barista does not recognise", root, marker.ProjectionSchemaVersion)
		}
		return &PackProjection{Shape: ProjectionManaged, Root: root, Files: pack.Tree.Paths(), Metadata: []string{ProjectionMarkerName}}, nil
	}
	// The first establishment of this daemon lifetime replaces whatever Barista-owned projection is
	// there — including one of another pack version or an unrecognized generation, which is replaced
	// wholesale rather than merged. A subtree that is not Barista-owned never reaches here:
	// inspectManagedPath already refused it without reading or replacing it.
	_ = present
	_ = marker
	return replaceManagedProjection(parent, root, pack, nil, hooks)
}

// codexSkillCollisions records every projected skill name Codex already offers from outside the
// managed subtree, with the effective winner precedence verification established. For codex-cli
// 0.147.0 that winner is unconfirmable — the CLI lists both colliding entries with no
// de-duplication and no visible precedence — so the winner is left empty and the caller treats the
// run as unconfirmed discovery. Precedence is never assumed from ordering.
func codexSkillCollisions(parent, root string, projected []string) ([]SkillCollision, error) {
	temporary := filepath.Join(parent, ManagedProjectionDirectory+managedProjectionTemporarySuffix)
	offered, err := foreignSkillNames(parent, []string{root, temporary}, func(_ string, content []byte) string {
		return frontMatterName(content)
	})
	if err != nil {
		return nil, packUnavailablef("the Codex skills root could not be enumerated for skill name collisions, so precedence is unconfirmed: %s", err.Error())
	}
	collisions := make([]SkillCollision, 0, len(projected))
	for _, name := range projected {
		if path, colliding := offered[name]; colliding {
			collisions = append(collisions, SkillCollision{Name: name, Offered: path})
		}
	}
	return collisions, nil
}

// confirmCodexSkillDiscovery asks the same executable the run will launch which skills it resolved,
// using its own offline prompt-input rendering, and requires every projected SKILL.md's absolute
// path to appear. Matching on the path rather than the name is what proves the file Barista wrote is
// the file Codex resolved.
func confirmCodexSkillDiscovery(ctx context.Context, projectionContext packProjectionContext, projection *PackProjection) error {
	output, err := runVendorInventory(ctx, projectionContext, []string{"debug", "prompt-input", "list the available skills"})
	if err != nil {
		return packUnavailablef("the Codex CLI could not confirm that it resolved the projected capability pack skills: %s", err.Error())
	}
	for _, skill := range projectionContext.Pack.Manifest.Skills {
		path := filepath.Join(projection.Root, filepath.FromSlash(skill.Path))
		if !strings.Contains(output, path) {
			return packUnavailablef("the Codex CLI did not resolve the projected capability pack skill at %s, so pack discovery is unconfirmed", path)
		}
	}
	return nil
}

// runVendorInventory runs one vendor inventory command against the executable this run will launch.
// It is read-only by construction — both commands were verified to leave a fake HOME byte-for-byte
// unchanged — is bounded in time and output, inherits the launch environment so it reads the same
// configuration root the run will, and is never given the run's MCP token.
func runVendorInventory(ctx context.Context, projectionContext packProjectionContext, arguments []string) (string, error) {
	if projectionContext.Binary == "" {
		return "", errors.New("the harness has no resolved executable to confirm discovery with")
	}
	if projectionContext.inventory != nil {
		return projectionContext.inventory(ctx, projectionContext.Binary, arguments)
	}
	directory, err := os.MkdirTemp(projectionContext.DataRoot, "barista-pack-confirm-")
	if err != nil {
		return "", errors.New("a Barista-owned working directory for the discovery confirmation could not be created")
	}
	defer os.RemoveAll(directory)
	bounded, cancel := context.WithTimeout(ctx, packDiscoveryTimeout)
	defer cancel()
	command := exec.CommandContext(bounded, projectionContext.Binary, arguments...)
	configureProcessCancellation(command)
	command.Dir = directory
	command.Env = projectionContext.Environment
	// Output is bounded as it arrives, not after the fact: the command's stdout is untrusted once it
	// is parsed for a decision, and an unbounded read would be a memory bound the tool controls.
	output := &boundedBuffer{limit: maximumInventoryBytes}
	command.Stdout = output
	command.Stderr = &boundedBuffer{limit: maximumInventoryBytes}
	if err := command.Run(); err != nil {
		return "", errors.New("the vendor inventory command did not complete")
	}
	if output.exceeded {
		return "", errors.New("the vendor inventory command returned more output than Barista reads")
	}
	return output.buffer.String(), nil
}

// boundedBuffer collects at most limit bytes and records that more arrived, so a vendor command that
// floods stdout is refused rather than buffered without bound.
type boundedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

func (bounded *boundedBuffer) Write(data []byte) (int, error) {
	remaining := bounded.limit - bounded.buffer.Len()
	if len(data) > remaining {
		bounded.exceeded = true
		if remaining > 0 {
			bounded.buffer.Write(data[:remaining])
		}
		return len(data), nil
	}
	bounded.buffer.Write(data)
	return len(data), nil
}
