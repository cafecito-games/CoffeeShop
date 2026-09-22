package setup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

const downloadPayload = "known payload bytes for download verification"

func payloadChecksum() string {
	summed := sha256.Sum256([]byte(downloadPayload))
	return hex.EncodeToString(summed[:])
}

// temporaryDirectoryEntries lists every file a download run left behind in directory, so tests can
// assert nothing partially verified survives a rejection.
func temporaryDirectoryEntries(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func TestDownloadVerifiedSuccess(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte(downloadPayload))
	}))
	defer server.Close()
	directory := t.TempDir()
	path, err := DownloadVerified(context.Background(), server.Client(), directory, DownloadOptions{
		URL:            server.URL + "/adapter.tar.gz",
		ExpectedSHA256: payloadChecksum(),
		AllowedHosts:   []string{"127.0.0.1"},
	})
	if err != nil {
		t.Fatalf("DownloadVerified() error = %v", err)
	}
	defer os.Remove(path)
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if string(content) != downloadPayload {
		t.Fatalf("downloaded content = %q, want the served payload", content)
	}
	if filepath.Dir(path) != directory {
		t.Fatalf("downloaded file lives in %s, want %s", filepath.Dir(path), directory)
	}
}

func TestDownloadVerifiedChecksumMismatch(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte(downloadPayload))
	}))
	defer server.Close()
	directory := t.TempDir()
	wrongChecksum := strings.Repeat("0", 64)
	path, err := DownloadVerified(context.Background(), server.Client(), directory, DownloadOptions{
		URL:            server.URL + "/adapter.tar.gz",
		ExpectedSHA256: wrongChecksum,
		AllowedHosts:   []string{"127.0.0.1"},
	})
	if err == nil {
		t.Fatal("DownloadVerified() succeeded with a wrong checksum, want rejection")
	}
	if path != "" {
		t.Fatalf("DownloadVerified() returned path %q alongside an error", path)
	}
	if !strings.Contains(err.Error(), wrongChecksum) || !strings.Contains(err.Error(), payloadChecksum()) {
		t.Fatalf("DownloadVerified() error = %v, want it to name both digests", err)
	}
	if leftover := temporaryDirectoryEntries(t, directory); len(leftover) != 0 {
		t.Fatalf("checksum mismatch left temporary files behind: %v", leftover)
	}
}

func TestDownloadVerifiedOversizedPayload(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte(downloadPayload))
	}))
	defer server.Close()
	directory := t.TempDir()
	path, err := DownloadVerified(context.Background(), server.Client(), directory, DownloadOptions{
		URL:            server.URL + "/adapter.tar.gz",
		ExpectedSHA256: payloadChecksum(),
		MaximumBytes:   4,
		AllowedHosts:   []string{"127.0.0.1"},
	})
	if err == nil {
		t.Fatal("DownloadVerified() succeeded on an oversized payload, want rejection")
	}
	if path != "" {
		t.Fatalf("DownloadVerified() returned path %q alongside an error", path)
	}
	if !strings.Contains(err.Error(), "4") {
		t.Fatalf("DownloadVerified() error = %v, want it to name the byte bound", err)
	}
	if leftover := temporaryDirectoryEntries(t, directory); len(leftover) != 0 {
		t.Fatalf("oversized download left temporary files behind: %v", leftover)
	}
}

func TestDownloadVerifiedRedirectPolicies(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte(downloadPayload))
	}))
	defer target.Close()
	origin := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL+"/adapter.tar.gz", http.StatusFound)
	}))
	defer origin.Close()

	t.Run("redirect to a disallowed host is rejected", func(t *testing.T) {
		directory := t.TempDir()
		path, err := DownloadVerified(context.Background(), origin.Client(), directory, DownloadOptions{
			URL:            origin.URL + "/adapter.tar.gz",
			ExpectedSHA256: payloadChecksum(),
		})
		if err == nil {
			t.Fatal("DownloadVerified() followed a redirect with an empty allowlist, want rejection")
		}
		if path != "" {
			t.Fatalf("DownloadVerified() returned path %q alongside an error", path)
		}
		if leftover := temporaryDirectoryEntries(t, directory); len(leftover) != 0 {
			t.Fatalf("refused redirect left temporary files behind: %v", leftover)
		}
	})

	t.Run("redirect to an allowed host succeeds", func(t *testing.T) {
		directory := t.TempDir()
		path, err := DownloadVerified(context.Background(), origin.Client(), directory, DownloadOptions{
			URL:            origin.URL + "/adapter.tar.gz",
			ExpectedSHA256: payloadChecksum(),
			AllowedHosts:   []string{"127.0.0.1"},
		})
		if err != nil {
			t.Fatalf("DownloadVerified() error = %v", err)
		}
		defer os.Remove(path)
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read downloaded file: %v", err)
		}
		if string(content) != downloadPayload {
			t.Fatalf("downloaded content = %q, want the redirect target's payload", content)
		}
	})
}

// TestDownloadVerifiedRejectsNonHTTPSBeforeRequest asserts the scheme check happens before any
// request is attempted: the plain-HTTP test server counts requests and the test fails if it was
// ever contacted.
func TestDownloadVerifiedRejectsNonHTTPSBeforeRequest(t *testing.T) {
	var requestsSeen atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestsSeen.Add(1)
		writer.Write([]byte(downloadPayload))
	}))
	defer server.Close()
	directory := t.TempDir()
	path, err := DownloadVerified(context.Background(), server.Client(), directory, DownloadOptions{
		URL:            server.URL + "/adapter.tar.gz",
		ExpectedSHA256: payloadChecksum(),
		AllowedHosts:   []string{"127.0.0.1"},
	})
	if err == nil {
		t.Fatal("DownloadVerified() accepted a non-https url, want rejection")
	}
	if path != "" {
		t.Fatalf("DownloadVerified() returned path %q alongside an error", path)
	}
	if requestsSeen.Load() != 0 {
		t.Fatalf("DownloadVerified() contacted the server %d times before rejecting the scheme", requestsSeen.Load())
	}
	if leftover := temporaryDirectoryEntries(t, directory); len(leftover) != 0 {
		t.Fatalf("scheme rejection left temporary files behind: %v", leftover)
	}
}

func TestVerifyFileChecksum(t *testing.T) {
	directory := t.TempDir()
	artifact := filepath.Join(directory, "artifact")
	if err := os.WriteFile(artifact, []byte(downloadPayload), 0o644); err != nil {
		t.Fatalf("write artifact: %v", err)
	}
	if err := VerifyFileChecksum(artifact, payloadChecksum()); err != nil {
		t.Fatalf("VerifyFileChecksum() error = %v", err)
	}
	if err := VerifyFileChecksum(artifact, strings.Repeat("0", 64)); err == nil {
		t.Fatal("VerifyFileChecksum() accepted a wrong digest, want rejection")
	}
	if err := VerifyFileChecksum(filepath.Join(directory, "missing"), payloadChecksum()); err == nil {
		t.Fatal("VerifyFileChecksum() accepted a missing file, want rejection")
	}
}
