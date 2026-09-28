//go:build system && unix

package systemtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/harness"
)

type systemEvaluationSkill struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type systemEvaluationCase struct {
	SkillID     string                        `json:"skillId"`
	Evaluation  capabilitypack.EvaluationCase `json:"evaluation"`
	MissingTool string                        `json:"missingTool,omitempty"`
	Steps       []step                        `json:"steps"`
}

type systemEvaluationPlan struct {
	SchemaVersion string                  `json:"schemaVersion"`
	PackID        string                  `json:"packId"`
	PackVersion   string                  `json:"packVersion"`
	PackDigest    string                  `json:"packDigest"`
	Skills        []systemEvaluationSkill `json:"skills"`
	Cases         []systemEvaluationCase  `json:"cases"`
}

func installedEvaluationPlan(t *testing.T, installed installedSystemCapabilityPack) systemEvaluationPlan {
	t.Helper()
	plan := systemEvaluationPlan{SchemaVersion: "1", PackID: installed.manifest.ID, PackVersion: installed.manifest.Version, PackDigest: installed.digest}
	for _, declared := range installed.manifest.Skills {
		document := installed.tree[declared.Path]
		digest := sha256.Sum256(document)
		plan.Skills = append(plan.Skills, systemEvaluationSkill{ID: declared.ID, Path: declared.Path, SHA256: hex.EncodeToString(digest[:])})
		suite, err := capabilitypack.ParseEvaluationSuite(declared.EvaluationPath, installed.tree[declared.EvaluationPath])
		if err != nil {
			t.Fatalf("installed evaluation %s: %v", declared.EvaluationPath, err)
		}
		if suite.SkillID != declared.ID {
			t.Fatalf("installed evaluation %s names %s", declared.EvaluationPath, suite.SkillID)
		}
		for _, evaluation := range suite.Cases {
			plan.Cases = append(plan.Cases, systemEvaluationCase{
				SkillID: declared.ID, Evaluation: evaluation,
				MissingTool: missingEvaluationTool(declared.ID, evaluation),
				Steps:       evaluationSteps(t, declared.ID, evaluation),
			})
		}
	}
	sort.Slice(plan.Skills, func(left, right int) bool { return plan.Skills[left].ID < plan.Skills[right].ID })
	return plan
}

func missingEvaluationTool(skillID string, evaluation capabilitypack.EvaluationCase) string {
	if evaluation.Outcome != capabilitypack.OutcomeReportUnsupportedCapability {
		return ""
	}
	switch skillID {
	case "coffeeshop-artifacts":
		return "post_artifact"
	case "coffeeshop-coordination":
		return "delegate_task"
	case "coffeeshop-preview":
		return "publish_preview"
	case "coffeeshop-task-reporting":
		return "update_task"
	default:
		return "unknown"
	}
}

// evaluationSteps is intentionally exhaustive over producer identity. It supplies executable state
// and actions, but never duplicates the producer-owned prompt, class, activation, or outcome.
func evaluationSteps(t *testing.T, skillID string, evaluation capabilitypack.EvaluationCase) []step {
	t.Helper()
	message := fmt.Sprintf("evaluation %s/%s: %s", skillID, evaluation.ID, evaluation.Outcome)
	switch evaluation.Outcome {
	case capabilitypack.OutcomeNoActivation, capabilitypack.OutcomeRequestMissingInput, capabilitypack.OutcomeReportUnsupportedCapability:
		return []step{{Message: message}}
	case capabilitypack.OutcomeReportRefusal:
		context := step{Call: "get_task_context", Arguments: map[string]any{}, As: "context"}
		var refused step
		switch skillID {
		case "coffeeshop-artifacts":
			refused = step{Call: "post_artifact", Arguments: map[string]any{"relativePath": "../outside", "title": "refused", "kind": "report", "mediaType": "text/plain", "idempotencyKey": "eval-refused-{{harness}}"}, AllowError: true, As: "refusal"}
		case "coffeeshop-preview":
			refused = step{Call: "publish_preview", Arguments: map[string]any{"relativePath": "../outside", "entrypoint": "index.html", "title": "refused", "idempotencyKey": "eval-refused-{{harness}}"}, AllowError: true, As: "refusal"}
		case "coffeeshop-coordination":
			refused = step{Call: "get_instance", Arguments: map[string]any{"instanceId": "instance-outside-authority"}, AllowError: true, As: "refusal"}
		case "coffeeshop-task-reporting":
			refused = step{Call: "update_thread", Arguments: map[string]any{"status": "completed"}, AllowError: true, As: "refusal"}
		default:
			t.Fatalf("no refusal scenario for installed skill %s", skillID)
		}
		return []step{context, refused, {Message: message}}
	case capabilitypack.OutcomeFollowWorkflow:
		key := strings.NewReplacer("_", "-", "/", "-").Replace(evaluation.ID) + "-{{harness}}"
		switch skillID {
		case "coffeeshop-coordination":
			return []step{
				{Call: "get_task_context", Arguments: map[string]any{}, As: "context"},
				{Call: "get_execution_inventory", Arguments: map[string]any{}, As: "inventory"},
				{Call: "wait_for_task_events", Arguments: map[string]any{"timeoutMilliseconds": 0, "maximumEvents": 1}, As: "events"},
				{Message: message},
			}
		case "coffeeshop-artifacts":
			path := filepath.ToSlash(filepath.Join("evaluation", key+".txt"))
			return []step{
				{WriteFile: &writeFile{Path: path, Content: "producer-derived artifact\n"}},
				{Call: "get_task_context", Arguments: map[string]any{}, As: "context"},
				{Call: "post_artifact", Arguments: map[string]any{"relativePath": path, "title": key, "kind": "report", "mediaType": "text/plain", "idempotencyKey": "artifact-" + key}, As: "artifact"},
				{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "attach-" + key, "completion": map[string]any{"summary": message, "artifactIds": []string{"{{artifact.id}}"}}}, As: "updated"},
				{Message: message},
			}
		case "coffeeshop-task-reporting":
			return []step{
				{Call: "get_task_context", Arguments: map[string]any{}, As: "context"},
				{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "progress-" + key, "progress": message}, As: "updated"},
				{Call: "update_thread", Arguments: map[string]any{"summary": message}, AllowError: true, As: "thread"},
				{Message: message},
			}
		case "coffeeshop-preview":
			root := filepath.ToSlash(filepath.Join("preview", key))
			steps := []step{
				{WriteFile: &writeFile{Path: filepath.ToSlash(filepath.Join(root, "index.html")), Content: "<!doctype html><title>evaluation</title>"}},
				{Call: "get_task_context", Arguments: map[string]any{}, As: "context"},
				{Call: "publish_preview", Arguments: map[string]any{"relativePath": root, "entrypoint": "index.html", "title": key, "idempotencyKey": "preview-" + key}, As: "preview"},
			}
			if evaluation.ID == "edge-failed" {
				steps[2].AllowError = true
				return append(steps, step{Message: message})
			}
			return append(steps,
				step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "attach-" + key, "completion": map[string]any{"summary": message, "artifactIds": []string{"{{preview.artifact.id}}"}}}, As: "updated"},
				step{Message: message},
			)
		default:
			t.Fatalf("no workflow scenario for installed skill %s", skillID)
		}
	default:
		t.Fatalf("no executable scenario for %s/%s outcome %s", skillID, evaluation.ID, evaluation.Outcome)
	}
	return nil
}

func evaluationRequirements(skillID, harnessID string) map[string]any {
	model := "sonnet"
	if harnessID == "codex-cli" {
		model = "default"
	}
	return map[string]any{
		"skills": []string{skillID}, "harnessIds": []string{harnessID}, "models": []string{model},
		"transports": []string{"native-cli"}, "operatingSystems": []string{runtime.GOOS}, "labels": []string{"pack-matrix"},
	}
}

func evaluationRequirementsAt(skillID, harnessID, label string) map[string]any {
	requirements := evaluationRequirements(skillID, harnessID)
	requirements["labels"] = []string{label}
	return requirements
}

func writeEvaluationPlan(t *testing.T, root string, plan systemEvaluationPlan) string {
	t.Helper()
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "evaluation-plan.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func manifestWithCanonicalAdapters(t *testing.T, installed installedSystemCapabilityPack, root string) string {
	t.Helper()
	canonicalPath := filepath.Join(repositoryRoot, "apps", "control-agent", "internal", "setup", "manifest", "components.json")
	encoded, err := os.ReadFile(canonicalPath)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Components []struct{ ID, Kind, Version string } `json:"components"`
	}
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, component := range document.Components {
		found = found || (component.ID == installed.manifest.ID && component.Kind == "capability-pack" && component.Version == installed.version)
	}
	if !found {
		t.Fatal("canonical adapter manifest does not declare the installed capability pack identity")
	}
	path := filepath.Join(root, "capability-pack-with-canonical-adapters.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func createDelegatingTemplate(t *testing.T, cluster *environment, harnessID, skillID string) string {
	t.Helper()
	var result map[string]any
	status := cluster.hub.request(http.MethodPost, "/api/agent-templates", map[string]any{
		"idempotencyKey": "matrix-template-" + harnessID, "name": "Matrix delegator " + harnessID,
		"requirements": evaluationRequirements(skillID, harnessID), "delegation": map[string]any{"canDelegate": true},
	}, &result)
	if status != http.StatusCreated {
		t.Fatalf("create %s template: status=%d result=%v", harnessID, status, result)
	}
	return text(object(result, "template"), "id")
}

// TestCapabilityPackNativeEvaluationMatrix is closed over the installed pack: adding a skill or
// fixture row grows the expected set and fails unless the exhaustive executable-state registry can
// run it. The fake provider is deterministic integration machinery, not a model-quality oracle.
func TestCapabilityPackNativeEvaluationMatrix(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.prepareNode(nodeOptions{id: "pack-matrix", labels: []string{"pack-matrix"}, concurrency: 4, instanceCapacity: integer(8)})
	installed := installSystemCapabilityPack(t, node, true)
	plan := installedEvaluationPlan(t, installed)
	if err := os.MkdirAll(filepath.Join(node.home, ".codex", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	node.options.componentManifest = installed.manifestPath
	node.options.fakeEvaluationPlan = writeEvaluationPlan(t, cluster.root, plan)
	node.start()

	clientID, secret := cluster.mintOrchestratorClient("Capability-pack matrix", "orchestrate")
	bridge := cluster.startBridge("capability-pack-matrix", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Capability-pack matrix", "objective": "Execute every installed evaluation exactly once on each supported native harness."})
	threadID := text(object(created, "thread"), "id")

	type residentKey struct{ harness, skill string }
	residents := map[residentKey]string{}
	templates := map[string]string{}
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		templates[harnessID] = createDelegatingTemplate(t, cluster, harnessID, "coffeeshop-coordination")
		for _, skill := range plan.Skills {
			if skill.ID == "coffeeshop-coordination" {
				continue
			}
			spawned := bridge.mustCallTool("spawn_instance", map[string]any{
				"threadId": threadID, "idempotencyKey": "matrix-resident-" + harnessID + "-" + skill.ID,
				"requirements": evaluationRequirements(skill.ID, harnessID),
			})
			instanceID := text(object(spawned, "instance"), "id")
			cluster.eventually("matrix resident "+harnessID+"/"+skill.ID, func(current snapshot) (bool, string) {
				instance, known := instanceByID(current, instanceID)
				return known && instance.Status == "ready", "resident is not ready"
			})
			residents[residentKey{harnessID, skill.ID}] = instanceID
		}
	}

	expected := map[string]bool{}
	for harnessIndex, harnessID := range []string{"claude-cli", "codex-cli"} {
		for caseIndex, item := range plan.Cases {
			semanticID := strings.Join([]string{plan.PackID, plan.PackVersion, plan.PackDigest, item.SkillID, item.Evaluation.ID, harnessID, "native-cli"}, "|")
			expected[semanticID] = true
			key := fmt.Sprintf("matrix-%d-%03d", harnessIndex, caseIndex)
			title := key + "-" + item.SkillID + "-" + item.Evaluation.ID
			task := taskSpecification{Key: key, Title: title, Instructions: item.Evaluation.Prompt, Requirements: evaluationRequirements(item.SkillID, harnessID)}
			if item.SkillID == "coffeeshop-coordination" {
				if resident := residents[residentKey{harnessID, item.SkillID}]; resident != "" {
					task.Pin = map[string]any{"instanceId": resident}
				} else {
					task.Requirements = map[string]any{"templateId": templates[harnessID]}
				}
			} else {
				task.Pin = map[string]any{"instanceId": residents[residentKey{harnessID, item.SkillID}]}
			}
			bridge.mustCallTool("submit_tasks", map[string]any{"threadId": threadID, "idempotencyKey": key, "tasks": []taskSpecification{task}})
			terminal := cluster.eventually(title+" completion", func(current snapshot) (bool, string) {
				currentTask, known := taskByTitle(current, threadID, title)
				return known && (currentTask.Status == "completed" || currentTask.Status == "failed"), "evaluation is not terminal"
			})
			currentTask, _ := taskByTitle(terminal, threadID, title)
			if currentTask.Status != "completed" {
				t.Fatalf("%s failed: %s", semanticID, currentTask.Error)
			}
			if item.SkillID == "coffeeshop-coordination" && residents[residentKey{harnessID, item.SkillID}] == "" {
				attempt, ok := terminal.latestAttempt(currentTask)
				if !ok || attempt.InstanceID == "" {
					t.Fatalf("%s did not create a delegating resident", semanticID)
				}
				residents[residentKey{harnessID, item.SkillID}] = attempt.InstanceID
			}
			requireMatrixRunProof(t, terminal, currentTask, installed, item.SkillID)
		}
	}

	observed := map[string]bool{}
	for _, records := range cluster.harnessRecords() {
		for _, record := range records {
			if record.Event != "evaluation-result" {
				continue
			}
			identity := strings.Join([]string{record.PackID, record.PackVersion, record.PackDigest, record.SkillID, record.CaseID, record.HarnessID, record.Transport}, "|")
			if observed[identity] {
				t.Fatalf("evaluation identity ran twice: %s", identity)
			}
			if !record.Completed || record.ClaimsSuccess {
				t.Fatalf("evaluation result is not truthful: %+v", record)
			}
			observed[identity] = true
		}
	}
	if !equalStringSet(expected, observed) {
		t.Fatalf("declared/executed evaluation sets differ: want=%d got=%d", len(expected), len(observed))
	}
	requireEvaluationRecords(t, cluster, plan)
}

func requireMatrixRunProof(t *testing.T, current snapshot, item task, installed installedSystemCapabilityPack, skillID string) {
	t.Helper()
	run, ran := current.latestAttempt(item)
	allocation, allocated := allocationFor(current, run.InstanceID)
	if !ran || !allocated || allocation.ExpectedCapabilityPack == nil || run.TransportSelection == nil || run.TransportSelection.EffectiveCapabilityPack == nil {
		t.Fatalf("matrix run lacks placement/start proof: task=%+v run=%+v allocation=%+v", item, run, allocation)
	}
	wantExpected := allocation.ExpectedCapabilityPack.ID == installed.manifest.ID && allocation.ExpectedCapabilityPack.Version == installed.version && slices.Equal(allocation.ExpectedCapabilityPack.RequiredSkills, []string{skillID})
	effective := run.TransportSelection.EffectiveCapabilityPack
	wantSkills := installed.manifest.SkillIDs()
	slices.Sort(wantSkills)
	if !wantExpected || effective.ID != installed.manifest.ID || effective.Version != installed.version || !slices.Equal(effective.Skills, wantSkills) {
		t.Fatalf("matrix identity did not converge: allocation=%+v effective=%+v", allocation.ExpectedCapabilityPack, effective)
	}
}

func requireEvaluationRecords(t *testing.T, cluster *environment, plan systemEvaluationPlan) {
	t.Helper()
	starts := map[string]harnessRecord{}
	for file, records := range cluster.harnessRecords() {
		var started *harnessRecord
		calls := []string{}
		for _, record := range records {
			if strings.HasPrefix(record.Event, "evaluation-") || strings.HasPrefix(record.Event, "mcp-tool") {
				encoded, err := json.Marshal(record)
				if err != nil {
					t.Fatal(err)
				}
				for _, forbidden := range [][]byte{[]byte(cluster.root), []byte("http://"), []byte("https://"), []byte("csoc_")} {
					if bytes.Contains(encoded, forbidden) {
						t.Fatalf("evaluation record %s leaked a forbidden path/endpoint category", file)
					}
				}
			}
			if record.Event == "mcp-tool-call" {
				calls = append(calls, record.Tool)
			}
			if record.Event != "evaluation-start" {
				continue
			}
			copy := record
			started = &copy
			key := record.HarnessID + "/" + record.SkillID + "/" + record.CaseID
			starts[key] = record
			wantSelected := record.SkillID
			if record.Outcome == capabilitypack.OutcomeNoActivation {
				wantSelected = ""
			}
			if record.SelectedSkill != wantSelected || !slices.Equal(record.DiscoveredSkills, installedSkillIDs(plan)) {
				t.Fatalf("evaluation projection observation is false: %+v", record)
			}
			if record.HiddenTool != "" && slices.Contains(record.VisibleTools, record.HiddenTool) {
				t.Fatalf("hidden tool remained visible: %+v", record)
			}
		}
		if started != nil {
			switch started.Outcome {
			case capabilitypack.OutcomeNoActivation, capabilitypack.OutcomeRequestMissingInput, capabilitypack.OutcomeReportUnsupportedCapability:
				if len(calls) != 0 {
					t.Fatalf("%s/%s made forbidden tool calls: %v", started.SkillID, started.CaseID, calls)
				}
			case capabilitypack.OutcomeFollowWorkflow, capabilitypack.OutcomeReportRefusal:
				if len(calls) == 0 || calls[0] != "get_task_context" {
					t.Fatalf("%s/%s skipped context before mutation/refusal: %v", started.SkillID, started.CaseID, calls)
				}
			}
		}
	}
	if len(starts) != len(plan.Cases)*2 {
		t.Fatalf("evaluation-start count=%d want=%d", len(starts), len(plan.Cases)*2)
	}
}

func installedSkillIDs(plan systemEvaluationPlan) []string {
	result := make([]string, 0, len(plan.Skills))
	for _, skill := range plan.Skills {
		result = append(result, skill.ID)
	}
	return result
}

func equalStringSet(left, right map[string]bool) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if !right[key] {
			return false
		}
	}
	return true
}

// TestCapabilityPackUnsupportedACPParity proves the intentionally absent ACP activation adapters
// fail closed for skill work without regressing ordinary ACP execution on either provider.
func TestCapabilityPackUnsupportedACPParity(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.prepareNode(nodeOptions{
		id: "pack-acp", labels: []string{"pack-acp"}, concurrency: 2, instanceCapacity: integer(4),
		codex: true, claudeAuthMode: "api",
	})
	installed := installSystemCapabilityPack(t, node, true)
	node.options.componentManifest = manifestWithCanonicalAdapters(t, installed, cluster.root)
	node.start()

	clientID, secret := cluster.mintOrchestratorClient("Capability-pack ACP", "orchestrate")
	bridge := cluster.startBridge("capability-pack-acp", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "ACP parity", "objective": "Prove unsupported skill parity and no-skill compatibility."})
	threadID := text(object(created, "thread"), "id")
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		model := "default"
		if harnessID == "claude-cli" {
			model = acptest.ClaudeModel
		}
		base := map[string]any{
			"harnessIds": []string{harnessID}, "models": []string{model}, "transports": []string{"acp-v1"},
			"operatingSystems": []string{runtime.GOOS}, "labels": []string{"pack-acp"},
		}
		skill := map[string]any{}
		for key, value := range base {
			skill[key] = value
		}
		skill["skills"] = []string{"coffeeshop-preview"}
		blocked := bridge.mustCallTool("spawn_instance", map[string]any{
			"threadId": threadID, "idempotencyKey": "acp-skill-" + harnessID, "requirements": skill,
			"initialTask": map[string]any{"title": "acp-skill-" + harnessID, "instructions": "must never reach a provider"},
		})
		blockedTaskID := text(blocked, "initialTaskId")
		cluster.eventually("ACP skill refusal "+harnessID, func(current snapshot) (bool, string) {
			item, known := current.task(blockedTaskID)
			return known && len(item.AttemptRunIDs) == 0 && hasPlacementKind(item, "skill"), "skill work is not waiting on exact readiness"
		})

		plain := bridge.mustCallTool("spawn_instance", map[string]any{
			"threadId": threadID, "idempotencyKey": "acp-plain-" + harnessID, "requirements": base,
			"initialTask": map[string]any{"title": "acp-plain-" + harnessID, "instructions": script(t, step{Message: "plain ACP completed"})},
		})
		plainTaskID := text(plain, "initialTaskId")
		terminal := cluster.eventually("ACP no-skill completion "+harnessID, func(current snapshot) (bool, string) {
			item, known := current.task(plainTaskID)
			return known && item.Status == "completed", "ordinary ACP work is not complete"
		})
		plainTask, _ := terminal.task(plainTaskID)
		run, ran := terminal.latestAttempt(plainTask)
		if !ran || run.Transport != "acp-v1" || run.TransportSelection == nil || run.TransportSelection.EffectiveCapabilityPack != nil {
			t.Fatalf("ordinary %s ACP work gained pack authority: %+v", harnessID, run)
		}
	}
}

func prepareActivatedPackNode(t *testing.T, cluster *environment, id, label string, capacity int) (*baristaNode, installedSystemCapabilityPack) {
	t.Helper()
	node := cluster.prepareNode(nodeOptions{id: id, labels: []string{label}, concurrency: capacity, instanceCapacity: integer(capacity)})
	installed := installSystemCapabilityPack(t, node, true)
	if err := os.MkdirAll(filepath.Join(node.home, ".codex", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	node.options.componentManifest = installed.manifestPath
	node.start()
	return node, installed
}

// TestCapabilityPackRunIsolationAndCleanup holds two provider processes at deterministic gates,
// cancels one, and proves run/allocation identity and owned projection cleanup stay disjoint.
func TestCapabilityPackRunIsolationAndCleanup(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	claudeNode, _ := prepareActivatedPackNode(t, cluster, "pack-isolation-claude", "pack-isolation-claude", 1)
	codexNode, _ := prepareActivatedPackNode(t, cluster, "pack-isolation-codex", "pack-isolation-codex", 1)
	clientID, secret := cluster.mintOrchestratorClient("Pack isolation", "orchestrate")
	bridge := cluster.startBridge("pack-isolation", clientID, secret)

	type heldRun struct{ taskID, instanceID, runID string }
	start := func(harnessID, gate string) heldRun {
		label := "pack-isolation-claude"
		if harnessID == "codex-cli" {
			label = "pack-isolation-codex"
		}
		created := bridge.mustCallTool("create_thread", map[string]any{"title": "Isolation " + harnessID, "objective": "Hold one exact run."})
		threadID := text(object(created, "thread"), "id")
		spawned := bridge.mustCallTool("spawn_instance", map[string]any{
			"threadId": threadID, "idempotencyKey": "isolation-" + harnessID,
			"requirements": evaluationRequirementsAt("coffeeshop-artifacts", harnessID, label),
			"initialTask":  map[string]any{"title": "isolation-" + harnessID, "instructions": script(t, step{Gate: gate}, step{Message: "isolated done"})},
		})
		result := heldRun{taskID: text(spawned, "initialTaskId"), instanceID: text(object(spawned, "instance"), "id")}
		cluster.eventually("held "+harnessID+" run", func(current snapshot) (bool, string) {
			item, known := current.task(result.taskID)
			if !known {
				return false, "task is absent"
			}
			run, known := current.latestAttempt(item)
			if known {
				result.runID = run.ID
			}
			return known && run.Status == "running", "run is not held"
		})
		return result
	}
	claude := start("claude-cli", "isolation-claude")
	codex := start("codex-cli", "isolation-codex")
	current := cluster.hub.snapshot()
	claudeRun, _ := current.run(claude.runID)
	codexRun, _ := current.run(codex.runID)
	if claudeRun.ThreadID == codexRun.ThreadID || claudeRun.InstanceID == codexRun.InstanceID || claudeRun.AllocationID == codexRun.AllocationID || claudeRun.Workspace == codexRun.Workspace {
		t.Fatalf("concurrent pack runs shared authority: claude=%+v codex=%+v", claudeRun, codexRun)
	}
	if status := cluster.hub.request(http.MethodPost, "/api/runs/"+claude.runID+"/cancel", nil, nil); status != http.StatusOK {
		t.Fatalf("cancel held Claude run returned %d", status)
	}
	cluster.openGate("isolation-codex")
	cluster.eventually("isolated runs to settle", func(current snapshot) (bool, string) {
		claudeTask, claudeKnown := current.task(claude.taskID)
		codexTask, codexKnown := current.task(codex.taskID)
		return claudeKnown && codexKnown && claudeTask.Status == "cancelled" && codexTask.Status == "completed", "cancelled/success states have not settled"
	})
	if alive := cluster.liveHarnessProcesses(3 * time.Second); len(alive) != 0 {
		t.Fatalf("provider processes survived cleanup: %v", alive)
	}
	for _, candidate := range []*baristaNode{claudeNode, codexNode} {
		if entries, _ := os.ReadDir(filepath.Join(candidate.dataRoot, harness.RunScopedProjectionDirectory)); len(entries) != 0 {
			t.Fatalf("run-scoped projections survived cleanup on %s: %v", candidate.options.id, entries)
		}
	}
	managed := filepath.Join(codexNode.home, ".codex", "skills", harness.ManagedProjectionDirectory)
	if information, err := os.Stat(managed); err != nil || !information.IsDir() {
		t.Fatalf("Codex managed projection was not retained: %v", err)
	}
}

// TestCapabilityPackCrashRecovery proves a killed daemon loses current readiness and its exact
// attempt, then re-adopts the startup-selected pack and completes only through a fresh attempt.
func TestCapabilityPackCrashRecovery(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	node, _ := prepareActivatedPackNode(t, cluster, "pack-crash", "pack-crash", 1)
	clientID, secret := cluster.mintOrchestratorClient("Pack crash", "orchestrate")
	bridge := cluster.startBridge("pack-crash", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Pack crash", "objective": "Retry only after fresh readiness."})
	threadID := text(object(created, "thread"), "id")
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "pack-crash", "requirements": evaluationRequirementsAt("coffeeshop-artifacts", "claude-cli", "pack-crash"),
		"initialTask": map[string]any{"title": "pack-crash", "instructions": script(t, step{Gate: "pack-crash-release"}, step{Message: "recovered"})},
	})
	taskID := text(spawned, "initialTaskId")
	var firstRunID string
	cluster.eventually("pack run before crash", func(current snapshot) (bool, string) {
		item, known := current.task(taskID)
		if !known {
			return false, "task is absent"
		}
		run, known := current.latestAttempt(item)
		if known {
			firstRunID = run.ID
		}
		return known && run.Status == "running", "attempt is not running"
	})
	node.stop(true)
	cluster.eventually("pack node readiness loss", func(current snapshot) (bool, string) {
		candidate, known := nodeByID(current, node.options.id)
		return known && candidate.Status == "offline", "node is not offline"
	})
	node.start()
	cluster.eventually("fresh pack replacement attempt", func(current snapshot) (bool, string) {
		first, known := current.run(firstRunID)
		item, taskKnown := current.task(taskID)
		if !known || !taskKnown || first.Status != "failed" || len(item.AttemptRunIDs) != 2 {
			return false, "replacement has not converged"
		}
		latest, ran := current.latestAttempt(item)
		return ran && latest.Status == "running" && latest.ID != firstRunID, "replacement is not running"
	})
	cluster.openGate("pack-crash-release")
	cluster.eventually("recovered pack task", func(current snapshot) (bool, string) {
		item, known := current.task(taskID)
		return known && item.Status == "completed", "task is not complete"
	})
}
