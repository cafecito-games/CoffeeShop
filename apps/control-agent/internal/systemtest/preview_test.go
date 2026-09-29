//go:build system && unix

package systemtest

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const previewPriorSigningCanary = "1111111111111111111111111111111111111111111111111111111111111111"
const previewCurrentSigningCanary = "2222222222222222222222222222222222222222222222222222222222222222"

func TestPreviewPublicationEndToEnd(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{
		clockOffset: true,
		previewDelivery: &previewDeliveryOptions{
			keys:        []previewSigningKey{{id: "prior", secret: previewPriorSigningCanary}},
			activeKeyID: "prior",
		},
	})
	if cluster.hub.previewPort == 0 || cluster.hub.previewPort == cluster.hub.port {
		t.Fatalf("preview delivery did not bind a distinct listener: primary=%d preview=%d", cluster.hub.port, cluster.hub.previewPort)
	}
	if cluster.hub.previewAuthority == "" || cluster.hub.primaryAuthority == "" {
		t.Fatal("preview delivery did not retain both configured authorities")
	}
	if cluster.hub.snapshot().ArtifactPreviews == nil {
		t.Fatal("the Hub omitted the public artifact preview collection")
	}

	clientID, clientSecret := cluster.mintOrchestratorClient("Preview evidence operator", "orchestrate")
	operatorRoot := filepath.Join(cluster.root, "operator-preview-root")
	externalRoot := filepath.Join(operatorRoot, "external-site")
	if err := os.MkdirAll(filepath.Join(externalRoot, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	externalIndex := []byte("<!doctype html><title>External preview</title><script src=\"assets/external.js\"></script>\n")
	externalAlternate := []byte("<!doctype html><title>External alternate</title>\n")
	externalScript := []byte("document.body.dataset.producer = \"external\";\n")
	if err := os.WriteFile(filepath.Join(externalRoot, "index.html"), externalIndex, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(externalRoot, "alternate.html"), externalAlternate, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(externalRoot, "assets", "external.js"), externalScript, 0o644); err != nil {
		t.Fatal(err)
	}
	bridge := cluster.startBridgeAt("preview-primary", clientID, clientSecret, operatorRoot)
	bridge.awaitTools("create_thread", "publish_preview")
	created := bridge.mustCallTool("create_thread", map[string]any{
		"title": "Isolated preview evidence", "objective": "Prove run and external preview delivery.",
	})
	threadID := text(object(created, "thread"), "id")
	if threadID == "" {
		t.Fatalf("create_thread returned no identity: %v", created)
	}

	beforeRefusals := cluster.hub.snapshot()
	for name, arguments := range map[string]map[string]any{
		"traversal": {
			"threadId": threadID, "relativePath": "../outside", "entrypoint": "index.html",
			"title": "Refused traversal", "idempotencyKey": "external-refused-traversal",
		},
		"missing-entrypoint": {
			"threadId": threadID, "relativePath": "external-site", "entrypoint": "missing.html",
			"title": "Refused missing entrypoint", "idempotencyKey": "external-refused-entrypoint",
		},
		"forged-source": {
			"threadId": threadID, "relativePath": "external-site", "entrypoint": "index.html",
			"title": "Refused forged source", "idempotencyKey": "external-refused-source",
			"sourceKey": "orchestrator-client:forged",
		},
	} {
		outcome := bridge.callTool("publish_preview", arguments)
		if outcome.errorCode() != "invalid_arguments" {
			t.Fatalf("external %s refusal returned %+v", name, outcome)
		}
		encoded, _ := json.Marshal(outcome)
		if strings.Contains(string(encoded), operatorRoot) {
			t.Fatalf("external %s refusal exposed the Bridge working root", name)
		}
	}
	if after := cluster.hub.snapshot(); len(after.Artifacts) != len(beforeRefusals.Artifacts) || len(after.ArtifactPreviews) != len(beforeRefusals.ArtifactPreviews) {
		t.Fatalf("external local refusals mutated Hub publication state: before=%d/%d after=%d/%d",
			len(beforeRefusals.Artifacts), len(beforeRefusals.ArtifactPreviews), len(after.Artifacts), len(after.ArtifactPreviews))
	}

	externalArguments := map[string]any{
		"threadId": threadID, "relativePath": "external-site", "entrypoint": "index.html",
		"title": "External preview", "summary": "Published through the real Bridge",
		"ttlSeconds": 300, "idempotencyKey": "external-preview-v1",
	}
	externalResult := bridge.mustCallTool("publish_preview", externalArguments)
	externalArtifact := object(externalResult, "artifact")
	externalPreview := object(externalResult, "preview")
	externalArtifactID, externalPreviewID := text(externalArtifact, "id"), text(externalPreview, "id")
	if externalArtifactID == "" || externalPreviewID == "" || externalResult["created"] != true {
		t.Fatalf("external preview publication returned no durable identities: %v", externalResult)
	}
	for _, forbidden := range []string{"uploadGrant", "signedUrl", "url", "runId", "agentId", "instanceId", "allocationId"} {
		if _, present := externalResult[forbidden]; present {
			t.Fatalf("external publication exposed top-level %s: %v", forbidden, externalResult)
		}
		if _, present := externalArtifact[forbidden]; present {
			t.Fatalf("external artifact fabricated or exposed %s: %v", forbidden, externalArtifact)
		}
		if _, present := externalPreview[forbidden]; present {
			t.Fatalf("external preview fabricated or exposed %s: %v", forbidden, externalPreview)
		}
	}
	if text(externalArtifact, "sourceKey") != "orchestrator-client:"+clientID || text(externalPreview, "sourceKey") != "orchestrator-client:"+clientID {
		t.Fatalf("external source attribution is wrong: artifact=%v preview=%v", externalArtifact, externalPreview)
	}
	replay := bridge.mustCallTool("publish_preview", externalArguments)
	if text(object(replay, "artifact"), "id") != externalArtifactID || text(object(replay, "preview"), "id") != externalPreviewID || replay["created"] != false {
		t.Fatalf("same-session external replay did not converge: %v", replay)
	}
	if err := os.WriteFile(filepath.Join(externalRoot, "assets", "external.js"), []byte("changed bytes must conflict\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	conflict := bridge.callTool("publish_preview", externalArguments)
	if conflict.errorCode() != "conflict" {
		t.Fatalf("changed external bytes did not conflict: %+v", conflict)
	}
	if err := os.WriteFile(filepath.Join(externalRoot, "assets", "external.js"), externalScript, 0o644); err != nil {
		t.Fatal(err)
	}
	for name, changedValue := range map[string]map[string]any{
		"entrypoint": {"entrypoint": "alternate.html"},
		"metadata":   {"summary": "changed summary"},
		"ttl":        {"ttlSeconds": 301},
	} {
		changedArguments := make(map[string]any, len(externalArguments))
		for key, value := range externalArguments {
			changedArguments[key] = value
		}
		for key, value := range changedValue {
			changedArguments[key] = value
		}
		if outcome := bridge.callTool("publish_preview", changedArguments); outcome.errorCode() != "conflict" {
			t.Fatalf("changed external %s did not conflict: %+v", name, outcome)
		}
	}

	ready := cluster.eventually("the external preview to become ready", func(current snapshot) (bool, string) {
		item, known := previewByID(current, externalPreviewID)
		return known && item.Status == "ready" && item.AccessState == "eligible", "external preview is not ready and eligible"
	})
	item, _ := previewByID(ready, externalPreviewID)
	artifactItem, known := artifactByID(ready, externalArtifactID)
	if !known || item.ArtifactID != artifactItem.ID || item.ArtifactSHA256 != artifactItem.SHA256 ||
		item.ThreadID != threadID || item.SourceKey != "orchestrator-client:"+clientID ||
		item.RunID != "" || item.AgentID != "" || item.InstanceID != "" || item.AllocationID != "" ||
		artifactItem.ThreadID != threadID || !artifactItem.Uploaded {
		t.Fatalf("external snapshot projection lost its exact join/source: artifact=%+v preview=%+v", artifactItem, item)
	}
	displayNameKnown := false
	for _, client := range ready.OrchestratorClients {
		if client.ID == clientID && client.Name == "Preview evidence operator" {
			displayNameKnown = true
		}
	}
	if !displayNameKnown {
		t.Fatal("external preview producer display name was not projected from its orchestrator client")
	}
	eventsBeforeStableReplay := len(ready.Events)
	stableReplay := bridge.mustCallTool("publish_preview", externalArguments)
	stableSnapshot := cluster.hub.snapshot()
	if text(object(stableReplay, "artifact"), "id") != externalArtifactID ||
		text(object(stableReplay, "preview"), "id") != externalPreviewID || stableReplay["created"] != false ||
		len(stableSnapshot.Artifacts) != 1 || len(stableSnapshot.ArtifactPreviews) != 1 || len(stableSnapshot.Events) != eventsBeforeStableReplay {
		t.Fatalf("ready external replay changed public identity or events: result=%v counts=%d/%d/%d want events=%d",
			stableReplay, len(stableSnapshot.Artifacts), len(stableSnapshot.ArtifactPreviews), len(stableSnapshot.Events), eventsBeforeStableReplay)
	}
	status, archive := cluster.hub.rawGet(artifactItem.DownloadPath)
	digest := sha256.Sum256(archive)
	if status != http.StatusOK || int64(len(archive)) != int64(artifactItem.Size) || hex.EncodeToString(digest[:]) != artifactItem.SHA256 {
		t.Fatalf("external immutable bundle disagrees with its producer identity: status=%d bytes=%d artifact=%+v", status, len(archive), artifactItem)
	}

	node := cluster.startNode(nodeOptions{
		id: "preview-node", labels: []string{"preview-e2e"}, concurrency: 2, instanceCapacity: integer(2),
	})
	spawn := func(harnessID, model, key string) string {
		t.Helper()
		result := bridge.mustCallTool("spawn_instance", map[string]any{
			"threadId": threadID, "idempotencyKey": "preview-resident-" + key,
			"purpose":      map[string]any{"name": key + " preview producer", "title": key + " producer"},
			"requirements": nativePreviewRequirements(harnessID, model),
		})
		instanceID := text(object(result, "instance"), "id")
		if instanceID == "" {
			t.Fatalf("spawn %s returned no instance: %v", key, result)
		}
		cluster.eventually(key+" native resident readiness", func(current snapshot) (bool, string) {
			instance, known := instanceByID(current, instanceID)
			allocation, allocated := allocationFor(current, instanceID)
			return known && allocated && instance.Status == "ready" && allocation.Status == "active" &&
					allocation.HarnessID == harnessID && allocation.Model == model && allocation.Transport == "native-cli",
				"resident is not ready on the exact native allocation"
		})
		return instanceID
	}
	claudeInstanceID := spawn("claude-cli", "sonnet", "claude")
	codexInstanceID := spawn("codex-cli", "default", "codex")
	preparedMaliciousWorkspace := map[string]bool{}
	for _, instanceID := range []string{claudeInstanceID, codexInstanceID} {
		current := cluster.hub.snapshot()
		allocation, known := allocationFor(current, instanceID)
		if !known {
			t.Fatalf("instance %s lost its allocation", instanceID)
		}
		if preparedMaliciousWorkspace[allocation.Workspace] {
			continue
		}
		preparedMaliciousWorkspace[allocation.Workspace] = true
		maliciousRoot := filepath.Join(allocation.Workspace, "symlink-site")
		if err := os.MkdirAll(maliciousRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(maliciousRoot, "index.html"), []byte("<!doctype html><title>refused</title>"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(operatorRoot, "external-site", "assets", "external.js"), filepath.Join(maliciousRoot, "linked.js")); err != nil {
			t.Fatal(err)
		}
	}

	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "run-preview-publications",
		"tasks": []taskSpecification{
			{
				Key: "claude-preview", Title: "Claude preview", Instructions: runPreviewScript(t, "claude", 600),
				Requirements: nativePreviewRequirements("claude-cli", "sonnet"), Pin: map[string]any{"instanceId": claudeInstanceID},
			},
			{
				Key: "codex-preview", Title: "Codex preview", Instructions: runPreviewScript(t, "codex", 3600),
				Requirements: nativePreviewRequirements("codex-cli", "default"), Pin: map[string]any{"instanceId": codexInstanceID},
			},
		},
	})

	beforeRestart := cluster.eventually("both native run previews to be ready at their restart gates", func(current snapshot) (bool, string) {
		for _, title := range []string{"Claude preview", "Codex preview"} {
			item, known := taskByTitle(current, threadID, title)
			if known && (item.Status == "failed" || item.Status == "cancelled" || item.Status == "blocked") {
				t.Fatalf("%s became terminal before its restart gate: status=%s error=%s", title, item.Status, item.Error)
			}
			if !known || item.Status != "running" {
				return false, title + " is not held at its restart gate"
			}
			runItem, known := current.latestAttempt(item)
			if !known {
				return false, title + " has no run"
			}
			previewItem, previewKnown := previewForRun(current, runItem.ID)
			if !previewKnown || previewItem.Status != "ready" || previewItem.AccessState != "eligible" {
				return false, title + " preview is not ready"
			}
		}
		return len(current.Artifacts) == 3 && len(current.ArtifactPreviews) == 3, "publication counts are not exactly three"
	})
	for _, title := range []string{"Claude preview", "Codex preview"} {
		taskItem, _ := taskByTitle(beforeRestart, threadID, title)
		runItem, _ := beforeRestart.latestAttempt(taskItem)
		previewItem, _ := previewForRun(beforeRestart, runItem.ID)
		artifactForPreview, known := artifactByID(beforeRestart, previewItem.ArtifactID)
		if !known || previewItem.ThreadID != threadID || previewItem.SourceKey != artifactForPreview.SourceKey ||
			previewItem.RunID != runItem.ID || previewItem.InstanceID != runItem.InstanceID || previewItem.AllocationID != runItem.AllocationID ||
			previewItem.AgentID != "" || artifactForPreview.RunID != runItem.ID || artifactForPreview.InstanceID != runItem.InstanceID ||
			artifactForPreview.AllocationID != runItem.AllocationID || !artifactForPreview.Uploaded {
			t.Fatalf("%s lost exact run/instance/allocation attribution: run=%+v artifact=%+v preview=%+v", title, runItem, artifactForPreview, previewItem)
		}
	}

	bridgeEvidence := bridgeCapturedOutput(bridge)
	bridge.stop(false)
	cluster.hub.restart()
	cluster.eventually("both native residents to reconcile after Hub restart", func(current snapshot) (bool, string) {
		claude, claudeKnown := instanceByID(current, claudeInstanceID)
		codex, codexKnown := instanceByID(current, codexInstanceID)
		registered, nodeKnown := nodeByID(current, node.options.id)
		return claudeKnown && codexKnown && nodeKnown && registered.Status != "offline" &&
				strings.Count(node.logs.String(), "connected to") >= 2 &&
				(claude.Status == "busy" || claude.Status == "ready") && (codex.Status == "busy" || codex.Status == "ready"),
			"native residents and current Barista socket have not reconciled"
	})
	bridge = cluster.startBridgeAt("preview-reconnected", clientID, clientSecret, operatorRoot)
	bridge.mustCallTool("attach_thread", map[string]any{"threadId": threadID})
	reconnectedReplay := bridge.mustCallTool("publish_preview", externalArguments)
	if text(object(reconnectedReplay, "artifact"), "id") != externalArtifactID ||
		text(object(reconnectedReplay, "preview"), "id") != externalPreviewID || reconnectedReplay["created"] != false {
		t.Fatalf("external replay after Bridge/Hub restart did not converge: %v", reconnectedReplay)
	}
	cluster.openGate("preview-hub-restart")
	completed := cluster.eventually("both native preview tasks to replay and complete after restart", func(current snapshot) (bool, string) {
		for _, title := range []string{"Claude preview", "Codex preview"} {
			item, known := taskByTitle(current, threadID, title)
			if known && (item.Status == "failed" || item.Status == "cancelled" || item.Status == "blocked") {
				t.Fatalf("%s became terminal after restart: status=%s error=%s", title, item.Status, item.Error)
			}
			if !known || item.Status != "completed" {
				return false, title + " is not completed"
			}
		}
		return len(current.Artifacts) == 3 && len(current.ArtifactPreviews) == 3, "replay duplicated a durable publication"
	})
	for _, title := range []string{"Claude preview", "Codex preview"} {
		taskItem, _ := taskByTitle(completed, threadID, title)
		runItem, _ := completed.latestAttempt(taskItem)
		previewItem, _ := previewForRun(completed, runItem.ID)
		if !taskCompletionAttachedArtifact(taskItem, previewItem.ArtifactID) {
			t.Fatalf("%s completion did not attach its own preview artifact", title)
		}
	}
	if len(completed.Artifacts) != len(beforeRestart.Artifacts) || len(completed.ArtifactPreviews) != len(beforeRestart.ArtifactPreviews) {
		t.Fatal("restart replay changed durable artifact or preview counts")
	}

	claudeTask, _ := taskByTitle(completed, threadID, "Claude preview")
	claudeRun, _ := completed.latestAttempt(claudeTask)
	claudePreview, _ := previewForRun(completed, claudeRun.ID)
	claudeArtifact, _ := artifactByID(completed, claudePreview.ArtifactID)
	codexTask, _ := taskByTitle(completed, threadID, "Codex preview")
	codexRun, _ := completed.latestAttempt(codexTask)
	codexPreview, _ := previewForRun(completed, codexRun.ID)
	codexArtifact, _ := artifactByID(completed, codexPreview.ArtifactID)
	for producer, published := range map[string]artifact{"claude": claudeArtifact, "codex": codexArtifact} {
		status, bundle := cluster.hub.rawGet(published.DownloadPath)
		digest := sha256.Sum256(bundle)
		if status != http.StatusOK || len(bundle) != published.Size || hex.EncodeToString(digest[:]) != published.SHA256 {
			t.Fatalf("%s immutable bundle disagrees with its producer identity: status=%d bytes=%d artifact=%+v", producer, status, len(bundle), published)
		}
	}

	unauthorizedAccess := requestAtAuthority(t, cluster.hub.port, cluster.hub.primaryAuthority, http.MethodPost,
		"/api/previews/"+url.PathEscape(externalPreviewID)+"/access", map[string]any{"ttlSeconds": 60}, nil)
	if unauthorizedAccess.status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated primary-origin access issuance returned %d", unauthorizedAccess.status)
	}
	externalAccess := issuePreviewAccess(t, cluster.hub, externalPreviewID, 60)
	assertCapabilityURLIsBounded(t, cluster, externalAccess.raw, clientSecret, operatorRoot)
	entrypoint := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, externalAccess.url.Path+"?ignored=1", nil, map[string]string{
		"Authorization": "Bearer " + enrollmentToken,
		"Cookie":        "session=ignored",
		"Forwarded":     "host=hub.localhost",
		"Origin":        "https://attacker.example",
		"Range":         "bytes=0-3",
	})
	if entrypoint.status != http.StatusOK || string(entrypoint.body) != string(externalIndex) {
		t.Fatalf("isolated entrypoint did not serve exact producer bytes: status=%d bytes=%q", entrypoint.status, entrypoint.body)
	}
	for name, want := range map[string]string{
		"Content-Type":                 "text/html; charset=utf-8",
		"Content-Length":               strconv.Itoa(len(externalIndex)),
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "no-referrer",
		"Cache-Control":                "private, no-store, max-age=0",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
	} {
		if entrypoint.header.Get(name) != want {
			t.Fatalf("isolated entrypoint header %s=%q, want %q", name, entrypoint.header.Get(name), want)
		}
	}
	if csp := entrypoint.header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors http://"+cluster.hub.primaryAuthority) || !strings.Contains(csp, "connect-src 'none'") {
		t.Fatalf("isolated entrypoint CSP does not name the primary origin and closed network policy: %q", csp)
	}
	for _, forbidden := range []string{"Content-Range", "Set-Cookie", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Location"} {
		if entrypoint.header.Get(forbidden) != "" {
			t.Fatalf("isolated entrypoint exposed forbidden %s=%q", forbidden, entrypoint.header.Get(forbidden))
		}
	}
	externalAssetPath := capabilityMemberPath(t, externalAccess.url.Path, "assets/external.js")
	asset := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, externalAssetPath, nil, nil)
	if asset.status != http.StatusOK || string(asset.body) != string(externalScript) || asset.header.Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("isolated relative asset changed: status=%d type=%q body=%q", asset.status, asset.header.Get("Content-Type"), asset.body)
	}
	head := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodHead, externalAccess.url.Path, nil, nil)
	if head.status != http.StatusOK || len(head.body) != 0 || head.header.Get("Content-Length") != strconv.Itoa(len(externalIndex)) {
		t.Fatalf("isolated HEAD changed the GET metadata: status=%d length=%q body=%d", head.status, head.header.Get("Content-Length"), len(head.body))
	}
	method := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodPost, externalAccess.url.Path, map[string]any{}, nil)
	if method.status != http.StatusMethodNotAllowed || method.header.Get("Allow") != "GET, HEAD" || string(method.body) != "Method Not Allowed\n" {
		t.Fatalf("preview wrong-method policy changed: status=%d allow=%q body=%q", method.status, method.header.Get("Allow"), method.body)
	}

	primarySwap := requestAtAuthority(t, cluster.hub.port, cluster.hub.previewAuthority, http.MethodGet, "/api/snapshot", nil, map[string]string{
		"Authorization": "Bearer " + enrollmentToken, "X-Forwarded-Host": cluster.hub.primaryAuthority,
	})
	previewSwap := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.primaryAuthority, http.MethodGet, externalAccess.url.Path, nil, map[string]string{
		"Forwarded": "host=" + cluster.hub.previewAuthority, "X-Forwarded-Host": cluster.hub.previewAuthority,
	})
	if primarySwap.status != http.StatusMisdirectedRequest || previewSwap.status != http.StatusMisdirectedRequest {
		t.Fatalf("swapped authorities did not fail with 421: primary=%d preview=%d", primarySwap.status, previewSwap.status)
	}
	for _, path := range []string{"/", "/assets/external.js", "/api/snapshot", "/api/artifacts/" + externalArtifactID + "/content", "/events", "/orchestrator-client"} {
		response := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, path, nil, map[string]string{
			"Authorization": "Bearer " + enrollmentToken, "Cookie": "operator=ignored",
		})
		if response.status != http.StatusNotFound || string(response.body) != "Not Found\n" {
			t.Fatalf("preview listener exposed primary surface %s: status=%d body=%q", path, response.status, response.body)
		}
	}

	token := capabilityToken(t, externalAccess.url.Path)
	tampered := token[:len(token)-1] + differentTokenCharacter(token[len(token)-1])
	denials := []string{
		"/_coffee-shop/preview/v1/bad/index.html?token=" + url.QueryEscape(token),
		"/_coffee-shop/preview/v1/" + tampered + "/index.html",
		"/_coffee-shop/preview/v1/" + token + "/%2e%2e/index.html",
		"/_coffee-shop/preview/v1/" + token + "/assets%2Fexternal.js",
		"/_coffee-shop/preview/v1/" + token + "/assets%5Cexternal.js",
		"/_coffee-shop/preview/v1/" + token + "/assets/%252Fexternal.js",
		"/_coffee-shop/preview/v1/" + token + "/assets//external.js",
		"/_coffee-shop/preview/v1/" + token + "/assets/missing.js",
		"/_coffee-shop/preview/v1/" + token + "/assets",
		"/_coffee-shop/preview/v1/" + token + "/run-codex-site/assets/app.js",
	}
	var denialBody []byte
	for _, path := range denials {
		response := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, path, nil, map[string]string{
			"Authorization": "Bearer " + enrollmentToken, "Cookie": "capability=" + token, "Origin": "http://" + cluster.hub.primaryAuthority,
		})
		if response.status != http.StatusNotFound {
			t.Fatalf("malformed capability/path did not return 404: path=%s status=%d", screenedPath(path), response.status)
		}
		if denialBody == nil {
			denialBody = response.body
		} else if string(response.body) != string(denialBody) {
			t.Fatalf("public denial bodies differ for %s", screenedPath(path))
		}
	}

	claudeAccess := issuePreviewAccess(t, cluster.hub, claudePreview.ID, 300)
	codexPriorAccess := issuePreviewAccess(t, cluster.hub, codexPreview.ID, 300)
	claudeAsset := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet,
		capabilityMemberPath(t, claudeAccess.url.Path, "assets/app.js"), nil, nil)
	codexAsset := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet,
		capabilityMemberPath(t, codexPriorAccess.url.Path, "assets/app.js"), nil, nil)
	if string(claudeAsset.body) != "document.body.dataset.producer = \"claude\";\n" ||
		string(codexAsset.body) != "document.body.dataset.producer = \"codex\";\n" || string(claudeAsset.body) == string(codexAsset.body) {
		t.Fatalf("concurrent preview capabilities exchanged producer bytes: claude=%q codex=%q", claudeAsset.body, codexAsset.body)
	}
	if cross := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet,
		capabilityMemberPath(t, claudeAccess.url.Path, "assets/external.js"), nil, nil); cross.status != http.StatusNotFound {
		t.Fatalf("a run capability substituted an external member: status=%d", cross.status)
	}
	if kid := capabilityKeyID(t, codexPriorAccess.url.Path); kid != "prior" {
		t.Fatalf("initial issuance used key %q, want prior", kid)
	}

	duplicate := rawHostRequest(t, cluster.hub.previewPort, http.MethodGet, externalAccess.url.Path,
		[]string{cluster.hub.previewAuthority, cluster.hub.primaryAuthority}, nil)
	if duplicate.status != http.StatusMisdirectedRequest {
		t.Fatalf("duplicate Host did not fail with 421: status=%d", duplicate.status)
	}
	malformedAuthority := requestAtAuthority(t, cluster.hub.previewPort, "preview.localhost", http.MethodGet, externalAccess.url.Path, nil, map[string]string{
		"Forwarded": "host=" + cluster.hub.previewAuthority, "X-Forwarded-Host": cluster.hub.previewAuthority,
	})
	if malformedAuthority.status != http.StatusMisdirectedRequest {
		t.Fatalf("malformed preview authority did not fail with 421: status=%d", malformedAuthority.status)
	}

	bridgeEvidence += bridgeCapturedOutput(bridge)
	bridge.stop(false)
	cluster.hub.rotatePreviewSigningKeys("current",
		previewSigningKey{id: "prior", secret: previewPriorSigningCanary},
		previewSigningKey{id: "current", secret: previewCurrentSigningCanary},
	)
	cluster.hub.restart()
	if retained := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, codexPriorAccess.url.Path, nil, nil); retained.status != http.StatusOK {
		t.Fatalf("retained prior signing key stopped verifying its original grant: %d", retained.status)
	}
	codexCurrentAccess := issuePreviewAccess(t, cluster.hub, codexPreview.ID, 300)
	if kid := capabilityKeyID(t, codexCurrentAccess.url.Path); kid != "current" {
		t.Fatalf("rotation did not issue only from the active key: %q", kid)
	}
	cluster.hub.rotatePreviewSigningKeys("current", previewSigningKey{id: "current", secret: previewCurrentSigningCanary})
	cluster.hub.restart()
	if removed := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, codexPriorAccess.url.Path, nil, nil); removed.status != http.StatusNotFound {
		t.Fatalf("removed prior signing key still verified: %d", removed.status)
	}
	if current := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, codexCurrentAccess.url.Path, nil, nil); current.status != http.StatusOK {
		t.Fatalf("current signing key did not survive key removal restart: %d", current.status)
	}
	if final := cluster.hub.snapshot(); len(final.Artifacts) != 3 || len(final.ArtifactPreviews) != 3 {
		t.Fatalf("key rotation mutated publication state: artifacts=%d previews=%d", len(final.Artifacts), len(final.ArtifactPreviews))
	}

	externalCurrentAccess := issuePreviewAccess(t, cluster.hub, externalPreviewID, 60)
	renewedExternal := renewPreviewLifecycle(t, cluster.hub, externalPreviewID, 600)
	originalExternal, _ := previewByID(completed, externalPreviewID)
	if renewedExternal.Status != "ready" || renewedExternal.ExpiresAt <= originalExternal.ExpiresAt {
		t.Fatalf("eligible lifecycle renewal did not extend ready state: before=%+v after=%+v", originalExternal, renewedExternal)
	}
	cluster.hub.advanceClock(externalCurrentAccess.expiresAt.Sub(time.Now()) + 250*time.Millisecond)
	if old := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, externalCurrentAccess.url.Path, nil, nil); old.status != http.StatusNotFound {
		t.Fatalf("renewal extended an already-issued access URL: %d", old.status)
	}
	freshExternalAccess := issuePreviewAccess(t, cluster.hub, externalPreviewID, 60)
	if fresh := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, freshExternalAccess.url.Path, nil, nil); fresh.status != http.StatusOK {
		t.Fatalf("fresh access after lifecycle renewal did not serve: %d", fresh.status)
	}

	lifecycleExpiry, err := time.Parse(time.RFC3339Nano, renewedExternal.ExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	cluster.hub.advanceClock(lifecycleExpiry.Sub(time.Now()) + 250*time.Millisecond)
	unavailable := requestAtAuthority(t, cluster.hub.port, cluster.hub.primaryAuthority, http.MethodPost,
		"/api/previews/"+url.PathEscape(externalPreviewID)+"/access", map[string]any{},
		map[string]string{"Authorization": "Bearer " + enrollmentToken})
	if unavailable.status != http.StatusConflict {
		t.Fatalf("lifecycle expiry boundary still issued access: %d", unavailable.status)
	}
	expired := cluster.eventually("external preview expiry maintenance to persist exactly once", func(current snapshot) (bool, string) {
		item, known := previewByID(current, externalPreviewID)
		return known && item.Status == "expired" && item.AccessState == "unavailable" && item.ExpiredAt != "", "external preview expiry is not persisted"
	})
	expiredExternal, _ := previewByID(expired, externalPreviewID)
	cluster.hub.advanceClock(lifecycleExpiry.Sub(time.Now()) + time.Second)
	afterExpiry := cluster.hub.snapshot()
	afterExpiredExternal, _ := previewByID(afterExpiry, externalPreviewID)
	if afterExpiredExternal.ExpiredAt != expiredExternal.ExpiredAt || afterExpiredExternal.UpdatedAt != expiredExternal.UpdatedAt {
		t.Fatalf("a repeated due sweep changed terminal expiry state: before=%+v after=%+v", expiredExternal, afterExpiredExternal)
	}

	capturePreviewEvidence(t, cluster)

	driftAccess := issuePreviewAccess(t, cluster.hub, codexPreview.ID, 300)
	preparedEntrypoint := filepath.Join(filepath.Dir(cluster.hub.dataPath), "prepared-previews", codexPreview.ID,
		codexArtifact.SHA256, "content", codexPreview.Entrypoint)
	preparedBytes, err := os.ReadFile(preparedEntrypoint)
	if err != nil {
		t.Fatal(err)
	}
	preparedInfo, err := os.Stat(preparedEntrypoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(preparedEntrypoint); err != nil {
		t.Fatal(err)
	}
	driftIssuance := requestAtAuthority(t, cluster.hub.port, cluster.hub.primaryAuthority, http.MethodPost,
		"/api/previews/"+url.PathEscape(codexPreview.ID)+"/access", map[string]any{},
		map[string]string{"Authorization": "Bearer " + enrollmentToken})
	if driftIssuance.status != http.StatusConflict {
		t.Fatalf("prepared-tree drift received a new capability: %d", driftIssuance.status)
	}
	if driftDelivery := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, driftAccess.url.Path, nil, nil); driftDelivery.status != http.StatusNotFound {
		t.Fatalf("prepared-tree drift served from another source: %d", driftDelivery.status)
	}
	if _, err := os.Stat(preparedEntrypoint); !os.IsNotExist(err) {
		t.Fatalf("drift denial self-healed the removed member: %v", err)
	}
	if err := os.WriteFile(preparedEntrypoint, preparedBytes, preparedInfo.Mode().Perm()); err != nil {
		t.Fatal(err)
	}
	cluster.hub.restart()
	recoveredAccess := issuePreviewAccess(t, cluster.hub, codexPreview.ID, 300)
	if recovered := requestAtAuthority(t, cluster.hub.previewPort, cluster.hub.previewAuthority, http.MethodGet, recoveredAccess.url.Path, nil, nil); recovered.status != http.StatusOK || string(recovered.body) != "<!doctype html><title>codex preview</title><script src=\"assets/app.js\"></script>\n" {
		t.Fatalf("clean recovery did not serve restored exact bytes: status=%d body=%q", recovered.status, recovered.body)
	}

	privateBaristaPath := filepath.Join(node.root, "private-preview-authority-canary")
	if err := os.MkdirAll(privateBaristaPath, 0o700); err != nil {
		t.Fatal(err)
	}
	assertPreviewLeakage(t, cluster, node, bridgeEvidence, clientSecret, operatorRoot, privateBaristaPath,
		externalCurrentAccess.raw, freshExternalAccess.raw, driftAccess.raw, recoveredAccess.raw)

	if err := os.Remove(preparedEntrypoint); err != nil {
		t.Fatal(err)
	}
	cluster.hub.stop()
	recoveryLogs := cluster.hub.startExpectingRecoveryFailure()
	if !strings.Contains(strings.ToLower(recoveryLogs), "preview") ||
		strings.Contains(recoveryLogs, previewCurrentSigningCanary) || strings.Contains(recoveryLogs, preparedEntrypoint) {
		t.Fatal("inconsistent ready-state recovery did not produce a bounded, screened preview refusal")
	}

}

func renewPreviewLifecycle(t *testing.T, hub *hubProcess, previewID string, ttlSeconds int) artifactPreview {
	t.Helper()
	response := requestAtAuthority(t, hub.port, hub.primaryAuthority, http.MethodPost,
		"/api/previews/"+url.PathEscape(previewID)+"/renew", map[string]any{"ttlSeconds": ttlSeconds},
		map[string]string{"Authorization": "Bearer " + enrollmentToken})
	if response.status != http.StatusOK {
		t.Fatalf("preview lifecycle renewal returned %d: %s", response.status, response.body)
	}
	var result struct {
		Preview artifactPreview `json:"preview"`
	}
	if err := json.Unmarshal(response.body, &result); err != nil {
		t.Fatal(err)
	}
	return result.Preview
}

func bridgeCapturedOutput(bridge *bridgeProcess) string {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.stdout.String() + bridge.logs.String()
}

func capturePreviewEvidence(t *testing.T, cluster *environment) {
	t.Helper()
	directory := os.Getenv("COFFEE_SHOP_PREVIEW_EVIDENCE_DIR")
	if directory == "" {
		return
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(repositoryRoot, "apps", "web", "dist", "index.html")); err != nil {
		t.Fatal("preview evidence requested without the built PWA; run `task frontend:build` first")
	}
	chromium, err := exec.LookPath("chromium")
	if err != nil {
		t.Fatal("preview evidence requested but Chromium is unavailable")
	}
	playwrightCLI, err := exec.LookPath("playwright")
	if err != nil {
		t.Fatal("preview evidence requested but the Playwright CLI is unavailable")
	}
	resolvedPlaywrightCLI, err := filepath.EvalSymlinks(playwrightCLI)
	if err != nil {
		t.Fatal("preview evidence requested but the Playwright CLI cannot be resolved")
	}
	playwright := filepath.Join(filepath.Dir(resolvedPlaywrightCLI), "index.mjs")
	if _, err := os.Stat(playwright); err != nil {
		t.Fatal("preview evidence requested but the Playwright module is unavailable")
	}
	desktop := filepath.Join(directory, "preview-e2e-desktop-1440x1200.png")
	mobile := filepath.Join(directory, "preview-e2e-mobile-390x844.png")
	script := `
import { chromium } from "` + playwright + `";
const browser = await chromium.launch({ headless: true, executablePath: process.env.EVIDENCE_CHROMIUM });
for (const [path, width, height, focusReadyActions] of [[process.env.EVIDENCE_DESKTOP, 1440, 1200, false], [process.env.EVIDENCE_MOBILE, 390, 844, true]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(process.env.EVIDENCE_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  await page.getByRole("heading", { name: "Isolated preview evidence", exact: true }).waitFor();
  await page.getByText("External preview", { exact: true }).waitFor();
  await page.getByText("Claude preview", { exact: true }).waitFor();
  await page.getByText("Codex preview", { exact: true }).waitFor();
  if (focusReadyActions) {
    await page.getByText("Codex preview", { exact: true }).evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.getByRole("button", { name: "Request access to preview Codex preview", exact: true }).waitFor();
  }
  await page.screenshot({ path, fullPage: true });
  await page.close();
}
await browser.close();`
	command := exec.Command("node", "--input-type=module", "-e", script)
	command.Dir = repositoryRoot
	command.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"),
		"EVIDENCE_CHROMIUM=" + chromium,
		"EVIDENCE_URL=http://127.0.0.1:" + strconv.Itoa(cluster.hub.port) + "/?token=" + url.QueryEscape(enrollmentToken),
		"EVIDENCE_DESKTOP=" + desktop, "EVIDENCE_MOBILE=" + mobile,
	}
	if output, err := command.CombinedOutput(); err != nil {
		screened := strings.ReplaceAll(string(output), enrollmentToken, "<screened>")
		t.Fatalf("capture producer-backed PWA evidence: %v\n%s", err, screened)
	}
	for _, path := range []string{desktop, mobile} {
		info, err := os.Stat(path)
		if err != nil || info.Size() == 0 {
			t.Fatalf("PWA evidence was not captured at %s", path)
		}
	}
}

func assertPreviewLeakage(
	t *testing.T,
	cluster *environment,
	node *baristaNode,
	bridgeEvidence, clientSecret, operatorRoot, privateBaristaPath string,
	capabilityURLs ...string,
) {
	t.Helper()
	cluster.assertNoCredentialLeak()
	snapshotBytes, _ := json.Marshal(cluster.hub.snapshot())
	recordBytes, _ := json.Marshal(cluster.harnessRecords())
	channels := map[string][]byte{
		"public snapshot":  snapshotBytes,
		"Hub logs":         []byte(cluster.hub.logs.String()),
		"Barista logs":     []byte(node.logs.String()),
		"Bridge output":    []byte(bridgeEvidence),
		"provider records": recordBytes,
	}
	fileIndex := 0
	_ = filepath.WalkDir(cluster.root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr == nil {
			fileIndex++
			channels["scenario file "+strconv.Itoa(fileIndex)] = content
		}
		return nil
	})
	forbidden := []string{clientSecret, previewPriorSigningCanary, previewCurrentSigningCanary, operatorRoot, privateBaristaPath}
	forbidden = append(forbidden, capabilityURLs...)
	for category, content := range channels {
		for _, canary := range forbidden {
			if canary != "" && strings.Contains(string(content), canary) {
				t.Fatalf("preview authority leaked into %s", category)
			}
		}
	}
	public := string(snapshotBytes)
	for _, privateVocabulary := range []string{"uploadGrant", "signedUrl", "prepared-previews", "previewRegistrationReceipts", "artifactUploadGrants"} {
		if strings.Contains(public, privateVocabulary) {
			t.Fatalf("public snapshot exposed private preview vocabulary %s", privateVocabulary)
		}
	}
}

type observedHTTPResponse struct {
	status int
	header http.Header
	body   []byte
}

type issuedPreviewAccess struct {
	raw       string
	url       *url.URL
	expiresAt time.Time
}

func requestAtAuthority(t *testing.T, port int, authority, method, path string, body any, headers map[string]string) observedHTTPResponse {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(port)+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = authority
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("%s %s through %s: %v", method, screenedPath(path), authority, err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return observedHTTPResponse{status: response.StatusCode, header: response.Header.Clone(), body: content}
}

func rawHostRequest(t *testing.T, port int, method, path string, hosts []string, headers map[string]string) observedHTTPResponse {
	t.Helper()
	connection, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	writer := bufio.NewWriter(connection)
	if _, err := fmt.Fprintf(writer, "%s %s HTTP/1.1\r\n", method, path); err != nil {
		t.Fatal(err)
	}
	for _, host := range hosts {
		if _, err := fmt.Fprintf(writer, "Host: %s\r\n", host); err != nil {
			t.Fatal(err)
		}
	}
	for name, value := range headers {
		if _, err := fmt.Fprintf(writer, "%s: %s\r\n", name, value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.WriteString("Connection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: method})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	content, _ := io.ReadAll(response.Body)
	return observedHTTPResponse{status: response.StatusCode, header: response.Header.Clone(), body: content}
}

func issuePreviewAccess(t *testing.T, hub *hubProcess, previewID string, ttlSeconds int) issuedPreviewAccess {
	t.Helper()
	response := requestAtAuthority(t, hub.port, hub.primaryAuthority, http.MethodPost,
		"/api/previews/"+url.PathEscape(previewID)+"/access", map[string]any{"ttlSeconds": ttlSeconds},
		map[string]string{"Authorization": "Bearer " + enrollmentToken})
	if response.status != http.StatusOK {
		t.Fatalf("preview access issuance returned %d: %s", response.status, response.body)
	}
	if response.header.Get("Set-Cookie") != "" {
		t.Fatal("preview access issuance set a cookie")
	}
	var result struct {
		PreviewID string `json:"previewId"`
		URL       string `json:"url"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.Unmarshal(response.body, &result); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(result.URL)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, result.ExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	if result.PreviewID != previewID {
		t.Fatalf("access response changed preview identity: got %s want %s", result.PreviewID, previewID)
	}
	return issuedPreviewAccess{raw: result.URL, url: parsed, expiresAt: expiresAt}
}

func assertCapabilityURLIsBounded(t *testing.T, cluster *environment, raw, clientSecret, operatorRoot string) {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "http" || parsed.Host != cluster.hub.previewAuthority || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		t.Fatalf("capability URL escaped the configured isolated origin")
	}
	for _, forbidden := range []string{
		enrollmentToken, clientSecret, previewPriorSigningCanary, previewCurrentSigningCanary,
		operatorRoot, "Cookie", "Bearer", "uploadGrant",
	} {
		if strings.Contains(raw, forbidden) {
			t.Fatal("capability URL contained non-capability authority or a local root")
		}
	}
}

func capabilityToken(t *testing.T, path string) string {
	t.Helper()
	const prefix = "/_coffee-shop/preview/v1/"
	remainder := strings.TrimPrefix(path, prefix)
	separator := strings.IndexByte(remainder, '/')
	if remainder == path || separator < 1 {
		t.Fatalf("capability URL used an unknown route shape: %s", screenedPath(path))
	}
	return remainder[:separator]
}

func capabilityMemberPath(t *testing.T, capabilityPath, member string) string {
	t.Helper()
	return "/_coffee-shop/preview/v1/" + capabilityToken(t, capabilityPath) + "/" + member
}

func capabilityKeyID(t *testing.T, path string) string {
	t.Helper()
	payloadComponent := strings.Split(capabilityToken(t, path), ".")[0]
	payload, err := base64.RawURLEncoding.DecodeString(payloadComponent)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		KeyID string `json:"kid"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.KeyID
}

func differentTokenCharacter(value byte) string {
	if value == 'A' {
		return "B"
	}
	return "A"
}

func screenedPath(path string) string {
	if strings.HasPrefix(path, "/_coffee-shop/preview/v1/") {
		return "/_coffee-shop/preview/v1/<screened>"
	}
	return path
}

func nativePreviewRequirements(harnessID, model string) map[string]any {
	return map[string]any{
		"harnessIds": []string{harnessID}, "models": []string{model}, "transports": []string{"native-cli"},
		"operatingSystems": []string{runtime.GOOS}, "labels": []string{"preview-e2e"},
	}
}

func runPreviewScript(t *testing.T, producer string, ttlSeconds int) string {
	t.Helper()
	root := "run-" + producer + "-site"
	arguments := map[string]any{
		"relativePath": root, "entrypoint": "index.html", "title": strings.ToUpper(producer[:1]) + producer[1:] + " preview",
		"summary": "Published through the real " + producer + " native run", "ttlSeconds": ttlSeconds,
		"idempotencyKey": "run-preview-" + producer,
	}
	changed := map[string]any{}
	for key, value := range arguments {
		changed[key] = value
	}
	changed["title"] = arguments["title"].(string) + " changed"
	return script(t,
		step{Call: "publish_preview", Arguments: map[string]any{
			"relativePath": "/outside", "entrypoint": "index.html", "title": "Refused absolute", "idempotencyKey": "refused-absolute-" + producer,
		}, ExpectErrorCode: "invalid_arguments", As: "absoluteRefusal"},
		step{Call: "publish_preview", Arguments: map[string]any{
			"relativePath": "../outside", "entrypoint": "index.html", "title": "Refused traversal", "idempotencyKey": "refused-traversal-" + producer,
		}, ExpectErrorCode: "invalid_arguments", As: "traversalRefusal"},
		step{Call: "publish_preview", Arguments: map[string]any{
			"relativePath": "symlink-site", "entrypoint": "index.html", "title": "Refused symlink", "idempotencyKey": "refused-symlink-" + producer,
		}, ExpectErrorCode: "invalid_source", As: "symlinkRefusal"},
		step{WriteFile: &writeFile{Path: root + "/index.html", Content: "<!doctype html><title>" + producer + " preview</title><script src=\"assets/app.js\"></script>\n"}},
		step{WriteFile: &writeFile{Path: root + "/assets/app.js", Content: "document.body.dataset.producer = \"" + producer + "\";\n"}},
		step{Call: "publish_preview", Arguments: map[string]any{
			"relativePath": root, "entrypoint": "missing.html", "title": "Refused missing entrypoint", "idempotencyKey": "refused-entrypoint-" + producer,
		}, ExpectErrorCode: "invalid_source", As: "entrypointRefusal"},
		step{Call: "publish_preview", Arguments: arguments, As: "publication"},
		step{Gate: "preview-hub-restart"},
		step{Call: "publish_preview", Arguments: arguments, As: "replayed"},
		step{Call: "publish_preview", Arguments: changed, ExpectErrorCode: "idempotency_conflict", As: "conflict"},
		step{Call: "update_task", Arguments: map[string]any{
			"idempotencyKey": "attach-preview-" + producer,
			"completion":     map[string]any{"summary": producer + " preview ready", "artifactIds": []string{"{{publication.artifact.id}}"}},
		}, As: "completed"},
		step{Message: producer + " artifact={{publication.artifact.id}} preview={{publication.preview.id}} replay={{replayed.preview.id}}"},
	)
}

func previewForRun(current snapshot, runID string) (artifactPreview, bool) {
	for _, item := range current.ArtifactPreviews {
		if item.RunID == runID {
			return item, true
		}
	}
	return artifactPreview{}, false
}

func taskCompletionAttachedArtifact(item task, artifactID string) bool {
	completion, _ := item.Progress["completion"].(map[string]any)
	attached, _ := completion["artifactIds"].([]any)
	for _, candidate := range attached {
		if candidate == artifactID {
			return true
		}
	}
	return false
}

func previewByID(current snapshot, id string) (artifactPreview, bool) {
	for _, item := range current.ArtifactPreviews {
		if item.ID == id {
			return item, true
		}
	}
	return artifactPreview{}, false
}

func artifactByID(current snapshot, id string) (artifact, bool) {
	for _, item := range current.Artifacts {
		if item.ID == id {
			return item, true
		}
	}
	return artifact{}, false
}
