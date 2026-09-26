package harness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// packFixtureRoot is the repository's own capability pack tree. Every projection test below is driven
// by the bytes the real deterministic packer emits from it, not by a hand-written approximation, so a
// change to the canonical pack is a change these tests see.
const packFixtureRoot = "../../../../capability-pack"

// packFixture builds the active pack exactly as the daemon resolves one: the real tree, through the
// real packer, expanded through the real archive reader, digested by the real digest function.
func packFixture(t *testing.T) (ActivePack, []byte) {
	t.Helper()
	tree, err := capabilitypack.ReadTree(packFixtureRoot)
	require.NoError(t, err)
	archive, manifest, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	require.NoError(t, err)
	expanded, err := capabilitypack.ArchiveTree(archive)
	require.NoError(t, err)
	digest := capabilitypack.ArchiveDigest(archive)
	pack := ActivePack{
		ID: manifest.ID, Version: manifest.Version, ArchiveDigest: digest,
		Manifest: manifest, Tree: expanded, Build: "barista-test-build",
		Reread: func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
			return expanded, manifest, digest, nil
		},
	}
	return pack, archive
}

// confirmingInventory stands in for the vendor inventory subprocess and reports exactly what is on
// disk beneath roots, in both vendors' output shapes. A unit test may not execute a vendor CLI or
// reach the network, so the real commands are held to checked-in recordings of their real output in
// TestDiscoveryConfirmersAcceptRealVendorOutput instead.
func confirmingInventory(roots ...string) func(context.Context, string, []string) (string, error) {
	return func(context.Context, string, []string) (string, error) {
		var paths, names []string
		for _, root := range roots {
			filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
				if err != nil || entry.IsDir() || entry.Name() != "SKILL.md" {
					return nil
				}
				paths = append(paths, path)
				names = append(names, filepath.Base(filepath.Dir(path)))
				return nil
			})
		}
		slices.Sort(names)
		return fmt.Sprintf("Skills (%d)  %s\n%s\n", len(names), strings.Join(names, ", "), strings.Join(paths, "\n")), nil
	}
}

// fakeHarnessBinary is a vendor CLI stand-in that records its argument list and environment and then
// emits one terminal event in its vendor's own stream shape. A run that never launched leaves no
// record at all, which is how "the prompt was never sent" is asserted.
func fakeHarnessBinary(t *testing.T, harnessID string) (binary string, record string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the harness fixture is a shell script")
	}
	directory := t.TempDir()
	record = filepath.Join(directory, "invocation")
	event := `{"type":"result","result":"done"}`
	if harnessID == "codex-cli" {
		event = `{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`
	}
	binary = filepath.Join(directory, "fake-"+harnessID)
	script := "#!/bin/sh\n" +
		"for argument in \"$@\"; do printf '%s\\n' \"$argument\"; done > " + record + ".args\n" +
		"env > " + record + ".env\n" +
		"printf '%s\\n' '" + event + "'\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	return binary, record
}

// packTestRunner wires a Runner exactly as the daemon does, with the vendor inventory replaced.
func packTestRunner(t *testing.T, harnessID, binary, dataRoot string, pack *ActivePack, unavailable string, requirement PackRequirement, confirmRoots ...string) (*Runner, *[]string) {
	t.Helper()
	lines := &[]string{}
	runner := NewRunner([]protocol.HarnessProfile{{ID: harnessID, Binary: binary, Available: true}}).
		WithCapabilityPack(pack, unavailable, requirement, dataRoot).
		WithCapabilityPackReport(func(line string) { *lines = append(*lines, line) })
	runner.packInventory = confirmingInventory(confirmRoots...)
	return runner, lines
}

// fakeVendorHome installs a fake HOME with a $CODEX_HOME that looks like a real one, including the
// two files Barista must never touch. No test ever reads the developer's own ~/.codex or ~/.claude.
func fakeVendorHome(t *testing.T) (home string, codexHome string, skillsRoot string) {
	t.Helper()
	home = t.TempDir()
	codexHome = filepath.Join(home, ".codex")
	skillsRoot = filepath.Join(codexHome, "skills")
	require.NoError(t, os.MkdirAll(filepath.Join(skillsRoot, "operator-skill"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte(`{"tokens":{"id_token":"fixture"}}`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model = \"gpt-5\"\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(skillsRoot, "operator-skill", "SKILL.md"),
		[]byte("---\nname: operator-skill\ndescription: An operator's own skill that Barista never touches.\n---\n\nBody.\n"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".claude", "skills"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"installMethod":"fixture"}`), 0o644))
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	return home, codexHome, skillsRoot
}

// snapshotTree records every file's path, mode, and content digest beneath root, which is what a
// byte-for-byte comparison of vendor configuration is made of.
func snapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		information, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			snapshot[relative] = fmt.Sprintf("dir %04o", information.Mode().Perm())
			return nil
		}
		if !information.Mode().IsRegular() {
			snapshot[relative] = fmt.Sprintf("irregular %s", information.Mode().String())
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(content)
		snapshot[relative] = fmt.Sprintf("file %04o %s", information.Mode().Perm(), hex.EncodeToString(digest[:]))
		return nil
	})
	require.NoError(t, err)
	return snapshot
}

// withoutPrefixes removes every snapshot entry under the given relative prefixes, which is how the
// one named Barista-owned subtree and its temporary sibling are excluded from the comparison.
func withoutPrefixes(snapshot map[string]string, prefixes ...string) map[string]string {
	remaining := map[string]string{}
	for path, value := range snapshot {
		excluded := false
		for _, prefix := range prefixes {
			if path == prefix || strings.HasPrefix(path, prefix+string(filepath.Separator)) {
				excluded = true
			}
		}
		if !excluded {
			remaining[path] = value
		}
	}
	return remaining
}

func packRun(harnessID string) protocol.Run {
	return protocol.Run{ID: "run-pack-1", HarnessID: harnessID, Model: "default", Prompt: "do the thing", Transport: TransportNative}
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: the projection is produced from the active archive and nothing else.
// ---------------------------------------------------------------------------

func TestProjectionMatchesActiveArchiveTree(t *testing.T) {
	pack, archive := packFixture(t)
	dataRoot := t.TempDir()
	expected, err := capabilitypack.ArchiveTree(archive)
	require.NoError(t, err)

	for _, shape := range []struct {
		name     string
		project  func(packProjectionContext) (*PackProjection, error)
		metadata []string
		prepare  func(t *testing.T) []string
	}{
		{
			name: "claude run-scoped", project: projectClaudePluginDirectory,
			metadata: []string{ProjectionMarkerName, claudePluginManifestPath},
			prepare:  func(*testing.T) []string { return nil },
		},
		{
			name: "codex managed", project: projectCodexManagedSkills,
			metadata: []string{ProjectionMarkerName},
			prepare: func(t *testing.T) []string {
				_, _, skillsRoot := fakeVendorHome(t)
				return []string{"CODEX_HOME=" + filepath.Dir(skillsRoot)}
			},
		},
	} {
		t.Run(shape.name, func(t *testing.T) {
			environment := shape.prepare(t)
			projection, err := shape.project(packProjectionContext{
				Pack: pack, RunID: "run-pack-1", DataRoot: dataRoot,
				Environment: environment, established: newEstablishedProjections(),
			})
			require.NoError(t, err)
			t.Cleanup(func() { projection.Cleanup() })

			// The pack content in the projection equals the archive tree exactly: every byte of every
			// file, and the whole path set, which is PackManifest.Files plus pack.json.
			declared := []string{capabilitypack.PackManifestPath}
			for _, file := range pack.Manifest.Files {
				declared = append(declared, file.Path)
			}
			slices.Sort(declared)
			require.Equal(t, declared, expected.Paths(), "the archive tree is the manifest's files plus pack.json")

			projected := map[string][]byte{}
			require.NoError(t, filepath.WalkDir(projection.Root, func(path string, entry fs.DirEntry, err error) error {
				if err != nil || entry.IsDir() {
					return err
				}
				relative, err := filepath.Rel(projection.Root, path)
				if err != nil {
					return err
				}
				content, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				projected[filepath.ToSlash(relative)] = content
				return nil
			}))
			// Barista's own metadata is enumerated, never open-ended: the ownership marker every
			// projection carries, plus the vendor manifest the shape requires.
			require.ElementsMatch(t, shape.metadata, projection.Metadata)
			for _, path := range shape.metadata {
				require.Contains(t, projected, path)
				delete(projected, path)
			}
			require.Equal(t, declared, slices.Sorted(mapKeys(projected)), "projected pack content is the archive tree's path set")
			for path, content := range projected {
				require.Equal(t, expected[path], content, "projected %s does not equal the archive entry", path)
			}
		})
	}
}

func mapKeys[V any](values map[string]V) func(func(string) bool) {
	return func(yield func(string) bool) {
		for key := range values {
			if !yield(key) {
				return
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Acceptance criterion 2: cross-harness, cross-transport pack parity.
// ---------------------------------------------------------------------------

func TestPackParityAcrossHarnessAndTransport(t *testing.T) {
	pack, _ := packFixture(t)
	identity := pack.Identity()
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		for _, transport := range []string{TransportNative, TransportACP} {
			t.Run(harnessID+"/"+transport, func(t *testing.T) {
				_, _, skillsRoot := fakeVendorHome(t)
				dataRoot := t.TempDir()
				binary, _ := fakeHarnessBinary(t, harnessID)
				runner, lines := packTestRunner(t, harnessID, binary, dataRoot, &pack, "", PackOptional, dataRoot, skillsRoot)
				invocation := Invocation{Run: packRun(harnessID), Workspace: dataRoot, packEnvironment: os.Environ()}
				projection, err := runner.activatePack(context.Background(), invocation, transport, binary)
				require.NoError(t, err)
				t.Cleanup(func() { projection.Cleanup() })
				adapter, registered := packAdapterFor(harnessID, transport)
				if !registered {
					// acp-v1 ships no adapter for either harness, because neither ACP adapter's
					// skill-discovery surface has been verified. The pack is still the same one; the
					// run simply gets no projection and says so.
					require.Nil(t, projection)
					require.Contains(t, strings.Join(*lines, "\n"), "no Coffee Shop capability pack")
					return
				}
				require.NotNil(t, projection)
				require.Equal(t, adapter.Shape, projection.Shape)
				marker, err := readProjectionMarker(projection.Root)
				require.NoError(t, err)
				// Every shipped adapter binds the run to exactly the same id@version@digest.
				require.Equal(t, identity, marker.Identity())
				require.Contains(t, strings.Join(*lines, "\n"), pack.ArchiveDigest)
			})
		}
	}
}

// ---------------------------------------------------------------------------
// Acceptance criteria 3, 4 and 18: nothing reaches the prompt without the guarantee.
// ---------------------------------------------------------------------------

func TestPackRequiredRunWithoutAdapterFailsBeforePrompt(t *testing.T) {
	pack, _ := packFixture(t)
	dataRoot := t.TempDir()
	fakeVendorHome(t)
	binary, record := fakeHarnessBinary(t, "claude-cli")
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackRequired, dataRoot)
	runner.acp = NewACPDriver(ACPDriverOptions{})

	var events []protocol.HarnessEvent
	var started []protocol.RunTransportSelection
	run := packRun("claude-cli")
	run.Transport = TransportACP
	_, err := runner.Execute(context.Background(), Invocation{
		Run: run, Workspace: dataRoot,
		Events:  func(event protocol.HarnessEvent) { events = append(events, event) },
		Started: func(selection protocol.RunTransportSelection) { started = append(started, selection) },
	})
	require.Error(t, err)
	// The ACP driver is unavailable before the pack gate is even reached here, which is still a
	// refusal before the prompt. The pack gate's own refusal is proven directly below.
	require.Empty(t, started)
	require.NoFileExists(t, record+".args", "the harness must never have been launched")

	// Directly at the gate, with the transport settled, the reason names the missing adapter.
	_, gateErr := runner.activatePack(context.Background(), Invocation{
		Run: run, Workspace: dataRoot, Events: func(event protocol.HarnessEvent) { events = append(events, event) },
	}, TransportACP, "")
	require.ErrorIs(t, gateErr, ErrPackActivation)
	require.Contains(t, gateErr.Error(), "no capability pack activation adapter ships for harness claude-cli over transport acp-v1")
	require.Contains(t, gateErr.Error(), "no skill-discovery surface has been verified")
	require.Len(t, events, 1)
	require.Equal(t, "warning", events[0].Type)
	require.Equal(t, warningCapabilityPackUnavailable, events[0].Code)
}

func TestUnverifiedSurfaceHasNoAdapter(t *testing.T) {
	// Only combinations whose surface this issue records as verified may have an adapter. Both ACP
	// adapters are absent from this checkout, so no surface has been read from either and neither may
	// appear here — and neither may be inferred from the native transport of the same harness.
	require.Equal(t, [][2]string{
		{"claude-cli", TransportNative},
		{"codex-cli", TransportNative},
	}, PackReadyCombinations())
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		_, registered := packAdapterFor(harnessID, TransportACP)
		require.False(t, registered, "%s over acp-v1 must ship no activation adapter", harnessID)
		adapter, nativeRegistered := packAdapterFor(harnessID, TransportNative)
		require.True(t, nativeRegistered)
		require.NotEmpty(t, adapter.Surface, "a shipped adapter must name the surface it was verified against")
		require.NoError(t, adapter.Shape.Validate())
		require.NotNil(t, adapter.Project)
		require.NotNil(t, adapter.Confirm, "a shipped adapter must confirm discovery rather than assume it")
	}

	// A pack-required run there is refused before the prompt; a pack-optional one proceeds unskilled.
	pack, _ := packFixture(t)
	dataRoot := t.TempDir()
	for _, requirement := range PackRequirements {
		runner, lines := packTestRunner(t, "codex-cli", "", dataRoot, &pack, "", requirement, dataRoot)
		projection, err := runner.activatePack(context.Background(), Invocation{Run: packRun("codex-cli")}, TransportACP, "")
		require.Nil(t, projection)
		if requirement == PackRequired {
			require.ErrorIs(t, err, ErrPackActivation)
			continue
		}
		require.NoError(t, err)
		require.Contains(t, strings.Join(*lines, "\n"), "proceeds with no Coffee Shop capability pack")
	}
}

func TestProjectionFailureFailsBeforePrompt(t *testing.T) {
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "claude-cli")
	// A data root that is a regular file makes every projection write fail. A write failure refuses
	// the run whatever the requirement, because Barista already committed to projecting.
	brokenRoot := filepath.Join(dataRoot, "not-a-directory")
	require.NoError(t, os.WriteFile(brokenRoot, []byte("x"), 0o644))
	for _, requirement := range PackRequirements {
		runner, _ := packTestRunner(t, "claude-cli", binary, brokenRoot, &pack, "", requirement, dataRoot)
		var started []protocol.RunTransportSelection
		_, err := runner.Execute(context.Background(), Invocation{
			Run: packRun("claude-cli"), Workspace: dataRoot,
			Started: func(selection protocol.RunTransportSelection) { started = append(started, selection) },
		})
		require.ErrorIs(t, err, ErrPackActivation, "requirement %s", requirement)
		require.Empty(t, started, "the transport must never be announced as started")
		require.NoFileExists(t, record+".args", "the harness must never have been launched")
	}
}

func TestUnconfirmedDiscoveryFailsBeforePrompt(t *testing.T) {
	pack, _ := packFixture(t)
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		for _, inventory := range []struct {
			name string
			run  func(context.Context, string, []string) (string, error)
		}{
			{"command failed", func(context.Context, string, []string) (string, error) {
				return "", errors.New("exit status 1")
			}},
			{"skills not listed", func(context.Context, string, []string) (string, error) {
				return "Skills (0)\n", nil
			}},
		} {
			t.Run(harnessID+"/"+inventory.name, func(t *testing.T) {
				_, _, skillsRoot := fakeVendorHome(t)
				dataRoot := t.TempDir()
				binary, record := fakeHarnessBinary(t, harnessID)
				runner, lines := packTestRunner(t, harnessID, binary, dataRoot, &pack, "", PackRequired, dataRoot)
				runner.packInventory = inventory.run
				var started []protocol.RunTransportSelection
				_, err := runner.Execute(context.Background(), Invocation{
					Run: packRun(harnessID), Workspace: dataRoot,
					Started: func(selection protocol.RunTransportSelection) { started = append(started, selection) },
				})
				require.ErrorIs(t, err, ErrPackActivation)
				require.Contains(t, err.Error(), "unconfirmed")
				require.Empty(t, started)
				require.NoFileExists(t, record+".args")
				require.Contains(t, strings.Join(*lines, "\n"), "activation refused")

				// A pack-optional run on the same unconfirmable discovery proceeds unskilled and says so,
				// and the run-scoped projection this attempt created is gone.
				optional, optionalLines := packTestRunner(t, harnessID, binary, dataRoot, &pack, "", PackOptional, dataRoot)
				optional.packInventory = inventory.run
				result, err := optional.Execute(context.Background(), Invocation{Run: packRun(harnessID), Workspace: dataRoot})
				require.NoError(t, err)
				require.Equal(t, "done", result)
				// A pack-optional run is reported as the thing it actually is. For the run-scoped shape the
				// projection is gone, so the run is unskilled. For the managed shape the projection stays
				// installed in the vendor's own configuration and the run still discovers it, so calling it
				// unskilled would be false and it is reported as unconfirmed instead.
				reported := strings.Join(*optionalLines, "\n")
				if adapter, _ := packAdapterFor(harnessID, TransportNative); adapter.Shape == ProjectionManaged {
					require.Contains(t, reported, "activation "+string(PackUnconfirmed))
					require.Contains(t, reported, "still installed and its guarantee unconfirmed")
					require.NotContains(t, reported, "proceeds with no Coffee Shop capability pack")
					require.DirExists(t, filepath.Join(skillsRoot, ManagedProjectionDirectory))
				} else {
					require.Contains(t, reported, "activation "+string(PackUnskilled))
					require.Contains(t, reported, "proceeds with no Coffee Shop capability pack")
				}
				require.NoDirExists(t, filepath.Join(dataRoot, RunScopedProjectionDirectory, "run-pack-1"))
			})
		}
	}
}

// ---------------------------------------------------------------------------
// Acceptance criteria 5 and 7: integrity failures are distinct and never projected.
// ---------------------------------------------------------------------------

func TestTamperedActivePackRefused(t *testing.T) {
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "claude-cli")
	pack.Reread = func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		// The bytes still validate, but they are not the bytes Barista verified at startup.
		return pack.Tree, pack.Manifest, strings.Repeat("0", 64), nil
	}
	// A tampered pack refuses whatever the node's requirement: integrity is not a policy question.
	for _, requirement := range PackRequirements {
		runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", requirement, dataRoot)
		_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
		require.ErrorIs(t, err, ErrPackActivation)
		require.Contains(t, err.Error(), "bytes changed after Barista verified them")
		require.NoFileExists(t, record+".args")
		require.NoDirExists(t, filepath.Join(dataRoot, RunScopedProjectionDirectory))
	}
}

func TestMalformedActiveArchiveRefused(t *testing.T) {
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "claude-cli")
	pack.Reread = func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		// The validator's own bounded reason, as ValidateArchive would produce it.
		_, err := capabilitypack.ArchiveTree([]byte("not a gzip stream"))
		require.Error(t, err)
		return nil, capabilitypack.PackManifest{}, "", err
	}
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackRequired, dataRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
	require.ErrorIs(t, err, ErrPackActivation)
	require.Contains(t, err.Error(), "no longer verifies")
	require.NotContains(t, err.Error(), "bytes changed", "a malformed archive is its own reason, never the tampered one")
	require.NoFileExists(t, record+".args")
	require.NoDirExists(t, filepath.Join(dataRoot, RunScopedProjectionDirectory))
}

func TestArchiveIdentityMismatchRefused(t *testing.T) {
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "claude-cli")
	for _, drift := range []struct {
		name  string
		apply func(capabilitypack.PackManifest) capabilitypack.PackManifest
	}{
		{"pack id", func(manifest capabilitypack.PackManifest) capabilitypack.PackManifest {
			manifest.ID = "some-other-pack"
			return manifest
		}},
		{"pack version", func(manifest capabilitypack.PackManifest) capabilitypack.PackManifest {
			manifest.Version = "9.9.9"
			return manifest
		}},
	} {
		t.Run(drift.name, func(t *testing.T) {
			drifted := pack
			drifted.Reread = func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
				return pack.Tree, drift.apply(pack.Manifest), pack.ArchiveDigest, nil
			}
			runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &drifted, "", PackRequired, dataRoot)
			_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
			require.ErrorIs(t, err, ErrPackActivation)
			require.NoFileExists(t, record+".args")
			require.NoDirExists(t, filepath.Join(dataRoot, RunScopedProjectionDirectory))
		})
	}
}

func TestIncompatiblePackRefused(t *testing.T) {
	// Incompatibility is refused by the one validator, before any projection code sees the pack: the
	// resolution that produces an ActivePack cannot succeed for an incompatible or drifted pack.
	tree, err := capabilitypack.ReadTree(packFixtureRoot)
	require.NoError(t, err)
	for _, incompatible := range []struct {
		name  string
		apply func(capabilitypack.PackManifest) capabilitypack.PackManifest
	}{
		{"newer control protocol generation", func(manifest capabilitypack.PackManifest) capabilitypack.PackManifest {
			manifest.MinimumControlProtocolVersion = "99"
			return manifest
		}},
		{"drifted tool vocabulary", func(manifest capabilitypack.PackManifest) capabilitypack.PackManifest {
			manifest.ToolVocabulary = append([]string{"renamed_tool"}, manifest.ToolVocabulary...)
			return manifest
		}},
	} {
		t.Run(incompatible.name, func(t *testing.T) {
			manifest, err := capabilitypack.ParsePackManifest(tree[capabilitypack.PackManifestPath])
			require.NoError(t, err)
			edited, err := json.Marshal(incompatible.apply(manifest))
			require.NoError(t, err)
			broken := capabilitypack.Tree{}
			for path, content := range tree {
				broken[path] = content
			}
			broken[capabilitypack.PackManifestPath] = edited
			_, err = capabilitypack.Validate(broken, capabilitypack.DefaultVocabulary())
			require.Error(t, err)
		})
	}

	// And a Reread that reports the validator's refusal refuses the run without projecting.
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "claude-cli")
	pack.Reread = func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		return nil, capabilitypack.PackManifest{}, "", errors.New("pack manifest requires control protocol generation \"99\"")
	}
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackOptional, dataRoot)
	_, err = runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
	require.ErrorIs(t, err, ErrPackActivation)
	require.NoFileExists(t, record+".args")
	require.NoDirExists(t, filepath.Join(dataRoot, RunScopedProjectionDirectory))
}

// ---------------------------------------------------------------------------
// Acceptance criterion 8: the projection carries no endpoint and no token.
// ---------------------------------------------------------------------------

func TestProjectionCarriesNoEndpointOrToken(t *testing.T) {
	pack, _ := packFixture(t)
	const url = "http://127.0.0.1:55555/mcp/run-pack-1"
	const token = "coffee-shop-run-token-abcdef0123456789"
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		t.Run(harnessID, func(t *testing.T) {
			_, _, skillsRoot := fakeVendorHome(t)
			dataRoot := t.TempDir()
			binary, record := fakeHarnessBinary(t, harnessID)
			runner, _ := packTestRunner(t, harnessID, binary, dataRoot, &pack, "", PackRequired, dataRoot, skillsRoot)
			connected := make(chan struct{})
			close(connected)
			configuration := mcpserver.Config{URL: url, Token: token, Connected: connected}

			// The projection is inspected while it exists, which for the run-scoped shape is only
			// during the run: the adapter is driven directly, then the whole run is executed.
			projection, err := runner.activatePack(context.Background(),
				Invocation{Run: packRun(harnessID), Workspace: dataRoot, MCP: configuration, packEnvironment: os.Environ()},
				TransportNative, binary)
			require.NoError(t, err)
			require.NotNil(t, projection)
			require.NoError(t, filepath.WalkDir(projection.Root, func(path string, entry fs.DirEntry, err error) error {
				if err != nil || entry.IsDir() {
					return err
				}
				content, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				require.NotContains(t, string(content), url, "%s carries the run's MCP URL", path)
				require.NotContains(t, string(content), token, "%s carries the run's MCP token", path)
				return nil
			}))
			// The credential-free environment an adapter is handed is os.Environ() with Barista's own
			// credentials stripped, so a token that happened to be exported would not reach it either.
			require.NotContains(t, adapterEnvironment([]string{"COFFEE_SHOP_MCP_TOKEN=" + token, "PATH=/usr/bin"}, nil),
				"COFFEE_SHOP_MCP_TOKEN="+token)
			require.NoError(t, projection.Cleanup())

			result, err := runner.Execute(context.Background(), Invocation{
				Run: packRun(harnessID), Workspace: dataRoot, MCP: configuration,
			})
			require.NoError(t, err)
			require.Equal(t, "done", result)

			// The token reaches the child only through the environment, which is the one place it may be.
			environment, err := os.ReadFile(record + ".env")
			require.NoError(t, err)
			require.Contains(t, string(environment), "COFFEE_SHOP_MCP_TOKEN="+token)
			arguments, err := os.ReadFile(record + ".args")
			require.NoError(t, err)
			require.NotContains(t, string(arguments), token, "the token is never an argument")
		})
	}
}

// ---------------------------------------------------------------------------
// Acceptance criterion 9: vendor configuration unchanged outside one named subtree.
// ---------------------------------------------------------------------------

func TestVendorConfigurationUnchangedOutsideManagedSubtree(t *testing.T) {
	pack, _ := packFixture(t)

	t.Run("codex managed run", func(t *testing.T) {
		home, _, skillsRoot := fakeVendorHome(t)
		dataRoot := t.TempDir()
		binary, _ := fakeHarnessBinary(t, "codex-cli")
		runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)

		before := snapshotTree(t, home)
		result, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
		require.NoError(t, err)
		require.Equal(t, "done", result)
		after := snapshotTree(t, home)

		// The only two paths excluded are the one named Barista-owned subtree directly beneath the
		// vendor's own skills root, and the Barista-created temporary sibling used to replace it.
		managed := filepath.Join(".codex", "skills", ManagedProjectionDirectory)
		temporary := managed + managedProjectionTemporarySuffix
		require.Equal(t,
			withoutPrefixes(before, managed, temporary),
			withoutPrefixes(after, managed, temporary),
			"vendor configuration changed outside %s", managed)
		// The exclusions are real: the projection was in fact written, and auth.json and config.toml
		// are in the compared set rather than quietly outside it.
		require.DirExists(t, filepath.Join(skillsRoot, ManagedProjectionDirectory))
		require.Contains(t, before, filepath.Join(".codex", "auth.json"))
		require.Contains(t, before, filepath.Join(".codex", "config.toml"))
		require.NoDirExists(t, filepath.Join(skillsRoot, ManagedProjectionDirectory+managedProjectionTemporarySuffix))
	})

	t.Run("claude native run changes nothing at all", func(t *testing.T) {
		home, _, _ := fakeVendorHome(t)
		dataRoot := t.TempDir()
		binary, _ := fakeHarnessBinary(t, "claude-cli")
		runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackRequired, dataRoot)

		before := snapshotTree(t, home)
		result, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
		require.NoError(t, err)
		require.Equal(t, "done", result)
		// The projection is run-scoped under the data root, so nothing at all changes under HOME —
		// not even inside a Barista-owned subtree, because there is none.
		require.Equal(t, before, snapshotTree(t, home))
	})
}

// ---------------------------------------------------------------------------
// Acceptance criteria 10 and 11: cleanup and crash reconciliation.
// ---------------------------------------------------------------------------

func TestProjectionCleanupOnCompletionCancelAndFailure(t *testing.T) {
	pack, _ := packFixture(t)
	for _, ending := range []string{"completion", "cancellation", "startup failure", "exact retry"} {
		t.Run(ending, func(t *testing.T) {
			_, _, skillsRoot := fakeVendorHome(t)
			dataRoot := t.TempDir()
			harnessID := "claude-cli"
			binary, _ := fakeHarnessBinary(t, harnessID)
			if ending == "startup failure" {
				binary = filepath.Join(t.TempDir(), "absent-binary")
			}
			runner, _ := packTestRunner(t, harnessID, binary, dataRoot, &pack, "", PackOptional, dataRoot, skillsRoot)
			ctx, cancel := context.WithCancel(context.Background())
			if ending == "cancellation" {
				cancel()
			}
			defer cancel()
			attempts := 1
			if ending == "exact retry" {
				attempts = 2
			}
			for attempt := 0; attempt < attempts; attempt++ {
				runner.Execute(ctx, Invocation{Run: packRun(harnessID), Workspace: dataRoot})
			}
			// The run-scoped prefix holds nothing for this run, and only paths the run created were
			// ever removed.
			require.NoDirExists(t, filepath.Join(dataRoot, RunScopedProjectionDirectory, "run-pack-1"))
			// Cleanup is idempotent: an already-removed path succeeds.
			require.NoError(t, removeIfOwned(filepath.Join(dataRoot, RunScopedProjectionDirectory, "run-pack-1")))
			require.NoDirExists(t, filepath.Join(skillsRoot, ManagedProjectionDirectory+managedProjectionTemporarySuffix))
		})
	}
}

func TestCleanupLeavesUnownedContent(t *testing.T) {
	pack, _ := packFixture(t)
	dataRoot := t.TempDir()
	prefix := filepath.Join(dataRoot, RunScopedProjectionDirectory)
	require.NoError(t, os.MkdirAll(prefix, 0o755))

	// Three kinds of content Barista did not create, all directly under its own prefix.
	unowned := filepath.Join(prefix, "operator-note.txt")
	require.NoError(t, os.WriteFile(unowned, []byte("not Barista's"), 0o644))
	foreign := filepath.Join(prefix, "run-not-ours")
	require.NoError(t, os.MkdirAll(foreign, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(foreign, "theirs.txt"), []byte("theirs"), 0o644))
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "keep.txt"), []byte("keep"), 0o644))
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Symlink(outside, filepath.Join(prefix, "run-symlinked")))
	}

	// One real projection Barista did create, through the real adapter.
	fakeVendorHome(t)
	projection, err := projectClaudePluginDirectory(packProjectionContext{
		Pack: pack, RunID: "run-crashed", DataRoot: dataRoot, established: newEstablishedProjections(),
	})
	require.NoError(t, err)
	require.DirExists(t, projection.Root)

	removed, err := ReconcileStaleProjections(dataRoot)
	require.Error(t, err, "retained content is reported, never silently deleted")
	require.Equal(t, []string{filepath.Join(prefix, "run-crashed")}, removed)
	require.NoDirExists(t, filepath.Join(prefix, "run-crashed"))
	// Everything Barista did not create survives, byte for byte, and nothing outside was followed.
	require.FileExists(t, unowned)
	content, readErr := os.ReadFile(unowned)
	require.NoError(t, readErr)
	require.Equal(t, "not Barista's", string(content))
	require.FileExists(t, filepath.Join(foreign, "theirs.txt"))
	require.FileExists(t, filepath.Join(outside, "keep.txt"))
	require.Contains(t, err.Error(), "operator-note.txt")
	require.Contains(t, err.Error(), "run-not-ours")
	if runtime.GOOS != "windows" {
		require.Contains(t, err.Error(), "symlink")
	}
}

func TestStaleProjectionReconciledAtStartup(t *testing.T) {
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	// A projection a crashed daemon left behind, written by the real adapter and then abandoned.
	crashed, err := projectClaudePluginDirectory(packProjectionContext{
		Pack: pack, RunID: "run-from-a-crash", DataRoot: dataRoot, established: newEstablishedProjections(),
	})
	require.NoError(t, err)
	stale := crashed.Root
	require.DirExists(t, stale)

	// Nothing reconciles it until a daemon start does: a live run touches only its own state.
	binary, _ := fakeHarnessBinary(t, "claude-cli")
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackOptional, dataRoot)
	_, err = runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	require.DirExists(t, stale, "a live run must not reconcile another run's leftovers")

	removed, err := ReconcileStaleProjections(dataRoot)
	require.NoError(t, err)
	require.Contains(t, removed, filepath.Join(dataRoot, RunScopedProjectionDirectory, "run-from-a-crash"))
	require.NoDirExists(t, stale)
	// Idempotent: a second start finds nothing and succeeds.
	removed, err = ReconcileStaleProjections(dataRoot)
	require.NoError(t, err)
	require.Empty(t, removed)
}

// ---------------------------------------------------------------------------
// Acceptance criteria 12, 15 and 17: the managed projection's integrity rules.
// ---------------------------------------------------------------------------

func TestUpgradeDoesNotMutateInFlightProjection(t *testing.T) {
	pack, _ := packFixture(t)
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, _ := fakeHarnessBinary(t, "codex-cli")
	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	root := filepath.Join(skillsRoot, ManagedProjectionDirectory)
	established := snapshotTree(t, root)

	// A new version is activated while this daemon is live. The daemon adopts one pack selection per
	// lifetime, so its own projection is untouched by every later run it serves.
	for index := 0; index < 3; index++ {
		run := packRun("codex-cli")
		run.ID = fmt.Sprintf("run-pack-%d", index+2)
		_, err := runner.Execute(context.Background(), Invocation{Run: run, Workspace: dataRoot})
		require.NoError(t, err)
	}
	require.Equal(t, established, snapshotTree(t, root), "a live daemon's managed projection must never be mutated")

	// The next daemon, which adopted the new version, replaces it wholesale.
	upgraded := pack
	upgraded.Version = "2.0.0"
	upgraded.ArchiveDigest = strings.Repeat("a", 64)
	upgraded.Reread = func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		manifest := pack.Manifest
		manifest.Version = "2.0.0"
		return pack.Tree, manifest, upgraded.ArchiveDigest, nil
	}
	nextDaemon, _ := packTestRunner(t, "codex-cli", binary, t.TempDir(), &upgraded, "", PackRequired, skillsRoot)
	_, err = nextDaemon.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	marker, err := readProjectionMarker(root)
	require.NoError(t, err)
	require.Equal(t, upgraded.Identity(), marker.Identity())
}

func TestManagedProjectionReplacedAtomically(t *testing.T) {
	pack, _ := packFixture(t)
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "codex-cli")
	root := filepath.Join(skillsRoot, ManagedProjectionDirectory)

	// A complete previous projection of this build is in place.
	first, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err := first.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	previous := snapshotTree(t, root)
	require.NoError(t, os.Remove(record+".args"))

	// The next daemon fails after the temporary subtree is written and before the rename.
	upgraded := pack
	upgraded.ArchiveDigest = strings.Repeat("b", 64)
	upgraded.Reread = func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		return pack.Tree, pack.Manifest, upgraded.ArchiveDigest, nil
	}
	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &upgraded, "", PackRequired, skillsRoot)
	runner.packHooks = projectionHooks{beforeRename: func(temporary string) error {
		require.DirExists(t, temporary, "the complete new subtree is written to a sibling temporary path first")
		return errors.New("the disk filled")
	}}
	var started []protocol.RunTransportSelection
	_, err = runner.Execute(context.Background(), Invocation{
		Run: packRun("codex-cli"), Workspace: dataRoot,
		Started: func(selection protocol.RunTransportSelection) { started = append(started, selection) },
	})
	require.ErrorIs(t, err, ErrPackActivation)
	require.Contains(t, err.Error(), "atomically replaced")
	require.Empty(t, started, "the run failed before the prompt")
	require.NoFileExists(t, record+".args")
	require.Equal(t, previous, snapshotTree(t, root), "the previous projection must be byte-for-byte intact")
	require.NoDirExists(t, managedTemporarySibling(skillsRoot), "the one temporary sibling must be gone")
	// No third Barista-created path is ever left in the vendor's skills root.
	entries, err := os.ReadDir(skillsRoot)
	require.NoError(t, err)
	for _, entry := range entries {
		require.NotContains(t, entry.Name(), managedProjectionTemporarySuffix)
	}
}

func TestManagedProjectionNeverMutatedInPlace(t *testing.T) {
	pack, _ := packFixture(t)
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, _ := fakeHarnessBinary(t, "codex-cli")
	root := filepath.Join(skillsRoot, ManagedProjectionDirectory)
	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)

	// Every file inside the live projection is made read-only, and its directories too. A later run
	// that opened any of them for writing, created a file, or removed one would fail here; a run that
	// only reuses the projection cannot.
	var paths []string
	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		paths = append(paths, path)
		return nil
	}))
	for index := len(paths) - 1; index >= 0; index-- {
		information, err := os.Lstat(paths[index])
		require.NoError(t, err)
		mode := os.FileMode(0o444)
		if information.IsDir() {
			mode = 0o555
		}
		require.NoError(t, os.Chmod(paths[index], mode))
	}
	t.Cleanup(func() {
		for _, path := range paths {
			information, err := os.Lstat(path)
			if err != nil {
				continue
			}
			if information.IsDir() {
				os.Chmod(path, 0o755)
			} else {
				os.Chmod(path, 0o644)
			}
		}
	})
	before := snapshotTree(t, root)
	for index := 0; index < 3; index++ {
		run := packRun("codex-cli")
		run.ID = fmt.Sprintf("run-pack-reuse-%d", index)
		_, err := runner.Execute(context.Background(), Invocation{Run: run, Workspace: dataRoot})
		require.NoError(t, err, "reusing a live projection must require no write at all")
	}
	require.Equal(t, before, snapshotTree(t, root))
}

func TestForeignManagedSubtreeNeitherAdoptedNorClobbered(t *testing.T) {
	pack, _ := packFixture(t)
	foreignBody := []byte("an operator's own content\n")
	for _, occupant := range []struct {
		name    string
		install func(t *testing.T, root string)
		reason  string
	}{
		{"absent marker", func(t *testing.T, root string) {
			require.NoError(t, os.MkdirAll(filepath.Join(root, "skills", "theirs"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(root, "skills", "theirs", "SKILL.md"), foreignBody, 0o644))
		}, "carries no Barista ownership marker"},
		{"malformed marker", func(t *testing.T, root string) {
			require.NoError(t, os.MkdirAll(root, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(root, ProjectionMarkerName), []byte("{not json"), 0o644))
		}, "could not be decoded"},
		{"foreign owner", func(t *testing.T, root string) {
			require.NoError(t, os.MkdirAll(root, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(root, ProjectionMarkerName),
				[]byte(`{"owner":"someone-else","projectionSchemaVersion":"1","shape":"managed","packId":"p","packVersion":"1.0.0","archiveDigest":"d","baristaBuild":"x"}`), 0o644))
		}, "declares a different owner"},
		{"plain file", func(t *testing.T, root string) {
			require.NoError(t, os.WriteFile(root, foreignBody, 0o644))
		}, "is not a directory"},
		{"symlink", func(t *testing.T, root string) {
			if runtime.GOOS == "windows" {
				t.Skip("symlinks are not exercised on this platform")
			}
			target := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(target, "kept.txt"), foreignBody, 0o644))
			require.NoError(t, os.Symlink(target, root))
		}, "is a symlink"},
	} {
		t.Run(occupant.name, func(t *testing.T) {
			_, _, skillsRoot := fakeVendorHome(t)
			dataRoot := t.TempDir()
			binary, record := fakeHarnessBinary(t, "codex-cli")
			root := filepath.Join(skillsRoot, ManagedProjectionDirectory)
			occupant.install(t, root)
			before := snapshotTree(t, skillsRoot)

			// A pack-required run is refused before the prompt, naming the path and the reason.
			required, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
			var started []protocol.RunTransportSelection
			_, err := required.Execute(context.Background(), Invocation{
				Run: packRun("codex-cli"), Workspace: dataRoot,
				Started: func(selection protocol.RunTransportSelection) { started = append(started, selection) },
			})
			require.ErrorIs(t, err, ErrPackActivation)
			require.Contains(t, err.Error(), root)
			require.Contains(t, err.Error(), occupant.reason)
			require.Empty(t, started)
			require.NoFileExists(t, record+".args")
			require.Equal(t, before, snapshotTree(t, skillsRoot), "the foreign content must be byte-for-byte unchanged")

			// A pack-optional run proceeds unskilled with the same reason reported, still untouched.
			optional, lines := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackOptional, skillsRoot)
			result, err := optional.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
			require.NoError(t, err)
			require.Equal(t, "done", result)
			reported := strings.Join(*lines, "\n")
			require.Contains(t, reported, "proceeds with no Coffee Shop capability pack")
			require.Contains(t, reported, occupant.reason)
			require.Equal(t, before, snapshotTree(t, skillsRoot))
		})
	}
}

func TestManagedProjectionOwnershipMarker(t *testing.T) {
	pack, _ := packFixture(t)
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, _ := fakeHarnessBinary(t, "codex-cli")
	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)

	root := filepath.Join(skillsRoot, ManagedProjectionDirectory)
	// The marker is real bytes on disk, and the loader accepts exactly what the writer produced.
	data, err := os.ReadFile(filepath.Join(root, ProjectionMarkerName))
	require.NoError(t, err)
	marker, err := ParseProjectionMarker(data)
	require.NoError(t, err)
	require.Equal(t, ProjectionOwner, marker.Owner)
	require.Equal(t, ProjectionSchemaVersion, marker.ProjectionSchemaVersion)
	require.Equal(t, string(ProjectionManaged), marker.Shape)
	require.Equal(t, pack.ID, marker.PackID)
	require.Equal(t, pack.Version, marker.PackVersion)
	require.Equal(t, pack.ArchiveDigest, marker.ArchiveDigest)
	require.Equal(t, pack.Build, marker.BaristaBuild)
	require.True(t, marker.Current())
	// The identity a comparison uses covers all three fields, so two of three can never pass for three.
	require.Equal(t, pack.Identity(), marker.Identity())

	// A projection whose generation this build does not recognize is replaced wholesale, never merged.
	stale := marker
	stale.ProjectionSchemaVersion = "0"
	staleBytes, err := marshalMarker(stale)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, ProjectionMarkerName), staleBytes, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "leftover-from-an-older-layout.txt"), []byte("x"), 0o644))
	parsed, err := ParseProjectionMarker(staleBytes)
	require.NoError(t, err)
	require.False(t, parsed.Current())

	nextDaemon, _ := packTestRunner(t, "codex-cli", binary, t.TempDir(), &pack, "", PackRequired, skillsRoot)
	_, err = nextDaemon.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	require.NoFileExists(t, filepath.Join(root, "leftover-from-an-older-layout.txt"), "an unrecognized generation is replaced wholesale")
	replaced, err := readProjectionMarker(root)
	require.NoError(t, err)
	require.True(t, replaced.Current())
}

func TestPrecedenceCollisionRecordedAndUnconfirmableRefused(t *testing.T) {
	pack, _ := packFixture(t)
	names, err := pack.SkillNamesByDirectory()
	require.NoError(t, err)
	require.NotEmpty(t, names)
	colliding := slices.Sorted(mapKeys(names))[0]

	t.Run("no collision", func(t *testing.T) {
		_, _, skillsRoot := fakeVendorHome(t)
		collisions, err := codexSkillCollisions(skillsRoot, filepath.Join(skillsRoot, ManagedProjectionDirectory), []string{"a name nobody offers"})
		require.NoError(t, err)
		require.Empty(t, collisions)
	})

	t.Run("collision with an unconfirmable winner refuses a pack-required run", func(t *testing.T) {
		_, _, skillsRoot := fakeVendorHome(t)
		dataRoot := t.TempDir()
		// The operator offers a skill under the same name Codex will key a projected skill by, from
		// outside the managed subtree. Codex 0.147.0 lists both with no visible precedence.
		require.NoError(t, os.MkdirAll(filepath.Join(skillsRoot, "their-own"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(skillsRoot, "their-own", "SKILL.md"),
			[]byte("---\nname: "+names[colliding]+"\ndescription: The operator's own skill of the same name.\n---\n\nBody.\n"), 0o644))

		binary, record := fakeHarnessBinary(t, "codex-cli")
		required, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
		_, err := required.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
		require.ErrorIs(t, err, ErrPackActivation)
		require.Contains(t, err.Error(), names[colliding])
		require.Contains(t, err.Error(), "cannot be confirmed")
		require.NoFileExists(t, record+".args")

		optional, lines := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackOptional, skillsRoot)
		_, err = optional.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
		require.NoError(t, err)
		reported := strings.Join(*lines, "\n")
		require.Contains(t, reported, names[colliding])
		// The managed projection is installed, so the run is never reported as unskilled.
		require.Contains(t, reported, "activation "+string(PackUnconfirmed))
		require.NotContains(t, reported, "proceeds with no Coffee Shop capability pack")
	})

	t.Run("a confirmed winner is recorded and the run proceeds", func(t *testing.T) {
		_, _, skillsRoot := fakeVendorHome(t)
		dataRoot := t.TempDir()
		binary, record := fakeHarnessBinary(t, "codex-cli")
		// No vendor confirms a winner at its pinned version, so the branch is exercised by substituting
		// the registered adapter's projection with one that reports a confirmed winner. Everything else
		// — the gate, the report, and the launch — is the production path.
		key := packAdapterKey{HarnessID: "codex-cli", Transport: TransportNative}
		original := packActivationAdapters[key]
		confirmed := original
		confirmed.Project = func(projectionContext packProjectionContext) (*PackProjection, error) {
			projection, err := original.Project(projectionContext)
			if err != nil {
				return nil, err
			}
			projection.Collisions = []SkillCollision{{
				Name: projection.SkillNames[0], Offered: filepath.Join(skillsRoot, "their-own", "SKILL.md"),
				Winner: "the projected Coffee Shop skill",
			}}
			return projection, nil
		}
		packActivationAdapters[key] = confirmed
		t.Cleanup(func() { packActivationAdapters[key] = original })

		runner, lines := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
		result, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
		require.NoError(t, err)
		require.Equal(t, "done", result)
		require.FileExists(t, record+".args", "a confirmed winner must not refuse the run")
		reported := strings.Join(*lines, "\n")
		require.Contains(t, reported, "the effective winner is the projected Coffee Shop skill")
		require.Contains(t, reported, "activation projected")
	})
}

// ---------------------------------------------------------------------------
// Vocabulary closure and fail-closed defaults.
// ---------------------------------------------------------------------------

func TestCapabilityPackVocabulariesAreClosed(t *testing.T) {
	// Projection shapes: every value validates, and anything outside the vocabulary is rejected
	// rather than defaulting to either shape. Every shipped adapter uses one of exactly these.
	require.Equal(t, []ProjectionShape{ProjectionRunScoped, ProjectionManaged}, ProjectionShapes)
	for _, shape := range ProjectionShapes {
		require.NoError(t, shape.Validate())
		_, err := writeProjection(filepath.Join(t.TempDir(), "root"), ActivePack{Tree: capabilitypack.Tree{"pack.json": []byte("{}")}}, shape, nil)
		require.NoError(t, err, "every shape in the vocabulary must be writable")
	}
	for _, outside := range []ProjectionShape{"", "global", "symlinked"} {
		require.Error(t, outside.Validate())
		_, err := writeProjection(filepath.Join(t.TempDir(), "root"), ActivePack{}, outside, nil)
		require.Error(t, err, "a shape outside the vocabulary must be refused, not defaulted")
	}
	shapes := map[ProjectionShape]bool{}
	for _, adapter := range packActivationAdapters {
		require.NoError(t, adapter.Shape.Validate())
		shapes[adapter.Shape] = true
	}
	require.Len(t, shapes, 2, "both shapes are in use, and no adapter invents a third")

	// Pack requirements: every value parses, and every consumer handles both.
	require.Equal(t, []PackRequirement{PackOptional, PackRequired}, PackRequirements)
	pack, _ := packFixture(t)
	for _, requirement := range PackRequirements {
		parsed, err := ParsePackRequirement(string(requirement))
		require.NoError(t, err)
		require.Equal(t, requirement, parsed)
		runner := NewRunner(nil).WithCapabilityPack(&pack, "", requirement, t.TempDir())
		require.Equal(t, requirement, runner.CapabilityPackRequirement())
		err = runner.unskilled(Invocation{Run: packRun("codex-cli")}, requirement, packUnavailablef("a named reason"))
		if requirement == PackRequired {
			require.ErrorIs(t, err, ErrPackActivation)
		} else {
			require.NoError(t, err)
		}
	}
	for _, outside := range []string{"", "yes", "REQUIRED", "optional "} {
		_, err := ParsePackRequirement(outside)
		require.Error(t, err, "%q must be rejected, never defaulted", outside)
		if outside == "" {
			continue
		}
		require.Error(t, PackRequirement(outside).Validate())
		// A caller that bypassed configuration parsing collapses to the strictest policy, never the
		// permissive one, so an invalid value can never silently weaken the node.
		require.Equal(t, PackRequired,
			NewRunner(nil).WithCapabilityPack(&pack, "", PackRequirement(outside), t.TempDir()).CapabilityPackRequirement())
	}
	// An unwired Runner keeps the optional reading rather than an empty requirement.
	require.Equal(t, PackOptional, NewRunner(nil).CapabilityPackRequirement())

	// Activation outcomes: the whole vocabulary is enumerated in one place.
	require.Equal(t, []PackActivationOutcome{PackProjected, PackUnskilled, PackUnconfirmed, PackRefused}, PackActivationOutcomes)
	for _, outcome := range PackActivationOutcomes {
		require.NotEmpty(t, string(outcome))
	}
}

func TestDelegationOnlySkillRecordedInNonDelegatingRun(t *testing.T) {
	pack, _ := packFixture(t)
	delegating := ""
	for _, skill := range pack.Manifest.Skills {
		if len(skill.DelegationTools) > 0 {
			delegating = skill.ID
		}
	}
	require.NotEmpty(t, delegating, "the canonical pack declares at least one delegation-only skill")
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, _ := fakeHarnessBinary(t, "codex-cli")
	runner, lines := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err := runner.Execute(context.Background(), Invocation{
		Run: packRun("codex-cli"), Workspace: dataRoot,
		MCP: mcpserver.Config{CanDelegate: false},
	})
	require.NoError(t, err)
	reported := strings.Join(*lines, "\n")
	require.Contains(t, reported, delegating)
	require.Contains(t, reported, "delegation path is unavailable")
	// The pack is projected in full and the run's grant is never widened.
	require.FileExists(t, filepath.Join(skillsRoot, ManagedProjectionDirectory, capabilitypack.SkillPathFor(delegating)))
}

func TestPackUnavailableReasonsStayDistinct(t *testing.T) {
	dataRoot := t.TempDir()
	fakeVendorHome(t)
	for _, reason := range []string{
		"the activation ledger could not be accepted, so no capability pack was resolved",
		"no capability pack version is activated on this node",
	} {
		binary, record := fakeHarnessBinary(t, "claude-cli")
		runner, lines := packTestRunner(t, "claude-cli", binary, dataRoot, nil, reason, PackRequired, dataRoot)
		_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
		require.ErrorIs(t, err, ErrPackActivation)
		require.Contains(t, err.Error(), reason, "the resolution reason must reach the refusal verbatim")
		require.NoFileExists(t, record+".args")

		optional, optionalLines := packTestRunner(t, "claude-cli", binary, dataRoot, nil, reason, PackOptional, dataRoot)
		_, err = optional.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
		require.NoError(t, err)
		require.Contains(t, strings.Join(*optionalLines, "\n"), reason)
		_ = lines
	}
	// An unwired Runner names the absence rather than saying nothing.
	binary, _ := fakeHarnessBinary(t, "claude-cli")
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, nil, "", PackRequired, dataRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
	require.ErrorContains(t, err, "no capability pack is selected on this node")
}

func TestProjectionPathContainmentReusesThePackagedPathGrammar(t *testing.T) {
	pack, _ := packFixture(t)
	dataRoot := t.TempDir()
	for _, hostile := range []string{"..", "../escape", "a/b", `a\b`, "", ".hidden", "-leading"} {
		_, err := runScopedProjectionRoot(dataRoot, hostile, pack.ID, pack.Version)
		require.Error(t, err, "run id %q must be refused", hostile)
		_, err = runScopedRunRoot(dataRoot, hostile)
		require.Error(t, err, "run id %q must be refused", hostile)
	}
	_, err := runScopedProjectionRoot("relative/root", "run-1", pack.ID, pack.Version)
	require.Error(t, err, "a relative data root must be refused")
	root, err := runScopedProjectionRoot(dataRoot, "run-1", pack.ID, pack.Version)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(root, filepath.Join(dataRoot, RunScopedProjectionDirectory)+string(filepath.Separator)))
	require.Equal(t, ManagedProjectionDirectory, filepath.Base(root))

	// The writer refuses a tree path outside the grammar rather than writing it.
	err = capabilitypack.WriteTree(filepath.Join(dataRoot, "out"), capabilitypack.Tree{"../escape": []byte("x")})
	require.Error(t, err)
	require.NoDirExists(t, filepath.Join(dataRoot, "out"))
}

func TestCodexSkillsRootResolvesLikeCodexDoes(t *testing.T) {
	root, err := codexSkillsRoot([]string{"HOME=/home/operator"})
	require.NoError(t, err)
	require.Equal(t, filepath.Join("/home/operator", ".codex", "skills"), root)
	// CODEX_HOME wins, exactly as the vendor resolves it.
	root, err = codexSkillsRoot([]string{"HOME=/home/operator", "CODEX_HOME=/srv/codex"})
	require.NoError(t, err)
	require.Equal(t, filepath.Join("/srv/codex", "skills"), root)
	// A later assignment wins, matching how a child process reads a duplicated variable.
	root, err = codexSkillsRoot([]string{"CODEX_HOME=/first", "CODEX_HOME=/second"})
	require.NoError(t, err)
	require.Equal(t, filepath.Join("/second", "skills"), root)
	for _, environment := range [][]string{nil, {"HOME="}, {"CODEX_HOME=relative/path"}, {"HOME=relative"}} {
		_, err := codexSkillsRoot(environment)
		require.Error(t, err, "environment %v must be refused, never guessed", environment)
	}
}

// ---------------------------------------------------------------------------
// Real vendor output: the surfaces this issue claims, and the parsers that read them.
// ---------------------------------------------------------------------------

func TestVendorSurfaceFixturesRecordTheVerifiedSurfaces(t *testing.T) {
	// The claim "claude-cli 2.1.231 offers --plugin-dir, repeatable and session-only" is held to the
	// binary's own --help output, captured from the installed CLI.
	version, err := os.ReadFile(filepath.Join("testdata", "claude-cli-version-output.txt"))
	require.NoError(t, err)
	require.Contains(t, string(version), "2.1.231")
	help, err := os.ReadFile(filepath.Join("testdata", "claude-cli-plugin-dir-help.txt"))
	require.NoError(t, err)
	require.Contains(t, string(help), "--plugin-dir <path>")
	require.Contains(t, string(help), "for this session only")
	require.Contains(t, string(help), "repeatable")

	// The claim "codex-cli 0.147.0 offers no skills configuration key" is held to the binary's own
	// rejection of one.
	codexVersion, err := os.ReadFile(filepath.Join("testdata", "codex-cli-version-output.txt"))
	require.NoError(t, err)
	require.Contains(t, string(codexVersion), "0.147.0")
	rejection, err := os.ReadFile(filepath.Join("testdata", "codex-cli-skills-config-rejection.txt"))
	require.NoError(t, err)
	require.Contains(t, string(rejection), "unknown configuration field `skills.roots`")
}

func TestDiscoveryConfirmersAcceptRealVendorOutput(t *testing.T) {
	pack, _ := packFixture(t)

	// `claude --plugin-dir <root> plugin details coffee-shop-barista`, run against a projection of
	// this very pack on the installed 2.1.231, byte-for-byte as the CLI printed it.
	details, err := os.ReadFile(filepath.Join("testdata", "claude-cli-plugin-details-output.txt"))
	require.NoError(t, err)
	inventory := claudeSkillInventory(string(details))
	require.Equal(t, slices.Sorted(slices.Values(pack.Manifest.SkillIDs())), inventory,
		"the real plugin inventory must parse to exactly the pack's skills")
	require.NoError(t, confirmClaudePluginDiscovery(context.Background(),
		packProjectionContext{Pack: pack, inventory: func(context.Context, string, []string) (string, error) {
			return string(details), nil
		}},
		&PackProjection{Root: "/recorded/root", SkillNames: inventory}))

	// `codex debug prompt-input`, run against a managed projection of this very pack on the installed
	// 0.147.0, byte-for-byte as the CLI printed it. The recorded projection root is the one the
	// recording was made under, because the confirmation matches on the exact file paths.
	promptInput, err := os.ReadFile(filepath.Join("testdata", "codex-cli-prompt-input-output.json"))
	require.NoError(t, err)
	var rendered []map[string]any
	require.NoError(t, json.Unmarshal(promptInput, &rendered), "the recording is the CLI's own JSON")
	recordedRoot := ""
	for _, skill := range pack.Manifest.Skills {
		marker := "/" + ManagedProjectionDirectory + "/" + skill.Path
		index := strings.Index(string(promptInput), marker)
		require.GreaterOrEqual(t, index, 0, "the recording must name the projected skill %s", skill.ID)
		start := strings.LastIndex(string(promptInput)[:index], "(file: ") + len("(file: ")
		recordedRoot = strings.TrimSuffix(string(promptInput)[start:index+len(marker)], "/"+skill.Path)
	}
	require.NotEmpty(t, recordedRoot)
	require.NoError(t, confirmCodexSkillDiscovery(context.Background(),
		packProjectionContext{Pack: pack, inventory: func(context.Context, string, []string) (string, error) {
			return string(promptInput), nil
		}},
		&PackProjection{Root: recordedRoot}))

	// And a recording that does not name a projected skill is an unconfirmed discovery, not a pass.
	err = confirmCodexSkillDiscovery(context.Background(),
		packProjectionContext{Pack: pack, inventory: func(context.Context, string, []string) (string, error) {
			return "", nil
		}}, &PackProjection{Root: recordedRoot})
	require.Error(t, err)
	require.True(t, isPackUnavailable(err))
}

func TestProjectionMarkerLoaderAcceptsWhatTheWriterProduces(t *testing.T) {
	pack, _ := packFixture(t)
	for _, shape := range ProjectionShapes {
		data, err := marshalMarker(markerFor(pack, shape))
		require.NoError(t, err)
		marker, err := ParseProjectionMarker(data)
		require.NoError(t, err)
		require.Equal(t, string(shape), marker.Shape)
		require.Equal(t, pack.Identity(), marker.Identity())
		require.True(t, marker.Current())
	}
	for _, malformed := range []string{
		"", "{", "{}", `{"owner":"cafecito-games/CoffeeShop/barista"}`,
		`{"owner":"cafecito-games/CoffeeShop/barista","projectionSchemaVersion":"1","shape":"managed","packId":"p","packVersion":"1.0.0","archiveDigest":"d","baristaBuild":"b","extra":1}`,
		`{"owner":"cafecito-games/CoffeeShop/barista","projectionSchemaVersion":"1","shape":"managed","packId":"p","packVersion":"1.0.0","archiveDigest":"d","baristaBuild":"b"} trailing`,
	} {
		_, err := ParseProjectionMarker([]byte(malformed))
		require.Error(t, err, "%q must be foreign or corrupt, never absent", malformed)
	}
}

func TestFrontMatterNameReadsOperatorSkillsLeniently(t *testing.T) {
	// Real Codex system skills quote their metadata values; a projected pack skill does not.
	require.Equal(t, "imagegen", frontMatterName([]byte("---\nname: \"imagegen\"\ndescription: \"x\"\n---\n\nBody\n")))
	require.Equal(t, "Coffee Shop task coordination", frontMatterName([]byte("---\nid: a\nname: Coffee Shop task coordination\ndescription: Use when x\n---\n\nBody\n")))
	for _, absent := range []string{"", "no front matter", "---\ndescription: x\n---\n", "---\nname: x\n"} {
		require.Empty(t, frontMatterName([]byte(absent)), "%q declares no readable name", absent)
	}
}

func TestForeignSkillEnumerationIsBoundedAndNeverFollowsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks are not exercised on this platform")
	}
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "theirs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "theirs", "SKILL.md"),
		[]byte("---\nname: theirs\ndescription: x\n---\n\nBody\n"), 0o644))
	excluded := filepath.Join(root, ManagedProjectionDirectory)
	require.NoError(t, os.MkdirAll(filepath.Join(excluded, "ours"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(excluded, "ours", "SKILL.md"),
		[]byte("---\nname: ours\ndescription: x\n---\n\nBody\n"), 0o644))

	offered, err := foreignSkillNames(root, []string{excluded}, func(_ string, content []byte) string { return frontMatterName(content) })
	require.NoError(t, err)
	require.Contains(t, offered, "theirs")
	require.NotContains(t, offered, "ours", "the managed subtree's own skills are not foreign")

	// A SKILL.md that is a symlink is refused rather than followed, and a name that cannot be read is
	// refused rather than ignored: an unreadable name is a name a collision cannot be ruled out for.
	require.NoError(t, os.MkdirAll(filepath.Join(root, "linked"), 0o755))
	require.NoError(t, os.Symlink(filepath.Join(root, "theirs", "SKILL.md"), filepath.Join(root, "linked", "SKILL.md")))
	_, err = foreignSkillNames(root, []string{excluded}, func(_ string, content []byte) string { return frontMatterName(content) })
	require.Error(t, err)
	require.NoError(t, os.Remove(filepath.Join(root, "linked", "SKILL.md")))

	require.NoError(t, os.WriteFile(filepath.Join(root, "linked", "SKILL.md"), []byte("no metadata at all\n"), 0o644))
	_, err = foreignSkillNames(root, []string{excluded}, func(_ string, content []byte) string { return frontMatterName(content) })
	require.Error(t, err)
	require.NoError(t, os.Remove(filepath.Join(root, "linked", "SKILL.md")))

	// An oversized document is refused rather than read without bound.
	require.NoError(t, os.WriteFile(filepath.Join(root, "linked", "SKILL.md"), make([]byte, maximumForeignSkillBytes+1), 0o644))
	_, err = foreignSkillNames(root, []string{excluded}, func(_ string, content []byte) string { return frontMatterName(content) })
	require.Error(t, err)

	// An absent root is not a failure; it offers nothing.
	offered, err = foreignSkillNames(filepath.Join(root, "absent"), nil, func(_ string, content []byte) string { return frontMatterName(content) })
	require.NoError(t, err)
	require.Empty(t, offered)
}

func TestBoundedBufferRefusesUnboundedVendorOutput(t *testing.T) {
	bounded := &boundedBuffer{limit: 8}
	written, err := bounded.Write([]byte("0123456789"))
	require.NoError(t, err)
	require.Equal(t, 10, written)
	require.True(t, bounded.exceeded)
	require.Equal(t, "01234567", bounded.buffer.String())
	within := &boundedBuffer{limit: 8}
	within.Write([]byte("ab"))
	within.Write([]byte("cd"))
	require.False(t, within.exceeded)
	require.Equal(t, "abcd", within.buffer.String())
}

func TestActivePackSkillNamesRefuseADriftedLayout(t *testing.T) {
	pack, _ := packFixture(t)
	names, err := pack.SkillNamesByDirectory()
	require.NoError(t, err)
	require.Len(t, names, len(pack.Manifest.Skills))
	for id, name := range names {
		require.Equal(t, capabilitypack.SkillPathFor(id), skillPathFor(pack, id))
		require.NotEmpty(t, name)
	}

	// A manifest whose skill path is not the one packaged location is refused rather than re-derived.
	drifted := pack
	drifted.Manifest.Skills = append([]capabilitypack.PackSkill{}, pack.Manifest.Skills...)
	drifted.Manifest.Skills[0].Path = "elsewhere/SKILL.md"
	_, err = drifted.SkillNamesByDirectory()
	require.Error(t, err)

	// A skill absent from the tree is refused rather than silently skipped.
	missing := pack
	missing.Tree = capabilitypack.Tree{}
	_, err = missing.SkillNamesByDirectory()
	require.Error(t, err)
}

func skillPathFor(pack ActivePack, id string) string {
	for _, skill := range pack.Manifest.Skills {
		if skill.ID == id {
			return skill.Path
		}
	}
	return ""
}

func TestActivePackWithoutRereadIsRefused(t *testing.T) {
	pack, _ := packFixture(t)
	pack.Reread = nil
	dataRoot := t.TempDir()
	fakeVendorHome(t)
	binary, record := fakeHarnessBinary(t, "claude-cli")
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackOptional, dataRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
	require.ErrorIs(t, err, ErrPackActivation)
	require.Contains(t, err.Error(), "cannot be re-verified")
	require.NoFileExists(t, record+".args")
}

func TestClaudeProjectionIsHandedToTheSessionOnlySurface(t *testing.T) {
	pack, _ := packFixture(t)
	fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "claude-cli")
	runner, _ := packTestRunner(t, "claude-cli", binary, dataRoot, &pack, "", PackRequired, dataRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("claude-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	arguments, err := os.ReadFile(record + ".args")
	require.NoError(t, err)
	lines := strings.Split(strings.TrimRight(string(arguments), "\n"), "\n")
	index := slices.Index(lines, "--plugin-dir")
	require.GreaterOrEqual(t, index, 0, "the run must be given the verified session-only surface")
	require.Less(t, index+1, len(lines))
	root := lines[index+1]
	require.True(t, strings.HasPrefix(root, filepath.Join(dataRoot, RunScopedProjectionDirectory)+string(filepath.Separator)),
		"the projection root must be under the Barista data root, not vendor configuration: %s", root)
	require.Equal(t, ManagedProjectionDirectory, filepath.Base(root))
	// The plugin manifest the vendor requires carries the pack's own identity and nothing invented.
	require.NoDirExists(t, root, "the run-scoped projection is removed when the run ends")
}

func TestCodexProjectionCarriesNoExtraArgumentsAndKeepsThePromptLast(t *testing.T) {
	pack, _ := packFixture(t)
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, record := fakeHarnessBinary(t, "codex-cli")
	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	run := packRun("codex-cli")
	_, err := runner.Execute(context.Background(), Invocation{Run: run, Workspace: dataRoot})
	require.NoError(t, err)
	arguments, err := os.ReadFile(record + ".args")
	require.NoError(t, err)
	lines := strings.Split(strings.TrimRight(string(arguments), "\n"), "\n")
	require.Contains(t, lines[len(lines)-1], run.Prompt, "the prompt must remain the final positional argument")
	require.Equal(t, []string{"exec", "--json", "--sandbox", "workspace-write"}, lines[:4],
		"the managed shape adds no argument and preserves the sandbox default")
}

func TestPackActivationIsIdempotentForTheSameRunAndPack(t *testing.T) {
	pack, _ := packFixture(t)
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		t.Run(harnessID, func(t *testing.T) {
			binary, _ := fakeHarnessBinary(t, harnessID)
			runner, _ := packTestRunner(t, harnessID, binary, dataRoot, &pack, "", PackRequired, dataRoot, skillsRoot)
			first, err := runner.activatePack(context.Background(), Invocation{Run: packRun(harnessID), packEnvironment: os.Environ()}, TransportNative, binary)
			require.NoError(t, err)
			firstFiles := snapshotTree(t, first.Root)
			require.NoError(t, first.Cleanup())

			second, err := runner.activatePack(context.Background(), Invocation{Run: packRun(harnessID), packEnvironment: os.Environ()}, TransportNative, binary)
			require.NoError(t, err)
			require.Equal(t, first.Root, second.Root, "the projection path is deterministic")
			require.Equal(t, firstFiles, snapshotTree(t, second.Root), "an exact retry produces the same effective skill set")
			require.NoError(t, second.Cleanup())
			// Cleanup twice succeeds.
			require.NoError(t, second.Cleanup())
		})
	}
}

func TestReconcileStaleProjectionsRefusesARelativeDataRoot(t *testing.T) {
	_, err := ReconcileStaleProjections("relative/root")
	require.Error(t, err)
	removed, err := ReconcileStaleProjections(t.TempDir())
	require.NoError(t, err)
	require.Empty(t, removed, "a data root with no projection prefix is not a failure")
}

// TestInterruptedReplacementIsReconciledAtStartup covers the one unavoidable window in a POSIX
// directory replacement: a crash between moving the outgoing subtree aside and renaming the incoming
// one into place leaves the managed path absent and both complete subtrees inside the temporary
// sibling. Reconciliation at daemon start restores the incoming subtree and removes the sibling; a
// vendor that discovers skills recursively must not keep offering both copies.
func TestInterruptedReplacementIsReconciledAtStartup(t *testing.T) {
	pack, _ := packFixture(t)
	_, codexHome, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, _ := fakeHarnessBinary(t, "codex-cli")
	root := filepath.Join(skillsRoot, ManagedProjectionDirectory)
	temporary := managedTemporarySibling(skillsRoot)

	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	complete := snapshotTree(t, root)

	// Reproduce the crash state by hand: a complete incoming subtree and the previous one moved aside,
	// with the managed path absent.
	require.NoError(t, os.MkdirAll(temporary, 0o755))
	require.NoError(t, os.Rename(root, filepath.Join(temporary, "outgoing")))
	incoming, err := writeProjection(filepath.Join(temporary, "incoming"), pack, ProjectionManaged, nil)
	require.NoError(t, err)
	require.DirExists(t, incoming.Root)
	require.NoDirExists(t, root)

	repaired, err := ReconcileManagedProjections([]string{"CODEX_HOME=" + codexHome})
	require.NoError(t, err)
	require.Equal(t, []string{root}, repaired)
	require.NoDirExists(t, temporary, "the temporary sibling must be gone")
	marker, err := readProjectionMarker(root)
	require.NoError(t, err)
	require.Equal(t, pack.Identity(), marker.Identity())
	require.Equal(t, complete, snapshotTree(t, root))

	// Idempotent: a second start finds nothing to repair.
	repaired, err = ReconcileManagedProjections([]string{"CODEX_HOME=" + codexHome})
	require.NoError(t, err)
	require.Empty(t, repaired)

	// With no complete subtree to restore, the failure is reported rather than papered over, and
	// nothing Barista did not write is removed.
	require.NoError(t, os.RemoveAll(root))
	require.NoError(t, os.MkdirAll(filepath.Join(temporary, "incoming"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(temporary, "incoming", "no-marker.txt"), []byte("x"), 0o644))
	_, err = ReconcileManagedProjections([]string{"CODEX_HOME=" + codexHome})
	require.Error(t, err)
	require.FileExists(t, filepath.Join(temporary, "incoming", "no-marker.txt"))

	// An environment with no resolvable Codex home has nothing to reconcile and is not an error.
	repaired, err = ReconcileManagedProjections(nil)
	require.NoError(t, err)
	require.Empty(t, repaired)
}

// TestReservedTemporarySiblingNeitherAdoptedNorClobbered proves the second path Barista creates in a
// vendor's skills root is protected exactly like the first: content there that Barista did not write
// is never deleted, and a pack-required run refuses rather than clobbering it.
func TestReservedTemporarySiblingNeitherAdoptedNorClobbered(t *testing.T) {
	pack, _ := packFixture(t)
	for _, occupant := range []struct {
		name    string
		install func(t *testing.T, temporary string)
	}{
		{"a foreign directory", func(t *testing.T, temporary string) {
			require.NoError(t, os.MkdirAll(filepath.Join(temporary, "theirs"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(temporary, "theirs", "notes.txt"), []byte("theirs"), 0o644))
		}},
		{"a plain file", func(t *testing.T, temporary string) {
			require.NoError(t, os.WriteFile(temporary, []byte("theirs"), 0o644))
		}},
		{"a symlink", func(t *testing.T, temporary string) {
			if runtime.GOOS == "windows" {
				t.Skip("symlinks are not exercised on this platform")
			}
			target := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(target, "kept.txt"), []byte("kept"), 0o644))
			require.NoError(t, os.Symlink(target, temporary))
		}},
	} {
		t.Run(occupant.name, func(t *testing.T) {
			_, _, skillsRoot := fakeVendorHome(t)
			dataRoot := t.TempDir()
			binary, record := fakeHarnessBinary(t, "codex-cli")
			temporary := managedTemporarySibling(skillsRoot)
			occupant.install(t, temporary)
			before := snapshotTree(t, skillsRoot)

			runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
			_, err := runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
			require.ErrorIs(t, err, ErrPackActivation)
			require.Contains(t, err.Error(), temporary)
			require.NoFileExists(t, record+".args")
			require.Equal(t, before, snapshotTree(t, skillsRoot), "content Barista did not write must be untouched")
		})
	}

	// An interrupted write Barista *did* make is recognized and removed, because the ownership marker
	// is written before any content.
	_, _, skillsRoot := fakeVendorHome(t)
	dataRoot := t.TempDir()
	binary, _ := fakeHarnessBinary(t, "codex-cli")
	temporary := managedTemporarySibling(skillsRoot)
	partial, err := writeProjection(filepath.Join(temporary, "incoming"), pack, ProjectionManaged, nil)
	require.NoError(t, err)
	require.NoError(t, os.RemoveAll(filepath.Join(partial.Root, "skills")))
	runner, _ := packTestRunner(t, "codex-cli", binary, dataRoot, &pack, "", PackRequired, skillsRoot)
	_, err = runner.Execute(context.Background(), Invocation{Run: packRun("codex-cli"), Workspace: dataRoot})
	require.NoError(t, err)
	require.NoDirExists(t, temporary)
	require.DirExists(t, filepath.Join(skillsRoot, ManagedProjectionDirectory))
}

// TestAdapterSurfacesNameThePinnedVendorVersions ties every "verified at the pinned version" claim to
// the component manifest. A pin bump without re-verifying the surface fails here rather than leaving a
// stale claim in a doc comment and a stale recording in testdata.
func TestAdapterSurfacesNameThePinnedVendorVersions(t *testing.T) {
	manifest, err := setup.LoadDefaultManifest()
	require.NoError(t, err)
	pinned := map[string]string{}
	for _, entry := range manifest.ComponentsOfKind(setup.ComponentKindHarness) {
		pinned[entry.HarnessID] = entry.Version
	}
	require.Len(t, pinned, 2)

	recordings := map[string][]string{
		"claude-cli": {"claude-cli-version-output.txt"},
		"codex-cli":  {"codex-cli-version-output.txt"},
	}
	for key, adapter := range packActivationAdapters {
		version, managed := pinned[key.HarnessID]
		require.True(t, managed, "%s has no pinned harness version to verify a surface against", key.HarnessID)
		require.Contains(t, adapter.Surface, version,
			"the %s adapter's surface claims a version the component manifest does not pin", key.HarnessID)
		for _, recording := range recordings[key.HarnessID] {
			content, err := os.ReadFile(filepath.Join("testdata", recording))
			require.NoError(t, err)
			require.Contains(t, string(content), version,
				"%s records a different version than the component manifest pins", recording)
		}
	}
}

// TestCodexCollisionRecordingShowsNoConfirmablePrecedence is the recording the refuse-on-collision
// behavior rests on: with the same skill name offered from inside and from outside the managed
// subtree, codex-cli 0.147.0 lists both entries, so no winner can be confirmed.
func TestCodexCollisionRecordingShowsNoConfirmablePrecedence(t *testing.T) {
	recorded, err := os.ReadFile(filepath.Join("testdata", "codex-cli-collision-precedence-output.txt"))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimRight(string(recorded), "\n"), "\n")
	require.Len(t, lines, 2, "the CLI listed both colliding entries, so neither is the confirmable winner")
	inside, outside := 0, 0
	for _, line := range lines {
		require.Contains(t, line, "shared-skill-name")
		if strings.Contains(line, "/"+ManagedProjectionDirectory+"/") {
			inside++
			continue
		}
		outside++
	}
	require.Equal(t, 1, inside)
	require.Equal(t, 1, outside)
	// Which is why the Codex adapter records a collision with no winner, and the gate refuses.
	require.Empty(t, SkillCollision{Name: "shared-skill-name"}.Winner)
}

// TestClaudePluginManifestRecordingShowsItIsRequired is the recording behind the run-scoped shape: a
// directory without .claude-plugin/plugin.json is rejected outright by the CLI, so the projection must
// carry that one Barista-owned metadata file.
func TestClaudePluginManifestRecordingShowsItIsRequired(t *testing.T) {
	recorded, err := os.ReadFile(filepath.Join("testdata", "claude-cli-plugin-manifest-requirement.txt"))
	require.NoError(t, err)
	require.Contains(t, string(recorded), "No manifest found in directory")
	require.Contains(t, string(recorded), claudePluginManifestPath)
	require.Contains(t, string(recorded), "Validation failed")
	require.Contains(t, projectionMetadataPaths, claudePluginManifestPath)
}
