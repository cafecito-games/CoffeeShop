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
)

// BuildCapabilityReport assembles one full node capability report: runtime observations,
// operator-configured declarations, and one probe result per entry in AllowlistedProbes. The
// harnesses parameter is accepted for forward compatibility — a later pass may attach
// per-harness evidence — but is intentionally unused here so the call site does not need to
// change again.
func BuildCapabilityReport(ctx context.Context, cfg config.Config, harnesses []protocol.HarnessProfile) protocol.NodeCapabilityReport {
	_ = harnesses
	observedAt := time.Now().UTC().Format(time.RFC3339Nano)
	evidence := make([]protocol.NodeCapabilityEvidence, 0, 4+len(cfg.Labels)+len(cfg.Accelerators)+len(AllowlistedProbes))
	evidence = append(evidence,
		runtimeEvidence("os", runtime.GOOS, observedAt),
		runtimeEvidence("architecture", runtime.GOARCH, observedAt),
		runtimeEvidence("logical-cpu-count", strconv.Itoa(runtime.NumCPU()), observedAt),
		workspaceWritableEvidence(cfg.WorkspaceRoots, observedAt),
	)
	for _, label := range cfg.Labels {
		evidence = append(evidence, protocol.NodeCapabilityEvidence{
			CapabilityID:    "label:" + label,
			Source:          protocol.CapabilityEvidenceSourceConfigured,
			Success:         true,
			NormalizedValue: label,
			ObservedAt:      observedAt,
		})
	}
	for _, accelerator := range cfg.Accelerators {
		evidence = append(evidence, protocol.NodeCapabilityEvidence{
			CapabilityID:    "accelerator:" + accelerator,
			Source:          protocol.CapabilityEvidenceSourceConfigured,
			Success:         true,
			NormalizedValue: accelerator,
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
