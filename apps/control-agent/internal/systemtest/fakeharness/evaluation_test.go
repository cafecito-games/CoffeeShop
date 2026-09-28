package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
)

func evaluationFixture(t *testing.T) (string, evaluationPlan) {
	t.Helper()
	root := t.TempDir()
	skills := []evaluationSkill{}
	for _, id := range []string{"coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-preview", "coffeeshop-task-reporting"} {
		content := []byte("---\nid: " + id + "\n---\n\n# " + id + "\n")
		path := filepath.Join(root, "skills", id, "SKILL.md")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(content)
		skills = append(skills, evaluationSkill{ID: id, Path: "skills/" + id + "/SKILL.md", SHA256: hex.EncodeToString(digest[:])})
	}
	plan := evaluationPlan{
		SchemaVersion: "1", PackID: "coffeeshop-capability-pack", PackVersion: "1.2.0",
		PackDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Skills: skills,
		Cases: []evaluationPlanCase{{
			SkillID: "coffeeshop-preview",
			Evaluation: capabilitypack.EvaluationCase{ID: "direct", Class: capabilitypack.EvaluationClassDirect,
				Prompt: "Publish the preview.", Activates: true, Outcome: capabilitypack.OutcomeFollowWorkflow},
			Steps: []Step{{Message: "published truthfully"}},
		}},
	}
	return root, plan
}

func TestEvaluationPlanStrictlyMatchesPromptAndProjectedSkills(t *testing.T) {
	root, plan := evaluationFixture(t)
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "plan.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadEvaluationPlan(path)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := loaded.caseForPrompt("Publish the preview.")
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := loaded.caseForPrompt("Current Coffee Shop task:\nPublish the preview.\nUse the run-scoped tools.")
	if err != nil || wrapped.Evaluation.ID != "direct" {
		t.Fatalf("did not find the exact declared prompt inside the run wrapper: %+v %v", wrapped, err)
	}
	observation, err := observeProjectedSkills(root, loaded, selected.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Evaluation.ID != "direct" || observation.SelectedSkill != "coffeeshop-preview" || len(observation.DiscoveredSkills) != 4 {
		t.Fatalf("unexpected selection/observation: %+v %+v", selected, observation)
	}
}

func TestEvaluationPlanRejectsUnknownFieldsDuplicatesAndProjectionDrift(t *testing.T) {
	root, plan := evaluationFixture(t)
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	document["unknown"] = true
	unknown, _ := json.Marshal(document)
	path := filepath.Join(t.TempDir(), "unknown.json")
	if err := os.WriteFile(path, unknown, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadEvaluationPlan(path); err == nil {
		t.Fatal("unknown evaluator plan field was accepted")
	}

	plan.Cases = append(plan.Cases, plan.Cases[0])
	duplicate, _ := json.Marshal(plan)
	path = filepath.Join(t.TempDir(), "duplicate.json")
	if err := os.WriteFile(path, duplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadEvaluationPlan(path); err == nil {
		t.Fatal("duplicate evaluator case was accepted")
	}

	_, clean := evaluationFixture(t)
	if err := os.WriteFile(filepath.Join(root, "skills", "coffeeshop-preview", "SKILL.md"), []byte("drifted\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := observeProjectedSkills(root, clean, "coffeeshop-preview"); err == nil {
		t.Fatal("projected skill drift was accepted")
	}

	_, unsafe := evaluationFixture(t)
	unsafe.Cases[0].Steps = []Step{{Call: "publish_preview", AllowError: true}}
	unsafeBytes, _ := json.Marshal(unsafe)
	path = filepath.Join(t.TempDir(), "unsafe.json")
	if err := os.WriteFile(path, unsafeBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadEvaluationPlan(path); err == nil {
		t.Fatal("evaluation plan that swallows a tool error was accepted")
	}
}

func TestToolNamesFromListAreClosedSortedAndUnique(t *testing.T) {
	raw := json.RawMessage(`{"tools":[{"name":"update_task"},{"name":"get_task_context"}]}`)
	names, err := toolNamesFromList(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "get_task_context" || names[1] != "update_task" {
		t.Fatalf("unexpected tools: %v", names)
	}
	for _, invalid := range []json.RawMessage{
		json.RawMessage(`{"tools":[{"name":"update_task"},{"name":"update_task"}]}`),
		json.RawMessage(`{"tools":[{"name":"update_task","extra":true}]}`),
		json.RawMessage(`{"tools":[{"name":""}]}`),
	} {
		if _, err := toolNamesFromList(invalid); err == nil {
			t.Fatalf("invalid tools/list result was accepted: %s", invalid)
		}
	}
}
