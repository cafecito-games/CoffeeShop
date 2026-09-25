package capabilitypack

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// skillFrontMatterDelimiter opens and closes a SKILL.md's metadata block.
const skillFrontMatterDelimiter = "---"

// skillMetadataKeys is the closed set of SKILL.md metadata keys. An unknown key is rejected rather
// than ignored, for the same reason the pack manifest decodes strictly: a misspelled key that was
// silently dropped would leave a skill with no activation description at all.
var skillMetadataKeys = []string{"id", "name", "description"}

// skillDescriptionPrefix is the required opening of every skill description. A description owns the
// skill's activation conditions, so it must state them in the one shape every harness adapter and
// every evaluation fixture can be written against.
const skillDescriptionPrefix = "Use when "

// SkillDocument is one parsed SKILL.md: the metadata that decides when the skill activates, and the
// workflow body.
type SkillDocument struct {
	ID          string
	Name        string
	Description string
	Body        string
}

// ParseSkillDocument strictly parses a SKILL.md. A missing metadata block, a missing or empty
// required key, an unknown key, a duplicate key, or an empty body is a rejection: a skill with no
// activation description would activate unpredictably, which is worse than not shipping it.
func ParseSkillDocument(path string, content []byte) (SkillDocument, error) {
	text := string(content)
	if !strings.HasPrefix(text, skillFrontMatterDelimiter+"\n") {
		return SkillDocument{}, fmt.Errorf("skill %s has no metadata block", path)
	}
	remainder := text[len(skillFrontMatterDelimiter)+1:]
	closing := strings.Index(remainder, "\n"+skillFrontMatterDelimiter+"\n")
	if closing < 0 {
		return SkillDocument{}, fmt.Errorf("skill %s has an unterminated metadata block", path)
	}
	block := remainder[:closing]
	body := strings.TrimLeft(remainder[closing+len(skillFrontMatterDelimiter)+2:], "\n")
	values := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		if strings.TrimSpace(line) == "" {
			return SkillDocument{}, fmt.Errorf("skill %s metadata contains a blank line", path)
		}
		key, value, separated := strings.Cut(line, ":")
		if !separated {
			return SkillDocument{}, fmt.Errorf("skill %s metadata line is not a key and value", path)
		}
		key = strings.TrimSpace(key)
		if !slices.Contains(skillMetadataKeys, key) {
			return SkillDocument{}, fmt.Errorf("skill %s metadata declares an unknown key", path)
		}
		if _, duplicate := values[key]; duplicate {
			return SkillDocument{}, fmt.Errorf("skill %s metadata declares a duplicate key", path)
		}
		values[key] = strings.TrimSpace(value)
	}
	for _, key := range skillMetadataKeys {
		if values[key] == "" {
			return SkillDocument{}, fmt.Errorf("skill %s metadata is missing a non-empty %s", path, key)
		}
	}
	document := SkillDocument{ID: values["id"], Name: values["name"], Description: values["description"], Body: body}
	if err := document.validate(path); err != nil {
		return SkillDocument{}, err
	}
	return document, nil
}

func (document SkillDocument) validate(path string) error {
	if !protocol.LabelOrAcceleratorPattern.MatchString(document.ID) {
		return fmt.Errorf("skill %s metadata id is not kebab-case", path)
	}
	if len(document.Name) > maximumNameBytes {
		return fmt.Errorf("skill %s metadata name exceeds %d bytes", path, maximumNameBytes)
	}
	if !strings.HasPrefix(document.Description, skillDescriptionPrefix) {
		return fmt.Errorf("skill %s metadata description must state its activation conditions, beginning %q", path, skillDescriptionPrefix)
	}
	if len(document.Description) < minimumDescriptionBytes || len(document.Description) > maximumDescriptionBytes {
		return fmt.Errorf("skill %s metadata description is shorter than %d or longer than %d bytes", path, minimumDescriptionBytes, maximumDescriptionBytes)
	}
	if strings.TrimSpace(document.Body) == "" {
		return fmt.Errorf("skill %s has no workflow body", path)
	}
	return nil
}

// validateSkillDeclaration checks one declared skill against the vocabulary and the pack layout.
// Paths are fixed by the skill id rather than free-form, so a pack can never ship two skills that
// resolve to the same file or a skill whose evaluation fixture belongs to another skill.
func (skill PackSkill) validateDeclaration(index int, vocabulary Vocabulary) error {
	if !protocol.LabelOrAcceleratorPattern.MatchString(skill.ID) {
		return fmt.Errorf("pack skill at index %d: id is not kebab-case", index)
	}
	if skill.Path != SkillPathFor(skill.ID) {
		return fmt.Errorf("pack skill %s: path must be %s", skill.ID, SkillPathFor(skill.ID))
	}
	if skill.EvaluationPath != EvaluationPathFor(skill.ID) {
		return fmt.Errorf("pack skill %s: evaluationPath must be %s", skill.ID, EvaluationPathFor(skill.ID))
	}
	if len(skill.RequiredTools) == 0 {
		return fmt.Errorf("pack skill %s: requiredTools is empty", skill.ID)
	}
	if err := validateToolList(skill.ID, "requiredTools", skill.RequiredTools, vocabulary); err != nil {
		return err
	}
	if err := validateToolList(skill.ID, "delegationTools", skill.DelegationTools, vocabulary); err != nil {
		return err
	}
	for _, name := range skill.RequiredTools {
		if vocabulary.isDelegationOnly(name) {
			return fmt.Errorf("pack skill %s: %s is delegation-only and must be declared in delegationTools", skill.ID, name)
		}
	}
	for _, name := range skill.DelegationTools {
		if !vocabulary.isDelegationOnly(name) {
			return fmt.Errorf("pack skill %s: %s is served to every run and must be declared in requiredTools", skill.ID, name)
		}
		if slices.Contains(skill.RequiredTools, name) {
			return fmt.Errorf("pack skill %s: %s is declared in both requiredTools and delegationTools", skill.ID, name)
		}
	}
	return nil
}

// validateToolList holds a declared tool list to the running vocabulary: every name must exist, and
// the list must be sorted and duplicate-free so two packs that require the same tools cannot differ
// in their declaration.
func validateToolList(skillID string, field string, names []string, vocabulary Vocabulary) error {
	for index, name := range names {
		if !slices.Contains(vocabulary.ToolNames, name) {
			return fmt.Errorf("pack skill %s: %s names %q, which is not a hub tool", skillID, field, screenDetail(name))
		}
		if index > 0 && name <= names[index-1] {
			return fmt.Errorf("pack skill %s: %s must be sorted and duplicate-free", skillID, field)
		}
	}
	return nil
}

// SkillPathFor and EvaluationPathFor are the only definitions of where a skill's workflow and its
// evaluation fixture live inside a pack.
func SkillPathFor(skillID string) string      { return "skills/" + skillID + "/SKILL.md" }
func EvaluationPathFor(skillID string) string { return "evaluations/" + skillID + ".json" }

// declaredTools is the skill's full tool surface: the tools every run is served plus the
// delegation-only ones it may use when the run delegates.
func (skill PackSkill) declaredTools() []string {
	tools := make([]string, 0, len(skill.RequiredTools)+len(skill.DelegationTools))
	tools = append(tools, skill.RequiredTools...)
	tools = append(tools, skill.DelegationTools...)
	return tools
}

var errNoSkills = errors.New("pack manifest declares no skills")
