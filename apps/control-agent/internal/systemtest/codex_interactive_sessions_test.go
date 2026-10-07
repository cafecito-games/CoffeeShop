//go:build system && unix

package systemtest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

func writeCodexSystemManifest(t *testing.T, directory string) string {
	t.Helper()
	document := map[string]any{
		"manifestVersion": "2",
		"components": []any{map[string]any{
			"id": "codex-cli", "kind": "harness", "harnessId": "codex-cli", "provider": "openai",
			"label": "System-test Codex CLI", "version": "0.147.0",
			"platforms": map[string]any{runtime.GOOS + "-" + runtime.GOARCH: map[string]any{
				"kind": "manual", "executablePath": "bin/codex",
			}},
			"launch": map[string]any{},
		}},
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "codex-components.json")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func installCodexSystemHarness(t *testing.T, node *baristaNode, manifest string) {
	t.Helper()
	plan := filepath.Join(node.dataRoot, "codex-plan.json")
	requireSetupSuccess(t, planSetup(t, node.home, node.dataRoot, manifest, plan), "plan pinned Codex fixture")
	requireSetupSuccess(t, runSetupCommand(t, node.home, nil,
		"setup", "apply", "--data-root", node.dataRoot, "--manifest", manifest, "--plan", plan,
		"--manual-artifact", "codex-cli="+managedCodexBinary,
		"--manual-checksum", "codex-cli="+fileSHA256(t, managedCodexBinary)), "install pinned Codex fixture")
	requireSetupSuccess(t, runSetupCommand(t, node.home, nil,
		"setup", "activate", "--data-root", node.dataRoot, "--manifest", manifest,
		"--kind", "harness", "--id", "codex-cli", "--version", "0.147.0"), "activate pinned Codex fixture")
}

// TestCodexInteractiveSessionInventoryAndHistory crosses the real Barista/Hub protocol-v6
// boundary with an account-free private-stdio App Server. The web component suites consume the
// same validated snapshot/detail/history shapes and prove their read-only rendering separately.
func TestCodexInteractiveSessionInventoryAndHistory(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	manifest := writeCodexSystemManifest(t, cluster.root)
	node := cluster.prepareNode(nodeOptions{id: "codex-session-node", name: "Codex session host", componentManifest: manifest})
	installCodexSystemHarness(t, node, manifest)
	node.start()

	var inventory struct {
		Sessions []protocol.HostHarnessSession `json:"sessions"`
		Total    int                           `json:"total"`
		Revision int64                         `json:"revision"`
	}
	cluster.eventually("existing Codex sessions to reach the Hub", func(_ snapshot) (bool, string) {
		if status := cluster.hub.request(http.MethodGet, "/api/host-sessions?limit=64", nil, &inventory); status != http.StatusOK {
			return false, fmt.Sprintf("inventory route returned %d", status)
		}
		if inventory.Total != 2 || len(inventory.Sessions) != 2 || inventory.Revision < 1 {
			return false, "waiting for the complete two-session inventory"
		}
		for _, session := range inventory.Sessions {
			if session.NodeID != node.options.id || session.HarnessID != "codex-cli" || session.Workspace != node.root {
				return false, "waiting for canonical Codex inventory identity"
			}
		}
		return true, ""
	})
	byProvider := map[string]protocol.HostHarnessSession{}
	for _, session := range inventory.Sessions {
		byProvider[session.ProviderSessionID] = session
	}
	writable := byProvider["system-codex-thread"]
	legacy := byProvider["system-codex-legacy"]
	if writable.ControlMode != "resume" || !slices.Equal(writable.Operations, []string{"attach", "close", "read-history"}) {
		t.Fatalf("paginated thread published the wrong read/adoption evidence: %+v", writable)
	}
	if legacy.ControlMode != "observe" || !slices.Equal(legacy.Operations, []string{"read-history"}) {
		t.Fatalf("legacy thread was not constrained to observe-only: %+v", legacy)
	}

	var detail struct {
		Session protocol.HostHarnessSession `json:"session"`
		Links   map[string]string           `json:"links"`
	}
	detailPath := "/api/host-sessions/" + url.PathEscape(writable.HostHarnessSessionID)
	if status := cluster.hub.request(http.MethodGet, detailPath, nil, &detail); status != http.StatusOK {
		t.Fatalf("host-session detail returned %d", status)
	}
	if detail.Session.HostHarnessSessionID != writable.HostHarnessSessionID || len(detail.Links) != 0 {
		t.Fatalf("detail identity or read-only links did not correlate: %+v", detail)
	}
	var history struct {
		HostHarnessSessionID string                                   `json:"hostHarnessSessionId"`
		Revision             int64                                    `json:"revision"`
		Items                []protocol.HostHarnessSessionHistoryItem `json:"items"`
		Truncated            bool                                     `json:"truncated"`
		Omitted              bool                                     `json:"omitted"`
	}
	cluster.eventually("the bounded Codex history request to settle", func(_ snapshot) (bool, string) {
		history = struct {
			HostHarnessSessionID string                                   `json:"hostHarnessSessionId"`
			Revision             int64                                    `json:"revision"`
			Items                []protocol.HostHarnessSessionHistoryItem `json:"items"`
			Truncated            bool                                     `json:"truncated"`
			Omitted              bool                                     `json:"omitted"`
		}{}
		if status := cluster.hub.request(http.MethodGet, detailPath+"/history", nil, &history); status != http.StatusOK {
			return false, "waiting for the history read route"
		}
		if len(history.Items) != 2 {
			return false, "waiting for the imported provider history"
		}
		return true, ""
	})
	if history.HostHarnessSessionID != writable.HostHarnessSessionID || history.Revision != writable.Revision || history.Truncated || history.Omitted || len(history.Items) != 2 {
		t.Fatalf("bounded imported history did not correlate: %+v", history)
	}
	if history.Items[0].Kind != "assistant" || history.Items[1].Kind != "user" {
		t.Fatalf("imported history was not normalized: %+v", history.Items)
	}

	stableIDs := map[string]string{}
	for providerID, session := range byProvider {
		stableIDs[providerID] = session.HostHarnessSessionID
	}
	publicSnapshot := cluster.hub.snapshot()
	if len(publicSnapshot.HostHarnessSessions) != 0 || publicSnapshot.HostSessionInventoryRevision < 1 {
		t.Fatalf("network snapshot must carry only the v6 marker and inventory revision: %+v", publicSnapshot)
	}
	nodeState := func(current snapshot) (computeNode, bool) {
		for _, candidate := range current.Nodes {
			if candidate.ID == node.options.id {
				return candidate, true
			}
		}
		return computeNode{}, false
	}
	registered, found := nodeState(publicSnapshot)
	if !found || registered.Status == "offline" || registered.LastSeen == "" {
		t.Fatalf("Codex session node was not registered before restart: %+v", registered)
	}
	readInventory := func() (bool, string) {
		inventory = struct {
			Sessions []protocol.HostHarnessSession `json:"sessions"`
			Total    int                           `json:"total"`
			Revision int64                         `json:"revision"`
		}{}
		if status := cluster.hub.request(http.MethodGet, "/api/host-sessions?limit=64", nil, &inventory); status != http.StatusOK {
			return false, fmt.Sprintf("inventory route returned %d", status)
		}
		if inventory.Total != 2 || len(inventory.Sessions) != 2 || inventory.Revision < 1 {
			return false, "waiting for the complete two-session inventory"
		}
		return true, ""
	}
	beforeHubRestart := registered.LastSeen
	var afterHubReconnect string
	cluster.hub.restart()
	cluster.eventually("the reconnect generation to preserve the Codex inventory", func(current snapshot) (bool, string) {
		reconnected, found := nodeState(current)
		if !found || reconnected.Status == "offline" || reconnected.LastSeen == beforeHubRestart {
			return false, "waiting for a fresh Barista registration after Hub restart"
		}
		afterHubReconnect = reconnected.LastSeen
		return readInventory()
	})
	node.restart()
	cluster.eventually("the Barista restart to preserve Coffee Shop session identities", func(current snapshot) (bool, string) {
		reconnected, found := nodeState(current)
		if !found || reconnected.Status == "offline" || reconnected.LastSeen == afterHubReconnect {
			return false, "waiting for a fresh registration after Barista restart"
		}
		if ready, reason := readInventory(); !ready {
			return false, reason
		}
		for _, session := range inventory.Sessions {
			if stableIDs[session.ProviderSessionID] != session.HostHarnessSessionID {
				return false, "waiting for stable Coffee Shop identity"
			}
		}
		return true, ""
	})

	snapshotBytes, _ := json.Marshal(cluster.hub.snapshot())
	detailBytes, _ := json.Marshal(detail)
	historyBytes, _ := json.Marshal(history)
	scanCanaries(t, map[string][]byte{
		"public host-session snapshot": snapshotBytes,
		"host-session detail":          detailBytes,
		"host-session history":         historyBytes,
		"Barista logs":                 []byte(node.logs.String()),
		"Hub logs":                     []byte(cluster.hub.logs.String()),
	})
}
