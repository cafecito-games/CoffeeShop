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

// evaluationSteps is a closed executable registry keyed by the producer-owned skill and case IDs.
// An added or renamed row is fatal until its exact behavior is deliberately modeled here.
func evaluationSteps(t *testing.T, skillID string, evaluation capabilitypack.EvaluationCase) []step {
	t.Helper()
	message := fmt.Sprintf("evaluation %s/%s: %s", skillID, evaluation.ID, evaluation.Outcome)
	key := strings.NewReplacer("_", "-", "/", "-").Replace(evaluation.ID) + "-{{harness}}"
	context := step{Call: "get_task_context", Arguments: map[string]any{}, As: "context"}
	messageOnly := func(outcome string) []step {
		if evaluation.Outcome != outcome {
			t.Fatalf("%s/%s outcome=%s want=%s", skillID, evaluation.ID, evaluation.Outcome, outcome)
		}
		return []step{{Message: message}}
	}
	workflow := func(steps ...step) []step {
		if evaluation.Outcome != capabilitypack.OutcomeFollowWorkflow {
			t.Fatalf("%s/%s must follow workflow, got %s", skillID, evaluation.ID, evaluation.Outcome)
		}
		return append(steps, step{Message: message})
	}
	refusal := func(call step) []step {
		if evaluation.Outcome != capabilitypack.OutcomeReportRefusal || call.ExpectErrorCode == "" || call.AllowError {
			t.Fatalf("%s/%s refusal is not strict", skillID, evaluation.ID)
		}
		return []step{context, call, {Message: message}}
	}
	switch skillID + "/" + evaluation.ID {
	case "coffeeshop-artifacts/direct-publish-patch":
		return artifactEvaluation(workflow, context, key, message, "patch", false)
	case "coffeeshop-artifacts/direct-publish-test-results":
		return artifactEvaluation(workflow, context, key, message, "test-results", false)
	case "coffeeshop-artifacts/indirect-needs-to-survive-the-run":
		return artifactEvaluation(workflow, context, key, message, "report", false)
	case "coffeeshop-artifacts/indirect-reviewer-wants-the-log":
		return artifactEvaluation(workflow, context, key, message, "log", false)
	case "coffeeshop-artifacts/edge-already-published-earlier-attempt":
		return artifactEvaluation(workflow, context, key, message, "report", true)
	case "coffeeshop-artifacts/incomplete-no-file-named", "coffeeshop-artifacts/incomplete-no-title-or-kind":
		return messageOnly(capabilitypack.OutcomeRequestMissingInput)
	case "coffeeshop-artifacts/unrelated-scratch-file", "coffeeshop-artifacts/unrelated-explicit-message-instead":
		return messageOnly(capabilitypack.OutcomeNoActivation)
	case "coffeeshop-artifacts/edge-publishing-not-served":
		return messageOnly(capabilitypack.OutcomeReportUnsupportedCapability)
	case "coffeeshop-artifacts/authorization-refused-path", "coffeeshop-artifacts/authorization-outside-workspace":
		return refusal(step{Call: "post_artifact", Arguments: map[string]any{"relativePath": "../outside", "title": "refused", "kind": "report", "mediaType": "text/plain", "idempotencyKey": "refused-" + key}, ExpectErrorCode: "tool_failed", As: "refusal"})

	case "coffeeshop-coordination/direct-read-task-context":
		return workflow(context)
	case "coffeeshop-coordination/direct-split-across-agents":
		return workflow(context, step{Call: "get_execution_inventory", Arguments: map[string]any{}, As: "inventory"}, step{Call: "submit_tasks", Arguments: map[string]any{"idempotencyKey": "split-" + key, "tasks": []any{map[string]any{"key": "delegated", "title": "Delegated matrix work", "instructions": "Wait for a matching resident.", "requirements": map[string]any{"labels": []string{"intentionally-unplaceable-matrix-child"}}}}}, As: "delegated"})
	case "coffeeshop-coordination/direct-manage-resident-instance":
		return workflow(context,
			step{Call: "get_instance", Arguments: map[string]any{"instanceId": "{{context.task.instanceId}}"}, As: "instance"},
			step{Call: "renew_instance", Arguments: map[string]any{"instanceId": "{{context.task.instanceId}}", "idempotencyKey": "renew-" + key}, As: "renewed"},
			step{Call: "spawn_instance", Arguments: map[string]any{"idempotencyKey": "spawn-" + key, "purpose": map[string]any{"title": "Managed evaluation resident"}, "requirements": map[string]any{"labels": []string{"intentionally-unplaceable-managed-resident"}}}, As: "spawned"},
			step{Call: "get_instance", Arguments: map[string]any{"instanceId": "{{spawned.instance.id}}"}, As: "spawnedState"},
			step{Call: "release_instance", Arguments: map[string]any{"instanceId": "{{spawned.instance.id}}", "mode": "drain", "idempotencyKey": "release-" + key}, As: "released"})
	case "coffeeshop-coordination/indirect-blocked-on-answer":
		return workflow(context,
			step{Call: "send_task_message", Arguments: map[string]any{"idempotencyKey": "question-" + key, "recipient": map[string]any{"type": "orchestrator"}, "kind": "question", "body": "Is the schema approved?"}, As: "question"},
			step{Call: "wait_for_task_events", Arguments: map[string]any{"timeoutMilliseconds": 0, "maximumEvents": 1}, As: "events"})
	case "coffeeshop-coordination/indirect-who-can-run-this":
		return workflow(context,
			step{Call: "get_execution_inventory", Arguments: map[string]any{}, As: "inventory"},
			step{Call: "submit_tasks", Arguments: map[string]any{"idempotencyKey": "inventory-task-" + key, "tasks": []any{map[string]any{"key": "go-work", "title": "Go follow-up", "instructions": "Complete the Go follow-up.", "requirements": map[string]any{"labels": []string{"intentionally-unplaceable-inventory-child"}}}}}, As: "submitted"})
	case "coffeeshop-coordination/edge-instance-placement-pending":
		return workflow(context,
			step{Call: "spawn_instance", Arguments: map[string]any{"idempotencyKey": "pending-" + key, "requirements": map[string]any{"labels": []string{"intentionally-unplaceable-pending-resident"}}}, As: "pending"},
			step{Call: "get_instance", Arguments: map[string]any{"instanceId": "{{pending.instance.id}}"}, As: "pendingState"})
	case "coffeeshop-coordination/edge-wait-returned-nothing":
		return workflow(context, step{Call: "wait_for_task_events", Arguments: map[string]any{"timeoutMilliseconds": 0, "maximumEvents": 1}, As: "events"})
	case "coffeeshop-coordination/incomplete-no-task-named", "coffeeshop-coordination/incomplete-no-agent-named":
		return messageOnly(capabilitypack.OutcomeRequestMissingInput)
	case "coffeeshop-coordination/unrelated-local-refactor", "coffeeshop-coordination/unrelated-explicit-other-workflow":
		return messageOnly(capabilitypack.OutcomeNoActivation)
	case "coffeeshop-coordination/edge-delegation-not-served":
		return messageOnly(capabilitypack.OutcomeReportUnsupportedCapability)
	case "coffeeshop-coordination/authorization-refused-delegation":
		return refusal(step{Call: "delegate_task", Arguments: map[string]any{"agentId": "agent-outside-directory", "task": "refused", "idempotencyKey": "refused-" + key}, ExpectErrorCode: "target_ineligible", As: "refusal"})
	case "coffeeshop-coordination/authorization-refused-instance-lifecycle":
		return refusal(step{Call: "get_instance", Arguments: map[string]any{"instanceId": "instance-outside-authority"}, ExpectErrorCode: "not_found", As: "refusal"})
	case "coffeeshop-coordination/authorization-widen-scope":
		return refusal(step{Call: "spawn_instance", Arguments: map[string]any{"threadId": "thread-outside-authority", "idempotencyKey": "refused-" + key}, ExpectErrorCode: "invalid_arguments", As: "refusal"})

	case "coffeeshop-preview/direct-publish-preview", "coffeeshop-preview/indirect-share-static-site":
		return previewEvaluation(workflow, context, key, message, "")
	case "coffeeshop-preview/edge-stable-replay":
		return previewEvaluation(workflow, context, key, message, "replay")
	case "coffeeshop-preview/edge-upload-pending":
		return previewEvaluation(workflow, context, key, message, "pending")
	case "coffeeshop-preview/edge-processing":
		return previewLifecycleObservation(workflow, context, key, "processing")
	case "coffeeshop-preview/edge-ready-without-url":
		return previewLifecycleObservation(workflow, context, key, "ready-without-url")
	case "coffeeshop-preview/edge-failed":
		return previewLifecycleObservation(workflow, context, key, "failed")
	case "coffeeshop-preview/edge-expired":
		return previewLifecycleObservation(workflow, context, key, "expired")
	case "coffeeshop-preview/edge-incompatible-output":
		return previewLifecycleObservation(workflow, context, key, "incompatible-output")
	case "coffeeshop-preview/edge-changed-revision":
		return previewEvaluation(workflow, context, key, message, "revision")
	case "coffeeshop-preview/edge-malformed-result":
		return previewEvaluation(workflow, context, key, message, "malformed")
	case "coffeeshop-preview/edge-update-task-fails":
		return previewEvaluation(workflow, context, key, message, "update-fails")
	case "coffeeshop-preview/edge-no-current-task":
		return previewEvaluation(workflow, context, key, message, "no-task")
	case "coffeeshop-preview/incomplete-no-output", "coffeeshop-preview/incomplete-no-entrypoint":
		return messageOnly(capabilitypack.OutcomeRequestMissingInput)
	case "coffeeshop-preview/unrelated-file-artifact", "coffeeshop-preview/unrelated-local-browser-check":
		return messageOnly(capabilitypack.OutcomeNoActivation)
	case "coffeeshop-preview/edge-tool-not-served":
		return messageOnly(capabilitypack.OutcomeReportUnsupportedCapability)
	case "coffeeshop-preview/authorization-refused-publication", "coffeeshop-preview/authorization-request-access-url":
		return refusal(step{Call: "publish_preview", Arguments: map[string]any{"relativePath": "../outside", "entrypoint": "index.html", "title": "refused", "idempotencyKey": "refused-" + key}, ExpectErrorCode: "invalid_arguments", As: "refusal"})

	case "coffeeshop-task-reporting/direct-report-progress":
		return workflow(context, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "progress-" + key, "progress": message}, As: "updated"})
	case "coffeeshop-task-reporting/indirect-objective-drifted":
		return workflow(context, step{Call: "update_thread", Arguments: map[string]any{"objective": "Updated evaluation objective"}, ExpectErrorCode: "forbidden", As: "refused"})
	case "coffeeshop-task-reporting/indirect-blocked-and-silent":
		return workflow(context, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "blocked-" + key, "blockedReason": "Waiting for the credential decision"}, As: "updated"})
	case "coffeeshop-task-reporting/edge-objective-not-satisfied":
		return workflow(context, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "incomplete-" + key, "progress": "Child tasks failed; thread objective is not satisfied", "blockedReason": "Dependent work failed"}, As: "updated"})
	case "coffeeshop-task-reporting/direct-complete-the-thread":
		return workflow(context, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "complete-" + key, "completion": map[string]any{"summary": message}}, As: "updated"})
	case "coffeeshop-task-reporting/incomplete-no-task-named", "coffeeshop-task-reporting/incomplete-no-summary-given":
		return messageOnly(capabilitypack.OutcomeRequestMissingInput)
	case "coffeeshop-task-reporting/unrelated-explain-the-code", "coffeeshop-task-reporting/unrelated-explicit-no-status-change":
		return messageOnly(capabilitypack.OutcomeNoActivation)
	case "coffeeshop-task-reporting/edge-status-change-not-served":
		return messageOnly(capabilitypack.OutcomeReportUnsupportedCapability)
	case "coffeeshop-task-reporting/authorization-refused-completion":
		return refusal(step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "refused-" + key, "completion": map[string]any{"summary": "refused", "artifactIds": []string{"artifact-outside-authority"}}}, ExpectErrorCode: "invalid_artifact", As: "refusal"})
	case "coffeeshop-task-reporting/authorization-archive-the-thread":
		return refusal(step{Call: "update_thread", Arguments: map[string]any{"status": "archived"}, ExpectErrorCode: "forbidden", As: "refusal"})
	default:
		t.Fatalf("no exact executable scenario for %s/%s outcome %s", skillID, evaluation.ID, evaluation.Outcome)
		return nil
	}
}

func artifactEvaluation(workflow func(...step) []step, context step, key, message, kind string, replay bool) []step {
	path := filepath.ToSlash(filepath.Join("evaluation", key+".txt"))
	call := step{Call: "post_artifact", Arguments: map[string]any{"relativePath": path, "title": key, "kind": kind, "mediaType": "text/plain", "idempotencyKey": "artifact-" + key}, As: "artifact"}
	steps := []step{{WriteFile: &writeFile{Path: path, Content: "producer-derived artifact\n"}}, context, call}
	if replay {
		replayed := call
		replayed.As = "replayed"
		steps = append(steps, replayed)
		conflict := call
		conflict.Arguments = map[string]any{"relativePath": path, "title": key + " changed", "kind": kind, "mediaType": "text/plain", "idempotencyKey": "artifact-" + key}
		conflict.ExpectErrorCode, conflict.As = "idempotency_conflict", "conflict"
		steps = append(steps, conflict)
	}
	steps = append(steps, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "attach-" + key, "completion": map[string]any{"summary": message, "artifactIds": []string{"{{artifact.id}}"}}}, As: "updated"})
	return workflow(steps...)
}

func previewEvaluation(workflow func(...step) []step, context step, key, message, mode string) []step {
	root := filepath.ToSlash(filepath.Join("preview", key))
	call := step{Call: "publish_preview", Arguments: map[string]any{"relativePath": root, "entrypoint": "index.html", "title": key, "idempotencyKey": "preview-" + key}, As: "preview"}
	steps := []step{{WriteFile: &writeFile{Path: filepath.ToSlash(filepath.Join(root, "index.html")), Content: "<!doctype html><title>evaluation</title>"}}, context, call}
	switch mode {
	case "":
	case "replay":
		replayed := call
		replayed.As = "replayed"
		steps = append(steps, replayed)
		conflict := call
		conflict.Arguments = map[string]any{"relativePath": root, "entrypoint": "index.html", "title": key + " changed", "idempotencyKey": "preview-" + key}
		conflict.ExpectErrorCode, conflict.As = "idempotency_conflict", "conflict"
		steps = append(steps, conflict)
	case "pending":
		return workflow(steps...)
	case "revision":
		steps = append(steps, step{WriteFile: &writeFile{Path: filepath.ToSlash(filepath.Join(root, "index.html")), Content: "<!doctype html><title>changed revision</title>"}})
		changed := call
		changed.Arguments = map[string]any{"relativePath": root, "entrypoint": "index.html", "title": key + " revision 2", "idempotencyKey": "preview-revision-2-" + key}
		changed.As = "revision"
		steps = append(steps, changed)
		steps = append(steps, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "attach-revision-" + key, "completion": map[string]any{"summary": message, "artifactIds": []string{"{{revision.artifact.id}}"}}}, As: "updated"})
		return workflow(steps...)
	case "malformed":
		steps[2].MutateResultRemove = "artifact.id"
		return workflow(steps...)
	case "update-fails":
		steps = append(steps, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "failed-" + key, "completion": map[string]any{"summary": message, "artifactIds": []string{"artifact-outside-authority"}}}, ExpectErrorCode: "invalid_artifact", As: "failed"})
		return workflow(steps...)
	case "no-task":
		steps = append(steps, step{Call: "get_task_context", Arguments: map[string]any{"taskId": "task-does-not-exist"}, ExpectErrorCode: "not_found", As: "missing"})
		return workflow(steps...)
	default:
		panic("unknown preview evaluation mode " + mode)
	}
	steps = append(steps, step{Call: "update_task", Arguments: map[string]any{"idempotencyKey": "attach-" + key, "completion": map[string]any{"summary": message, "artifactIds": []string{"{{preview.artifact.id}}"}}}, As: "updated"})
	return workflow(steps...)
}

// previewLifecycleObservation keeps the #103 matrix honest about the boundary it owns. A
// run-scoped publish can create or replay registration, whose immediate producer status is
// upload-pending; processing, ready, failed, and expired are later Hub preparation/clock states
// with no worker mutation tool. The installed-projection test consumes exact fixtures emitted by
// those lifecycle producers. Here every row still proves the real publish/no-publish decision and
// records the bounded claim the model is allowed to make at this boundary.
func previewLifecycleObservation(workflow func(...step) []step, context step, key, observation string) []step {
	root := filepath.ToSlash(filepath.Join("preview", key))
	content := "<!doctype html><title>preview lifecycle observation</title>"
	steps := []step{{WriteFile: &writeFile{Path: filepath.ToSlash(filepath.Join(root, "index.html")), Content: content}}, context}
	if observation == "incompatible-output" {
		steps[0].WriteFile.Content = "<!doctype html><script src=/app.js></script><script>fetch('/api/live')</script>"
		return workflow(append(steps, step{Message: "preview-observation=incompatible-output publication=skipped attachment=skipped access-url=none"})...)
	}
	arguments := map[string]any{
		"relativePath": root, "entrypoint": "index.html", "title": key, "idempotencyKey": "preview-" + key,
	}
	if observation == "expired" {
		arguments["ttlSeconds"] = 300
	}
	steps = append(steps, step{Call: "publish_preview", Arguments: arguments, As: "publication"})
	if observation == "processing" {
		steps = append(steps, step{Call: "publish_preview", Arguments: arguments, As: "replayed"})
	}
	steps = append(steps, step{Message: "preview-observation=" + observation + " producer-status={{publication.preview.status}} ready=false attachment=skipped access-url=none"})
	return workflow(steps...)
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
			before := cluster.hub.snapshot()
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
			if item.Evaluation.Outcome == capabilitypack.OutcomeReportRefusal {
				requireRefusalPreservedState(t, before, terminal, threadID)
			}
			if item.SkillID == "coffeeshop-artifacts" && item.Evaluation.ID == "edge-already-published-earlier-attempt" && len(terminal.Artifacts) != len(before.Artifacts)+1 {
				t.Fatalf("artifact replay created %d durable records, want exactly one", len(terminal.Artifacts)-len(before.Artifacts))
			}
			if item.SkillID == "coffeeshop-preview" {
				switch item.Evaluation.ID {
				case "edge-processing", "edge-ready-without-url", "edge-failed", "edge-expired":
					if len(terminal.Artifacts) != len(before.Artifacts)+1 {
						t.Fatalf("%s created %d durable preview artifacts, want one", item.Evaluation.ID, len(terminal.Artifacts)-len(before.Artifacts))
					}
				case "edge-incompatible-output":
					if len(terminal.Artifacts) != len(before.Artifacts) {
						t.Fatalf("incompatible output was published: before=%d after=%d", len(before.Artifacts), len(terminal.Artifacts))
					}
				}
			}
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
			if !record.Completed {
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

func requireRefusalPreservedState(t *testing.T, before, after snapshot, threadID string) {
	t.Helper()
	findThread := func(current snapshot) (thread, bool) {
		for _, candidate := range current.Threads {
			if candidate.ID == threadID {
				return candidate, true
			}
		}
		return thread{}, false
	}
	beforeThread, beforeKnown := findThread(before)
	afterThread, afterKnown := findThread(after)
	if !beforeKnown || !afterKnown || beforeThread.Status != afterThread.Status || beforeThread.Summary != afterThread.Summary ||
		len(after.Artifacts) != len(before.Artifacts) || len(after.Threads) != len(before.Threads) ||
		len(after.TaskMessages) != len(before.TaskMessages) || len(after.Instances) != len(before.Instances) ||
		len(after.Allocations) != len(before.Allocations) || len(after.Tasks) != len(before.Tasks)+1 {
		t.Fatalf("refusal mutated protected Hub state: before={threads:%d tasks:%d artifacts:%d messages:%d instances:%d allocations:%d thread:%+v} after={threads:%d tasks:%d artifacts:%d messages:%d instances:%d allocations:%d thread:%+v}",
			len(before.Threads), len(before.Tasks), len(before.Artifacts), len(before.TaskMessages), len(before.Instances), len(before.Allocations), beforeThread,
			len(after.Threads), len(after.Tasks), len(after.Artifacts), len(after.TaskMessages), len(after.Instances), len(after.Allocations), afterThread)
	}
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

type evaluationCallResult struct {
	Tool      string
	IsError   bool
	ErrorCode string
	Result    string
}

func requireEvaluationRecords(t *testing.T, cluster *environment, plan systemEvaluationPlan) {
	t.Helper()
	type trace struct {
		Start    harnessRecord
		Calls    []evaluationCallResult
		Messages []string
	}
	traces := map[string]trace{}
	caseByID := map[string]systemEvaluationCase{}
	for _, item := range plan.Cases {
		caseByID[item.SkillID+"/"+item.Evaluation.ID] = item
	}
	for file, records := range cluster.harnessRecords() {
		var current *trace
		for _, record := range records {
			if strings.HasPrefix(record.Event, "evaluation-") || strings.HasPrefix(record.Event, "mcp-tool") {
				encoded, err := json.Marshal(record)
				if err != nil {
					t.Fatal(err)
				}
				lower := bytes.ToLower(encoded)
				for _, forbidden := range [][]byte{[]byte(strings.ToLower(cluster.root)), []byte(`"url":`), []byte("http"), []byte("://"), []byte("csoc_")} {
					if bytes.Contains(lower, forbidden) {
						t.Fatalf("evaluation record %s leaked a forbidden path/endpoint category", file)
					}
				}
			}
			switch record.Event {
			case "evaluation-start":
				if current != nil {
					t.Fatalf("%s started a new evaluation before the prior result", file)
				}
				current = &trace{Start: record}
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
			case "mcp-tool-call":
				if current != nil {
					current.Calls = append(current.Calls, evaluationCallResult{Tool: record.Tool})
				}
			case "mcp-tool-result":
				if current == nil || len(current.Calls) == 0 || current.Calls[len(current.Calls)-1].Tool != record.Tool {
					t.Fatalf("%s has an unpaired MCP result for %s", file, record.Tool)
				}
				encoded, _ := json.Marshal(record.Result)
				last := &current.Calls[len(current.Calls)-1]
				last.IsError, last.ErrorCode, last.Result = record.IsError, record.ErrorCode, string(encoded)
			case "evaluation-message":
				if current == nil {
					t.Fatalf("%s has an evaluation message outside a case", file)
				}
				current.Messages = append(current.Messages, record.Message)
			case "evaluation-result":
				if current == nil || current.Start.SkillID != record.SkillID || current.Start.CaseID != record.CaseID {
					t.Fatalf("%s has an unmatched evaluation result: %+v", file, record)
				}
				key := record.HarnessID + "/" + record.SkillID + "/" + record.CaseID
				if _, duplicate := traces[key]; duplicate {
					t.Fatalf("duplicate evaluation trace %s", key)
				}
				traces[key] = *current
				current = nil
			}
		}
		if current != nil {
			t.Fatalf("%s ended without an evaluation result", file)
		}
	}
	if len(traces) != len(plan.Cases)*2 {
		t.Fatalf("evaluation trace count=%d want=%d", len(traces), len(plan.Cases)*2)
	}
	for identity, item := range caseByID {
		claude := traces["claude-cli/"+identity]
		codex := traces["codex-cli/"+identity]
		expected := []string{}
		for _, candidate := range item.Steps {
			if candidate.Call != "" {
				expected = append(expected, candidate.Call)
			}
		}
		actual := make([]string, 0, len(claude.Calls))
		for _, call := range claude.Calls {
			actual = append(actual, call.Tool)
		}
		if !slices.Equal(actual, expected) {
			t.Fatalf("%s ordered calls=%v want=%v", identity, actual, expected)
		}
		if !slices.Equal(claude.Calls, codex.Calls) {
			t.Fatalf("%s Claude/Codex semantic outcomes differ: claude=%+v codex=%+v", identity, claude.Calls, codex.Calls)
		}
		if !slices.Equal(claude.Messages, codex.Messages) {
			t.Fatalf("%s Claude/Codex claims differ: claude=%q codex=%q", identity, claude.Messages, codex.Messages)
		}
		if item.Evaluation.Outcome == capabilitypack.OutcomeReportRefusal {
			last := claude.Calls[len(claude.Calls)-1]
			if !last.IsError || last.ErrorCode == "" {
				t.Fatalf("%s did not record its closed denial: %+v", identity, last)
			}
		}
		requireEvaluationSemantics(t, identity, claude.Calls, claude.Messages)
	}
}

func requireEvaluationSemantics(t *testing.T, identity string, calls []evaluationCallResult, messages []string) {
	t.Helper()
	find := func(tool string) []evaluationCallResult {
		matches := make([]evaluationCallResult, 0)
		for _, call := range calls {
			if call.Tool == tool {
				matches = append(matches, call)
			}
		}
		return matches
	}
	hasMessage := func(fragment string) bool {
		return slices.ContainsFunc(messages, func(message string) bool { return strings.Contains(message, fragment) })
	}
	switch identity {
	case "coffeeshop-artifacts/edge-already-published-earlier-attempt":
		published := find("post_artifact")
		// post_artifact returns the artifact projection rather than a synthetic created flag. The
		// matrix's serialized Hub-state assertion proves the first two calls converge on one
		// durable artifact; this trace proves both calls succeeded and changed arguments conflict.
		if len(published) != 3 || published[0].IsError || published[1].IsError || published[2].ErrorCode != "idempotency_conflict" {
			t.Fatalf("%s did not prove create/replay/conflict semantics: %+v", identity, published)
		}
	case "coffeeshop-preview/edge-stable-replay":
		published := find("publish_preview")
		if len(published) != 3 || !strings.Contains(published[0].Result, `"created":true`) || !strings.Contains(published[1].Result, `"created":false`) || published[2].ErrorCode != "idempotency_conflict" {
			t.Fatalf("%s did not prove create/replay/conflict semantics: %+v", identity, published)
		}
	case "coffeeshop-preview/edge-upload-pending":
		published := find("publish_preview")
		if len(published) != 1 || !strings.Contains(published[0].Result, `"previewStatus":"upload-pending"`) || len(find("update_task")) != 0 {
			t.Fatalf("%s did not preserve truthful pending state: calls=%+v", identity, calls)
		}
	case "coffeeshop-preview/edge-processing":
		published := find("publish_preview")
		replayObservedKnownLifecycle := len(published) == 2 && (strings.Contains(published[1].Result, `"previewStatus":"upload-pending"`) ||
			strings.Contains(published[1].Result, `"previewStatus":"processing"`) ||
			strings.Contains(published[1].Result, `"previewStatus":"ready"`))
		if len(published) != 2 || published[0].IsError || published[1].IsError ||
			!strings.Contains(published[0].Result, `"previewStatus":"upload-pending"`) ||
			!strings.Contains(published[1].Result, `"created":false`) || !replayObservedKnownLifecycle || len(find("update_task")) != 0 ||
			!hasMessage("preview-observation=processing producer-status=upload-pending ready=false attachment=skipped access-url=none") {
			t.Fatalf("%s made an unsupported lifecycle claim: calls=%+v messages=%q", identity, calls, messages)
		}
	case "coffeeshop-preview/edge-ready-without-url", "coffeeshop-preview/edge-failed", "coffeeshop-preview/edge-expired":
		published := find("publish_preview")
		observation := strings.TrimPrefix(identity, "coffeeshop-preview/edge-")
		if len(published) != 1 || published[0].IsError || !strings.Contains(published[0].Result, `"previewStatus":"upload-pending"`) ||
			len(find("update_task")) != 0 || !hasMessage("preview-observation="+observation+" producer-status=upload-pending ready=false attachment=skipped access-url=none") {
			t.Fatalf("%s made an unsupported lifecycle claim: calls=%+v messages=%q", identity, calls, messages)
		}
	case "coffeeshop-preview/edge-incompatible-output":
		if len(find("publish_preview")) != 0 || len(find("update_task")) != 0 ||
			!hasMessage("preview-observation=incompatible-output publication=skipped attachment=skipped access-url=none") {
			t.Fatalf("%s published or attached incompatible output: calls=%+v messages=%q", identity, calls, messages)
		}
	case "coffeeshop-preview/edge-changed-revision":
		published := find("publish_preview")
		if len(published) != 2 || !strings.Contains(published[0].Result, `"created":true`) || !strings.Contains(published[1].Result, `"created":true`) {
			t.Fatalf("%s did not create an explicit next revision: %+v", identity, published)
		}
	case "coffeeshop-preview/edge-malformed-result":
		if len(find("publish_preview")) != 1 || len(find("update_task")) != 0 {
			t.Fatalf("%s derived a follow-on mutation from malformed producer data: %+v", identity, calls)
		}
	case "coffeeshop-preview/edge-update-task-fails":
		updates := find("update_task")
		if len(find("publish_preview")) != 1 || len(updates) != 1 || updates[0].ErrorCode != "invalid_artifact" {
			t.Fatalf("%s did not retain publication while reporting attachment failure: %+v", identity, calls)
		}
	case "coffeeshop-preview/edge-no-current-task":
		contexts := find("get_task_context")
		if len(find("publish_preview")) != 1 || len(find("update_task")) != 0 || len(contexts) != 2 || contexts[1].ErrorCode != "not_found" {
			t.Fatalf("%s invented a current task or lost durable publication: %+v", identity, calls)
		}
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
	if err := os.MkdirAll(filepath.Join(node.home, ".codex", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
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

		both := map[string]any{}
		for key, value := range skill {
			both[key] = value
		}
		both["transports"] = []string{"native-cli", "acp-v1"}
		selected := bridge.mustCallTool("spawn_instance", map[string]any{
			"threadId": threadID, "idempotencyKey": "both-transports-" + harnessID, "requirements": both,
			"initialTask": map[string]any{"title": "both-transports-" + harnessID, "instructions": script(t, step{Message: "native pack transport selected"})},
		})
		selectedTaskID := text(selected, "initialTaskId")
		selectedSnapshot := cluster.eventually("pack-ready native selection "+harnessID, func(current snapshot) (bool, string) {
			item, known := current.task(selectedTaskID)
			return known && item.Status == "completed", "both-transport task is not complete"
		})
		selectedTask, _ := selectedSnapshot.task(selectedTaskID)
		selectedRun, ran := selectedSnapshot.latestAttempt(selectedTask)
		if !ran || selectedRun.Transport != "native-cli" || selectedRun.TransportSelection == nil || selectedRun.TransportSelection.EffectiveCapabilityPack == nil || selectedRun.TransportSelection.EffectiveCapabilityPack.ID != installed.manifest.ID {
			t.Fatalf("scheduler did not prefer the pack-ready native transport over ACP for %s: %+v", harnessID, selectedRun)
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
	unmanaged := filepath.Join(codexNode.home, ".codex", "skills", "personal", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(unmanaged), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unmanaged, []byte("---\nname: personal-skill\ndescription: Private unmanaged test skill.\n---\n\n# Personal skill\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	outsideBefore := unmanagedSkillTree(t, filepath.Join(codexNode.home, ".codex", "skills"))

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
	outsideAfter := unmanagedSkillTree(t, filepath.Join(codexNode.home, ".codex", "skills"))
	if !equalStringMap(outsideBefore, outsideAfter) {
		t.Fatalf("Codex projection changed content outside its managed subtree: before=%v after=%v", outsideBefore, outsideAfter)
	}
}

func unmanagedSkillTree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == harness.ManagedProjectionDirectory || strings.HasPrefix(relative, harness.ManagedProjectionDirectory+string(filepath.Separator)) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			result[filepath.ToSlash(relative)+"/"] = "directory"
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		result[filepath.ToSlash(relative)] = hex.EncodeToString(digest[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func equalStringMap(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
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
	if runtime.GOOS == "linux" {
		if alive := cluster.liveHarnessProcesses(3 * time.Second); len(alive) != 0 {
			t.Fatalf("provider child survived daemon crash: %v", alive)
		}
	}
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
	if entries, _ := os.ReadDir(filepath.Join(node.dataRoot, harness.RunScopedProjectionDirectory)); len(entries) != 0 {
		t.Fatalf("run projection survived crash reconciliation: %v", entries)
	}
	final := cluster.hub.snapshot()
	first, firstKnown := final.run(firstRunID)
	item, taskKnown := final.task(taskID)
	if !firstKnown || !taskKnown || first.Status != "failed" || item.Status != "completed" || len(item.AttemptRunIDs) != 2 {
		t.Fatalf("crash projection was not reconciled exactly once: first=%+v task=%+v", first, item)
	}
	cluster.assertRetainedDiagnosticsRedacted()
}
