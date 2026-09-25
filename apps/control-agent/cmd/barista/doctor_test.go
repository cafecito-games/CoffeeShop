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
		"manifestVersion": "2",
		"components": [
			{
				"id": "manual-acp", "kind": "acp-adapter", "harnessId": "manual-cli", "provider": "manual-vendor",
				"label": "Manual ACP adapter", "version": "0.4.0",
				"platforms": {"%s": {"kind": "manual", "executablePath": "bin/adapter"}},
				"launch": {}
			}
		]
	}`, platform)
	manifestPath := filepath.Join(t.TempDir(), "components.json")
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
		Components []struct {
			Component struct {
				Kind    string `json:"kind"`
				ID      string `json:"id"`
				Version string `json:"version"`
			} `json:"component"`
			HarnessID          string `json:"harnessId"`
			HarnessInstalled   bool   `json:"harnessInstalled"`
			ComponentInstalled bool   `json:"componentInstalled"`
			AuthReadiness      string `json:"authReadiness"`
			ACPLaunchReady     bool   `json:"acpLaunchReady"`
		} `json:"components"`
		HubConnectivity struct {
			Endpoint  string `json:"endpoint"`
			Reachable bool   `json:"reachable"`
		} `json:"hubConnectivity"`
		ProjectReadiness string `json:"projectReadiness"`
	}
	require.NoError(t, json.Unmarshal([]byte(stdout), &report))
	require.Len(t, report.Components, 1)
	entry := report.Components[0]
	require.Equal(t, "manual-acp", entry.Component.ID)
	require.Equal(t, "acp-adapter", entry.Component.Kind)
	require.Equal(t, "0.4.0", entry.Component.Version)
	require.False(t, entry.HarnessInstalled)
	require.False(t, entry.ComponentInstalled)
	require.Equal(t, "unknown", entry.AuthReadiness)
	// launch readiness is exactly the conjunction of the three inputs.
	require.Equal(t, entry.HarnessInstalled && entry.ComponentInstalled && entry.AuthReadiness == "ready", entry.ACPLaunchReady)
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
	require.Contains(t, stdout, "acp-adapter/manual-acp@0.4.0 (manual-cli): harness=missing component=missing auth=unknown launch=not-ready")
	require.Contains(t, stdout, "hub http://127.0.0.1:1: unreachable")
	require.Contains(t, stdout, "project readiness:")
	require.Contains(t, stdout, "approval policy for claude-cli: manual (every ACP permission request is sent to Coffee Shop)")
	require.Contains(t, stdout, "approval policy for codex-cli: manual")
}

func TestDoctorReportsTheEffectiveApprovalPolicy(t *testing.T) {
	emptyPATH(t)
	manifestPath := doctorManifestFixture(t)
	t.Setenv("BARISTA_APPROVAL_POLICY", "auto")

	stdout, _, code := captureOutput(t, func() int {
		return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1", "--approval-policy", "claude-cli=bypass"})
	})
	require.Equal(t, 0, code)
	require.Contains(t, stdout, "approval policy for claude-cli: bypass (permission requests are not sent to Coffee Shop)")
	require.Contains(t, stdout, "approval policy for codex-cli: auto")

	stdout, _, code = captureOutput(t, func() int {
		return runDoctor([]string{"--json", "--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1", "--approval-policy", "codex-cli=bypass"})
	})
	require.Equal(t, 0, code)
	var report struct {
		ApprovalPolicies map[string]string `json:"approvalPolicies"`
	}
	require.NoError(t, json.Unmarshal([]byte(stdout), &report))
	require.Equal(t, map[string]string{"claude-cli": "auto", "codex-cli": "bypass"}, report.ApprovalPolicies)

	_, stderr, code := captureOutput(t, func() int {
		return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--approval-policy", "auto", "--approval-policy", "bypass"})
	})
	require.Equal(t, 2, code)
	require.Contains(t, stderr, "conflicts with an earlier node-wide approval policy")
}

// TestHostPortFromEndpointNeverEmbedsTheRawEndpointInErrors proves the fix-4 property: an invalid
// or malformed control endpoint's error names only what was structurally wrong, never the raw
// endpoint value itself — including ordinary "user:password@" userinfo, which
// protocol.LooksSecretLike's narrow token-shaped denylist does not recognize as secret-like at
// all, so this path must never rely on that screen catching it after the fact.
func TestHostPortFromEndpointNeverEmbedsTheRawEndpointInErrors(t *testing.T) {
	const secretLikeUserinfo = "user:hunter2ghp_abcdefghij1234567890"
	tests := []struct {
		name      string
		endpoint  string
		wantError bool
	}{
		{
			name:      "userinfo with an ordinary password is not itself invalid",
			endpoint:  "https://" + secretLikeUserinfo + "@hub.example:8787",
			wantError: false,
		},
		{
			name:      "empty endpoint",
			endpoint:  "   ",
			wantError: true,
		},
		{
			name:      "url with no host",
			endpoint:  "https:///path?leaked=" + secretLikeUserinfo,
			wantError: true,
		},
		{
			name:      "unparseable url with invalid percent-encoding",
			endpoint:  "https://" + secretLikeUserinfo + "@%zz.example.com",
			wantError: true,
		},
		{
			name:      "unparseable url with an embedded control character",
			endpoint:  "https://" + secretLikeUserinfo + "@exa\nmple.com",
			wantError: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := hostPortFromEndpoint(test.endpoint)
			if test.wantError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			if err != nil {
				require.NotContains(t, err.Error(), secretLikeUserinfo)
				require.NotContains(t, err.Error(), "hunter2")
				require.NotContains(t, err.Error(), test.endpoint)
			}
		})
	}
}

// TestDoctorNeverLeaksEndpointCredentialsThroughConnectivityFailure exercises the same property
// end to end through runDoctor: a malformed --control-endpoint carrying credential-shaped userinfo
// must never surface in stdout, in either JSON or human output.
func TestDoctorNeverLeaksEndpointCredentialsThroughConnectivityFailure(t *testing.T) {
	emptyPATH(t)
	manifestPath := doctorManifestFixture(t)
	const secretLikeUserinfo = "user:hunter2ghp_abcdefghij1234567890"
	malformedEndpoint := "https://" + secretLikeUserinfo + "@%zz.example.com"

	stdout, _, code := captureOutput(t, func() int {
		return runDoctor([]string{"--json", "--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", malformedEndpoint})
	})
	require.Equal(t, 0, code)
	require.NotContains(t, stdout, secretLikeUserinfo)
	require.NotContains(t, stdout, "hunter2")
}

func TestDoctorReportsTheInstanceCapacityTheDaemonWouldUse(t *testing.T) {
	emptyPATH(t)
	manifestPath := doctorManifestFixture(t)

	t.Run("unset capacity resolves to the daemon's concurrency default", func(t *testing.T) {
		t.Setenv("BARISTA_CONCURRENCY", "3")
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "")
		stdout, _, code := captureOutput(t, func() int {
			return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1"})
		})
		require.Equal(t, 0, code)
		require.Contains(t, stdout, "resident instance capacity: 3\n")
	})

	t.Run("an explicit zero reports disabled hosting", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "0")
		stdout, _, code := captureOutput(t, func() int {
			return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1"})
		})
		require.Equal(t, 0, code)
		require.Contains(t, stdout, "resident instance hosting: disabled (instance capacity 0)\n")
	})

	t.Run("the flag overrides the environment", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "4")
		stdout, _, code := captureOutput(t, func() int {
			return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1", "--instance-capacity", "9"})
		})
		require.Equal(t, 0, code)
		require.Contains(t, stdout, "resident instance capacity: 9\n")
	})

	t.Run("a malformed environment value is rejected", func(t *testing.T) {
		t.Setenv("BARISTA_INSTANCE_CAPACITY", "many")
		_, stderr, code := captureOutput(t, func() int {
			return runDoctor([]string{"--manifest", manifestPath, "--data-root", t.TempDir(), "--control-endpoint", "http://127.0.0.1:1"})
		})
		require.Equal(t, 2, code)
		require.Contains(t, stderr, "BARISTA_INSTANCE_CAPACITY must be a non-negative integer")
	})
}
