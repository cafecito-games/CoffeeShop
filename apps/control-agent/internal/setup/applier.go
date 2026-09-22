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
	"runtime"
	"slices"
	"strings"
	"time"
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

// Apply executes exactly the operations in plan, after verifying plan.Digest against a fresh
// ComputePlanDigest(plan) (a hand-edited or corrupted plan is rejected before anything else) and
// verifying manifestBytes still hashes to plan.ManifestDigest (the manifest changed since
// planning is rejected the same way). It then re-observes, for every operation, whether
// ExpectedCurrentState still holds — a concurrent modification between plan and apply stops
// before that operation's mutation, never recomputing a new expectation on the fly. Operations
// are applied in the given order; on the first failure, Apply stops and returns the error together
// with an ApplyResult describing every operation completed before the failure (partial success is
// reported, never hidden), and the ownership ledger on disk reflects exactly the operations that
// completed — never a discarded write.
func Apply(ctx context.Context, plan Plan, manifestBytes []byte, ledger OwnershipLedger, dataRoot string, options ApplyOptions) (ApplyResult, error) {
	result := ApplyResult{}
	if ComputePlanDigest(plan) != plan.Digest {
		return result, errors.New("plan digest does not match plan contents")
	}
	manifestSum := sha256.Sum256(manifestBytes)
	if hex.EncodeToString(manifestSum[:]) != plan.ManifestDigest {
		return result, errors.New("manifest changed since the plan was built")
	}
	if plan.DataRoot != dataRoot {
		return result, errors.New("plan data root does not match the apply data root")
	}
	for _, operation := range plan.Operations {
		if _, err := resolveTargetWithinRoot(operation.TargetPath, dataRoot); err != nil {
			return result, fmt.Errorf("adapter %s target path is not safely installable: %w", operation.AdapterID, err)
		}
		observed := observeCurrentState(operation.TargetPath, ledger)
		if observed != operation.ExpectedCurrentState {
			return result, fmt.Errorf("adapter %s target %s changed state since planning (expected %s, observed %s)", operation.AdapterID, operation.TargetPath, operation.ExpectedCurrentState, observed)
		}
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

// installArchive downloads and verifies the pinned archive, extracts exactly the declared
// executable entry into a staging directory under dataRoot, and renames it into place. Staging
// stays under the owned data-root prefix (never the system temporary directory) so a failed run
// leaves nothing to reason about anywhere else on the machine.
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
	stagedPath := filepath.Join(stagingDirectory, "extracted")
	contentSHA256, sizeBytes, err := extractArchiveEntry(archivePath, operation.Source.ExecutablePath, stagedPath, isZip)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s archive extraction failed: %w", operation.AdapterID, err)
	}
	return placeInstalledFile(stagedPath, operation, contentSHA256, sizeBytes)
}

// installManualArtifact accepts the operator-placed artifact only after verifying the checksum
// the operator asserted out-of-band, then installs it by copy exactly like an archive extract.
// Failures here name only the adapter ID: the operator's source path is not this tool's to
// publish into logs or errors.
func installManualArtifact(operation Operation, dataRoot string, options ApplyOptions) (OwnershipRecord, error) {
	source, hasSource := options.ManualArtifactSources[operation.AdapterID]
	assertedChecksum, hasChecksum := options.ManualChecksums[operation.AdapterID]
	if !hasSource || source == "" || !hasChecksum || assertedChecksum == "" {
		return OwnershipRecord{}, fmt.Errorf("adapter %s requires both a manual artifact source and a manual checksum", operation.AdapterID)
	}
	if err := VerifyFileChecksum(source, assertedChecksum); err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s manual artifact failed checksum verification", operation.AdapterID)
	}
	stagingDirectory, err := os.MkdirTemp(dataRoot, "setup-staging-*")
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("create staging directory under %s: %w", dataRoot, err)
	}
	defer os.RemoveAll(stagingDirectory)
	stagedPath := filepath.Join(stagingDirectory, "artifact")
	contentSHA256, sizeBytes, err := copyFileHashed(source, stagedPath)
	if err != nil {
		return OwnershipRecord{}, fmt.Errorf("adapter %s manual artifact could not be staged", operation.AdapterID)
	}
	return placeInstalledFile(stagedPath, operation, contentSHA256, sizeBytes)
}

// placeInstalledFile moves a staged, fully verified file onto its target with a same-filesystem
// atomic rename (the staging directory already lives under dataRoot) and stamps the ownership
// record. InstalledAt is written once here and never recomputed.
func placeInstalledFile(stagedPath string, operation Operation, contentSHA256 string, sizeBytes int64) (OwnershipRecord, error) {
	if err := os.MkdirAll(filepath.Dir(operation.TargetPath), 0o755); err != nil {
		return OwnershipRecord{}, fmt.Errorf("create target directory under %s: %w", filepath.Dir(operation.TargetPath), err)
	}
	if err := os.Rename(stagedPath, operation.TargetPath); err != nil {
		return OwnershipRecord{}, fmt.Errorf("move adapter %s artifact into place at %s: %w", operation.AdapterID, operation.TargetPath, err)
	}
	return OwnershipRecord{
		Path:           operation.TargetPath,
		AdapterID:      operation.AdapterID,
		AdapterVersion: operation.AdapterVersion,
		ContentSHA256:  contentSHA256,
		SizeBytes:      sizeBytes,
		InstalledAt:    time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

// extractArchiveEntry pulls only the single declared entry out of a .tar.gz or .zip archive,
// writing it to destinationPath and returning its digest and size. Archive bytes are untrusted no
// matter what the manifest promised about them, so the matched entry name is re-checked against
// the same no-absolute/no-traversal grammar the manifest enforces before a single byte is
// written. There is no separate "inner checksum" in the manifest to compare against; the digest
// of what was actually extracted is computed and recorded so the ownership ledger always reflects
// installed bytes, not promised ones.
func extractArchiveEntry(archivePath string, executablePath string, destinationPath string, isZip bool) (string, int64, error) {
	if err := validateArchiveEntryName(executablePath); err != nil {
		return "", 0, err
	}
	if isZip {
		return extractZipEntry(archivePath, executablePath, destinationPath)
	}
	return extractTarGzipEntry(archivePath, executablePath, destinationPath)
}

func extractTarGzipEntry(archivePath string, executablePath string, destinationPath string) (string, int64, error) {
	archiveFile, err := os.Open(archivePath)
	if err != nil {
		return "", 0, fmt.Errorf("open downloaded archive: %w", err)
	}
	defer archiveFile.Close()
	gzipReader, err := gzip.NewReader(archiveFile)
	if err != nil {
		return "", 0, fmt.Errorf("open gzip stream: %w", err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return "", 0, errors.New("archive does not contain the declared executable entry")
		}
		if err != nil {
			return "", 0, fmt.Errorf("read archive entry: %w", err)
		}
		if header.Typeflag != tar.TypeReg || path.Clean(header.Name) != path.Clean(executablePath) {
			continue
		}
		if err := validateArchiveEntryName(header.Name); err != nil {
			return "", 0, err
		}
		return writeExtractedEntry(reader, destinationPath)
	}
}

func extractZipEntry(archivePath string, executablePath string, destinationPath string) (string, int64, error) {
	zipReader, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", 0, fmt.Errorf("open zip archive: %w", err)
	}
	defer zipReader.Close()
	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() || path.Clean(file.Name) != path.Clean(executablePath) {
			continue
		}
		if err := validateArchiveEntryName(file.Name); err != nil {
			return "", 0, err
		}
		opened, err := file.Open()
		if err != nil {
			return "", 0, fmt.Errorf("open zip entry: %w", err)
		}
		contentSHA256, sizeBytes, writeErr := writeExtractedEntry(opened, destinationPath)
		opened.Close()
		return contentSHA256, sizeBytes, writeErr
	}
	return "", 0, errors.New("archive does not contain the declared executable entry")
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

// writeExtractedEntry streams one archive entry into destinationPath, hashing while copying, and
// marks the result executable (non-Windows only; Windows permissions carry over from the archive
// entry's own attributes).
func writeExtractedEntry(reader io.Reader, destinationPath string) (string, int64, error) {
	destination, err := os.Create(destinationPath)
	if err != nil {
		return "", 0, fmt.Errorf("create extracted file: %w", err)
	}
	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(destination, digest), reader)
	if err != nil {
		destination.Close()
		os.Remove(destinationPath)
		return "", 0, fmt.Errorf("write extracted file: %w", err)
	}
	if err := destination.Sync(); err != nil {
		destination.Close()
		os.Remove(destinationPath)
		return "", 0, fmt.Errorf("sync extracted file: %w", err)
	}
	if err := destination.Close(); err != nil {
		os.Remove(destinationPath)
		return "", 0, fmt.Errorf("close extracted file: %w", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(destinationPath, 0o755); err != nil {
			os.Remove(destinationPath)
			return "", 0, fmt.Errorf("mark extracted file executable: %w", err)
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), written, nil
}

func copyFileHashed(sourcePath string, destinationPath string) (string, int64, error) {
	source, err := os.Open(sourcePath)
	if err != nil {
		return "", 0, err
	}
	defer source.Close()
	return writeExtractedEntry(source, destinationPath)
}

// resolveTargetWithinRoot enforces the applier's core containment rule for a planned target path:
// after resolving symlinks in every ancestor directory that already exists, the target must land
// inside dataRoot, and a symlink sitting at the exact target path is always refused — never
// followed, never overwritten. dataRoot itself is resolved the same way so a symlinked data root
// cannot be used to pivot the comparison.
func resolveTargetWithinRoot(targetPath string, dataRoot string) (string, error) {
	if !filepath.IsAbs(targetPath) {
		return "", errors.New("target path is not absolute")
	}
	if information, err := os.Lstat(targetPath); err == nil {
		if information.Mode()&fs.ModeSymlink != 0 {
			return "", errors.New("target path is a symlink")
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("target path could not be inspected: %w", err)
	}
	resolvedRoot, err := resolveExistingAncestors(dataRoot)
	if err != nil {
		return "", err
	}
	resolvedTarget, err := resolveExistingAncestors(targetPath)
	if err != nil {
		return "", err
	}
	if resolvedTarget != resolvedRoot && !strings.HasPrefix(resolvedTarget, resolvedRoot+string(filepath.Separator)) {
		return "", errors.New("target path escapes the data root")
	}
	return resolvedTarget, nil
}

// resolveExistingAncestors calls filepath.EvalSymlinks on the deepest ancestor of targetPath that
// already exists and rejoins the not-yet-existing remainder, so containment can be judged on the
// path as it will exist after apply creates the missing final directories. When no ancestor
// exists at all the lexical path is returned unchanged; the prefix check still applies lexically.
func resolveExistingAncestors(targetPath string) (string, error) {
	cleaned := filepath.Clean(targetPath)
	existing := cleaned
	var remainder []string
	for {
		resolved, err := filepath.EvalSymlinks(existing)
		if err == nil {
			return filepath.Join(append([]string{resolved}, remainder...)...), nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("resolve path under %s: %w", existing, err)
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return cleaned, nil
		}
		remainder = append([]string{filepath.Base(existing)}, remainder...)
		existing = parent
	}
}
