package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func doctorManifestFixture(t *testing.T) string {
	t.Helper()
	platform := runtime.GOOS + "-" + runtime.GOARCH
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "manual-acp", "harnessId": "manual-cli", "provider": "manual-vendor",
				"label": "Manual ACP adapter", "version": "0.4.0",
				"platforms": {"%s": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			}
		]
	}`, platform)
	manifestPath := filepath.Join(t.TempDir(), "adapters.json")
	require.NoError(t, os.WriteFile(manifestPath, []byte(manifestJSON), 0o644))
	return manifestPath
}

// emptyPATH isolates harness discovery from whatever happens to be installed on the test machine.
func emptyPATH(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
}

func TestDoctorJSONReportsUnreachableHubAndStillSucceeds(t *testing.T) {
	emptyPATH(t)
	manifestPath := doctorManifestFixture(t)
	dataRoot := t.TempDir()

	stdout, stderr, code := captureOutput(t, func() int {
		return runDoctor([]string{"--json", "--manifest", manifestPath, "--data-root", dataRoot, "--control-endpoint", "http://127.0.0.1:1"})
	})
	require.Equal(t, 0, code, "an unreachable hub is a reported fact, not a command failure; stderr: %s", stderr)

	var report struct {
		Adapters []struct {
			AdapterID        string `json:"adapterId"`
			HarnessID        string `json:"harnessId"`
			HarnessInstalled bool   `json:"harnessInstalled"`
			AdapterInstalled bool   `json:"adapterInstalled"`
			AuthReadiness    string `json:"authReadiness"`
			ACPLaunchReady   bool   `json:"acpLaunchReady"`
		} `json:"adapters"`
		HubConnectivity struct {
			Endpoint  string `json:"endpoint"`
			Reachable bool   `json:"reachable"`
		} `json:"hubConnectivity"`
		ProjectReadiness string `json:"projectReadiness"`
	}
	require.NoError(t, json.Unmarshal([]byte(stdout), &report))
	require.Len(t, report.Adapters, 1)
	entry := report.Adapters[0]
	require.Equal(t, "manual-acp", entry.AdapterID)
	require.False(t, entry.HarnessInstalled)
	require.False(t, entry.AdapterInstalled)
	require.Equal(t, "unknown", entry.AuthReadiness)
	// launch readiness is exactly the conjunction of the three inputs.
	require.Equal(t, entry.HarnessInstalled && entry.AdapterInstalled && entry.AuthReadiness == "ready", entry.ACPLaunchReady)
	require.False(t, report.HubConnectivity.Reachable)
	require.Equal(t, "http://127.0.0.1:1", report.HubConnectivity.Endpoint)
	require.NotEmpty(t, report.ProjectReadiness)
}

func TestDoctorHumanSummaryReportsUnreachableHub(t *testing.T) {
	emptyPATH(t)
	manifestPath := doctorManifestFixture(t)

	stdout, _, code := captureOutput(t, func() int {
		return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1"})
	})
	require.Equal(t, 0, code)
	require.Contains(t, stdout, "manual-acp (manual-cli): harness=missing adapter=missing auth=unknown launch=not-ready")
	require.Contains(t, stdout, "hub http://127.0.0.1:1: unreachable")
	require.Contains(t, stdout, "project readiness:")
}
