package setup

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/safepath"
)

// ApplyOptions configures one apply run. HTTPClient defaults to http.DefaultClient's transport
// behavior but callers (and all tests) must supply an explicit *http.Client so no download is
// ever accidentally attempted through an unconfigured default in a test binary.
type ApplyOptions struct {
	HTTPClient   *http.Client
	AllowedHosts []string // forwarded to DownloadVerified for every install-archive operation
	// ManualArtifactSources maps an adapter ID to a local filesystem path the operator asserts
	// holds the correct executable for a manual-placement-check operation.
	ManualArtifactSources map[string]string
	// ManualChecksums maps an adapter ID to the SHA-256 the operator asserts for that path. Apply
	// refuses the operation when this is missing for a manual adapter present in the plan — no
	// artifact is ever installed or accepted without an explicit checksum from somewhere.
	ManualChecksums map[string]string
}

// ApplyResult reports the outcome of one apply. Applied lists operations that performed a real
// mutation; Skipped lists operations that were already satisfied (ExpectedOwnedMatch, idempotent
// re-apply). Apply persists the updated ledger itself, incrementally, after every successful
// operation.
type ApplyResult struct {
	Applied []Operation
	Skipped []Operation
}

// Apply never executes the operations recorded in the supplied plan. Instead it re-derives the
// plan from the verified manifest and the currently observed filesystem/ledger state — exactly
// what BuildPlan would produce right now — and requires the supplied plan to equal that freshly
// derived one exactly, field by field, including every operation. Only the derived operations are
// ever executed; the supplied plan file exists solely to confirm the operator's intent still
// matches reality; it is never a source of what gets installed.
//
// Two independent checks gate this, deliberately not collapsed into a single digest comparison:
//
//  1. The supplied plan's own Digest must equal ComputePlanDigest(plan) — the digest recomputed
//     from the plan's own other fields. This catches a plan whose Digest field was copied from
//     some other, legitimately-generated plan (for example one with no operations at all, or with
//     a different data root) without being recomputed for its own actual content: such a plan is
//     not self-consistent and is rejected before its Digest is ever compared to anything else.
//  2. The supplied, now known-self-consistent plan must equal the derived plan field by field
//     (compared directly, not merely by digest equality), which is what actually establishes that
//     the plan matches the manifest and the live node state right now.
//
// plan.Platform is never trusted either: Apply always derives operations for CurrentPlatform(),
// this node's own runtime.GOOS-runtime.GOARCH, and rejects a plan built for any other platform —
// a plan for platform X cannot be replayed against a node running platform Y just because some
// past state of platform Y's manifest entries happened to produce the same operations.
//
// On the first operation failure, Apply stops and returns the error together with an ApplyResult
// describing every operation completed before the failure (partial success is reported, never
// hidden), and the ownership ledger on disk reflects exactly the operations that completed — never
// a discarded write.
func Apply(ctx context.Context, plan Plan, manifestBytes []byte, ledger OwnershipLedger, dataRoot string, options ApplyOptions) (ApplyResult, error) {
	result := ApplyResult{}
	if ComputePlanDigest(plan) != plan.Digest {
		return result, errors.New("supplied plan digest does not match its own contents")
	}
	manifest, err := ParseManifest(manifestBytes)
	if err != nil {
		return result, fmt.Errorf("apply manifest: %w", err)
	}
	nodePlatform := CurrentPlatform()
	if plan.Platform != nodePlatform {
		return result, fmt.Errorf("plan was built for platform %s, this node is %s; run setup plan again on this node", plan.Platform, nodePlatform)
	}
	derivedPlan, _, err := BuildPlan(manifestBytes, manifest, nodePlatform, dataRoot, ledger)
	if err != nil {
		return result, fmt.Errorf("derive plan from manifest and current state: %w", err)
	}
	if !plansEqual(plan, derivedPlan) {
		return result, errors.New("supplied plan does not match the manifest and current node state; run setup plan again")
	}
	for _, operation := range derivedPlan.Operations {
		if operation.ExpectedCurrentState == ExpectedUnownedExists {
			return result, fmt.Errorf("adapter %s target %s holds a file this tool did not create", operation.AdapterID, operation.TargetPath)
		}
		if operation.ExpectedCurrentState == ExpectedOwnedMatch {
			result.Skipped = append(result.Skipped, operation)
			continue
		}
		record, err := installOperation(ctx, operation, dataRoot, options)
		if err != nil {
			return result, err
		}
		ledger = ledger.WithRecord(record)
		if err := ledger.Save(dataRoot); err != nil {
			return result, fmt.Errorf("persist ownership ledger after installing adapter %s: %w", operation.AdapterID, err)
		}
		result.Applied = append(result.Applied, operation)
	}
	return result, nil
}

// plansEqual compares two plans field by field, including every operation, rather than trusting
// digest equality alone to imply content equality. Both plans are expected to already be
// self-consistent (their own Digest already verified against ComputePlanDigest), so this checks
// the property digest comparison is meant to guarantee, directly.
func plansEqual(a Plan, b Plan) bool {
	return reflect.DeepEqual(a, b)
}

func installOperation(ctx context.Context, operation Operation, dataRoot string, options ApplyOptions) (OwnershipRecord, error) {
	switch operation.Kind {
	case OperationInstallArchive:
		return installArchive(ctx, operation, dataRoot, options)
	case OperationManualPlacementCheck:
		return installManualArtifact(operation, dataRoot, options)
	default:
		return OwnershipRecord{}, fmt.Errorf("adapter %s operation kind is unknown", operation.AdapterID)
	}
}

// installArchive downloads and verifies the pinned archive, then streams exactly the declared
// executable entry straight from the archive reader into the verified target directory through
// stageAndInstall — the archive's own bytes are read once, hashed while being written, and never
// separately re-opened for a second verification pass.
func installArchive(ctx context.Context, operation Operation, dataRoot string, options ApplyOptions) (OwnershipRecord, error) {
	parsedURL, err := url.Parse(operation.Source.URL)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s source url cannot be parsed", operation.AdapterID)
	}
	lowercasePath := strings.ToLower(parsedURL.Path)
	isZip := strings.HasSuffix(lowercasePath, ".zip")
	if !isZip && !strings.HasSuffix(lowercasePath, ".tar.gz") {
		return OwnershipRecord{}, fmt.Errorf("adapter %s archive must be a .tar.gz or .zip distribution", operation.AdapterID)
	}
	stagingDirectory, err := os.MkdirTemp(dataRoot, "setup-staging-*")
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("create staging directory under %s: %w", dataRoot, err)
	}
	defer os.RemoveAll(stagingDirectory)
	archivePath, err := DownloadVerified(ctx, options.HTTPClient, stagingDirectory, DownloadOptions{
		URL:            operation.Source.URL,
		ExpectedSHA256: operation.ExpectedChecksum,
		MaximumBytes:   operation.Source.SizeBytes,
		AllowedHosts:   options.AllowedHosts,
	})
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s archive download failed: %w", operation.AdapterID, err)
	}
	entryReader, closeEntry, err := openArchiveEntry(archivePath, operation.Source.ExecutablePath, isZip)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s archive extraction failed: %w", operation.AdapterID, err)
	}
	defer closeEntry()
	// The archive itself was already checksum-verified in full by DownloadVerified; there is no
	// separate manifest-declared checksum for the single extracted entry, so stageAndInstall simply
	// records whatever digest the extracted bytes actually have rather than comparing one.
	return stageAndInstall(dataRoot, operation, entryReader, "")
}

// installManualArtifact accepts the operator-placed artifact only after verifying, in the same
// single pass that writes it into place, the checksum the operator asserted out-of-band. The
// source file is opened exactly once and never reopened: stageAndInstall reads it straight through
// while hashing and staging it, so a source that changes on disk between the operator computing
// its checksum and apply running is caught by the checksum comparison on the one read that
// happens, not by two reads that could observe different content. Failures here name only the
// adapter ID: the operator's source path is not this tool's to publish into logs or errors.
func installManualArtifact(operation Operation, dataRoot string, options ApplyOptions) (OwnershipRecord, error) {
	source, hasSource := options.ManualArtifactSources[operation.AdapterID]
	assertedChecksum, hasChecksum := options.ManualChecksums[operation.AdapterID]
	if !hasSource || source == "" || !hasChecksum || assertedChecksum == "" {
		return OwnershipRecord{}, fmt.Errorf("adapter %s requires both a manual artifact source and a manual checksum", operation.AdapterID)
	}
	sourceFile, err := os.Open(source)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s manual artifact could not be opened", operation.AdapterID)
	}
	defer sourceFile.Close()
	return stageAndInstall(dataRoot, operation, sourceFile, assertedChecksum)
}

// stageAndInstall reads reader exactly once, hashing while writing it into a temporary file
// created directly inside operation's target directory, and only publishes that temporary file at
// operation.TargetPath after every check below passes:
//
//  1. the target directory chain from dataRoot down to the target's parent is walked component by
//     component with ensureDirectoryWithinRoot, which rejects a symlink at any level rather than
//     following or replacing one, immediately before the temporary file is created;
//  2. the copied content's digest matches expectedChecksum, when one is given;
//  3. the directory chain is re-verified a second time, and the exact target path is re-confirmed
//     absent, immediately before publishing — closing the window between the first verification
//     and the mutation, not just checking once up front.
//
// Publishing itself is a hard link (os.Link), not a rename: a rename silently replaces whatever
// already sits at the destination, which would still let a file created in the instant between
// check 3's Lstat and the mutation itself be overwritten. os.Link instead fails atomically with
// ErrExist when anything — file, directory, or symlink — already occupies the target path, so the
// no-replacement guarantee holds even against that exact race, not just against the state observed
// a moment earlier. The temporary file is removed after a successful link (the target is now a
// second, independent hard link to the same durable content) or on any failure path via the defer
// below.
//
// An install operation only ever reaches this function when planning observed the target absent
// (ExpectedOwnedMatch operations are skipped before installOperation is called), so any file found
// at the target — owned by this tool or not — is refused rather than replaced.
func stageAndInstall(dataRoot string, operation Operation, reader io.Reader, expectedChecksum string) (OwnershipRecord, error) {
	targetDirectory := filepath.Dir(operation.TargetPath)
	resolvedDirectory, err := ensureDirectoryWithinRoot(dataRoot, targetDirectory)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s install directory is not safely usable: %w", operation.AdapterID, err)
	}
	tempFile, err := os.CreateTemp(resolvedDirectory, "setup-tmp-*")
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s could not stage a temporary file: %w", operation.AdapterID, err)
	}
	tempPath := tempFile.Name()
	// The temporary file is always removed by this defer, on every path: once published via
	// os.Link, the target holds its own independent hard link to the same content, so the
	// temporary name is no longer needed either way.
	defer func() {
		tempFile.Close()
		os.Remove(tempPath)
	}()

	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(tempFile, digest), reader)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s artifact could not be staged: %w", operation.AdapterID, err)
	}
	contentSHA256 := hex.EncodeToString(digest.Sum(nil))
	if expectedChecksum != "" && !strings.EqualFold(contentSHA256, expectedChecksum) {
		return OwnershipRecord{}, fmt.Errorf("adapter %s artifact failed checksum verification", operation.AdapterID)
	}
	if runtime.GOOS != "windows" {
		if err := tempFile.Chmod(0o755); err != nil {
			return OwnershipRecord{}, fmt.Errorf("adapter %s artifact could not be marked executable: %w", operation.AdapterID, err)
		}
	}
	if err := tempFile.Sync(); err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s artifact could not be synced: %w", operation.AdapterID, err)
	}
	if err := tempFile.Close(); err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s artifact could not be finalized: %w", operation.AdapterID, err)
	}

	// Re-verify immediately before publishing: a symlink or foreign file planted anywhere in the
	// chain (or at the exact target) during staging is still caught here, not just at the check
	// that ran before staging began. os.Link below is what makes the final step itself atomic
	// against anything that appears in the instant after this check.
	if _, err := ensureDirectoryWithinRoot(dataRoot, targetDirectory); err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s install directory changed unsafely during install: %w", operation.AdapterID, err)
	}
	if _, err := os.Lstat(operation.TargetPath); err == nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s target %s appeared unexpectedly during install", operation.AdapterID, operation.TargetPath)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return OwnershipRecord{}, fmt.Errorf("adapter %s target could not be inspected: %w", operation.AdapterID, err)
	}
	if err := os.Link(tempPath, operation.TargetPath); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return OwnershipRecord{}, fmt.Errorf("adapter %s target %s appeared unexpectedly during install", operation.AdapterID, operation.TargetPath)
		}
		// A filesystem that cannot hard-link here (for example a cross-device data root, or one
		// that disallows hard links entirely) fails closed rather than falling back to a replacing
		// rename, which would reopen exactly the race this function exists to close.
		return OwnershipRecord{}, fmt.Errorf("adapter %s could not be installed without replacement: %w", operation.AdapterID, err)
	}
	return OwnershipRecord{
		Path:           operation.TargetPath,
		AdapterID:      operation.AdapterID,
		AdapterVersion: operation.AdapterVersion,
		ContentSHA256:  contentSHA256,
		SizeBytes:      written,
		InstalledAt:    time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func ensureDirectoryWithinRoot(dataRoot string, directory string) (string, error) {
	return safepath.EnsureDirectoryWithinRoot(dataRoot, directory, 0o755)
}

func verifyDirectoryWithinRoot(dataRoot string, directory string) (string, error) {
	return safepath.VerifyDirectoryWithinRoot(dataRoot, directory)
}

// openArchiveEntry locates the single declared executable entry in a downloaded, already
// checksum-verified archive and returns a reader positioned at its content plus a cleanup
// function. It performs no filesystem write of its own — every archive byte still passes through
// stageAndInstall's single-pass hashing before anything is placed anywhere.
func openArchiveEntry(archivePath string, executablePath string, isZip bool) (io.Reader, func(), error) {
	if err := validateArchiveEntryName(executablePath); err != nil {
		return nil, nil, err
	}
	if isZip {
		return openZipEntry(archivePath, executablePath)
	}
	return openTarGzipEntry(archivePath, executablePath)
}

func openTarGzipEntry(archivePath string, executablePath string) (io.Reader, func(), error) {
	archiveFile, err := os.Open(archivePath)
	if err != nil {
		return nil, nil, fmt.Errorf("open downloaded archive: %w", err)
	}
	gzipReader, err := gzip.NewReader(archiveFile)
	if err != nil {
		archiveFile.Close()
		return nil, nil, fmt.Errorf("open gzip stream: %w", err)
	}
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			gzipReader.Close()
			archiveFile.Close()
			return nil, nil, errors.New("archive does not contain the declared executable entry")
		}
		if err != nil {
			gzipReader.Close()
			archiveFile.Close()
			return nil, nil, fmt.Errorf("read archive entry: %w", err)
		}
		if header.Typeflag != tar.TypeReg || path.Clean(header.Name) != path.Clean(executablePath) {
			continue
		}
		if err := validateArchiveEntryName(header.Name); err != nil {
			gzipReader.Close()
			archiveFile.Close()
			return nil, nil, err
		}
		return reader, func() { gzipReader.Close(); archiveFile.Close() }, nil
	}
}

func openZipEntry(archivePath string, executablePath string) (io.Reader, func(), error) {
	zipReader, err := zip.OpenReader(archivePath)
	if err != nil {
		return nil, nil, fmt.Errorf("open zip archive: %w", err)
	}
	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() || path.Clean(file.Name) != path.Clean(executablePath) {
			continue
		}
		if err := validateArchiveEntryName(file.Name); err != nil {
			zipReader.Close()
			return nil, nil, err
		}
		opened, err := file.Open()
		if err != nil {
			zipReader.Close()
			return nil, nil, fmt.Errorf("open zip entry: %w", err)
		}
		return opened, func() { opened.Close(); zipReader.Close() }, nil
	}
	zipReader.Close()
	return nil, nil, errors.New("archive does not contain the declared executable entry")
}

// validateArchiveEntryName is the extraction-side twin of the manifest's executablePath grammar:
// defense in depth against archive bytes whose entry names were never seen by manifest
// validation.
func validateArchiveEntryName(entryName string) error {
	if entryName == "" || strings.ContainsRune(entryName, '\\') {
		return errors.New("archive entry name is empty or uses backslashes")
	}
	cleaned := path.Clean(entryName)
	if strings.HasPrefix(cleaned, "/") || path.IsAbs(cleaned) {
		return errors.New("archive entry name must be relative")
	}
	if slices.Contains(strings.Split(cleaned, "/"), "..") {
		return errors.New("archive entry name must not traverse upward")
	}
	return nil
}
