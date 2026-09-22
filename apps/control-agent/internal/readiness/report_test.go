package readiness

import (
	"context"
	"os"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

func evidenceByCapabilityID(report protocol.NodeCapabilityReport, capabilityID string) protocol.NodeCapabilityEvidence {
	for _, entry := range report.Evidence {
		if entry.CapabilityID == capabilityID {
			return entry
		}
	}
	return protocol.NodeCapabilityEvidence{}
}

func TestBuildCapabilityReportProducesConfiguredEvidence(t *testing.T) {
	cfg := config.Config{
		NodeID:          "worker-1",
		WorkspaceRoots:  []string{t.TempDir()},
		Labels:          []string{"gpu"},
		Accelerators:    []string{"cuda"},
		MemoryMegabytes: 32768,
	}
	report := BuildCapabilityReport(context.Background(), cfg, nil)

	label := evidenceByCapabilityID(report, "label:gpu")
	require.True(t, label.Success)
	require.Equal(t, protocol.CapabilityEvidenceSourceConfigured, label.Source)
	require.Equal(t, "gpu", label.NormalizedValue)

	accelerator := evidenceByCapabilityID(report, "accelerator:cuda")
	require.True(t, accelerator.Success)
	require.Equal(t, "cuda", accelerator.NormalizedValue)

	memory := evidenceByCapabilityID(report, "configured-memory-megabytes")
	require.True(t, memory.Success)
	require.Equal(t, "32768", memory.NormalizedValue)
}

func TestBuildCapabilityReportOmitsSecretLikeLabelsAndAccelerators(t *testing.T) {
	// config.Parse already rejects a secret-like label/accelerator at startup; this constructs
	// config.Config directly to exercise BuildCapabilityReport's own defense-in-depth screening
	// as if that earlier gate were somehow bypassed.
	cfg := config.Config{
		NodeID:         "worker-1",
		WorkspaceRoots: []string{t.TempDir()},
		Labels:         []string{"gpu", "sk-abcdefghij1234567890"},
		Accelerators:   []string{"cuda", "sk-abcdefghij1234567890"},
	}
	report := BuildCapabilityReport(context.Background(), cfg, nil)

	require.True(t, evidenceByCapabilityID(report, "label:gpu").Success, "a clean label must still be reported")
	require.True(t, evidenceByCapabilityID(report, "accelerator:cuda").Success)
	require.Equal(t, protocol.NodeCapabilityEvidence{}, evidenceByCapabilityID(report, "label:sk-abcdefghij1234567890"),
		"a secret-like label must never be forwarded, not even as a failed entry that echoes it")
	require.Equal(t, protocol.NodeCapabilityEvidence{}, evidenceByCapabilityID(report, "accelerator:sk-abcdefghij1234567890"))
	require.NoError(t, report.Validate())
}

func TestBuildCapabilityReportOmitsUnsetConfiguredEvidence(t *testing.T) {
	cfg := config.Config{NodeID: "worker-1", WorkspaceRoots: []string{t.TempDir()}}
	report := BuildCapabilityReport(context.Background(), cfg, nil)

	for _, entry := range report.Evidence {
		require.NotContains(t, entry.CapabilityID, "label:")
		require.NotContains(t, entry.CapabilityID, "accelerator:")
	}
	require.Equal(t, protocol.NodeCapabilityEvidence{}, evidenceByCapabilityID(report, "configured-memory-megabytes"))
}

func TestWorkspaceWritableSucceedsWhenAnyRootIsWritable(t *testing.T) {
	writable := t.TempDir()
	readonly := t.TempDir()
	require.NoError(t, os.Chmod(readonly, 0o500))
	t.Cleanup(func() { os.Chmod(readonly, 0o755) })

	evidence := workspaceWritableEvidence([]string{readonly, writable}, "2026-01-02T03:04:05Z")
	require.True(t, evidence.Success)
	require.Equal(t, "true", evidence.NormalizedValue)
	require.Empty(t, evidence.Diagnostic)
}

func TestWorkspaceWritableFailsWhenNoRootIsWritable(t *testing.T) {
	readonly := t.TempDir()
	require.NoError(t, os.Chmod(readonly, 0o500))
	t.Cleanup(func() { os.Chmod(readonly, 0o755) })

	evidence := workspaceWritableEvidence([]string{readonly}, "2026-01-02T03:04:05Z")
	if evidence.Success {
		// macOS and some CI accounts can still write to a 0o500 directory they own, in which
		// case this environment cannot produce a truly non-writable root; the writable-roots
		// count semantics are still covered by the any-root-succeeds test above.
		t.Skip("environment permits writing to a 0o500 directory owned by the test user")
	}
	require.False(t, evidence.Success)
	require.Contains(t, evidence.Diagnostic, "0 of 1 workspace roots are writable")
}

func TestBuildCapabilityReportPopulatesIdentityAndValidates(t *testing.T) {
	cfg := config.Config{
		NodeID:           "worker-1",
		WorkspaceRoots:   []string{t.TempDir()},
		ProjectAllowlist: []string{"coffee-shop"},
	}
	report := BuildCapabilityReport(context.Background(), cfg, nil)

	require.Equal(t, "worker-1", report.NodeID)
	require.Equal(t, []string{"coffee-shop"}, report.ProjectAllowlist)
	require.NotEmpty(t, report.At)
	for _, entry := range report.Evidence {
		require.NoError(t, entry.Validate())
		require.Equal(t, report.At, entry.ObservedAt)
	}
	require.NoError(t, report.Validate())
}

func TestBuildCapabilityReportLeavesProjectAllowlistNilWhenUnrestricted(t *testing.T) {
	cfg := config.Config{NodeID: "worker-1", WorkspaceRoots: []string{t.TempDir()}}
	report := BuildCapabilityReport(context.Background(), cfg, nil)

	require.Nil(t, report.ProjectAllowlist)
	require.NoError(t, report.Validate())
}
