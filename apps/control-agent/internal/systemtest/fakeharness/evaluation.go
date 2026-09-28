package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
)

const (
	evaluationPlanVariable     = "COFFEE_SHOP_FAKE_EVALUATION_PLAN"
	maximumEvaluationPlanBytes = 1024 * 1024
)

type evaluationSkill struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type evaluationPlanCase struct {
	SkillID     string                        `json:"skillId"`
	Evaluation  capabilitypack.EvaluationCase `json:"evaluation"`
	MissingTool string                        `json:"missingTool,omitempty"`
	Steps       []Step                        `json:"steps"`
}

type evaluationPlan struct {
	SchemaVersion string               `json:"schemaVersion"`
	PackID        string               `json:"packId"`
	PackVersion   string               `json:"packVersion"`
	PackDigest    string               `json:"packDigest"`
	Skills        []evaluationSkill    `json:"skills"`
	Cases         []evaluationPlanCase `json:"cases"`
}

type evaluationObservation struct {
	DiscoveredSkills []string
	SelectedSkill    string
	SelectedSHA256   string
}

func loadEvaluationPlan(path string) (evaluationPlan, error) {
	if path == "" {
		return evaluationPlan{}, errors.New("evaluation plan path is empty")
	}
	information, err := os.Lstat(path)
	if err != nil || !information.Mode().IsRegular() || information.Size() > maximumEvaluationPlanBytes {
		return evaluationPlan{}, errors.New("evaluation plan is absent, not regular, or oversized")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return evaluationPlan{}, errors.New("evaluation plan could not be read")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var plan evaluationPlan
	if err := decoder.Decode(&plan); err != nil {
		return evaluationPlan{}, fmt.Errorf("decode evaluation plan: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return evaluationPlan{}, errors.New("evaluation plan has trailing data")
	}
	if err := plan.validate(); err != nil {
		return evaluationPlan{}, err
	}
	return plan, nil
}

func (plan evaluationPlan) validate() error {
	if plan.SchemaVersion != "1" || plan.PackID == "" || plan.PackVersion == "" || !isSHA256(plan.PackDigest) {
		return errors.New("evaluation plan identity is invalid")
	}
	if len(plan.Skills) == 0 || len(plan.Cases) == 0 {
		return errors.New("evaluation plan is empty")
	}
	skillIDs := map[string]evaluationSkill{}
	previous := ""
	for _, skill := range plan.Skills {
		if skill.ID == "" || skill.ID <= previous || !isSHA256(skill.SHA256) || skill.Path != capabilitypack.SkillPathFor(skill.ID) {
			return errors.New("evaluation plan skills are malformed, unsorted, or duplicated")
		}
		previous = skill.ID
		skillIDs[skill.ID] = skill
	}
	caseIDs := map[string]bool{}
	prompts := map[string]bool{}
	for _, item := range plan.Cases {
		evaluation := item.Evaluation
		key := item.SkillID + "\x00" + evaluation.ID
		_, knownSkill := skillIDs[item.SkillID]
		if !knownSkill || evaluation.ID == "" || evaluation.Prompt == "" || caseIDs[key] || prompts[evaluation.Prompt] || len(item.Steps) == 0 {
			return errors.New("evaluation plan cases are malformed or duplicated")
		}
		if !slices.Contains(capabilitypack.EvaluationClasses, evaluation.Class) || !slices.Contains(capabilitypack.EvaluationOutcomes, evaluation.Outcome) || evaluation.ClaimsSuccess {
			return errors.New("evaluation plan case expectation is invalid")
		}
		if (evaluation.Outcome == capabilitypack.OutcomeNoActivation) == evaluation.Activates {
			return errors.New("evaluation plan activation contradicts its outcome")
		}
		if (evaluation.Outcome == capabilitypack.OutcomeReportUnsupportedCapability) != (item.MissingTool != "") {
			return errors.New("evaluation plan missing-tool evidence contradicts its outcome")
		}
		caseIDs[key] = true
		prompts[evaluation.Prompt] = true
	}
	return nil
}

func (plan evaluationPlan) caseForPrompt(prompt string) (evaluationPlanCase, error) {
	var matched *evaluationPlanCase
	for _, item := range plan.Cases {
		if item.Evaluation.Prompt == prompt || strings.Contains(prompt, item.Evaluation.Prompt) {
			if matched != nil {
				return evaluationPlanCase{}, errors.New("prompt contains more than one declared evaluation")
			}
			copy := item
			matched = &copy
		}
	}
	if matched != nil {
		return *matched, nil
	}
	return evaluationPlanCase{}, errors.New("prompt is not declared by the installed evaluation plan")
}

func observeProjectedSkills(root string, plan evaluationPlan, selected string) (evaluationObservation, error) {
	if root == "" || !filepath.IsAbs(root) {
		return evaluationObservation{}, errors.New("projected skill root is not absolute")
	}
	found := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("projected skill document is not regular")
		}
		id := filepath.Base(filepath.Dir(path))
		if _, duplicate := found[id]; duplicate {
			return errors.New("projected skill identity is duplicated")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		found[id] = hex.EncodeToString(digest[:])
		return nil
	})
	if err != nil {
		return evaluationObservation{}, fmt.Errorf("inspect projected skills: %w", err)
	}
	discovered := make([]string, 0, len(found))
	for id := range found {
		discovered = append(discovered, id)
	}
	slices.Sort(discovered)
	want := make([]string, 0, len(plan.Skills))
	for _, skill := range plan.Skills {
		want = append(want, skill.ID)
		if found[skill.ID] != skill.SHA256 {
			return evaluationObservation{}, fmt.Errorf("projected skill %s does not match the installed plan", skill.ID)
		}
	}
	if !slices.Equal(discovered, want) {
		return evaluationObservation{}, errors.New("projected skill set differs from the installed plan")
	}
	observation := evaluationObservation{DiscoveredSkills: discovered}
	if selected != "" {
		index, known := slices.BinarySearchFunc(plan.Skills, selected, func(skill evaluationSkill, id string) int {
			return strings.Compare(skill.ID, id)
		})
		if !known {
			return evaluationObservation{}, errors.New("selected skill is absent from the installed plan")
		}
		observation.SelectedSkill = selected
		observation.SelectedSHA256 = plan.Skills[index].SHA256
	}
	return observation, nil
}

func isSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func nativeProjectionRoot(role string, arguments []string) (string, error) {
	if role == "codex" {
		root := os.Getenv("CODEX_HOME")
		if root == "" {
			home := os.Getenv("HOME")
			if home == "" {
				return "", errors.New("Codex evaluation has neither CODEX_HOME nor HOME")
			}
			root = filepath.Join(home, ".codex")
		}
		return filepath.Join(root, "skills", "coffee-shop-barista"), nil
	}
	for index := 0; index+1 < len(arguments); index++ {
		if arguments[index] == "--plugin-dir" {
			return arguments[index+1], nil
		}
	}
	return "", errors.New("Claude evaluation has no projected plugin directory")
}

func runNativeEvaluation(host host, client *mcpClient, role string, arguments []string, prompt, workingDirectory string) (bool, error) {
	path := os.Getenv(evaluationPlanVariable)
	if path == "" {
		return false, nil
	}
	plan, err := loadEvaluationPlan(path)
	if err != nil {
		return true, err
	}
	item, err := plan.caseForPrompt(prompt)
	if err != nil {
		return true, err
	}
	root, err := nativeProjectionRoot(role, arguments)
	if err != nil {
		return true, err
	}
	selected := ""
	if item.Evaluation.Activates {
		selected = item.SkillID
	}
	observation, err := observeProjectedSkills(root, plan, selected)
	if err != nil {
		return true, err
	}
	if client == nil {
		return true, errors.New("evaluation run has no Coffee Shop MCP server")
	}
	if err := client.connect(context.Background()); err != nil {
		return true, err
	}
	served := client.toolNames()
	visible := slices.Clone(served)
	if item.MissingTool != "" {
		index := slices.Index(visible, item.MissingTool)
		if index < 0 {
			return true, fmt.Errorf("missing-tool case names %s, which the real server did not serve", item.MissingTool)
		}
		visible = append(visible[:index:index], visible[index+1:]...)
	}
	activeRecorder.write(map[string]any{
		"event": "evaluation-start", "packId": plan.PackID, "packVersion": plan.PackVersion,
		"packDigest": plan.PackDigest, "skillId": item.SkillID, "caseId": item.Evaluation.ID,
		"class": item.Evaluation.Class, "outcome": item.Evaluation.Outcome, "harnessId": role + "-cli",
		"transport": "native-cli", "discoveredSkills": observation.DiscoveredSkills,
		"selectedSkill": observation.SelectedSkill, "selectedSkillSha256": observation.SelectedSHA256,
		"servedTools": served, "visibleTools": visible, "hiddenTool": item.MissingTool,
	})
	if item.MissingTool != "" {
		for _, step := range item.Steps {
			if step.Call == item.MissingTool {
				return true, errors.New("missing-tool evaluation attempts to call its hidden tool")
			}
		}
	}
	engine := newEngine(host, client, prompt, workingDirectory, "")
	engine.variables["harness"] = role + "-cli"
	err = engine.run(context.Background(), Script{Steps: item.Steps})
	activeRecorder.write(map[string]any{
		"event": "evaluation-result", "packId": plan.PackID, "packVersion": plan.PackVersion,
		"packDigest": plan.PackDigest, "skillId": item.SkillID, "caseId": item.Evaluation.ID,
		"class": item.Evaluation.Class, "outcome": item.Evaluation.Outcome,
		"harnessId": role + "-cli", "transport": "native-cli",
		"selectedSkill": observation.SelectedSkill, "claimsSuccess": false, "completed": err == nil,
	})
	return true, err
}
