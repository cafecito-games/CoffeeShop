package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func planManifestFixture() Manifest {
	return Manifest{
		ManifestVersion: ManifestVersion,
		Adapters: []AdapterManifestEntry{
			{
				ID:        "alpha-acp",
				HarnessID: "alpha-cli",
				Provider:  "alpha-vendor",
				Label:     "Alpha ACP adapter",
				Version:   "1.0.0",
				Platforms: map[string]PlatformDistribution{
					"darwin-arm64": {
						Kind:           DistributionKindArchive,
						URL:            "https://downloads.example.com/alpha.tar.gz",
						SHA256:         strings.Repeat("a", 64),
						SizeBytes:      2048,
						ExecutablePath: "bin/adapter",
					},
				},
			},
			{
				ID:        "beta-acp",
				HarnessID: "beta-cli",
				Provider:  "beta-vendor",
				Label:     "Beta ACP adapter",
				Version:   "0.2.0",
				Platforms: map[string]PlatformDistribution{
					"darwin-arm64": {
						Kind:           DistributionKindManual,
						ExecutablePath: "bin/adapter",
					},
				},
			},
			{
				ID:        "gamma-acp",
				HarnessID: "gamma-cli",
				Provider:  "gamma-vendor",
				Label:     "Gamma ACP adapter",
				Version:   "0.3.0",
				Platforms: map[string]PlatformDistribution{
					"linux-amd64": {
						Kind:           DistributionKindArchive,
						URL:            "https://downloads.example.com/gamma.tar.gz",
						SHA256:         strings.Repeat("c", 64),
						SizeBytes:      4096,
						ExecutablePath: "bin/adapter",
					},
				},
			},
		},
	}
}

func marshalPlanFixture(t *testing.T) []byte {
	t.Helper()
	data, err := json.Marshal(planManifestFixture())
	if err != nil {
		t.Fatalf("marshal plan fixture: %v", err)
	}
	return data
}

func TestBuildPlanDeterministic(t *testing.T) {
	manifestBytes := marshalPlanFixture(t)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	dataRoot := t.TempDir()
	first, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	second, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if first.Digest != second.Digest {
		t.Fatalf("BuildPlan() digests differ across identical inputs: %s vs %s", first.Digest, second.Digest)
	}
	firstEncoded, _ := json.Marshal(first)
	secondEncoded, _ := json.Marshal(second)
	if string(firstEncoded) != string(secondEncoded) {
		t.Fatal("BuildPlan() produced non-identical serialized plans across identical inputs")
	}
	if ComputePlanDigest(first) != first.Digest {
		t.Fatal("ComputePlanDigest() disagrees with the digest BuildPlan recorded")
	}
}

func TestBuildPlanSkipsUnsupportedPlatform(t *testing.T) {
	manifestBytes := marshalPlanFixture(t)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	plan, skipped, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", t.TempDir(), OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(plan.Operations) != 2 {
		t.Fatalf("BuildPlan() produced %d operations, want 2", len(plan.Operations))
	}
	if len(skipped) != 1 || skipped[0] != "gamma-cli" {
		t.Fatalf("BuildPlan() skipped = %v, want [gamma-cli]", skipped)
	}
}

func TestBuildPlanDigestCoversDataRootAndManifestBytes(t *testing.T) {
	manifestBytes := marshalPlanFixture(t)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	baseline, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", filepath.Join(t.TempDir(), "one"), OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}

	t.Run("changing the data root changes the digest", func(t *testing.T) {
		other, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", filepath.Join(t.TempDir(), "two"), OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if other.Digest == baseline.Digest {
			t.Fatal("BuildPlan() digest is unchanged after moving the data root")
		}
	})

	t.Run("changing the manifest bytes changes both digests", func(t *testing.T) {
		// A formatting-only change reparses to the identical manifest, but the plan digest is over
		// the exact manifest bytes: any source change, semantic or not, invalidates prior plans.
		reformatted := append(append([]byte{}, manifestBytes...), '\n')
		reparsed, err := ParseManifest(reformatted)
		if err != nil {
			t.Fatalf("ParseManifest() error = %v", err)
		}
		other, _, err := BuildPlan(reformatted, reparsed, "darwin-arm64", filepath.Join(t.TempDir(), "three"), OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if other.ManifestDigest == baseline.ManifestDigest {
			t.Fatal("BuildPlan() manifest digest is unchanged after the manifest bytes changed")
		}
		if other.Digest == baseline.Digest {
			t.Fatal("BuildPlan() digest is unchanged after the manifest bytes changed")
		}
	})
}

func TestBuildPlanExpectedCurrentState(t *testing.T) {
	manifestBytes := marshalPlanFixture(t)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}

	t.Run("empty data root yields absent", func(t *testing.T) {
		plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", t.TempDir(), OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		for _, operation := range plan.Operations {
			if operation.ExpectedCurrentState != ExpectedAbsent {
				t.Fatalf("operation for %s expected %s, want absent", operation.AdapterID, operation.ExpectedCurrentState)
			}
		}
	})

	t.Run("ledger record plus matching file yields owned-match", func(t *testing.T) {
		dataRoot := t.TempDir()
		content := []byte("owned alpha bytes")
		summed := sha256.Sum256(content)
		target := filepath.Join(dataRoot, "adapters", "alpha-cli", "alpha-acp", "1.0.0", "bin", "adapter")
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("create target directory: %v", err)
		}
		if err := os.WriteFile(target, content, 0o755); err != nil {
			t.Fatalf("write target file: %v", err)
		}
		ledger := OwnershipLedger{}.WithRecord(OwnershipRecord{
			Path:          target,
			AdapterID:     "alpha-acp",
			ContentSHA256: hex.EncodeToString(summed[:]),
			SizeBytes:     int64(len(content)),
		})
		plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, ledger)
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if plan.Operations[0].ExpectedCurrentState != ExpectedOwnedMatch {
			t.Fatalf("operation for alpha-acp expected %s, want owned-match", plan.Operations[0].ExpectedCurrentState)
		}
		if plan.Operations[1].ExpectedCurrentState != ExpectedAbsent {
			t.Fatalf("operation for beta-acp expected %s, want absent", plan.Operations[1].ExpectedCurrentState)
		}
	})

	t.Run("unowned file at the target yields unowned-exists", func(t *testing.T) {
		dataRoot := t.TempDir()
		target := filepath.Join(dataRoot, "adapters", "alpha-cli", "alpha-acp", "1.0.0", "bin", "adapter")
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("create target directory: %v", err)
		}
		if err := os.WriteFile(target, []byte("someone else's file"), 0o644); err != nil {
			t.Fatalf("write target file: %v", err)
		}
		plan, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", dataRoot, OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		if plan.Operations[0].ExpectedCurrentState != ExpectedUnownedExists {
			t.Fatalf("operation for alpha-acp expected %s, want unowned-exists", plan.Operations[0].ExpectedCurrentState)
		}
	})
}

func TestBuildPlanRejectsBadInputs(t *testing.T) {
	manifestBytes := marshalPlanFixture(t)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	if _, _, err := BuildPlan(manifestBytes, manifest, "darwin-arm64", "relative/path", OwnershipLedger{}); err == nil {
		t.Fatal("BuildPlan() accepted a relative data root, want rejection")
	}
	if _, _, err := BuildPlan(manifestBytes, manifest, "darwin_arm64", t.TempDir(), OwnershipLedger{}); err == nil {
		t.Fatal("BuildPlan() accepted a malformed platform key, want rejection")
	}
	if _, _, err := BuildPlan(manifestBytes, Manifest{ManifestVersion: ManifestVersion}, "darwin-arm64", t.TempDir(), OwnershipLedger{}); err == nil {
		t.Fatal("BuildPlan() accepted an unvalidated manifest, want rejection")
	}
}
