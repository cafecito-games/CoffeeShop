package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/mcpserver"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

const (
	previewPublicationKey = "task-preview-dashboard-r1"
	previewAttachmentKey  = "task-preview-attach-dashboard-r1"
)

type previewWorkflowCall struct {
	Operation string
	Arguments map[string]any
}

type previewWorkflowAuthority struct {
	t             *testing.T
	status        string
	malformed     bool
	mu            sync.Mutex
	calls         []previewWorkflowCall
	registered    map[string]map[string]any
	uploaded      map[string]bool
	uploads       int
	attachments   int
	publicationID string
}

func newPreviewWorkflowAuthority(t *testing.T, status string, malformed bool) *previewWorkflowAuthority {
	return &previewWorkflowAuthority{
		t: t, status: status, malformed: malformed, registered: map[string]map[string]any{},
		uploaded: map[string]bool{}, publicationID: "preview-workflow-one",
	}
}

func decodeWorkflowArguments(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var arguments map[string]any
	require.NoError(t, json.Unmarshal(raw, &arguments))
	return arguments
}

func (authority *previewWorkflowAuthority) call(_ context.Context, runID, operation string, raw json.RawMessage) (json.RawMessage, error) {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	arguments := decodeWorkflowArguments(authority.t, raw)
	authority.calls = append(authority.calls, previewWorkflowCall{Operation: operation, Arguments: arguments})
	switch operation {
	case "get_task_context":
		return json.Marshal(map[string]any{
			"thread": map[string]any{"id": "thread-preview"}, "task": map[string]any{"id": "task-preview"},
			"caller": map[string]any{"role": "task", "runId": runID}, "delegations": []any{},
			"artifacts": []any{}, "availableAgents": []any{}, "limits": map[string]any{}, "version": "1",
		})
	case "publish_preview":
		key, _ := arguments["idempotencyKey"].(string)
		if previous := authority.registered[key]; previous != nil {
			if !reflect.DeepEqual(previous, arguments) {
				return nil, &mcpserver.ToolError{Code: "idempotency_conflict", Message: "The publication key already has different arguments"}
			}
			return authority.registration(runID, arguments, false, authority.uploaded[key])
		}
		authority.registered[key] = arguments
		if authority.malformed {
			result, err := authority.registration(runID, arguments, false, true)
			if err != nil {
				return nil, err
			}
			var value map[string]any
			require.NoError(authority.t, json.Unmarshal(result, &value))
			delete(value, "preview")
			return json.Marshal(value)
		}
		created := authority.status == "upload-pending"
		alreadyUploaded := authority.status != "upload-pending"
		authority.uploaded[key] = alreadyUploaded
		return authority.registration(runID, arguments, created, alreadyUploaded)
	case "update_task":
		authority.attachments++
		return json.Marshal(map[string]any{
			"created": true, "updateId": "update-preview-one", "task": map[string]any{"id": "task-preview"},
		})
	default:
		return nil, &mcpserver.ToolError{Code: "forbidden", Message: "Unexpected workflow call"}
	}
}

func (authority *previewWorkflowAuthority) upload(_ context.Context, path string, content io.Reader, size int64) error {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	data, err := io.ReadAll(content)
	require.NoError(authority.t, err)
	require.Equal(authority.t, size, int64(len(data)))
	require.Equal(authority.t, "/api/artifacts/artifact-preview-one/content", path)
	authority.uploads++
	authority.uploaded[previewPublicationKey] = true
	return nil
}

func (authority *previewWorkflowAuthority) registration(runID string, arguments map[string]any, created, uploaded bool) (json.RawMessage, error) {
	createdAt := "2026-09-28T12:00:00Z"
	updatedAt := "2026-09-28T12:01:00Z"
	preview := map[string]any{
		"id": authority.publicationID, "artifactId": "artifact-preview-one", "artifactSha256": arguments["sha256"],
		"threadId": "thread-preview", "runId": runID, "agentId": "agent-preview", "entrypoint": arguments["entrypoint"],
		"status": authority.status, "processingGeneration": 0, "createdAt": createdAt, "updatedAt": createdAt,
		"expiresAt": "2026-09-28T13:00:00Z", "accessState": "unavailable",
	}
	switch authority.status {
	case "processing":
		preview["processingGeneration"] = 1
		preview["updatedAt"] = updatedAt
	case "ready":
		preview["processingGeneration"] = 1
		preview["updatedAt"] = updatedAt
		preview["readyAt"] = updatedAt
		preview["accessState"] = "eligible"
	case "failed":
		preview["processingGeneration"] = 1
		preview["updatedAt"] = updatedAt
		preview["failedAt"] = updatedAt
		preview["failureCode"] = "bundle-invalid"
	}
	return json.Marshal(map[string]any{
		"artifact": map[string]any{
			"id": "artifact-preview-one", "threadId": "thread-preview", "runId": runID, "agentId": "agent-preview",
			"relativePath": arguments["relativePath"], "title": arguments["title"], "kind": arguments["kind"],
			"mediaType": arguments["mediaType"], "summary": arguments["summary"], "size": arguments["size"],
			"sha256": arguments["sha256"], "downloadPath": "/api/artifacts/artifact-preview-one/content",
			"uploaded": uploaded, "idempotencyKey": arguments["idempotencyKey"], "createdAt": createdAt,
		},
		"preview": preview, "uploadPath": "/api/artifacts/artifact-preview-one/content", "created": created,
	})
}

func installedPreviewWorkflowPack(t *testing.T) ActivePack {
	t.Helper()
	tree, err := capabilitypack.ReadTree(packFixtureRoot)
	require.NoError(t, err)
	archive, packManifest, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	require.NoError(t, err)
	digest := capabilitypack.ArchiveDigest(archive)
	platform := setup.CurrentPlatform()
	manifestBytes := []byte(fmt.Sprintf(`{"manifestVersion":%q,"components":[{"id":%q,"kind":"capability-pack","harnessId":"coffee-shop","provider":"cafecito-games","label":"Coffee Shop capability pack","version":%q,"platforms":{%q:{"kind":"manual","executablePath":"coffeeshop-capability-pack.tar.gz"}},"launch":{}}]}`,
		setup.ManifestVersion, packManifest.ID, packManifest.Version, platform))
	manifest, err := setup.ParseManifest(manifestBytes)
	require.NoError(t, err)
	dataRoot := t.TempDir()
	plan, _, err := setup.BuildPlan(manifestBytes, manifest, platform, dataRoot, setup.OwnershipLedger{})
	require.NoError(t, err)
	source := filepath.Join(t.TempDir(), "coffeeshop-capability-pack.tar.gz")
	require.NoError(t, os.WriteFile(source, archive, 0o644))
	_, err = setup.Apply(context.Background(), plan, manifestBytes, setup.OwnershipLedger{}, dataRoot, setup.ApplyOptions{
		ManualArtifactSources: map[string]string{packManifest.ID: source},
		ManualChecksums:       map[string]string{packManifest.ID: digest},
	})
	require.NoError(t, err)
	ownership, err := setup.LoadOwnershipLedger(dataRoot)
	require.NoError(t, err)
	selector := setup.ComponentSelector{Kind: setup.ComponentKindCapabilityPack, ID: packManifest.ID, Version: packManifest.Version}
	_, err = setup.Activate(context.Background(), setup.ActivationContext{
		DataRoot: dataRoot, Manifest: manifest, Platform: platform, Ownership: ownership,
		Activation: setup.LoadActivationState(dataRoot), InUse: func(string) bool { return false },
		Probe: func(_ context.Context, installed setup.InstalledComponent) error {
			_, probeErr := capabilitypack.ProbeInstalledArtifact(installed.Path, packManifest.ID, packManifest.Version)
			return probeErr
		},
	}, selector)
	require.NoError(t, err)
	installed, err := setup.ActiveInstalledComponent(dataRoot, manifest, platform, ownership, setup.LoadActivationState(dataRoot), selector.Identity())
	require.NoError(t, err)
	reread := func() (capabilitypack.Tree, capabilitypack.PackManifest, string, error) {
		content, readErr := os.ReadFile(installed.Path)
		if readErr != nil {
			return nil, capabilitypack.PackManifest{}, "", readErr
		}
		expanded, expandErr := capabilitypack.ArchiveTree(content)
		if expandErr != nil {
			return nil, capabilitypack.PackManifest{}, "", expandErr
		}
		verified, verifyErr := capabilitypack.ValidateArchive(content, capabilitypack.DefaultVocabulary())
		return expanded, verified, capabilitypack.ArchiveDigest(content), verifyErr
	}
	expanded, verified, installedDigest, err := reread()
	require.NoError(t, err)
	return ActivePack{ID: verified.ID, Version: verified.Version, ArchiveDigest: installedDigest, Manifest: verified, Tree: expanded, Build: "preview-workflow-test", Reread: reread}
}

func buildPreviewWorkflowHarness(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	binary := filepath.Join(directory, "fakeharness")
	command := exec.Command("go", "build", "-o", binary, "../systemtest/fakeharness")
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	codex := filepath.Join(directory, "codex")
	require.NoError(t, os.Symlink(binary, codex))
	return codex
}

func recordedPreviewWorkflowCalls(t *testing.T, directory string) []previewWorkflowCall {
	t.Helper()
	calls := []previewWorkflowCall{}
	entries, err := os.ReadDir(directory)
	require.NoError(t, err)
	for _, entry := range entries {
		file, err := os.Open(filepath.Join(directory, entry.Name()))
		require.NoError(t, err)
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			var record struct {
				Event     string         `json:"event"`
				Tool      string         `json:"tool"`
				Arguments map[string]any `json:"arguments"`
			}
			require.NoError(t, json.Unmarshal(scanner.Bytes(), &record))
			if record.Event == "mcp-tool-call" {
				calls = append(calls, previewWorkflowCall{Operation: record.Tool, Arguments: record.Arguments})
			}
		}
		require.NoError(t, scanner.Err())
		require.NoError(t, file.Close())
	}
	return calls
}

func previewWorkflowScript(t *testing.T, status string, malformed, replay bool) string {
	t.Helper()
	publish := map[string]any{
		"relativePath": "site", "entrypoint": "index.html", "title": "Task dashboard", "summary": "Static task dashboard",
		"ttlSeconds": 3600, "idempotencyKey": previewPublicationKey,
	}
	steps := []map[string]any{
		{"call": "get_task_context", "as": "context"},
		{"call": "publish_preview", "arguments": publish, "as": "publication", "allowError": malformed},
	}
	if malformed {
		steps = append(steps, map[string]any{"message": "status=failure error={{publication.error.code}} attachment=skipped"})
	} else {
		if replay {
			steps = append(steps,
				map[string]any{"call": "publish_preview", "arguments": publish, "as": "replay"},
				map[string]any{"call": "publish_preview", "arguments": map[string]any{
					"relativePath": "site", "entrypoint": "index.html", "title": "Changed title", "summary": "Static task dashboard",
					"ttlSeconds": 3600, "idempotencyKey": previewPublicationKey,
				}, "as": "conflict", "allowError": true},
			)
		}
		steps = append(steps,
			map[string]any{"call": "update_task", "arguments": map[string]any{
				"idempotencyKey": previewAttachmentKey,
				"completion":     map[string]any{"summary": "Published preview {{publication.preview.id}} with returned status {{publication.preview.status}}", "artifactIds": []any{"{{publication.artifact.id}}"}},
			}, "as": "attachment"},
		)
		message := "status={{publication.preview.status}} artifact={{publication.artifact.id}} preview={{publication.preview.id}} uploaded={{publication.artifact.uploaded}} expires={{publication.preview.expiresAt}} access-url=operator-only"
		if status == "failed" {
			message += " failure-code={{publication.preview.failureCode}}"
		}
		if replay {
			message += " replay-created={{replay.created}} conflict={{conflict.error.code}}"
		}
		steps = append(steps, map[string]any{"message": message})
	}
	encoded, err := json.Marshal(map[string]any{"steps": steps})
	require.NoError(t, err)
	return "<fake-script>" + string(encoded) + "</fake-script>"
}

// TestPreviewWorkflowAtInstalledProjectionBoundary drives the canonical archive through setup's
// install/activate lifecycle, the real Codex projection and discovery adapter, a compiled fake
// harness, and the real run-scoped MCP server. The only fake is the Hub-side authority response,
// which is varied to prove the skill's observable lifecycle claims without inventing a second
// producer implementation.
func TestPreviewWorkflowAtInstalledProjectionBoundary(t *testing.T) {
	binary := buildPreviewWorkflowHarness(t)
	for _, test := range []struct {
		name, status string
		malformed    bool
		replay       bool
		wantOutput   []string
	}{
		{name: "pending replay and conflict", status: "upload-pending", replay: true, wantOutput: []string{"status=upload-pending", "uploaded=true", "replay-created=false", "conflict=idempotency_conflict"}},
		{name: "processing", status: "processing", wantOutput: []string{"status=processing", "uploaded=true"}},
		{name: "ready without URL", status: "ready", wantOutput: []string{"status=ready", "access-url=operator-only"}},
		{name: "failed", status: "failed", wantOutput: []string{"status=failed", "uploaded=true", "failure-code=bundle-invalid"}},
		{name: "malformed", status: "upload-pending", malformed: true, wantOutput: []string{"status=failure", "error=invalid_result", "attachment=skipped"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			pack := installedPreviewWorkflowPack(t)
			home := t.TempDir()
			codexHome := filepath.Join(home, ".codex")
			records := filepath.Join(home, "records")
			require.NoError(t, os.MkdirAll(filepath.Join(codexHome, "skills"), 0o755))
			require.NoError(t, os.MkdirAll(records, 0o755))
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", codexHome)
			t.Setenv("COFFEE_SHOP_FAKE_RECORD_DIRECTORY", records)

			workspace := t.TempDir()
			require.NoError(t, os.Mkdir(filepath.Join(workspace, "site"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", "index.html"), []byte("<!doctype html><link rel=stylesheet href=./site.css><h1>Preview</h1>\n"), 0o644))
			require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", "site.css"), []byte("h1 { color: navy; }\n"), 0o644))

			authority := newPreviewWorkflowAuthority(t, test.status, test.malformed)
			server := mcpserver.New(authority.call, authority.upload, t.TempDir())
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			require.NoError(t, server.Start(ctx))
			runID := "run-preview-" + test.status
			if test.malformed {
				runID += "-malformed"
			} else if test.replay {
				runID += "-replay"
			}
			grant, err := server.Grant(runID, workspace, false)
			require.NoError(t, err)

			lines := []string{}
			runner := NewRunner([]protocol.HarnessProfile{{ID: "codex-cli", Binary: binary, Available: true}}).
				WithCapabilityPack(&pack, CapabilityPackUnavailability{}, PackRequired, t.TempDir()).
				WithCapabilityPackReport(func(line string) { lines = append(lines, line) })
			result, err := runner.Execute(ctx, Invocation{
				Run:   protocol.Run{ID: runID, HarnessID: "codex-cli", Model: "default", Prompt: previewWorkflowScript(t, test.status, test.malformed, test.replay), Transport: TransportNative},
				Agent: protocol.Agent{SystemPrompt: "Follow the installed Coffee Shop workflow."}, Workspace: workspace, MCP: grant,
			})
			require.NoError(t, err)
			for _, expected := range test.wantOutput {
				require.Contains(t, result, expected)
			}
			require.NotContains(t, strings.ToLower(result), "http")
			require.NotContains(t, strings.ToLower(result), "signed")
			require.Contains(t, strings.Join(lines, "\n"), "capability pack activation projected")
			require.Contains(t, strings.Join(lines, "\n"), "Coffee Shop static previews")
			harnessCalls := recordedPreviewWorkflowCalls(t, records)
			require.NotEmpty(t, harnessCalls)
			require.Equal(t, "get_task_context", harnessCalls[0].Operation)
			require.Equal(t, "publish_preview", harnessCalls[1].Operation)
			require.Equal(t, map[string]any{
				"relativePath": "site", "entrypoint": "index.html", "title": "Task dashboard",
				"summary": "Static task dashboard", "ttlSeconds": float64(3600), "idempotencyKey": previewPublicationKey,
			}, harnessCalls[1].Arguments)

			authority.mu.Lock()
			calls := append([]previewWorkflowCall(nil), authority.calls...)
			uploads, attachments := authority.uploads, authority.attachments
			authority.mu.Unlock()
			require.GreaterOrEqual(t, len(calls), 2)
			require.Equal(t, "get_task_context", calls[0].Operation)
			require.Equal(t, "publish_preview", calls[1].Operation)
			require.Equal(t, "site", calls[1].Arguments["relativePath"])
			require.Equal(t, "index.html", calls[1].Arguments["entrypoint"])
			require.Equal(t, "Task dashboard", calls[1].Arguments["title"])
			require.Equal(t, "Static task dashboard", calls[1].Arguments["summary"])
			require.Equal(t, float64(3600), calls[1].Arguments["ttlSeconds"])
			require.Equal(t, previewPublicationKey, calls[1].Arguments["idempotencyKey"])
			if test.malformed {
				require.Equal(t, 0, attachments)
				require.Len(t, calls, 2)
				require.Len(t, harnessCalls, 2)
				return
			}
			require.Equal(t, 1, attachments)
			last := calls[len(calls)-1]
			require.Equal(t, "update_task", last.Operation)
			require.Equal(t, previewAttachmentKey, last.Arguments["idempotencyKey"])
			completion := last.Arguments["completion"].(map[string]any)
			require.Equal(t, []any{"artifact-preview-one"}, completion["artifactIds"])
			require.Contains(t, completion["summary"], test.status)
			if test.replay {
				require.Len(t, calls, 5)
				require.Len(t, harnessCalls, 5)
				require.Equal(t, 1, uploads, "an exact replay must not upload or create a second preview")
				require.Len(t, authority.registered, 1, "an exact replay must retain one publication identity")
				require.Equal(t, harnessCalls[1].Arguments, harnessCalls[2].Arguments)
				require.Equal(t, previewPublicationKey, calls[3].Arguments["idempotencyKey"])
				require.NotEqual(t, calls[1].Arguments["title"], calls[3].Arguments["title"])
			} else {
				require.Len(t, calls, 3)
				require.Len(t, harnessCalls, 3)
			}
		})
	}
}
