package setup

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// testPlatform is this test binary's own runtime platform key. Apply now independently derives
// and enforces CurrentPlatform() against a supplied plan (fix for trusting plan.Platform), so
// every fixture manifest below declares its platform distribution under this exact key, and every
// BuildPlan call that feeds into an Apply call in this file uses it too — a plan built for a
// hardcoded, possibly different platform would otherwise be rejected regardless of what else the
// test is trying to exercise.
var testPlatform = CurrentPlatform()

func sha256Hex(data []byte) string {
	summed := sha256.Sum256(data)
	return hex.EncodeToString(summed[:])
}

func buildTarGzipArchive(t *testing.T, executablePath string, content []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	header := &tar.Header{Typeflag: tar.TypeReg, Name: executablePath, Mode: 0o755, Size: int64(len(content))}
	if err := tarWriter.WriteHeader(header); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tarWriter.Write(content); err != nil {
		t.Fatalf("write tar content: %v", err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	return buffer.Bytes()
}

func buildZipArchive(t *testing.T, executablePath string, content []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	zipWriter := zip.NewWriter(&buffer)
	entry, err := zipWriter.Create(executablePath)
	if err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if _, err := entry.Write(content); err != nil {
		t.Fatalf("write zip content: %v", err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatalf("close zip writer: %v", err)
	}
	return buffer.Bytes()
}

func archiveServerFixture(t *testing.T, alphaArchive []byte, betaArchive []byte) *httptest.Server {
	t.Helper()
	multiplexer := http.NewServeMux()
	multiplexer.HandleFunc("/alpha/adapter.tar.gz", func(writer http.ResponseWriter, request *http.Request) {
		writer.Write(alphaArchive)
	})
	multiplexer.HandleFunc("/beta/adapter.zip", func(writer http.ResponseWriter, request *http.Request) {
		writer.Write(betaArchive)
	})
	server := httptest.NewTLSServer(multiplexer)
	t.Cleanup(server.Close)
	return server
}

func archiveManifestFixture(t *testing.T, serverURL string, alphaChecksum string, betaChecksum string, alphaSize int, betaSize int) ([]byte, Manifest) {
	t.Helper()
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "alpha-acp", "harnessId": "alpha-cli", "provider": "alpha-vendor",
				"label": "Alpha ACP adapter", "version": "1.0.0",
				"platforms": {"%s": {"kind": "archive", "url": "%s/alpha/adapter.tar.gz", "sha256": "%s", "sizeBytes": %d, "executablePath": "bin/adapter"}}
			},
			{
				"id": "beta-acp", "harnessId": "beta-cli", "provider": "beta-vendor",
				"label": "Beta ACP adapter", "version": "2.0.0",
				"platforms": {"%s": {"kind": "archive", "url": "%s/beta/adapter.zip", "sha256": "%s", "sizeBytes": %d, "executablePath": "bin/adapter"}}
			}
		]
	}`, testPlatform, serverURL, alphaChecksum, alphaSize, testPlatform, serverURL, betaChecksum, betaSize)
	manifestBytes := []byte(manifestJSON)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	return manifestBytes, manifest
}

func manualManifestFixture(t *testing.T) ([]byte, Manifest) {
	t.Helper()
	manifestJSON := []byte(fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "manual-acp", "harnessId": "manual-cli", "provider": "manual-vendor",
				"label": "Manual ACP adapter", "version": "0.4.0",
				"platforms": {"%s": {"kind": "manual", "executablePath": "bin/adapter"}}
			}
		]
	}`, testPlatform))
	manifest, err := ParseManifest(manifestJSON)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	return manifestJSON, manifest
}

func applyOptions(server *httptest.Server) ApplyOptions {
	return ApplyOptions{HTTPClient: server.Client(), AllowedHosts: []string{"127.0.0.1"}}
}

func assertInstalledExecutable(t *testing.T, path string, content []byte) {
	t.Helper()
	information, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("stat installed adapter %s: %v", path, err)
	}
	if !information.Mode().IsRegular() {
		t.Fatalf("installed adapter %s is not a regular file: %s", path, information.Mode())
	}
	if information.Mode().Perm()&0o111 == 0 {
		t.Fatalf("installed adapter %s is not executable: %s", path, information.Mode().Perm())
	}
	installed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read installed adapter %s: %v", path, err)
	}
	if !bytes.Equal(installed, content) {
		t.Fatalf("installed adapter %s content mismatch", path)
	}
}

// strayTemporaryArtifacts walks dataRoot for anything a failed apply should have cleaned up.
func strayTemporaryArtifacts(t *testing.T, dataRoot string) []string {
	t.Helper()
	var strays []string
	err := filepath.WalkDir(dataRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if strings.HasPrefix(entry.Name(), "setup-staging-") || strings.HasPrefix(entry.Name(), "setup-download-") {
			strays = append(strays, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk data root: %v", err)
	}
	return strays
}

func TestApplyInstallsTarGzipAndZipArchives(t *testing.T) {
	alphaContent := []byte("#!/bin/sh\necho alpha\n")
	betaContent := []byte("#!/bin/sh\necho beta\n")
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", alphaContent)
	betaArchive := buildZipArchive(t, "bin/adapter", betaContent)
	server := archiveServerFixture(t, alphaArchive, betaArchive)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), sha256Hex(betaArchive), len(alphaArchive), len(betaArchive))
	dataRoot := t.TempDir()
	plan, skipped, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(skipped) != 0 {
		t.Fatalf("BuildPlan() skipped = %v, want none", skipped)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(result.Applied) != 2 || len(result.Skipped) != 0 {
		t.Fatalf("Apply() applied %d, skipped %d, want 2 applied", len(result.Applied), len(result.Skipped))
	}
	assertInstalledExecutable(t, plan.Operations[0].TargetPath, alphaContent)
	assertInstalledExecutable(t, plan.Operations[1].TargetPath, betaContent)
	ledger, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	if len(ledger.Records) != 2 {
		t.Fatalf("ledger holds %d records after apply, want 2", len(ledger.Records))
	}
	for index, operation := range plan.Operations {
		record, ok := ledger.RecordFor(operation.TargetPath)
		if !ok {
			t.Fatalf("ledger has no record for %s", operation.TargetPath)
		}
		wantDigest := sha256Hex([][]byte{alphaContent, betaContent}[index])
		if record.ContentSHA256 != wantDigest {
			t.Fatalf("ledger digest for %s = %s, want %s", operation.TargetPath, record.ContentSHA256, wantDigest)
		}
	}

	// Re-planning against the installed state and re-applying must be a pure no-op.
	replanned, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, ledger)
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	second, err := Apply(context.Background(), replanned, manifestBytes, ledger, dataRoot, applyOptions(server))
	if err != nil {
		t.Fatalf("Apply() re-run error = %v", err)
	}
	if len(second.Applied) != 0 || len(second.Skipped) != 2 {
		t.Fatalf("Apply() re-run applied %d, skipped %d, want 0 applied and 2 skipped", len(second.Applied), len(second.Skipped))
	}
}

// TestApplyRejectsHandEditedPlanWithStaleDigest proves the first half of the fix-1 property: a
// plan hand-edited without recomputing its Digest for the new content is not self-consistent, and
// Apply catches that before it ever compares the plan to derived state at all.
func TestApplyRejectsHandEditedPlanWithStaleDigest(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	server := archiveServerFixture(t, alphaArchive, nil)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), strings.Repeat("0", 64), len(alphaArchive), 1)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	plan.Platform = "some-other-platform" // edited without recomputing Digest
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted a hand-edited plan with a stale digest, want rejection")
	}
	if !strings.Contains(err.Error(), "digest does not match its own contents") {
		t.Fatalf("Apply() error = %v, want it to name the self-consistency failure", err)
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a stale plan", len(result.Applied))
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("stale apply mutated the data root: %v", err)
	}
}

// TestApplyRejectsPlanWithNoOperationsButCopiedDigest is the fix-1 regression the review asked for
// directly: a plan whose Digest was copied verbatim from a different, legitimately-generated plan
// (rather than recomputed for this plan's own, tampered content) must be rejected by the
// self-consistency check alone, before Apply ever gets to comparing it against derived state.
func TestApplyRejectsPlanWithNoOperationsButCopiedDigest(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	legitimate, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if len(legitimate.Operations) == 0 {
		t.Fatal("test fixture error: legitimate plan has no operations to strip")
	}

	forged := legitimate
	forged.Operations = nil
	forged.Postconditions = nil
	// The forged plan's Digest is the legitimate plan's own digest, copied verbatim rather than
	// recomputed for the now-empty Operations.
	forged.Digest = legitimate.Digest

	result, err := Apply(context.Background(), forged, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": "/nonexistent/source"},
		ManualChecksums:       map[string]string{"manual-acp": strings.Repeat("0", 64)},
	})
	if err == nil {
		t.Fatal("Apply() accepted a plan with no operations but a copied valid digest, want rejection")
	}
	if !strings.Contains(err.Error(), "digest does not match its own contents") {
		t.Fatalf("Apply() error = %v, want it to name the self-consistency failure", err)
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a forged plan", len(result.Applied))
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("forged apply mutated the data root: %v", err)
	}
}

// TestApplyRejectsPlanBuiltForAnotherPlatform proves the fix-2 property: even a fully
// self-consistent plan (its Digest genuinely matches its own content) is rejected when that
// content was built for a platform other than this node's own runtime.GOOS-runtime.GOARCH — Apply
// never trusts plan.Platform, it always derives operations for CurrentPlatform() and compares
// against that.
func TestApplyRejectsPlanBuiltForAnotherPlatform(t *testing.T) {
	otherPlatform := "some-other-platform"
	if otherPlatform == testPlatform {
		t.Fatal("test fixture error: otherPlatform collides with testPlatform")
	}
	manifestJSON := []byte(fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "manual-acp", "harnessId": "manual-cli", "provider": "manual-vendor",
				"label": "Manual ACP adapter", "version": "0.4.0",
				"platforms": {
					"%s": {"kind": "manual", "executablePath": "bin/adapter"},
					"%s": {"kind": "manual", "executablePath": "bin/adapter"}
				}
			}
		]
	}`, testPlatform, otherPlatform))
	manifest, err := ParseManifest(manifestJSON)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	dataRoot := t.TempDir()
	// Built honestly, for otherPlatform, with a correctly self-consistent digest — nothing about
	// this plan is tampered except that it targets a platform other than this test binary's own.
	planForOtherPlatform, _, err := BuildPlan(manifestJSON, manifest, otherPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if ComputePlanDigest(planForOtherPlatform) != planForOtherPlatform.Digest {
		t.Fatal("test fixture error: plan built for another platform is not self-consistent")
	}

	result, err := Apply(context.Background(), planForOtherPlatform, manifestJSON, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": "/nonexistent/source"},
		ManualChecksums:       map[string]string{"manual-acp": strings.Repeat("0", 64)},
	})
	if err == nil {
		t.Fatal("Apply() accepted a plan built for a different platform, want rejection")
	}
	if !strings.Contains(err.Error(), "this node is "+testPlatform) {
		t.Fatalf("Apply() error = %v, want it to name this node's platform", err)
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a cross-platform plan", len(result.Applied))
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("cross-platform apply mutated the data root: %v", err)
	}
}

func TestApplyRejectsChangedManifestBytes(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	server := archiveServerFixture(t, alphaArchive, nil)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), strings.Repeat("0", 64), len(alphaArchive), 1)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	changedManifestBytes := append(append([]byte{}, manifestBytes...), ' ')
	result, err := Apply(context.Background(), plan, changedManifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted different manifest bytes than the plan was built from, want rejection")
	}
	if !strings.Contains(err.Error(), "does not match the manifest and current node state") {
		t.Fatalf("Apply() error = %v, want it to name the plan/state mismatch", err)
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a stale manifest", len(result.Applied))
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("stale apply mutated the data root: %v", err)
	}
}

func TestApplyRejectsConflictingState(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	betaArchive := buildZipArchive(t, "bin/adapter", []byte("beta"))
	server := archiveServerFixture(t, alphaArchive, betaArchive)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), sha256Hex(betaArchive), len(alphaArchive), len(betaArchive))
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	// A foreign file lands at the first target between planning and apply.
	if err := os.MkdirAll(filepath.Dir(plan.Operations[0].TargetPath), 0o755); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	if err := os.WriteFile(plan.Operations[0].TargetPath, []byte("not ours"), 0o644); err != nil {
		t.Fatalf("write conflicting file: %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() proceeded over a conflicting target, want rejection")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations despite the conflict", len(result.Applied))
	}
	// The conflict stops the whole apply: the second operation never ran either.
	if _, err := os.Stat(plan.Operations[1].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("Apply() proceeded past a conflict to a later operation: %v", err)
	}
	conflicting, err := os.ReadFile(plan.Operations[0].TargetPath)
	if err != nil || string(conflicting) != "not ours" {
		t.Fatalf("conflicting file was mutated: %q, %v", conflicting, err)
	}
}

func TestApplyRejectsArchiveChecksumMismatch(t *testing.T) {
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", []byte("alpha"))
	server := archiveServerFixture(t, alphaArchive, nil)
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, strings.Repeat("0", 64), strings.Repeat("0", 64), len(alphaArchive), 1)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted an archive with the wrong checksum, want rejection")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations despite the checksum mismatch", len(result.Applied))
	}
	if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("target exists after a failed install: %v", err)
	}
	if strays := strayTemporaryArtifacts(t, dataRoot); len(strays) != 0 {
		t.Fatalf("failed install left temporary artifacts behind: %v", strays)
	}
}

func TestApplyRejectsUnsupportedArchiveExtension(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte("raw binary"))
	}))
	defer server.Close()
	manifestJSON := fmt.Sprintf(`{
		"manifestVersion": "1",
		"adapters": [
			{
				"id": "alpha-acp", "harnessId": "alpha-cli", "provider": "alpha-vendor",
				"label": "Alpha ACP adapter", "version": "1.0.0",
				"platforms": {"%s": {"kind": "archive", "url": "%s/alpha/adapter.bin", "sha256": "%s", "sizeBytes": 10, "executablePath": "bin/adapter"}}
			}
		]
	}`, testPlatform, server.URL, sha256Hex([]byte("raw binary")))
	manifestBytes := []byte(manifestJSON)
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() accepted an unsupported archive extension, want rejection")
	}
	if !strings.Contains(err.Error(), ".tar.gz or .zip") {
		t.Fatalf("Apply() error = %v, want it to name the supported extensions", err)
	}
}

func TestApplyManualPlacementCheck(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	sourceDirectory := t.TempDir()
	artifactContent := []byte("#!/bin/sh\necho manual\n")
	source := filepath.Join(sourceDirectory, "operator-placed-adapter")
	if err := os.WriteFile(source, artifactContent, 0o755); err != nil {
		t.Fatalf("write manual source: %v", err)
	}
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	if plan.Operations[0].Kind != OperationManualPlacementCheck {
		t.Fatalf("planned kind = %s, want %s", plan.Operations[0].Kind, OperationManualPlacementCheck)
	}
	if plan.Operations[0].ExpectedChecksum != "" {
		t.Fatalf("manual operation carries checksum %q in the plan, want empty", plan.Operations[0].ExpectedChecksum)
	}

	t.Run("matching checksum installs by copying", func(t *testing.T) {
		result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
			ManualChecksums:       map[string]string{"manual-acp": sha256Hex(artifactContent)},
		})
		if err != nil {
			t.Fatalf("Apply() error = %v", err)
		}
		if len(result.Applied) != 1 {
			t.Fatalf("Apply() applied %d operations, want 1", len(result.Applied))
		}
		assertInstalledExecutable(t, plan.Operations[0].TargetPath, artifactContent)
		ledger, err := LoadOwnershipLedger(dataRoot)
		if err != nil {
			t.Fatalf("LoadOwnershipLedger() error = %v", err)
		}
		if record, ok := ledger.RecordFor(plan.Operations[0].TargetPath); !ok || record.ContentSHA256 != sha256Hex(artifactContent) {
			t.Fatalf("ledger record after manual install = %+v, %v", record, ok)
		}
	})

	t.Run("missing checksum fails naming only the adapter", func(t *testing.T) {
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
		})
		if err == nil {
			t.Fatal("Apply() accepted a manual install without an operator checksum, want rejection")
		}
		if !strings.Contains(err.Error(), "manual-acp") {
			t.Fatalf("Apply() error = %v, want it to name the adapter id", err)
		}
		if strings.Contains(err.Error(), source) || strings.Contains(err.Error(), sourceDirectory) {
			t.Fatalf("Apply() error leaked the operator source path: %v", err)
		}
		if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
			t.Fatalf("manual install mutated the target despite refusing: %v", err)
		}
	})

	t.Run("checksum mismatch fails without copying", func(t *testing.T) {
		dataRoot := t.TempDir()
		plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
		if err != nil {
			t.Fatalf("BuildPlan() error = %v", err)
		}
		_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
			ManualChecksums:       map[string]string{"manual-acp": strings.Repeat("0", 64)},
		})
		if err == nil {
			t.Fatal("Apply() accepted a manual artifact with the wrong checksum, want rejection")
		}
		if strings.Contains(err.Error(), source) {
			t.Fatalf("Apply() error leaked the operator source path: %v", err)
		}
		if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
			t.Fatalf("mismatched manual install reached the target: %v", err)
		}
	})
}

// TestApplyRejectsTargetOutsideDataRoot proves the fix-1 property against a plan whose Operations
// were forged to escape the data root: hand-editing TargetPath and recomputing a self-consistent
// Digest for the tampered content is not enough, because Apply never trusts plan.Operations at
// all — it re-derives its own operations from the manifest and current state, and only checks the
// supplied plan's digest against that derived one. AdapterTargetPath can never itself produce an
// escaping path from a valid manifest, so the derived plan's digest will not match the forged
// plan's, and the escape attempt is rejected before anything resembling installation runs.
func TestApplyRejectsTargetOutsideDataRoot(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	plan.Operations[0].TargetPath = filepath.Join(dataRoot, "..", "escaped-adapter")
	plan.Digest = ComputePlanDigest(plan)
	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": "/nonexistent/source"},
		ManualChecksums:       map[string]string{"manual-acp": strings.Repeat("0", 64)},
	})
	if err == nil {
		t.Fatal("Apply() accepted a target outside the data root, want rejection")
	}
	if !strings.Contains(err.Error(), "does not match the manifest and current node state") {
		t.Fatalf("Apply() error = %v, want it to name the plan/state mismatch", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dataRoot), "escaped-adapter")); !os.IsNotExist(err) {
		t.Fatalf("escaping target was created: %v", err)
	}
}

// TestApplyRejectsForgedPlanWithRecomputedDigest is the fix-1 regression the review asked for
// directly: a plan whose Operations point at an attacker-controlled URL and checksum, with the
// forger having correctly recomputed Digest for that tampered content (so a naive
// ComputePlanDigest(plan) == plan.Digest self-check alone would have accepted it), must still be
// rejected — and the attacker's server must never even receive a request, because Apply only ever
// executes operations it derives itself from the real manifest.
func TestApplyRejectsForgedPlanWithRecomputedDigest(t *testing.T) {
	var attackerRequests int
	attacker := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attackerRequests++
		writer.Write([]byte("malicious payload"))
	}))
	defer attacker.Close()

	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}

	forged := plan
	forged.Operations = append([]Operation{}, plan.Operations...)
	forged.Operations[0].Kind = OperationInstallArchive
	forged.Operations[0].Source = PlatformDistribution{
		Kind:           DistributionKindArchive,
		URL:            attacker.URL + "/malicious.tar.gz",
		SHA256:         sha256Hex([]byte("malicious payload")),
		SizeBytes:      int64(len("malicious payload")),
		ExecutablePath: "bin/adapter",
	}
	forged.Operations[0].ExpectedChecksum = sha256Hex([]byte("malicious payload"))
	// The forger recomputes a self-consistent digest for the tampered plan — this alone must not
	// be enough to pass Apply's verification.
	forged.Digest = ComputePlanDigest(forged)
	if forged.Digest == plan.Digest {
		t.Fatal("test fixture error: forging the plan did not change its digest")
	}

	result, err := Apply(context.Background(), forged, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		HTTPClient:   attacker.Client(),
		AllowedHosts: []string{"127.0.0.1"},
	})
	if err == nil {
		t.Fatal("Apply() accepted a forged plan with a recomputed digest, want rejection")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations from a forged plan", len(result.Applied))
	}
	if attackerRequests != 0 {
		t.Fatalf("Apply() contacted the attacker-controlled source %d times, want zero", attackerRequests)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "adapters")); !os.IsNotExist(err) {
		t.Fatalf("forged apply mutated the data root: %v", err)
	}
}

func TestApplyRejectsSymlinkAtTarget(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	target := plan.Operations[0].TargetPath
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	outsider := filepath.Join(t.TempDir(), "symlink-target")
	sentinel := []byte("sentinel content")
	if err := os.WriteFile(outsider, sentinel, 0o644); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink(outsider, target); err != nil {
		t.Fatalf("create symlink at install target: %v", err)
	}
	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": outsider},
		ManualChecksums:       map[string]string{"manual-acp": sha256Hex(sentinel)},
	})
	if err == nil {
		t.Fatal("Apply() accepted a symlink at the install target, want rejection")
	}
	throughLink, err := os.ReadFile(outsider)
	if err != nil || !bytes.Equal(throughLink, sentinel) {
		t.Fatalf("install wrote through the symlink: %q, %v", throughLink, err)
	}
}

func TestApplyPartialFailurePersistsCompletedOperations(t *testing.T) {
	alphaContent := []byte("alpha bytes")
	betaContent := []byte("beta bytes")
	alphaArchive := buildTarGzipArchive(t, "bin/adapter", alphaContent)
	betaArchive := buildZipArchive(t, "bin/adapter", betaContent)
	server := archiveServerFixture(t, alphaArchive, betaArchive)
	// The beta pin is wrong on purpose: the first operation must succeed and persist before the
	// second fails its checksum verification.
	manifestBytes, manifest := archiveManifestFixture(t, server.URL, sha256Hex(alphaArchive), strings.Repeat("0", 64), len(alphaArchive), len(betaArchive))
	dataRoot := t.TempDir()
	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, applyOptions(server))
	if err == nil {
		t.Fatal("Apply() succeeded despite a failing second operation, want partial failure")
	}
	if len(result.Applied) != 1 {
		t.Fatalf("Apply() reported %d applied operations, want the first one only", len(result.Applied))
	}
	assertInstalledExecutable(t, plan.Operations[0].TargetPath, alphaContent)
	if _, err := os.Stat(plan.Operations[1].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("second target exists despite its failed operation: %v", err)
	}
	ledger, err := LoadOwnershipLedger(dataRoot)
	if err != nil {
		t.Fatalf("LoadOwnershipLedger() error = %v", err)
	}
	if len(ledger.Records) != 1 {
		t.Fatalf("persisted ledger holds %d records after partial failure, want exactly 1", len(ledger.Records))
	}
	if _, ok := ledger.RecordFor(plan.Operations[0].TargetPath); !ok {
		t.Fatal("persisted ledger is missing the completed operation's record")
	}
	if _, ok := ledger.RecordFor(plan.Operations[1].TargetPath); ok {
		t.Fatal("persisted ledger holds a record for the failed operation")
	}
	if strays := strayTemporaryArtifacts(t, dataRoot); len(strays) != 0 {
		t.Fatalf("partial failure left temporary artifacts behind: %v", strays)
	}
}

// TestApplyRejectsManualArtifactChangedAfterChecksumWasAsserted proves the fix-3 property: a
// manual artifact is read exactly once, hashed while it is staged, and only then compared against
// the operator-asserted checksum — there is no separate "verify, then reopen and copy" pair of
// reads that a source mutated in between could straddle. Simulating that mutation (the operator
// computed a checksum for content A; by the time apply actually reads the file, it holds content
// B) must be caught by the single read's own hash mismatch, not silently accepted because an
// earlier, now-stale verification pass approved a different version of the file.
func TestApplyRejectsManualArtifactChangedAfterChecksumWasAsserted(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	sourceDirectory := t.TempDir()
	originalContent := []byte("#!/bin/sh\necho original\n")
	source := filepath.Join(sourceDirectory, "operator-placed-adapter")
	if err := os.WriteFile(source, originalContent, 0o755); err != nil {
		t.Fatalf("write manual source: %v", err)
	}
	// The operator computed this checksum against originalContent.
	assertedChecksum := sha256Hex(originalContent)

	// The file is swapped for different content before apply ever reads it — exactly the race a
	// two-pass verify-then-copy implementation would miss if the swap happened between the two
	// reads, and exactly what a single-pass implementation must still catch regardless of when the
	// swap happened, since there is only one read.
	swappedContent := []byte("#!/bin/sh\necho swapped-in-by-an-attacker\n")
	if err := os.WriteFile(source, swappedContent, 0o755); err != nil {
		t.Fatalf("swap manual source: %v", err)
	}

	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	result, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": source},
		ManualChecksums:       map[string]string{"manual-acp": assertedChecksum},
	})
	if err == nil {
		t.Fatal("Apply() accepted a manual artifact whose content no longer matches the asserted checksum, want rejection")
	}
	if len(result.Applied) != 0 {
		t.Fatalf("Apply() applied %d operations despite the checksum mismatch", len(result.Applied))
	}
	if _, err := os.Stat(plan.Operations[0].TargetPath); !os.IsNotExist(err) {
		t.Fatalf("swapped-content install reached the target: %v", err)
	}
	if strays := strayTemporaryArtifacts(t, dataRoot); len(strays) != 0 {
		t.Fatalf("rejected install left temporary artifacts behind: %v", strays)
	}
}

// TestApplyRejectsAncestorSymlinkReplacement proves the fix-4 property: ensureDirectoryWithinRoot
// walks the install directory chain component by component and refuses a symlink at any level,
// rather than a plain MkdirAll/Rename pair that would follow a pre-existing symlink ancestor
// straight through to wherever it points. Replacing an intermediate ancestor of the target with a
// symlink to a directory outside dataRoot must stop the install and must never create anything
// inside the symlinked-to location.
func TestApplyRejectsAncestorSymlinkReplacement(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	sourceDirectory := t.TempDir()
	artifactContent := []byte("#!/bin/sh\necho manual\n")
	source := filepath.Join(sourceDirectory, "operator-placed-adapter")
	if err := os.WriteFile(source, artifactContent, 0o755); err != nil {
		t.Fatalf("write manual source: %v", err)
	}

	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	// TargetPath is <dataRoot>/adapters/manual-cli/manual-acp/0.4.0/bin/adapter; replace the
	// "manual-cli" ancestor with a symlink pointing outside dataRoot entirely, before any of the
	// chain exists on disk.
	adaptersDirectory := filepath.Join(dataRoot, "adapters")
	if err := os.MkdirAll(adaptersDirectory, 0o755); err != nil {
		t.Fatalf("create adapters directory: %v", err)
	}
	outsideTarget := t.TempDir()
	symlinkedAncestor := filepath.Join(adaptersDirectory, "manual-cli")
	if err := os.Symlink(outsideTarget, symlinkedAncestor); err != nil {
		t.Fatalf("create ancestor symlink: %v", err)
	}

	_, err = Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
		ManualArtifactSources: map[string]string{"manual-acp": source},
		ManualChecksums:       map[string]string{"manual-acp": sha256Hex(artifactContent)},
	})
	if err == nil {
		t.Fatal("Apply() accepted an install directory chain with a symlinked ancestor, want rejection")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("Apply() error = %v, want it to name the symlinked ancestor", err)
	}
	entries, readErr := os.ReadDir(outsideTarget)
	if readErr != nil {
		t.Fatalf("read outside target: %v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("install wrote through the ancestor symlink into %s: %v", outsideTarget, entries)
	}
}

// TestApplyNeverOverwritesTargetThatAppearsDuringInstall proves the fix-3 property: publishing an
// installed file uses os.Link, which fails atomically with ErrExist when anything already
// occupies the target path, rather than os.Rename, which would silently replace it. A background
// goroutine races to create the target with O_CREATE|O_EXCL (itself never replacing anything,
// exactly like a genuine concurrent actor) throughout the whole install; regardless of which of
// the two ever wins the exact race, the target's content afterward must belong entirely to
// whichever one actually won — Apply reporting success must mean its own content landed, and Apply
// reporting failure must mean the racer's content was left completely untouched. Content silently
// mixed or replaced would be the exact bug this test exists to catch.
func TestApplyNeverOverwritesTargetThatAppearsDuringInstall(t *testing.T) {
	manifestBytes, manifest := manualManifestFixture(t)
	dataRoot := t.TempDir()
	sourceDirectory := t.TempDir()
	installedContent := []byte("#!/bin/sh\necho installed\n")
	source := filepath.Join(sourceDirectory, "operator-placed-adapter")
	if err := os.WriteFile(source, installedContent, 0o755); err != nil {
		t.Fatalf("write manual source: %v", err)
	}

	plan, _, err := BuildPlan(manifestBytes, manifest, testPlatform, dataRoot, OwnershipLedger{})
	if err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
	targetPath := plan.Operations[0].TargetPath
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatalf("pre-create target directory for the racer: %v", err)
	}

	foreignContent := []byte("foreign content planted by a concurrent actor")
	var racerWon atomic.Bool
	stop := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			file, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
			if err == nil {
				file.Write(foreignContent)
				file.Close()
				racerWon.Store(true)
				return
			}
			if !errors.Is(err, fs.ErrExist) {
				return
			}
		}
	}()

	applyErr := func() error {
		defer func() {
			close(stop)
			wait.Wait()
		}()
		_, err := Apply(context.Background(), plan, manifestBytes, OwnershipLedger{}, dataRoot, ApplyOptions{
			ManualArtifactSources: map[string]string{"manual-acp": source},
			ManualChecksums:       map[string]string{"manual-acp": sha256Hex(installedContent)},
		})
		return err
	}()

	if !racerWon.Load() {
		t.Skip("racer never won the timing window on this run; cannot exercise the race deterministically")
	}

	finalContent, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read target after race: %v", err)
	}
	if applyErr == nil {
		if !bytes.Equal(finalContent, installedContent) {
			t.Fatalf("Apply() reported success but target content = %q, want the installed content", finalContent)
		}
	} else {
		if !bytes.Equal(finalContent, foreignContent) {
			t.Fatalf("Apply() reported failure (%v) but target content = %q, want the racer's untouched content — Apply overwrote a file that appeared during install", applyErr, finalContent)
		}
	}
}
