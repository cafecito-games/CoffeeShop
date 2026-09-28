package capabilitypack

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Tree is one pack's complete content, keyed by pack-relative forward-slash path. It is the only
// input shape the validator accepts, so the same rules apply whether the content came from the
// repository working tree or from an installed archive — there is no build-only check and no
// install-only check.
type Tree map[string][]byte

// Paths returns every path in the tree in sorted order, which is also the order the deterministic
// packer writes them in.
func (tree Tree) Paths() []string {
	return slices.Sorted(maps.Keys(tree))
}

// Validate is the single validator every producer and consumer of a capability pack runs. It
// returns the parsed pack manifest only when every rule holds; any failure produces no manifest, no
// archive, and no activation.
//
// Rules are ordered so that a rejection never echoes untrusted bytes: every file is screened for
// secret-like content before anything is decoded, and a path is only ever named in a diagnostic
// after it matched the packaged-path grammar.
func Validate(tree Tree, vocabulary Vocabulary) (PackManifest, error) {
	if err := vocabulary.validate(); err != nil {
		return PackManifest{}, err
	}
	if len(tree) == 0 {
		return PackManifest{}, errNoPackManifest
	}
	if len(tree) > MaximumPackFiles {
		return PackManifest{}, fmt.Errorf("pack tree carries more than %d files", MaximumPackFiles)
	}
	total := 0
	for _, path := range tree.Paths() {
		if err := validatePackPath(path); err != nil {
			// The path failed the grammar, so it is never echoed; the tree is reported as a whole.
			return PackManifest{}, fmt.Errorf("pack tree carries an unsafe path: %w", err)
		}
		if err := screenSecrets(path, tree[path]); err != nil {
			return PackManifest{}, err
		}
		total += len(tree[path])
	}
	if total > MaximumPackBytes {
		return PackManifest{}, fmt.Errorf("pack tree exceeds %d bytes", MaximumPackBytes)
	}
	manifestBytes, present := tree[PackManifestPath]
	if !present {
		return PackManifest{}, errNoPackManifest
	}
	manifest, err := ParsePackManifest(manifestBytes)
	if err != nil {
		return PackManifest{}, err
	}
	if err := manifest.validateIdentity(); err != nil {
		return PackManifest{}, err
	}
	if err := manifest.validateVocabulary(vocabulary); err != nil {
		return PackManifest{}, err
	}
	if err := manifest.validateFiles(); err != nil {
		return PackManifest{}, err
	}
	if err := manifest.reconcileFiles(tree); err != nil {
		return PackManifest{}, err
	}
	for _, path := range tree.Paths() {
		if err := screenContent(path, tree[path]); err != nil {
			return PackManifest{}, err
		}
	}
	if err := manifest.validateSkills(tree, vocabulary); err != nil {
		return PackManifest{}, err
	}
	if err := manifest.validateProse(tree, vocabulary); err != nil {
		return PackManifest{}, err
	}
	return manifest, nil
}

// reconcileFiles checks the declared file set against the tree in both directions and verifies every
// digest. An undeclared extra file is as fatal as a missing declared one: a pack whose content is
// not entirely accounted for by its manifest is a pack whose digest proves nothing about what a
// harness would read.
func (manifest PackManifest) reconcileFiles(tree Tree) error {
	declared := make(map[string]string, len(manifest.Files))
	for _, file := range manifest.Files {
		content, present := tree[file.Path]
		if !present {
			return fmt.Errorf("pack file %s is declared by the pack manifest but missing from the tree", file.Path)
		}
		digest := sha256.Sum256(content)
		if hex.EncodeToString(digest[:]) != file.SHA256 {
			// The content is never printed; only the path, which already matched the grammar.
			return fmt.Errorf("pack file %s does not match the digest the pack manifest pins it at", file.Path)
		}
		declared[file.Path] = file.SHA256
	}
	for _, path := range tree.Paths() {
		if path == PackManifestPath {
			continue
		}
		if _, ok := declared[path]; !ok {
			return fmt.Errorf("pack file %s is present in the tree but not declared by the pack manifest", path)
		}
	}
	return nil
}

// validateSkills resolves every declared skill to its workflow document and its evaluation fixture.
func (manifest PackManifest) validateSkills(tree Tree, vocabulary Vocabulary) error {
	if len(manifest.Skills) == 0 {
		return errNoSkills
	}
	seenIDs := map[string]bool{}
	declaredTools := map[string]bool{}
	for index, skill := range manifest.Skills {
		if err := skill.validateDeclaration(index, vocabulary); err != nil {
			return err
		}
		if seenIDs[skill.ID] {
			return fmt.Errorf("pack skill %s: duplicate skill id", skill.ID)
		}
		seenIDs[skill.ID] = true
		content, present := tree[skill.Path]
		if !present {
			return fmt.Errorf("pack skill %s: %s is missing", skill.ID, skill.Path)
		}
		document, err := ParseSkillDocument(skill.Path, content)
		if err != nil {
			return err
		}
		if document.ID != skill.ID {
			return fmt.Errorf("pack skill %s: %s declares a different skill id", skill.ID, skill.Path)
		}
		fixture, present := tree[skill.EvaluationPath]
		if !present {
			return fmt.Errorf("pack skill %s: %s is missing", skill.ID, skill.EvaluationPath)
		}
		suite, err := ParseEvaluationSuite(skill.EvaluationPath, fixture)
		if err != nil {
			return err
		}
		if err := suite.validate(skill.EvaluationPath, skill.ID); err != nil {
			return err
		}
		if err := skill.reconcileProse(document); err != nil {
			return err
		}
		for _, name := range skill.declaredTools() {
			declaredTools[name] = true
		}
	}
	// The manifest and generated reference cover the complete served vocabulary. Every served tool
	// must also belong to at least one focused workflow, and each skill reconciles its declaration
	// exactly against its own prose above. Advertising a tool therefore neither silently grants it nor
	// leaves a model-visible capability without guidance about when and how to use it.
	for _, name := range vocabulary.ToolNames {
		if !declaredTools[name] {
			return fmt.Errorf("hub tool %s is served by the run-scoped MCP server but no pack skill declares it", name)
		}
	}
	return nil
}

// reconcileProse requires a skill's declared tool surface and the tools its workflow text actually
// names to be exactly the same set. A tool named in prose but not declared would escape the
// delegation and vocabulary checks; a tool declared but never taught would be an unfulfilled promise
// to whatever consumes the declaration.
func (skill PackSkill) reconcileProse(document SkillDocument) error {
	named := toolNamesInProse(document.Body + "\n" + document.Description)
	declared := skill.declaredTools()
	for _, name := range named {
		if !slices.Contains(declared, name) {
			return fmt.Errorf("pack skill %s: its workflow names %s, which the skill does not declare", skill.ID, name)
		}
	}
	for _, name := range declared {
		if !slices.Contains(named, name) {
			return fmt.Errorf("pack skill %s: it declares %s but its workflow never teaches it", skill.ID, name)
		}
	}
	return nil
}

// validateProse holds every other Markdown file in the pack to the vocabulary too. A reference that
// still names a renamed tool is drift, and drift must break validation rather than ship.
func (manifest PackManifest) validateProse(tree Tree, vocabulary Vocabulary) error {
	skillPaths := map[string]bool{}
	for _, skill := range manifest.Skills {
		skillPaths[skill.Path] = true
	}
	for _, path := range tree.Paths() {
		if skillPaths[path] || !strings.HasSuffix(path, ".md") {
			continue
		}
		for _, name := range toolNamesInProse(string(tree[path])) {
			if !slices.Contains(vocabulary.ToolNames, name) {
				return fmt.Errorf("pack file %s names %s, which is not a hub tool", path, screenDetail(name))
			}
		}
	}
	return nil
}
