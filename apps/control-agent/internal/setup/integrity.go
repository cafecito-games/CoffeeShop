package setup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
)

// MaximumDownloadBytes bounds any single adapter artifact download. Chosen generously for real
// adapter archives while still bounding memory/disk use from a compromised or misconfigured
// manifest.
const MaximumDownloadBytes = 512 * 1024 * 1024

// DownloadOptions fully describes one bounded, verified HTTPS download.
type DownloadOptions struct {
	URL            string
	ExpectedSHA256 string
	MaximumBytes   int64 // 0 means MaximumDownloadBytes
	AllowedHosts   []string
}

// DownloadVerified fetches options.URL into a new temporary file inside destinationDirectory,
// verifies its SHA-256 and size against options before returning, and returns the temporary
// file's path. The caller is responsible for atomically renaming it into place and for removing
// it on any subsequent failure. On any integrity, size, scheme, or host mismatch, the temporary
// file is deleted before returning the error — nothing partially verified is ever left behind.
func DownloadVerified(ctx context.Context, client *http.Client, destinationDirectory string, options DownloadOptions) (string, error) {
	if client == nil {
		return "", errors.New("download requires an explicit http client")
	}
	parsedURL, err := url.Parse(options.URL)
	if err != nil || parsedURL.Scheme != "https" {
		return "", errors.New("download url must use https")
	}
	maximumBytes := options.MaximumBytes
	if maximumBytes <= 0 {
		maximumBytes = MaximumDownloadBytes
	}
	// The caller's client is cloned rather than mutated; only the redirect policy is overridden so
	// a redirect can never carry the download to a host the operator did not allow. An empty
	// allowlist rejects every redirect — fail closed by default.
	verifiedClient := *client
	verifiedClient.CheckRedirect = func(request *http.Request, _ []*http.Request) error {
		if !slices.Contains(options.AllowedHosts, request.URL.Hostname()) {
			return errors.New("redirect to a host outside the allowlist was refused")
		}
		return nil
	}
	temporaryFile, err := os.CreateTemp(destinationDirectory, "setup-download-*")
	if err != nil {
		return "", fmt.Errorf("create download temporary file: %w", err)
	}
	temporaryPath := temporaryFile.Name()
	// fail closes and removes the temporary file so no partially verified bytes survive any
	// rejection path. The error is deliberately not wrapped with the underlying request failure,
	// because net/http embeds the full request URL — query string included — into it.
	fail := func(err error) (string, error) {
		temporaryFile.Close()
		os.Remove(temporaryPath)
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, options.URL, nil)
	if err != nil {
		return fail(errors.New("download request could not be built"))
	}
	response, err := verifiedClient.Do(request)
	if err != nil {
		return fail(errors.New("download request failed"))
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fail(fmt.Errorf("download returned status %d", response.StatusCode))
	}
	digest := sha256.New()
	written, err := io.Copy(temporaryFile, io.TeeReader(io.LimitReader(response.Body, maximumBytes+1), digest))
	if err != nil {
		return fail(errors.New("download body could not be read"))
	}
	if written > maximumBytes {
		return fail(fmt.Errorf("download exceeded its bound of %d bytes", maximumBytes))
	}
	if err := temporaryFile.Sync(); err != nil {
		return fail(fmt.Errorf("sync download temporary file: %w", err))
	}
	if err := temporaryFile.Close(); err != nil {
		return fail(fmt.Errorf("close download temporary file: %w", err))
	}
	actualSHA256 := hex.EncodeToString(digest.Sum(nil))
	if !strings.EqualFold(actualSHA256, options.ExpectedSHA256) {
		return fail(fmt.Errorf("download checksum mismatch: expected %s, got %s", strings.ToLower(options.ExpectedSHA256), actualSHA256))
	}
	return temporaryPath, nil
}

// VerifyFileChecksum reports whether the file at path has the given lowercase-hex SHA-256 digest.
func VerifyFileChecksum(path string, expectedSHA256 string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open artifact for checksum verification: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return fmt.Errorf("read artifact for checksum verification: %w", err)
	}
	actualSHA256 := hex.EncodeToString(digest.Sum(nil))
	if !strings.EqualFold(actualSHA256, expectedSHA256) {
		return fmt.Errorf("artifact checksum mismatch: expected %s, got %s", strings.ToLower(expectedSHA256), actualSHA256)
	}
	return nil
}
