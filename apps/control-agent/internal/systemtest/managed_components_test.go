//go:build system && unix

package systemtest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"testing"
)

const (
	managedVersionA = "2.0.14"
	managedVersionB = "2.0.15"
	managedNodeID   = "managed-component-node"
)

type setupCommandResult struct {
	code   int
	output string
}

const setupCommandOutputLimit = 64 * 1024

type boundedCommandOutput struct {
	content   []byte
	truncated bool
}

func (output *boundedCommandOutput) Write(value []byte) (int, error) {
	remaining := setupCommandOutputLimit - len(output.content)
	if remaining > 0 {
		if remaining > len(value) {
			remaining = len(value)
		}
		output.content = append(output.content, value[:remaining]...)
	}
	if remaining < len(value) {
		output.truncated = true
	}
	return len(value), nil
}

func (output *boundedCommandOutput) String() string {
	if output.truncated {
		return string(output.content) + "\n[output truncated]\n"
	}
	return string(output.content)
}

func runSetupCommand(t *testing.T, home string, extraEnvironment []string, arguments ...string) setupCommandResult {
	t.Helper()
	command := exec.Command(baristaBinary, arguments...)
	command.Dir = home
	command.Env = []string{
		"PATH=" + nativeDirectory + string(os.PathListSeparator) + os.Getenv("PATH"),
		"HOME=" + home,
	}
	command.Env = append(command.Env, extraEnvironment...)
	for name, value := range providerCanaries {
		command.Env = append(command.Env, name+"="+value)
	}
	output := &boundedCommandOutput{}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	result := setupCommandResult{output: output.String()}
	if err == nil {
		// Keep the zero exit code.
	} else if exit, ok := err.(*exec.ExitError); ok {
		result.code = exit.ExitCode()
	} else {
		t.Fatalf("run %s: %v", strings.Join(arguments, " "), err)
	}
	for category, secret := range providerCanaries {
		if strings.Contains(result.output, secret) {
			t.Fatalf("provider credential category %s leaked into setup command output", category)
		}
	}
	return result
}

func requireSetupSuccess(t *testing.T, result setupCommandResult, phase string) string {
	t.Helper()
	if result.code != 0 {
		t.Fatalf("%s exited %d:\n%s", phase, result.code, result.output)
	}
	return result.output
}

func requireSetupFailure(t *testing.T, result setupCommandResult, phase string) string {
	t.Helper()
	if result.code == 0 {
		t.Fatalf("%s unexpectedly succeeded:\n%s", phase, result.output)
	}
	return result.output
}

func fileSHA256(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func writeHarnessManifest(t *testing.T, directory, name, version string, distribution map[string]any) string {
	t.Helper()
	document := map[string]any{
		"manifestVersion": "2",
		"components": []any{map[string]any{
			"id": "claude-cli", "kind": "harness", "harnessId": "claude-cli", "provider": "anthropic",
			"label": "System-test Claude Code", "version": version,
			"platforms": map[string]any{runtime.GOOS + "-" + runtime.GOARCH: distribution},
			"launch":    map[string]any{},
		}},
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeUnsupportedHarnessManifest(t *testing.T, directory string) string {
	t.Helper()
	document := map[string]any{
		"manifestVersion": "2",
		"components": []any{map[string]any{
			"id": "claude-cli", "kind": "harness", "harnessId": "claude-cli", "provider": "anthropic",
			"label": "Unsupported fixture", "version": managedVersionA,
			"platforms": map[string]any{"plan9-amd64": map[string]any{"kind": "manual", "executablePath": "bin/claude"}},
			"launch":    map[string]any{},
		}},
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "unsupported.json")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func manualManifest(t *testing.T, directory, name, version string) string {
	return writeHarnessManifest(t, directory, name, version, map[string]any{
		"kind": "manual", "executablePath": "bin/claude",
	})
}

func planSetup(t *testing.T, home, dataRoot, manifest, plan string, environment ...string) setupCommandResult {
	return runSetupCommand(t, home, environment, "setup", "plan", "--data-root", dataRoot, "--manifest", manifest, "--out", plan)
}

func applyManualSetup(t *testing.T, home, dataRoot, manifest, plan, artifact, checksum string) setupCommandResult {
	arguments := []string{"setup", "apply", "--data-root", dataRoot, "--manifest", manifest, "--plan", plan,
		"--manual-artifact", "claude-cli=" + artifact}
	if checksum != "" {
		arguments = append(arguments, "--manual-checksum", "claude-cli="+checksum)
	}
	return runSetupCommand(t, home, nil, arguments...)
}

func activateHarnessCLI(t *testing.T, home, dataRoot, manifest, version string) setupCommandResult {
	return runSetupCommand(t, home, nil, "setup", "activate", "--data-root", dataRoot, "--manifest", manifest,
		"--kind", "harness", "--id", "claude-cli", "--version", version)
}

func rollbackHarnessCLI(t *testing.T, home, dataRoot, manifest string) setupCommandResult {
	return runSetupCommand(t, home, nil, "setup", "rollback", "--data-root", dataRoot, "--manifest", manifest,
		"--kind", "harness", "--id", "claude-cli")
}

func pruneHarnessCLI(t *testing.T, home, dataRoot, manifest string) setupCommandResult {
	return runSetupCommand(t, home, nil, "setup", "prune", "--data-root", dataRoot, "--manifest", manifest,
		"--kind", "harness", "--id", "claude-cli")
}

func doctorCLI(t *testing.T, home, dataRoot, manifest, endpoint string) setupCommandResult {
	return runSetupCommand(t, home, nil, "doctor", "--json", "--data-root", dataRoot,
		"--manifest", manifest, "--control-endpoint", endpoint)
}

type componentDoctorReport struct {
	Components []struct {
		Component struct {
			Kind    string `json:"kind"`
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"component"`
		ActiveVersion   string `json:"activeVersion"`
		RollbackVersion string `json:"rollbackVersion"`
		Provenance      string `json:"provenance"`
	} `json:"components"`
}

func requireDoctorHarness(t *testing.T, output, activeVersion, rollbackVersion string) {
	t.Helper()
	var report componentDoctorReport
	if err := json.Unmarshal([]byte(output), &report); err != nil {
		t.Fatalf("decode doctor report: %v\n%s", err, output)
	}
	for _, component := range report.Components {
		if component.Component.Kind != "harness" || component.Component.ID != "claude-cli" {
			continue
		}
		if component.Component.Version != activeVersion || component.ActiveVersion != activeVersion ||
			component.RollbackVersion != rollbackVersion || component.Provenance != "managed" {
			t.Fatalf("doctor reported the wrong managed selection: %+v", component)
		}
		return
	}
	t.Fatal("doctor omitted claude-cli")
}

func restoreManagedHarness(t *testing.T, target, artifact string) {
	t.Helper()
	if err := os.RemoveAll(target); err != nil {
		t.Fatal(err)
	}
	content := bytesIfPresent(t, artifact)
	if err := os.WriteFile(target, content, 0o755); err != nil {
		t.Fatal(err)
	}
}

func installManualHarness(t *testing.T, home, dataRoot, manifest, plan, artifact string) {
	t.Helper()
	requireSetupSuccess(t, planSetup(t, home, dataRoot, manifest, plan), "setup plan")
	requireSetupSuccess(t, applyManualSetup(t, home, dataRoot, manifest, plan, artifact, fileSHA256(t, artifact)), "setup apply")
}

func managedHarnessTarget(dataRoot, version string) string {
	return filepath.Join(dataRoot, "harnesses", "claude-cli", "claude-cli", version, "bin", "claude")
}

func bytesIfPresent(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func buildTarGzip(t *testing.T, entry string, content []byte) []byte {
	t.Helper()
	var result bytes.Buffer
	gzipWriter := gzip.NewWriter(&result)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{Name: entry, Mode: 0o755, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func trustEnvironment(t *testing.T, servers ...*httptest.Server) []string {
	t.Helper()
	var certificates bytes.Buffer
	for _, server := range servers {
		certificate := server.Certificate()
		if certificate == nil {
			t.Fatal("TLS fixture has no certificate")
		}
		if err := pem.Encode(&certificates, &pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw}); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(t.TempDir(), "roots.pem")
	if err := os.WriteFile(path, certificates.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return []string{"SSL_CERT_FILE=" + path}
}

// TestManagedComponentCLIRefusalMatrix invokes the real setup command for every phase. Package
// tests exercise the lower-level authorities exhaustively; this scenario proves the CLI joins keep
// the same no-mutation and idempotency properties on isolated filesystem roots.
func TestManagedComponentCLIRefusalMatrix(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	artifactA := managedHarnessBinaries[managedVersionA]
	artifactB := managedHarnessBinaries[managedVersionB]
	manifestA := manualManifest(t, root, "manifest-a.json", managedVersionA)
	manifestB := manualManifest(t, root, "manifest-b.json", managedVersionB)

	t.Run("manual lifecycle, replay, and stale intent", func(t *testing.T) {
		dataRoot := filepath.Join(root, "manual-data")
		planA := filepath.Join(root, "plan-a.json")
		requireSetupSuccess(t, planSetup(t, home, dataRoot, manifestA, planA), "read-only plan")
		if _, err := os.Stat(dataRoot); !os.IsNotExist(err) {
			t.Fatalf("planning created or touched the absent data root: %v", err)
		}
		failed := requireSetupFailure(t, applyManualSetup(t, home, dataRoot, manifestA, planA, artifactA, ""), "missing checksum")
		if strings.Contains(failed, artifactA) {
			t.Fatal("manual source path leaked into the refusal")
		}
		requireSetupFailure(t, applyManualSetup(t, home, dataRoot, manifestA, planA, artifactA, strings.Repeat("0", 64)), "wrong checksum")
		if content := bytesIfPresent(t, filepath.Join(dataRoot, "ownership.json")); content != nil {
			t.Fatalf("a refused manual apply wrote ownership: %s", content)
		}

		// The missing-checksum command created the owned root before Apply refused, but it installed
		// nothing. A fresh plan binds that observed state and succeeds exactly once.
		requireSetupSuccess(t, planSetup(t, home, dataRoot, manifestA, planA), "fresh plan")
		requireSetupSuccess(t, applyManualSetup(t, home, dataRoot, manifestA, planA, artifactA, fileSHA256(t, artifactA)), "manual apply")
		requireSetupSuccess(t, activateHarnessCLI(t, home, dataRoot, manifestA, managedVersionA), "activate A")
		activationBefore := bytesIfPresent(t, filepath.Join(dataRoot, "activation.json"))
		requireSetupSuccess(t, activateHarnessCLI(t, home, dataRoot, manifestA, managedVersionA), "activate A replay")
		if !bytes.Equal(activationBefore, bytesIfPresent(t, filepath.Join(dataRoot, "activation.json"))) {
			t.Fatal("exact activation replay rewrote its ledger")
		}
		replayPlan := filepath.Join(root, "replay-plan.json")
		requireSetupSuccess(t, planSetup(t, home, dataRoot, manifestA, replayPlan), "replay plan")
		ownershipBefore := bytesIfPresent(t, filepath.Join(dataRoot, "ownership.json"))
		replay := requireSetupSuccess(t, applyManualSetup(t, home, dataRoot, manifestA, replayPlan, artifactA, fileSHA256(t, artifactA)), "apply replay")
		if !strings.Contains(replay, "already installed") || !bytes.Equal(ownershipBefore, bytesIfPresent(t, filepath.Join(dataRoot, "ownership.json"))) {
			t.Fatal("exact apply replay did not converge without a write")
		}

		editedPlan := filepath.Join(root, "edited-plan.json")
		planBytes := bytesIfPresent(t, replayPlan)
		var document map[string]any
		if err := json.Unmarshal(planBytes, &document); err != nil {
			t.Fatal(err)
		}
		document["digest"] = strings.Repeat("0", 64)
		edited, _ := json.Marshal(document)
		if err := os.WriteFile(editedPlan, edited, 0o600); err != nil {
			t.Fatal(err)
		}
		requireSetupFailure(t, applyManualSetup(t, home, dataRoot, manifestA, editedPlan, artifactA, fileSHA256(t, artifactA)), "edited plan")
		requireSetupFailure(t, applyManualSetup(t, home, dataRoot, manifestB, replayPlan, artifactB, fileSHA256(t, artifactB)), "stale manifest")
		if !bytes.Equal(ownershipBefore, bytesIfPresent(t, filepath.Join(dataRoot, "ownership.json"))) {
			t.Fatal("edited/stale plan changed ownership")
		}
	})

	t.Run("target race, probe refusal, and unsupported platform", func(t *testing.T) {
		dataRoot := filepath.Join(root, "negative-data")
		plan := filepath.Join(root, "negative-plan.json")
		requireSetupSuccess(t, planSetup(t, home, dataRoot, manifestB, plan), "negative plan")
		target := managedHarnessTarget(dataRoot, managedVersionB)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		foreign := []byte("foreign file\n")
		if err := os.WriteFile(target, foreign, 0o755); err != nil {
			t.Fatal(err)
		}
		requireSetupFailure(t, applyManualSetup(t, home, dataRoot, manifestB, plan, artifactB, fileSHA256(t, artifactB)), "target changed after plan")
		if !bytes.Equal(foreign, bytesIfPresent(t, target)) {
			t.Fatal("stale target refusal replaced the foreign file")
		}

		probeRoot := filepath.Join(root, "probe-data")
		wrongManifest := manualManifest(t, root, "manifest-wrong-version.json", "2.0.16")
		wrongPlan := filepath.Join(root, "wrong-version-plan.json")
		installManualHarness(t, home, probeRoot, wrongManifest, wrongPlan, artifactB)
		probeOutput := requireSetupFailure(t, activateHarnessCLI(t, home, probeRoot, wrongManifest, "2.0.16"), "wrong self-reported version")
		if strings.Contains(probeOutput, managedVersionB) || bytesIfPresent(t, filepath.Join(probeRoot, "activation.json")) != nil {
			t.Fatal("probe refusal leaked raw output or wrote activation")
		}

		unstartableRoot := filepath.Join(root, "unstartable-data")
		unstartablePlan := filepath.Join(root, "unstartable-plan.json")
		installManualHarness(t, home, unstartableRoot, manifestB, unstartablePlan, artifactB)
		unstartableTarget := managedHarnessTarget(unstartableRoot, managedVersionB)
		if err := os.Chmod(unstartableTarget, 0o600); err != nil {
			t.Fatal(err)
		}
		ownershipBeforeProbeFailure := bytesIfPresent(t, filepath.Join(unstartableRoot, "ownership.json"))
		requireSetupFailure(t, activateHarnessCLI(t, home, unstartableRoot, manifestB, managedVersionB), "unstartable version probe")
		if bytesIfPresent(t, filepath.Join(unstartableRoot, "activation.json")) != nil ||
			!bytes.Equal(ownershipBeforeProbeFailure, bytesIfPresent(t, filepath.Join(unstartableRoot, "ownership.json"))) ||
			!bytes.Equal(bytesIfPresent(t, artifactB), bytesIfPresent(t, unstartableTarget)) {
			t.Fatal("probe start refusal mutated activation, ownership, or installed bytes")
		}

		unsupportedRoot := filepath.Join(root, "unsupported-data")
		unsupportedPlan := filepath.Join(root, "unsupported-plan.json")
		output := requireSetupSuccess(t, planSetup(t, home, unsupportedRoot, writeUnsupportedHarnessManifest(t, root), unsupportedPlan), "unsupported plan")
		var unsupportedDocument struct {
			Operations []json.RawMessage `json:"operations"`
		}
		if err := json.Unmarshal(bytesIfPresent(t, unsupportedPlan), &unsupportedDocument); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(output, "skipped") || len(unsupportedDocument.Operations) != 0 {
			t.Fatalf("unsupported platform invented an operation: %s\n%s", output, bytesIfPresent(t, unsupportedPlan))
		}
	})
}

// TestManagedComponentArchiveCLI proves archive bytes cross the real HTTPS, digest, size,
// redirect, and extraction boundaries used by the setup command rather than an in-memory applier.
func TestManagedComponentArchiveCLI(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	artifact := bytesIfPresent(t, managedHarnessBinaries[managedVersionA])
	archive := buildTarGzip(t, "bin/claude", artifact)
	traversingArchive := buildTarGzip(t, "../escaped", artifact)
	archiveDigest := sha256.Sum256(archive)
	traversingDigest := sha256.Sum256(traversingArchive)
	malformedDigest := sha256.Sum256([]byte("not an archive"))
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/claude.tar.gz":
			_, _ = writer.Write(archive)
		case "/truncated.tar.gz":
			_, _ = writer.Write(archive[:len(archive)/2])
		case "/malformed.tar.gz":
			_, _ = writer.Write([]byte("not an archive"))
		case "/traversing.tar.gz":
			_, _ = writer.Write(traversingArchive)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	trust := trustEnvironment(t, server)

	testCases := []struct {
		name       string
		path       string
		digest     string
		size       int
		shouldPass bool
	}{
		{name: "verified archive", path: "/claude.tar.gz", digest: hex.EncodeToString(archiveDigest[:]), size: len(archive), shouldPass: true},
		{name: "digest mismatch", path: "/claude.tar.gz", digest: strings.Repeat("0", 64), size: len(archive)},
		{name: "size mismatch", path: "/claude.tar.gz", digest: hex.EncodeToString(archiveDigest[:]), size: len(archive) - 1},
		{name: "truncated content", path: "/truncated.tar.gz", digest: hex.EncodeToString(archiveDigest[:]), size: len(archive)},
		{name: "malformed archive", path: "/malformed.tar.gz", digest: hex.EncodeToString(malformedDigest[:]), size: len("not an archive")},
		{name: "traversing archive", path: "/traversing.tar.gz", digest: hex.EncodeToString(traversingDigest[:]), size: len(traversingArchive)},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			dataRoot := filepath.Join(root, strings.ReplaceAll(testCase.name, " ", "-"))
			manifest := writeHarnessManifest(t, root, strings.ReplaceAll(testCase.name, " ", "-")+".json", managedVersionA, map[string]any{
				"kind": "archive", "url": server.URL + testCase.path, "sha256": testCase.digest,
				"sizeBytes": testCase.size, "executablePath": "bin/claude",
			})
			plan := dataRoot + ".plan.json"
			requireSetupSuccess(t, planSetup(t, home, dataRoot, manifest, plan, trust...), "archive plan")
			result := runSetupCommand(t, home, trust, "setup", "apply", "--data-root", dataRoot, "--manifest", manifest, "--plan", plan)
			if testCase.shouldPass {
				requireSetupSuccess(t, result, testCase.name)
				if !bytes.Equal(artifact, bytesIfPresent(t, managedHarnessTarget(dataRoot, managedVersionA))) {
					t.Fatal("verified archive did not install the producer bytes")
				}
			} else {
				requireSetupFailure(t, result, testCase.name)
				if bytesIfPresent(t, filepath.Join(dataRoot, "ownership.json")) != nil {
					t.Fatal("refused archive wrote ownership")
				}
			}
		})
	}

	t.Run("redirect requires an explicit host", func(t *testing.T) {
		target := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write(archive) }))
		defer target.Close()
		redirect := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			http.Redirect(writer, request, target.URL+"/claude.tar.gz", http.StatusFound)
		}))
		defer redirect.Close()
		trust := trustEnvironment(t, target, redirect)
		dataRoot := filepath.Join(root, "redirect")
		manifest := writeHarnessManifest(t, root, "redirect.json", managedVersionA, map[string]any{
			"kind": "archive", "url": redirect.URL + "/claude.tar.gz", "sha256": hex.EncodeToString(archiveDigest[:]),
			"sizeBytes": len(archive), "executablePath": "bin/claude",
		})
		plan := dataRoot + ".plan.json"
		requireSetupSuccess(t, planSetup(t, home, dataRoot, manifest, plan, trust...), "redirect plan")
		requireSetupFailure(t, runSetupCommand(t, home, trust, "setup", "apply", "--data-root", dataRoot, "--manifest", manifest, "--plan", plan), "unapproved redirect")
		approved := append([]string{}, trust...)
		result := runSetupCommand(t, home, approved, "setup", "apply", "--data-root", dataRoot, "--manifest", manifest, "--plan", plan,
			"--allowed-host", strings.Split(strings.TrimPrefix(target.URL, "https://"), ":")[0])
		requireSetupSuccess(t, result, "approved redirect")
	})
}

func componentInventoryFor(current snapshot, nodeID string) (componentInventory, bool) {
	for _, report := range current.ComponentInventories {
		if report.NodeID == nodeID {
			return report, true
		}
	}
	return componentInventory{}, false
}

func claudeComponent(report componentInventory) (componentInventoryEntry, bool) {
	for _, component := range report.Components {
		if component.Kind == "harness" && component.ID == "claude-cli" {
			return component, true
		}
	}
	return componentInventoryEntry{}, false
}

func requireInventoryContract(t *testing.T, report componentInventory, nodeID string) {
	t.Helper()
	if report.NodeID != nodeID {
		t.Fatalf("component inventory belongs to %q, want %q", report.NodeID, nodeID)
	}
	if err := report.Validate(); err != nil {
		t.Fatalf("component inventory violates the shared sorted/vocabulary contract: %v\n%+v", err, report)
	}
}

func requireClaudeInventoryState(t *testing.T, report componentInventory, declared, active, rollback string, installed, codes []string) {
	t.Helper()
	component, found := claudeComponent(report)
	if !found {
		t.Fatal("component inventory omitted claude-cli")
	}
	if component.HarnessID != "claude-cli" || component.DeclaredVersion != declared || component.ActiveVersion != active ||
		component.RollbackVersion != rollback || component.RollbackAvailable != (rollback != "") ||
		component.Provenance != "managed" || component.Readiness != "ready" ||
		!slices.Equal(component.InstalledVersions, installed) || !slices.Equal(component.DiagnosticCodes, codes) {
		t.Fatalf("component inventory state does not match the running process: %+v", component)
	}
}

func nativeRunRecords(environment *environment) []harnessRecord {
	result := []harnessRecord{}
	for _, records := range environment.harnessRecords() {
		for _, record := range records {
			if record.Role == "claude" && record.Event == "native-run" {
				result = append(result, record)
			}
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].At < result[right].At })
	return result
}

func requireNativeRunVersion(t *testing.T, environment *environment, minimum int, version, executable string) {
	t.Helper()
	waitFor(t, fmt.Sprintf("native run %d to use %s", minimum, version), func() bool {
		records := nativeRunRecords(environment)
		if len(records) < minimum {
			return false
		}
		record := records[minimum-1]
		return strings.Contains(record.Version, version) && record.Executable == executable
	})
}

func requireInstanceGeneration(t *testing.T, current snapshot, instanceID, allocationID string, generations int, requirements []byte) {
	t.Helper()
	instance, found := instanceByID(current, instanceID)
	if !found {
		t.Fatalf("instance %s disappeared", instanceID)
	}
	encodedRequirements, err := json.Marshal(instance.Requirements)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encodedRequirements, requirements) {
		t.Fatalf("instance %s requirements changed across process generations", instanceID)
	}
	matching := 0
	active := 0
	for _, allocation := range current.Allocations {
		if allocation.InstanceID != instanceID {
			continue
		}
		matching++
		if allocation.Status == "active" {
			active++
			if allocation.ID != allocationID {
				t.Fatalf("instance %s active allocation is %s, want %s", instanceID, allocation.ID, allocationID)
			}
		}
	}
	if matching != generations || active != 1 {
		t.Fatalf("instance %s has %d allocation generations and %d active, want %d and 1", instanceID, matching, active, generations)
	}
}

func assertInventoryPrivacy(t *testing.T, raw []byte) {
	t.Helper()
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	inventories := document["componentInventories"]
	for _, forbidden := range []string{"componentPath", "dataRoot", "command", "sha256", "digest", "rawOutput", "notes", "authDocsUrl"} {
		if bytes.Contains(bytes.ToLower(inventories), bytes.ToLower([]byte(forbidden))) {
			t.Fatalf("component inventory exposed forbidden field category %s", forbidden)
		}
	}
}

func scanCanaries(t *testing.T, sources map[string][]byte) {
	t.Helper()
	secrets := map[string]string{"enrollment token": enrollmentToken}
	for name, value := range providerCanaries {
		secrets[name] = value
	}
	for source, content := range sources {
		for category, secret := range secrets {
			if bytes.Contains(content, []byte(secret)) {
				t.Errorf("%s leaked into %s", category, source)
			}
		}
	}
}

func collectFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr == nil {
			relative, relativeErr := filepath.Rel(root, path)
			if relativeErr == nil {
				result[relative] = content
			}
		}
		return nil
	})
	return result
}

// TestManagedComponentUpgradeRestartAndRollback crosses the real setup CLI, Hub, Barista,
// version-five resident lifecycle, native provider process, and component inventory projection.
func TestManagedComponentUpgradeRestartAndRollback(t *testing.T) {
	cluster := newEnvironment(t, environmentOptions{})
	node := cluster.prepareNode(nodeOptions{
		id: managedNodeID, labels: []string{"managed-component-e2e"}, concurrency: 1, instanceCapacity: integer(1),
	})
	fixtureRoot := filepath.Join(cluster.root, "managed-components")
	if err := os.MkdirAll(fixtureRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	manifestA := manualManifest(t, fixtureRoot, "manifest-a.json", managedVersionA)
	manifestB := manualManifest(t, fixtureRoot, "manifest-b.json", managedVersionB)
	planA := filepath.Join(fixtureRoot, "plan-a.json")
	planB := filepath.Join(fixtureRoot, "plan-b.json")
	installManualHarness(t, node.home, node.dataRoot, manifestA, planA, managedHarnessBinaries[managedVersionA])
	requireSetupSuccess(t, activateHarnessCLI(t, node.home, node.dataRoot, manifestA, managedVersionA), "activate A")
	doctorA := requireSetupSuccess(t, doctorCLI(t, node.home, node.dataRoot, manifestA, fmt.Sprintf("http://127.0.0.1:%d", cluster.hub.port)), "doctor A")
	requireDoctorHarness(t, doctorA, managedVersionA, "")
	node.options.componentManifest = manifestA
	node.start()

	liveA := cluster.eventually("the process-local A inventory", func(current snapshot) (bool, string) {
		report, found := componentInventoryFor(current, managedNodeID)
		component, known := claudeComponent(report)
		if !found || !known || component.ActiveVersion != managedVersionA || component.DeclaredVersion != managedVersionA {
			return false, "managed A inventory is not live"
		}
		if component.Provenance != "managed" || component.Readiness != "ready" || len(component.InstalledVersions) != 1 || component.InstalledVersions[0] != managedVersionA {
			return false, "managed A inventory has not converged"
		}
		return true, ""
	})
	reportA, _ := componentInventoryFor(liveA, managedNodeID)
	requireInventoryContract(t, reportA, managedNodeID)
	requireClaudeInventoryState(t, reportA, managedVersionA, managedVersionA, "", []string{managedVersionA}, []string{})
	status, raw := cluster.hub.rawGet("/api/snapshot")
	if status != http.StatusOK {
		t.Fatalf("snapshot returned %d", status)
	}
	assertInventoryPrivacy(t, raw)

	clientID, secret := cluster.mintOrchestratorClient("Managed component operator", "orchestrate")
	bridge := cluster.startBridge("managed-component-operator", clientID, secret)
	created := bridge.mustCallTool("create_thread", map[string]any{"title": "Managed component lifecycle", "objective": "Prove restart-bounded adoption."})
	threadID := text(object(created, "thread"), "id")
	requirements := map[string]any{
		"harnessIds": []string{"claude-cli"}, "models": []string{"sonnet"}, "transports": []string{"native-cli"},
		"operatingSystems": []string{runtime.GOOS}, "labels": []string{"managed-component-e2e"},
	}
	spawned := bridge.mustCallTool("spawn_instance", map[string]any{
		"threadId": threadID, "idempotencyKey": "managed-component-instance", "requirements": requirements,
		"purpose":     map[string]any{"name": "Managed component", "title": "Managed component", "summary": "Upgrade witness", "instructions": "Keep the resident identity stable."},
		"initialTask": map[string]any{"title": "managed-a-held", "instructions": script(t, step{Gate: "managed-a-held"}, step{Message: "A held"})},
	})
	instanceID := text(object(spawned, "instance"), "id")
	initialTaskID := text(spawned, "initialTaskId")
	var firstRun run
	activeA := cluster.eventually("the managed A run to hold one resident", func(current snapshot) (bool, string) {
		item, known := current.task(initialTaskID)
		if !known || len(item.AttemptRunIDs) != 1 {
			return false, "initial task has no attempt"
		}
		firstRun, known = current.latestAttempt(item)
		allocation, allocated := allocationFor(current, instanceID)
		return known && allocated && firstRun.Status == "running" && allocation.Status == "active" && firstRun.AllocationID == allocation.ID,
			"initial managed run is not correlated to the active allocation"
	})
	firstAllocation, _ := allocationFor(activeA, instanceID)
	initialInstance, _ := instanceByID(activeA, instanceID)
	initialRequirements, err := json.Marshal(initialInstance.Requirements)
	if err != nil {
		t.Fatal(err)
	}
	requireInstanceGeneration(t, activeA, instanceID, firstAllocation.ID, 1, initialRequirements)
	requireNativeRunVersion(t, cluster, 1, managedVersionA, managedHarnessTarget(node.dataRoot, managedVersionA))

	installManualHarness(t, node.home, node.dataRoot, manifestB, planB, managedHarnessBinaries[managedVersionB])
	requireSetupSuccess(t, activateHarnessCLI(t, node.home, node.dataRoot, manifestB, managedVersionB), "activate B while A is running")
	if current, _ := componentInventoryFor(cluster.hub.snapshot(), managedNodeID); current.ObservedAt != reportA.ObservedAt {
		t.Fatal("changing the ledger rewrote the running process's published inventory")
	}

	// A reconnect keeps the process and resident alive but asks it for fresh reports. This gives the
	// activation watcher a bounded observation point without waiting for its production interval.
	node.proxy.sever()
	preRestart := cluster.eventually("the A process to reconnect without hot-adopting B", func(current snapshot) (bool, string) {
		report, found := componentInventoryFor(current, managedNodeID)
		component, known := claudeComponent(report)
		allocation, allocated := allocationFor(current, instanceID)
		if !found || !known || !allocated || strings.Count(node.logs.String(), "connected to") < 2 {
			return false, "same process has not reconnected"
		}
		return component.ActiveVersion == managedVersionA && component.DeclaredVersion == managedVersionA && allocation.ID == firstAllocation.ID,
			"running process claimed the newly selected version or lost its resident"
	})
	if strings.Count(node.logs.String(), "the component activation record changed after startup") != 1 {
		t.Fatalf("running A process did not emit exactly one restart notice:\n%s", node.logs.tail(8000))
	}
	preRestartReport, _ := componentInventoryFor(preRestart, managedNodeID)
	requireInventoryContract(t, preRestartReport, managedNodeID)
	requireClaudeInventoryState(t, preRestartReport, managedVersionA, managedVersionA, "", []string{managedVersionA}, []string{})
	if preRestartReport.ObservedAt <= reportA.ObservedAt {
		t.Fatal("reconnect did not publish fresh process-local evidence")
	}

	cluster.openGate("managed-a-held")
	cluster.eventually("the held A run to finish", func(current snapshot) (bool, string) {
		completed, known := current.run(firstRun.ID)
		return known && completed.Status == "completed", "held A run is not complete"
	})
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "managed-a-second",
		"tasks": []taskSpecification{{Key: "a-second", Title: "managed-a-second", Instructions: script(t, step{Message: "A second"}), Requirements: requirements, Pin: map[string]any{"instanceId": instanceID}}},
	})
	cluster.eventually("the second pre-restart A run to finish", func(current snapshot) (bool, string) {
		item, known := taskByTitle(current, threadID, "managed-a-second")
		return known && item.Status == "completed", "second A task is not complete"
	})
	requireNativeRunVersion(t, cluster, 2, managedVersionA, managedHarnessTarget(node.dataRoot, managedVersionA))

	node.stop(true)
	node.options.componentManifest = manifestB
	node.start()
	var secondAllocation instanceAllocation
	afterB := cluster.eventually("restart to adopt B and replace only the allocation", func(current snapshot) (bool, string) {
		report, found := componentInventoryFor(current, managedNodeID)
		component, known := claudeComponent(report)
		instance, hasInstance := instanceByID(current, instanceID)
		latest, allocated := allocationFor(current, instanceID)
		if !found || !known || !hasInstance || !allocated || component.ActiveVersion != managedVersionB || latest.ID == firstAllocation.ID {
			return false, "B process inventory or replacement allocation is absent"
		}
		if instance.Status != "ready" || latest.Status != "active" {
			return false, "replacement is not active"
		}
		secondAllocation = latest
		return true, ""
	})
	instanceAfterB, _ := instanceByID(afterB, instanceID)
	reportB, _ := componentInventoryFor(afterB, managedNodeID)
	requireInventoryContract(t, reportB, managedNodeID)
	requireClaudeInventoryState(t, reportB, managedVersionB, managedVersionB, managedVersionA,
		[]string{managedVersionA, managedVersionB}, []string{"rollback-available"})
	requireInstanceGeneration(t, afterB, instanceID, secondAllocation.ID, 2, initialRequirements)
	if instanceAfterB.ID != instanceID || len(afterB.Allocations) != 2 {
		t.Fatalf("restart replaced the instance instead of its allocation: %+v %+v", instanceAfterB, afterB.Allocations)
	}
	foundLostA := false
	for _, allocation := range afterB.Allocations {
		if allocation.ID == firstAllocation.ID && allocation.Status == "lost" {
			foundLostA = true
		}
	}
	if !foundLostA {
		t.Fatalf("old allocation history was not retained: %+v", afterB.Allocations)
	}
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "managed-b-run",
		"tasks": []taskSpecification{{Key: "b", Title: "managed-b-run", Instructions: script(t, step{Message: "B"}), Requirements: requirements, Pin: map[string]any{"instanceId": instanceID}}},
	})
	cluster.eventually("the B run to finish on the replacement", func(current snapshot) (bool, string) {
		item, known := taskByTitle(current, threadID, "managed-b-run")
		if !known || item.Status != "completed" {
			return false, "B task is not complete"
		}
		attempt, found := current.latestAttempt(item)
		return found && attempt.AllocationID == secondAllocation.ID, "B task did not use the replacement allocation"
	})
	requireNativeRunVersion(t, cluster, 3, managedVersionB, managedHarnessTarget(node.dataRoot, managedVersionB))

	doctorB := requireSetupSuccess(t, doctorCLI(t, node.home, node.dataRoot, manifestB, fmt.Sprintf("http://127.0.0.1:%d", cluster.hub.port)), "doctor B")
	requireDoctorHarness(t, doctorB, managedVersionB, managedVersionA)
	activationBeforeRollbackRefusals := bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))
	ownershipBeforeRollbackRefusals := bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))
	retained := requireSetupSuccess(t, pruneHarnessCLI(t, node.home, node.dataRoot, manifestB), "prune active and rollback versions")
	if !strings.Contains(retained, managedVersionA) || !strings.Contains(retained, managedVersionB) ||
		!bytes.Equal(activationBeforeRollbackRefusals, bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))) ||
		!bytes.Equal(ownershipBeforeRollbackRefusals, bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))) {
		t.Fatal("prune did not retain the active and rollback versions without mutation")
	}
	rollbackTarget := managedHarnessTarget(node.dataRoot, managedVersionA)
	absentTarget := rollbackTarget + ".absent"
	if err := os.Rename(rollbackTarget, absentTarget); err != nil {
		t.Fatal(err)
	}
	requireSetupFailure(t, rollbackHarnessCLI(t, node.home, node.dataRoot, manifestB), "rollback with absent retained bytes")
	if err := os.Rename(absentTarget, rollbackTarget); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rollbackTarget, []byte("drifted retained bytes\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	requireSetupFailure(t, rollbackHarnessCLI(t, node.home, node.dataRoot, manifestB), "rollback with drifted retained bytes")
	restoreManagedHarness(t, rollbackTarget, managedHarnessBinaries[managedVersionA])
	if !bytes.Equal(activationBeforeRollbackRefusals, bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))) ||
		!bytes.Equal(ownershipBeforeRollbackRefusals, bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))) {
		t.Fatal("a refused rollback mutated a ledger")
	}
	requireSetupSuccess(t, rollbackHarnessCLI(t, node.home, node.dataRoot, manifestB), "rollback to A")
	activationAfterRollback := bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))
	requireSetupFailure(t, rollbackHarnessCLI(t, node.home, node.dataRoot, manifestB), "rollback replay after target consumption")
	if !bytes.Equal(activationAfterRollback, bytesIfPresent(t, filepath.Join(node.dataRoot, "activation.json"))) {
		t.Fatal("a second rollback oscillated or rewrote the activation record")
	}
	node.stop(true)
	node.options.componentManifest = manifestA
	node.start()
	var thirdAllocation instanceAllocation
	rolledBackA := cluster.eventually("rollback restart to adopt A", func(current snapshot) (bool, string) {
		report, found := componentInventoryFor(current, managedNodeID)
		component, known := claudeComponent(report)
		latest, allocated := allocationFor(current, instanceID)
		if !found || !known || !allocated || component.ActiveVersion != managedVersionA || latest.ID == secondAllocation.ID {
			return false, "rolled-back A process or replacement is absent"
		}
		thirdAllocation = latest
		return latest.Status == "active", "rolled-back allocation is not active"
	})
	rolledBackReport, _ := componentInventoryFor(rolledBackA, managedNodeID)
	requireInventoryContract(t, rolledBackReport, managedNodeID)
	requireClaudeInventoryState(t, rolledBackReport, managedVersionA, managedVersionA, "",
		[]string{managedVersionA, managedVersionB}, []string{})
	requireInstanceGeneration(t, rolledBackA, instanceID, thirdAllocation.ID, 3, initialRequirements)
	bridge.mustCallTool("submit_tasks", map[string]any{
		"threadId": threadID, "idempotencyKey": "managed-a-rollback-run",
		"tasks": []taskSpecification{{Key: "a-rollback", Title: "managed-a-rollback-run", Instructions: script(t, step{Message: "A rollback"}), Requirements: requirements, Pin: map[string]any{"instanceId": instanceID}}},
	})
	cluster.eventually("the rolled-back A run to finish", func(current snapshot) (bool, string) {
		item, known := taskByTitle(current, threadID, "managed-a-rollback-run")
		if !known || item.Status != "completed" {
			return false, "rolled-back task is not complete"
		}
		attempt, found := current.latestAttempt(item)
		return found && attempt.AllocationID == thirdAllocation.ID, "rolled-back task used the wrong generation"
	})
	requireNativeRunVersion(t, cluster, 4, managedVersionA, managedHarnessTarget(node.dataRoot, managedVersionA))

	doctorRolledBack := requireSetupSuccess(t, doctorCLI(t, node.home, node.dataRoot, manifestA, fmt.Sprintf("http://127.0.0.1:%d", cluster.hub.port)), "doctor rolled back A")
	requireDoctorHarness(t, doctorRolledBack, managedVersionA, "")
	pruneTarget := managedHarnessTarget(node.dataRoot, managedVersionB)
	pruneOwnership := bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))
	unowned := filepath.Join(filepath.Dir(pruneTarget), "operator-note.keep")
	if err := os.WriteFile(unowned, []byte("not owned by Barista\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(pruneTarget); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(pruneTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	requireSetupSuccess(t, pruneHarnessCLI(t, node.home, node.dataRoot, manifestB), "prune retains directory")
	if !bytes.Equal(pruneOwnership, bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))) {
		t.Fatal("prune rewrote ownership while retaining a directory")
	}
	restoreManagedHarness(t, pruneTarget, managedHarnessBinaries[managedVersionB])
	outside := filepath.Join(fixtureRoot, "outside-prune-sentinel")
	if err := os.WriteFile(outside, []byte("outside\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(pruneTarget); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, pruneTarget); err != nil {
		t.Fatal(err)
	}
	requireSetupSuccess(t, pruneHarnessCLI(t, node.home, node.dataRoot, manifestB), "prune retains symlink")
	if string(bytesIfPresent(t, outside)) != "outside\n" || !bytes.Equal(pruneOwnership, bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))) {
		t.Fatal("prune followed a symlink or rewrote ownership")
	}
	restoreManagedHarness(t, pruneTarget, managedHarnessBinaries[managedVersionB])
	if err := os.WriteFile(pruneTarget, []byte("drifted inactive bytes\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	requireSetupSuccess(t, pruneHarnessCLI(t, node.home, node.dataRoot, manifestB), "prune retains drifted bytes")
	if !bytes.Equal(pruneOwnership, bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))) {
		t.Fatal("prune rewrote ownership while retaining drifted bytes")
	}
	restoreManagedHarness(t, pruneTarget, managedHarnessBinaries[managedVersionB])
	pruned := requireSetupSuccess(t, pruneHarnessCLI(t, node.home, node.dataRoot, manifestB), "prune inactive B")
	if !strings.Contains(pruned, managedVersionB) || bytesIfPresent(t, managedHarnessTarget(node.dataRoot, managedVersionB)) != nil {
		t.Fatal("prune did not remove the inactive owned B version")
	}
	if bytesIfPresent(t, managedHarnessTarget(node.dataRoot, managedVersionA)) == nil {
		t.Fatal("prune removed the active rolled-back A version")
	}
	if string(bytesIfPresent(t, unowned)) != "not owned by Barista\n" || string(bytesIfPresent(t, outside)) != "outside\n" {
		t.Fatal("prune removed an unowned file or changed an outside target")
	}
	ownershipAfterPrune := bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))
	requireSetupSuccess(t, pruneHarnessCLI(t, node.home, node.dataRoot, manifestB), "prune replay")
	if !bytes.Equal(ownershipAfterPrune, bytesIfPresent(t, filepath.Join(node.dataRoot, "ownership.json"))) {
		t.Fatal("prune replay rewrote ownership")
	}

	// Disconnect retains last-known evidence while node state owns liveness. Restarting Hub while
	// the proxy is paused proves SQLite recovery without letting a reconnect replace the report.
	node.proxy.setPaused(true)
	node.proxy.sever()
	offline := cluster.eventually("inventory to remain while its node is offline", func(current snapshot) (bool, string) {
		nodeState, found := nodeByID(current, managedNodeID)
		_, reported := componentInventoryFor(current, managedNodeID)
		return found && reported && nodeState.Status == "offline", "offline last-known evidence is not visible"
	})
	offlineReport, _ := componentInventoryFor(offline, managedNodeID)
	requireInventoryContract(t, offlineReport, managedNodeID)
	requireClaudeInventoryState(t, offlineReport, managedVersionA, managedVersionA, "",
		[]string{managedVersionA, managedVersionB}, []string{})
	cluster.hub.restart()
	restored := cluster.hub.snapshot()
	restoredNode, nodeFound := nodeByID(restored, managedNodeID)
	restoredReport, reportFound := componentInventoryFor(restored, managedNodeID)
	if !nodeFound || !reportFound || restoredNode.Status != "offline" || restoredReport.ObservedAt != offlineReport.ObservedAt {
		t.Fatalf("Hub restart did not retain offline informational evidence: node=%+v report=%+v", restoredNode, restoredReport)
	}
	requireInventoryContract(t, restoredReport, managedNodeID)
	requireClaudeInventoryState(t, restoredReport, managedVersionA, managedVersionA, "",
		[]string{managedVersionA, managedVersionB}, []string{})

	compatibilityWorkspace := filepath.Join(cluster.root, "compatibility-workspace")
	if err := os.MkdirAll(compatibilityWorkspace, 0o755); err != nil {
		t.Fatal(err)
	}
	compatibility := startCompatibilityBarista(t, cluster.hub.port, compatibilityWorkspace, "managed-v4", "4")
	cluster.eventually("version-four peer without invented inventory", func(current snapshot) (bool, string) {
		legacy, found := nodeByID(current, "managed-v4")
		_, invented := componentInventoryFor(current, "managed-v4")
		return found && legacy.Status != "offline" && !invented, "version-four compatibility state is not truthful"
	})
	compatibilityAgent := cluster.createAgent(agentOptions{
		name: "Version four compatibility", harnessID: "codex-cli", model: "default", nodeID: "managed-v4", workspace: compatibilityWorkspace,
	})
	compatibilityRun := cluster.sendMessage(compatibilityAgent, "Run the supported legacy direct path.", "")
	cluster.eventually("version-four legacy dispatch to remain usable", func(current snapshot) (bool, string) {
		item, found := current.run(compatibilityRun.ID)
		return found && item.Status == "completed" && item.Output == "legacy done", "version-four direct run is not complete"
	})
	var compatibilityDispatch map[string]json.RawMessage
	for _, raw := range compatibility.recordedDispatches() {
		var decoded struct {
			Run struct {
				ID string `json:"id"`
			} `json:"run"`
		}
		if json.Unmarshal(raw, &decoded) != nil || decoded.Run.ID != compatibilityRun.ID {
			continue
		}
		if err := json.Unmarshal(raw, &compatibilityDispatch); err != nil {
			t.Fatal(err)
		}
	}
	if compatibilityDispatch == nil {
		t.Fatal("version-four peer did not receive its legacy dispatch")
	}
	if execution, present := compatibilityDispatch["execution"]; present {
		t.Fatalf("version-four legacy dispatch carried v5 execution authority: %s", execution)
	}

	node.proxy.setPaused(false)
	freshA := cluster.eventually("current Barista to republish fresh A inventory", func(current snapshot) (bool, string) {
		nodeState, found := nodeByID(current, managedNodeID)
		report, reported := componentInventoryFor(current, managedNodeID)
		component, known := claudeComponent(report)
		return found && reported && known && nodeState.Status != "offline" && component.ActiveVersion == managedVersionA && report.ObservedAt > restoredReport.ObservedAt,
			"current process has not replaced offline evidence"
	})
	freshReport, _ := componentInventoryFor(freshA, managedNodeID)
	requireInventoryContract(t, freshReport, managedNodeID)
	requireClaudeInventoryState(t, freshReport, managedVersionA, managedVersionA, "", []string{managedVersionA}, []string{})

	cluster.assertNoCredentialLeak()
	sources := collectFiles(t, fixtureRoot)
	for name, content := range collectFiles(t, node.dataRoot) {
		sources["node "+name] = content
	}
	sources["barista log"] = []byte(node.logs.String())
	sources["hub log"] = []byte(cluster.hub.logs.String())
	sources["doctor A"] = []byte(doctorA)
	sources["doctor B"] = []byte(doctorB)
	sources["doctor rolled back A"] = []byte(doctorRolledBack)
	for name, records := range cluster.harnessRecords() {
		encoded, _ := json.Marshal(records)
		sources["provider record "+name] = encoded
	}
	scanCanaries(t, sources)
}
