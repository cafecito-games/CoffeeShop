package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// claudePluginManifestPath is where the Claude CLI requires a plugin directory's manifest. Verified
// against claude 2.1.231, the version internal/setup/manifest/components.json pins: `claude plugin
// validate <dir>` on a directory without it fails with "No manifest found in directory. Expected
// .claude-plugin/marketplace.json or .claude-plugin/plugin.json".
const claudePluginManifestPath = ".claude-plugin/plugin.json"

// claudePluginSkillsDirectory is the manifest's declared skills root, relative to the plugin
// directory. It is the pack tree's own skills directory, which capabilitypack.SkillPathFor owns.
const claudePluginSkillsDirectory = "./skills"

// claudePluginDirectoryAdapter drives the Claude CLI's run-scoped plugin surface.
//
// Surface verification, against the installed claude 2.1.231 — exactly the pinned version:
//
//	$ claude --version
//	2.1.231 (Claude Code)
//	$ claude --help
//	  --plugin-dir <path>   Load a plugin from a directory or .zip for this session only
//	                        (repeatable: --plugin-dir A --plugin-dir B.zip) (default: [])
//
// Because the surface is session-only, a Claude native run writes nothing at all into vendor
// configuration: the projection lives under the Barista data root and is removed when the run ends.
//
// Discovery is confirmed against the same binary, offline and without credentials:
//
//	$ claude --plugin-dir <root> plugin details coffee-shop-barista
//	coffee-shop-barista 1.0.0
//	Component inventory
//	  Skills (3)  coffeeshop-artifacts, coffeeshop-coordination, coffeeshop-task-reporting
//
// which also established that Claude keys a skill by the directory it occupies, not by the name its
// SKILL.md metadata declares — the opposite of Codex. That is why each adapter supplies the vendor's
// own key rather than sharing one assumption.
func claudePluginDirectoryAdapter() packActivationAdapter {
	return packActivationAdapter{
		Surface: "claude --plugin-dir <path> (session-only, verified on claude 2.1.231)",
		Shape:   ProjectionRunScoped,
		Project: projectClaudePluginDirectory,
		Confirm: confirmClaudePluginDiscovery,
	}
}

// claudePluginManifest is the minimum manifest the Claude CLI accepts for a plugin directory. It
// carries the pack's own identity and summary and nothing Barista invented: no endpoint, no token,
// no absolute path, and no tool grant.
type claudePluginManifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Skills      []string `json:"skills"`
}

func projectClaudePluginDirectory(projectionContext packProjectionContext) (*PackProjection, error) {
	pack := projectionContext.Pack
	root, err := runScopedProjectionRoot(projectionContext.DataRoot, projectionContext.RunID, pack.ID, pack.Version)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	runRoot, err := runScopedRunRoot(projectionContext.DataRoot, projectionContext.RunID)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	// A retry of the same run reuses nothing: the previous attempt's own directory is removed so the
	// projection is written into a directory this call created and can never merge with a partial one.
	if err := removeIfOwned(runRoot); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	manifest, err := json.MarshalIndent(claudePluginManifest{
		Name:        ManagedProjectionDirectory,
		Version:     pack.Version,
		Description: pack.Manifest.Summary,
		Skills:      []string{claudePluginSkillsDirectory},
	}, "", "  ")
	if err != nil {
		return nil, err
	}
	projection, err := writeProjection(root, pack, ProjectionRunScoped, map[string][]byte{
		claudePluginManifestPath: append(manifest, '\n'),
	})
	if err != nil {
		removeIfOwned(runRoot)
		return nil, fmt.Errorf("%w: %s", ErrPackActivation, err.Error())
	}
	// Claude keys a skill by its directory, which is the pack skill's own id.
	projection.SkillNames = slices.Sorted(slices.Values(pack.Manifest.SkillIDs()))
	projection.Arguments = []string{"--plugin-dir", root}
	projection.cleanup = func() error { return removeIfOwned(runRoot) }
	return projection, nil
}

// confirmClaudePluginDiscovery asks the same executable the run will launch whether it resolved the
// projection, using its own offline plugin inventory. A discovery that cannot be confirmed fails
// exactly like a discovery that never happened.
func confirmClaudePluginDiscovery(ctx context.Context, projectionContext packProjectionContext, projection *PackProjection) error {
	output, err := runVendorInventory(ctx, projectionContext, []string{"--plugin-dir", projection.Root, "plugin", "details", ManagedProjectionDirectory})
	if err != nil {
		return packUnavailablef("the Claude CLI could not be asked whether it resolved the projected capability pack skills, so pack discovery is unconfirmed: %s", err.Error())
	}
	inventory := claudeSkillInventory(output)
	for _, name := range projection.SkillNames {
		if !slices.Contains(inventory, name) {
			return packUnavailablef("the Claude CLI did not list the projected capability pack skill %s, so pack discovery is unconfirmed", name)
		}
	}
	return nil
}

// claudeSkillInventory reads the skill names out of `claude plugin details` output. The command's
// inventory line is "  Skills (3)  a, b, c"; a plugin with none prints "Skills (0)" and no names.
func claudeSkillInventory(output string) []string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "Skills (") {
			continue
		}
		_, listed, closed := strings.Cut(trimmed, ")")
		if !closed {
			return nil
		}
		names := make([]string, 0, 4)
		for _, name := range strings.Split(listed, ",") {
			if trimmedName := strings.TrimSpace(name); trimmedName != "" {
				names = append(names, trimmedName)
			}
		}
		return names
	}
	return nil
}
