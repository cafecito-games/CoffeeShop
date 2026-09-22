package readiness

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/config"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/workspace"
)

// BuildCapabilityReport assembles one full node capability report: runtime observations,
// operator-configured declarations, and one probe result per entry in AllowlistedProbes. The
// harnesses parameter is accepted for forward compatibility — a later pass may attach
// per-harness evidence — but is intentionally unused here so the call site does not need to
// change again.
func BuildCapabilityReport(ctx context.Context, cfg config.Config, harnesses []protocol.HarnessProfile) protocol.NodeCapabilityReport {
	_ = harnesses
	observedAt := time.Now().UTC().Format(time.RFC3339Nano)
	evidence := make([]protocol.NodeCapabilityEvidence, 0, 5+len(cfg.Labels)+len(cfg.Accelerators)+len(cfg.Toolchains)+len(AllowlistedProbes))
	evidence = append(evidence,
		runtimeEvidence("os", runtime.GOOS, observedAt),
		runtimeEvidence("architecture", runtime.GOARCH, observedAt),
		runtimeEvidence("logical-cpu-count", strconv.Itoa(runtime.NumCPU()), observedAt),
		workspaceWritableEvidence(cfg.WorkspaceRoots, observedAt),
	)
	evidence = append(evidence, workspaceLeaseEvidence(len(cfg.WorkspaceRoots) > 0, observedAt)...)
	// Barista config validation already rejects a secret-like label or accelerator at startup
	// (see config.Parse), so this should never trigger in practice. It is kept as defense in
	// depth, using the same detector probe output is screened with, so a value that somehow
	// bypassed config validation is still never forwarded to the hub.
	for _, label := range cfg.Labels {
		if looksSecretLike(label) {
			continue
		}
		evidence = append(evidence, protocol.NodeCapabilityEvidence{
			CapabilityID:    "label:" + label,
			Source:          protocol.CapabilityEvidenceSourceConfigured,
			Success:         true,
			NormalizedValue: label,
			ObservedAt:      observedAt,
		})
	}
	for _, accelerator := range cfg.Accelerators {
		if looksSecretLike(accelerator) {
			continue
		}
		evidence = append(evidence, protocol.NodeCapabilityEvidence{
			CapabilityID:    "accelerator:" + accelerator,
			Source:          protocol.CapabilityEvidenceSourceConfigured,
			Success:         true,
			NormalizedValue: accelerator,
			ObservedAt:      observedAt,
		})
	}
	// A toolchain without a version is still worth reporting: the version is omitted rather than
	// sent as an empty NormalizedValue, so a project profile can require the toolchain's presence
	// without pinning it.
	for _, toolchain := range cfg.Toolchains {
		if looksSecretLike(toolchain.ID) || looksSecretLike(toolchain.Version) {
			continue
		}
		evidence = append(evidence, protocol.NodeCapabilityEvidence{
			CapabilityID:    "toolchain:" + toolchain.ID,
			Source:          protocol.CapabilityEvidenceSourceConfigured,
			Success:         true,
			NormalizedValue: toolchain.Version,
			ObservedAt:      observedAt,
		})
	}
	// An unset memory value is omitted entirely rather than reported as failed evidence.
	if cfg.MemoryMegabytes > 0 {
		evidence = append(evidence, protocol.NodeCapabilityEvidence{
			CapabilityID:    "configured-memory-megabytes",
			Source:          protocol.CapabilityEvidenceSourceConfigured,
			Success:         true,
			NormalizedValue: strconv.Itoa(cfg.MemoryMegabytes),
			ObservedAt:      observedAt,
		})
	}

	// Each goroutine writes to its own slice index, so the slice itself needs no lock; the
	// WaitGroup still ensures every probe settles before the report is assembled. One slow or
	// missing toolchain delays the report only by its own timeout.
	probeEvidence := make([]protocol.NodeCapabilityEvidence, len(AllowlistedProbes))
	var waitGroup sync.WaitGroup
	for index, probe := range AllowlistedProbes {
		waitGroup.Go(func() {
			entry := RunProbe(ctx, probe)
			entry.ObservedAt = observedAt
			probeEvidence[index] = entry
		})
	}
	waitGroup.Wait()
	evidence = append(evidence, probeEvidence...)

	var projectAllowlist []string
	if len(cfg.ProjectAllowlist) > 0 {
		projectAllowlist = cfg.ProjectAllowlist
	}
	return protocol.NodeCapabilityReport{
		NodeID:           cfg.NodeID,
		ProjectAllowlist: projectAllowlist,
		Evidence:         evidence,
		At:               observedAt,
	}
}

func runtimeEvidence(capabilityID, normalizedValue, observedAt string) protocol.NodeCapabilityEvidence {
	return protocol.NodeCapabilityEvidence{
		CapabilityID:    capabilityID,
		Source:          protocol.CapabilityEvidenceSourceRuntime,
		Success:         true,
		NormalizedValue: normalizedValue,
		ObservedAt:      observedAt,
	}
}

// workspaceWritableEvidence probes each configured root by creating and immediately removing a
// temporary file. Any writable root satisfies the capability; the failure diagnostic reports a
// count rather than echoing paths.
func workspaceWritableEvidence(roots []string, observedAt string) protocol.NodeCapabilityEvidence {
	writable := 0
	for _, root := range roots {
		file, err := os.CreateTemp(root, ".barista-writable-*")
		if err != nil {
			continue
		}
		path := file.Name()
		file.Close()
		os.Remove(path)
		writable++
	}
	evidence := protocol.NodeCapabilityEvidence{
		CapabilityID: "workspace-writable",
		Source:       protocol.CapabilityEvidenceSourceRuntime,
		ObservedAt:   observedAt,
	}
	if writable > 0 {
		evidence.Success = true
		evidence.NormalizedValue = "true"
		return evidence
	}
	evidence.Diagnostic = fmt.Sprintf("%d of %d workspace roots are writable", writable, len(roots))
	return evidence
}

// workspaceLeaseEvidence advertises which workspace lease policies this Barista can provision, so
// the hub never places a leased task on a Barista that would have to reject it. Lease paths are
// POSIX paths, and the git-worktree policy also needs a resolvable git executable.
func workspaceLeaseEvidence(hasRoots bool, observedAt string) []protocol.NodeCapabilityEvidence {
	_, gitErr := workspace.FindGit()
	posixPaths := runtime.GOOS != "windows"
	supported := map[string]bool{
		protocol.WorkspaceIsolationGitWorktree:       posixPaths && hasRoots && gitErr == nil,
		protocol.WorkspaceIsolationExclusiveExisting: posixPaths && hasRoots,
	}
	evidence := make([]protocol.NodeCapabilityEvidence, 0, len(protocol.WorkspaceIsolationPolicies))
	for _, policy := range protocol.WorkspaceIsolationPolicies {
		entry := protocol.NodeCapabilityEvidence{
			CapabilityID: "workspace-lease:" + policy,
			Source:       protocol.CapabilityEvidenceSourceRuntime,
			ObservedAt:   observedAt,
		}
		if supported[policy] {
			entry.Success = true
			entry.NormalizedValue = "true"
		} else {
			entry.Diagnostic = "this workspace lease policy is not available on this Barista"
		}
		evidence = append(evidence, entry)
	}
	return evidence
}
