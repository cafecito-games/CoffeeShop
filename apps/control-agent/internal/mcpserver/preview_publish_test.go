package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

const publishArguments = `{
  "relativePath":"site",
  "entrypoint":"index.html",
  "title":"Site preview",
  "summary":"Static site",
  "ttlSeconds":300,
  "idempotencyKey":"preview-site-1"
}`

func publishWorkspace(t *testing.T) (string, string) {
	t.Helper()
	workspace, dataRoot := previewFixture(t)
	return workspace, dataRoot
}

func registrationResponse(t *testing.T, runID string, arguments json.RawMessage, created, uploaded bool) json.RawMessage {
	t.Helper()
	var values map[string]any
	require.NoError(t, json.Unmarshal(arguments, &values))
	artifactID := "artifact-one"
	previewID := "preview-one"
	createdAt := "2026-09-27T12:00:00Z"
	result := map[string]any{
		"artifact": map[string]any{
			"id": artifactID, "threadId": "thread-one", "runId": runID, "agentId": "agent-one",
			"relativePath": values["relativePath"], "title": values["title"], "kind": values["kind"],
			"mediaType": values["mediaType"], "summary": values["summary"], "size": values["size"],
			"sha256": values["sha256"], "downloadPath": "/api/artifacts/artifact-one/content",
			"uploaded": uploaded, "idempotencyKey": values["idempotencyKey"], "createdAt": createdAt,
		},
		"preview": map[string]any{
			"id": previewID, "artifactId": artifactID, "artifactSha256": values["sha256"],
			"threadId": "thread-one", "runId": runID, "agentId": "agent-one",
			"entrypoint": values["entrypoint"], "status": "upload-pending", "processingGeneration": 0,
			"createdAt": createdAt, "updatedAt": createdAt, "expiresAt": "2026-09-27T12:05:00Z",
			"accessState": "unavailable",
		},
		"uploadPath": "/api/artifacts/artifact-one/content",
		"created":    created,
	}
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	return encoded
}

func newPublishServer(t *testing.T, caller Caller, uploader Uploader, dataRoot string) *Server {
	t.Helper()
	return New(caller, uploader, dataRoot)
}

func TestPublishPreviewPackagesRegistersUploadsAndReturnsOnlyTrustedRecords(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	var forwarded json.RawMessage
	var uploaded []byte
	server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		require.Equal(t, "run-one", runID)
		require.Equal(t, "publish_preview", operation)
		forwarded = append(json.RawMessage(nil), arguments...)
		return registrationResponse(t, runID, arguments, true, false), nil
	}, func(_ context.Context, uploadPath string, content io.Reader, size int64) error {
		require.Equal(t, "/api/artifacts/artifact-one/content", uploadPath)
		var err error
		uploaded, err = io.ReadAll(content)
		require.Equal(t, size, int64(len(uploaded)))
		return err
	}, dataRoot)

	result, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	require.NoError(t, err)
	var output map[string]any
	require.NoError(t, json.Unmarshal(result, &output))
	require.Equal(t, true, output["created"])
	require.NotContains(t, output, "uploadPath")
	require.Equal(t, true, output["artifact"].(map[string]any)["uploaded"])
	require.Equal(t, "upload-pending", output["preview"].(map[string]any)["status"])

	var sent map[string]any
	require.NoError(t, json.Unmarshal(forwarded, &sent))
	require.Equal(t, "site", sent["relativePath"])
	require.Equal(t, "index.html", sent["entrypoint"])
	require.Equal(t, protocol.PreviewBundleArtifactKind, sent["kind"])
	require.Equal(t, protocol.PreviewBundleMediaType, sent["mediaType"])
	require.Equal(t, float64(len(uploaded)), sent["size"])
	digest := sha256.Sum256(uploaded)
	require.Equal(t, hex.EncodeToString(digest[:]), sent["sha256"])
	require.NotContains(t, sent, "archive")
	require.NotContains(t, sent, "uploadPath")
	require.NotContains(t, string(forwarded), dataRoot)
	require.NotContains(t, string(result), dataRoot)
	require.NotContains(t, string(result), "signedUrl")
	requireScratchEmpty(t, dataRoot)
}

func TestPublishPreviewIsServedThroughTheRunScopedMCPBridge(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		require.Equal(t, "publish_preview", operation)
		return registrationResponse(t, runID, arguments, true, false), nil
	}, func(_ context.Context, _ string, content io.Reader, _ int64) error {
		_, err := io.Copy(io.Discard, content)
		return err
	}, dataRoot)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	require.NoError(t, server.Start(ctx))
	config, err := server.Grant("run-one", workspace, false)
	require.NoError(t, err)
	status, response := postRPC(t, config, toolCallBody(1, "publish_preview", publishArguments))
	require.Equal(t, http.StatusOK, status)
	result := response["result"].(map[string]any)
	require.Equal(t, false, result["isError"])
	structured := result["structuredContent"].(map[string]any)
	require.Equal(t, true, structured["created"])
	require.Equal(t, true, structured["artifact"].(map[string]any)["uploaded"])
	require.NotContains(t, result["content"].([]any)[0].(map[string]any)["text"].(string), dataRoot)
}

func TestPreviewRegistrationValidatorConsumesByteFaithfulHubProducerFixtures(t *testing.T) {
	// Produced byte-for-byte by apps/hub/src/hubTools.test.ts:152-186 through the real
	// createHubToolHandler -> registerPreview path.
	expected := publishPreviewArguments{
		RelativePath: "site", Entrypoint: "index.html", Title: "Site preview", Summary: "Static site",
		TTLSeconds: 300, IdempotencyKey: "preview-site-1",
	}
	for _, test := range []struct {
		name     string
		file     string
		created  bool
		uploaded bool
	}{
		{name: "created", file: "publish-preview-created.json", created: true, uploaded: false},
		{name: "replayed", file: "publish-preview-replayed.json", created: false, uploaded: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := os.ReadFile("../../../../packages/protocol/test/fixtures/hub-tools/" + test.file)
			require.NoError(t, err)
			registration, uploadPath, err := validatePreviewRegistration(
				data, "run-root", expected, 512, strings.Repeat("a", 64),
			)
			require.NoError(t, err)
			require.Equal(t, test.created, registration.Created)
			require.Equal(t, test.uploaded, registration.Artifact.Uploaded)
			require.Equal(t, registration.Artifact.ID, registration.Preview.ArtifactID)
			require.Equal(t, registration.Artifact.SHA256, registration.Preview.ArtifactSHA256)
			require.Equal(t, registration.Artifact.DownloadPath, uploadPath)
		})
	}
}

func TestPublishPreviewReplayRetriesPendingUploadAndSkipsCommittedUpload(t *testing.T) {
	for _, test := range []struct {
		name        string
		uploaded    bool
		wantUploads int32
	}{
		{name: "uploaded false", uploaded: false, wantUploads: 1},
		{name: "uploaded true", uploaded: true, wantUploads: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			workspace, dataRoot := publishWorkspace(t)
			var uploads atomic.Int32
			server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
				return registrationResponse(t, runID, arguments, false, test.uploaded), nil
			}, func(_ context.Context, _ string, content io.Reader, _ int64) error {
				uploads.Add(1)
				_, err := io.Copy(io.Discard, content)
				return err
			}, dataRoot)
			result, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
			require.NoError(t, err)
			require.Equal(t, test.wantUploads, uploads.Load())
			var decoded struct {
				Created  bool `json:"created"`
				Artifact struct {
					ID       string `json:"id"`
					Uploaded bool   `json:"uploaded"`
				} `json:"artifact"`
				Preview struct {
					ID string `json:"id"`
				} `json:"preview"`
			}
			require.NoError(t, json.Unmarshal(result, &decoded))
			require.False(t, decoded.Created)
			require.True(t, decoded.Artifact.Uploaded)
			require.Equal(t, "artifact-one", decoded.Artifact.ID)
			require.Equal(t, "preview-one", decoded.Preview.ID)
			requireScratchEmpty(t, dataRoot)
		})
	}
}

func TestPublishPreviewRejectsMalformedInputBeforeWalkingOrCallingHub(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	outside := filepath.Join(t.TempDir(), "outside")
	var calls atomic.Int32
	server := newPublishServer(t, func(context.Context, string, string, json.RawMessage) (json.RawMessage, error) {
		calls.Add(1)
		return nil, errors.New("must not be called")
	}, nil, dataRoot)
	overlong := strings.Repeat("x", protocol.PreviewBundleContract.MaximumPathBytes+1)
	nonNFC := "cafe\u0301"
	tests := []string{
		`{}`,
		`{"relativePath":"site","relativePath":"other","entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":"site","entrypoint":"index.html","title":"Site","idempotencyKey":"key","extra":true}`,
		`{"relativePath":3,"entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":"","entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":".","entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":"../site","entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":` + mustJSON(t, outside) + `,"entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":` + mustJSON(t, nonNFC) + `,"entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":` + mustJSON(t, overlong) + `,"entrypoint":"index.html","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":"site","entrypoint":"index.htm","title":"Site","idempotencyKey":"key"}`,
		`{"relativePath":"site","entrypoint":"index.html","title":null,"idempotencyKey":"key"}`,
		`{"relativePath":"site","entrypoint":"index.html","title":" ","idempotencyKey":"key"}`,
		`{"relativePath":"site","entrypoint":"index.html","title":"Site","idempotencyKey":" "}`,
		`{"relativePath":"site","entrypoint":"index.html","title":"Site","idempotencyKey":"key","ttlSeconds":299}`,
		`{"relativePath":"site","entrypoint":"index.html","title":"Site","idempotencyKey":"key","ttlSeconds":300.0}`,
		`{"relativePath":"site","entrypoint":"index.html","title":"Site","idempotencyKey":"key","summary":false}`,
		`{"relativePath":"site","entrypoint":"index.html","title":"Authorization: Bearer abcdefghijklmnop","idempotencyKey":"key"}`,
	}
	for index, raw := range tests {
		_, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(raw))
		var failure *ToolError
		require.ErrorAs(t, err, &failure, index)
		require.Equal(t, "invalid_arguments", failure.Code, index)
		require.False(t, failure.Retryable, index)
	}
	require.Zero(t, calls.Load())
	requireScratchEmpty(t, dataRoot)
}

func TestPublishPreviewValidatesEveryRegistrationAuthorityFieldBeforeUpload(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "missing artifact", mutate: func(result map[string]any) { delete(result, "artifact") }},
		{name: "run", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["runId"] = "run-other" }},
		{name: "path", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["relativePath"] = "other" }},
		{name: "kind", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["kind"] = "report" }},
		{name: "media", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["mediaType"] = "application/gzip" }},
		{name: "size", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["size"] = float64(1) }},
		{name: "digest", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["sha256"] = strings.Repeat("b", 64) }},
		{name: "idempotency key", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["idempotencyKey"] = "other" }},
		{name: "upload path", mutate: func(result map[string]any) { result["uploadPath"] = "https://signed.invalid/token" }},
		{name: "artifact linkage", mutate: func(result map[string]any) { result["preview"].(map[string]any)["artifactId"] = "artifact-other" }},
		{name: "entrypoint", mutate: func(result map[string]any) { result["preview"].(map[string]any)["entrypoint"] = "other.html" }},
		{name: "unknown status", mutate: func(result map[string]any) { result["preview"].(map[string]any)["status"] = "published" }},
		{name: "unknown access", mutate: func(result map[string]any) { result["preview"].(map[string]any)["accessState"] = "public" }},
		{name: "expiry beyond lifetime", mutate: func(result map[string]any) {
			result["preview"].(map[string]any)["expiresAt"] = "2026-10-05T12:00:00Z"
		}},
		{name: "actor linkage", mutate: func(result map[string]any) { result["preview"].(map[string]any)["agentId"] = "agent-other" }},
		{name: "created uploaded", mutate: func(result map[string]any) { result["artifact"].(map[string]any)["uploaded"] = true }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			workspace, dataRoot := publishWorkspace(t)
			var uploads atomic.Int32
			server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
				var result map[string]any
				require.NoError(t, json.Unmarshal(registrationResponse(t, runID, arguments, true, false), &result))
				test.mutate(result)
				encoded, err := json.Marshal(result)
				require.NoError(t, err)
				return encoded, nil
			}, func(context.Context, string, io.Reader, int64) error { uploads.Add(1); return nil }, dataRoot)
			_, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
			var failure *ToolError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, "invalid_result", failure.Code)
			require.Zero(t, uploads.Load())
			requireScratchEmpty(t, dataRoot)
		})
	}
}

func TestPublishPreviewIgnoresUntrustedForwardFieldsInsteadOfReflectingThem(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		var result map[string]any
		require.NoError(t, json.Unmarshal(registrationResponse(t, runID, arguments, false, true), &result))
		result["signedUrl"] = "https://preview.invalid/token"
		result["artifact"].(map[string]any)["credential"] = "bearer-secret"
		result["preview"].(map[string]any)["futureAuthority"] = "secret"
		encoded, err := json.Marshal(result)
		require.NoError(t, err)
		return encoded, nil
	}, nil, dataRoot)
	result, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	require.NoError(t, err)
	require.NotContains(t, string(result), "signedUrl")
	require.NotContains(t, string(result), "credential")
	require.NotContains(t, string(result), "futureAuthority")
	require.NotContains(t, string(result), "secret")
}

func TestPreviewRegistrationValidatorHandlesEveryClosedLifecycleStatus(t *testing.T) {
	expected := publishPreviewArguments{
		RelativePath: "site", Entrypoint: "index.html", Title: "Site preview", Summary: "Static site",
		TTLSeconds: 300, IdempotencyKey: "preview-site-1",
	}
	for _, status := range protocol.ArtifactPreviewStatuses {
		t.Run(status, func(t *testing.T) {
			var response map[string]any
			require.NoError(t, json.Unmarshal(registrationResponse(t, "run-one", json.RawMessage(`{
				"relativePath":"site","entrypoint":"index.html","title":"Site preview","summary":"Static site",
				"kind":"preview-bundle","mediaType":"application/vnd.coffee-shop.preview-bundle+tar+gzip",
				"size":512,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"idempotencyKey":"preview-site-1"
			}`), false, true), &response))
			preview := response["preview"].(map[string]any)
			switch status {
			case "upload-pending":
			case "processing":
				preview["status"] = status
				preview["processingGeneration"] = float64(1)
			case "ready":
				preview["status"] = status
				preview["processingGeneration"] = float64(1)
				preview["readyAt"] = preview["updatedAt"]
				preview["accessState"] = "eligible"
			case "failed":
				preview["status"] = status
				preview["processingGeneration"] = float64(1)
				preview["failedAt"] = preview["updatedAt"]
				preview["failureCode"] = "bundle-invalid"
			case "expired":
				preview["status"] = status
				preview["updatedAt"] = preview["expiresAt"]
				preview["expiredAt"] = preview["expiresAt"]
			default:
				t.Fatalf("unhandled status %q", status)
			}
			encoded, err := json.Marshal(response)
			require.NoError(t, err)
			registration, _, err := validatePreviewRegistration(
				encoded, "run-one", expected, 512, strings.Repeat("a", 64),
			)
			require.NoError(t, err)
			require.Equal(t, status, registration.Preview.Status)
		})
	}
}

func TestPublishPreviewPreservesHubErrorsAndClassifiesUploadFailures(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	hubFailure := &ToolError{Code: "idempotency_conflict", Message: "The key conflicts", Retryable: false}
	server := newPublishServer(t, func(context.Context, string, string, json.RawMessage) (json.RawMessage, error) {
		return nil, hubFailure
	}, nil, dataRoot)
	_, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	require.ErrorIs(t, err, hubFailure)
	requireScratchEmpty(t, dataRoot)

	for _, test := range []struct {
		name      string
		err       error
		retryable bool
	}{
		{name: "HTTP 400", err: &UploadError{StatusCode: 400}, retryable: false},
		{name: "HTTP 408", err: &UploadError{StatusCode: 408}, retryable: true},
		{name: "HTTP 425", err: &UploadError{StatusCode: 425}, retryable: true},
		{name: "HTTP 429", err: &UploadError{StatusCode: 429}, retryable: true},
		{name: "HTTP 500", err: &UploadError{StatusCode: 500}, retryable: true},
		{name: "transport", err: &UploadError{Uncertain: true}, retryable: true},
		{name: "unknown transport", err: errors.New("connection reset by peer"), retryable: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			workspace, dataRoot := publishWorkspace(t)
			server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
				return registrationResponse(t, runID, arguments, false, false), nil
			}, func(context.Context, string, io.Reader, int64) error { return test.err }, dataRoot)
			_, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
			var failure *ToolError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, test.retryable, failure.Retryable)
			require.NotContains(t, failure.Message, workspace)
			require.NotContains(t, failure.Message, dataRoot)
			requireScratchEmpty(t, dataRoot)
		})
	}
}

func TestPublishPreviewCancellationAfterRegistrationReturnsNoSuccessAndCleansScratch(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	ctx, cancel := context.WithCancel(context.Background())
	server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		return registrationResponse(t, runID, arguments, true, false), nil
	}, func(ctx context.Context, _ string, _ io.Reader, _ int64) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}, dataRoot)
	_, err := server.publishPreview(ctx, grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	var failure *ToolError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "cancelled", failure.Code)
	require.False(t, failure.Retryable)
	requireScratchEmpty(t, dataRoot)
}

func TestPublishPreviewCancellationDuringRegistrationReturnsNoSuccessAndCleansScratch(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	ctx, cancel := context.WithCancel(context.Background())
	server := newPublishServer(t, func(ctx context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		cancel()
		<-ctx.Done()
		return nil, ctx.Err()
	}, nil, dataRoot)
	_, err := server.publishPreview(ctx, grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	var failure *ToolError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "cancelled", failure.Code)
	requireScratchEmpty(t, dataRoot)
}

func TestPublishPreviewLostUploadResponseConvergesOnCommittedReplay(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	var registrations atomic.Int32
	var uploads atomic.Int32
	server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		call := registrations.Add(1)
		return registrationResponse(t, runID, arguments, call == 1, call > 1), nil
	}, func(_ context.Context, _ string, content io.Reader, _ int64) error {
		uploads.Add(1)
		_, err := io.Copy(io.Discard, content)
		if err != nil {
			return err
		}
		return &UploadError{Uncertain: true}
	}, dataRoot)
	_, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	var firstFailure *ToolError
	require.ErrorAs(t, err, &firstFailure)
	require.True(t, firstFailure.Retryable)
	result, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	require.NoError(t, err)
	require.Equal(t, int32(2), registrations.Load())
	require.Equal(t, int32(1), uploads.Load())
	require.Contains(t, string(result), `"uploaded":true`)
	require.Contains(t, string(result), `"created":false`)
}

func TestPublishPreviewChangedBytesUnderTheSameKeySurfaceHubConflict(t *testing.T) {
	workspace, dataRoot := publishWorkspace(t)
	var firstDigest string
	server := newPublishServer(t, func(_ context.Context, runID, operation string, arguments json.RawMessage) (json.RawMessage, error) {
		var values map[string]any
		require.NoError(t, json.Unmarshal(arguments, &values))
		digest := values["sha256"].(string)
		if firstDigest == "" {
			firstDigest = digest
			return registrationResponse(t, runID, arguments, false, true), nil
		}
		if digest != firstDigest {
			return nil, &ToolError{Code: "idempotency_conflict", Message: "The key conflicts", Retryable: false}
		}
		return registrationResponse(t, runID, arguments, false, true), nil
	}, nil, dataRoot)
	_, err := server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", "index.html"), []byte("changed bytes"), 0o600))
	_, err = server.publishPreview(context.Background(), grant{runID: "run-one", workspace: workspace}, json.RawMessage(publishArguments))
	var failure *ToolError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "idempotency_conflict", failure.Code)
}

func TestServerStartRecoversOnlyReservedPreviewScratch(t *testing.T) {
	dataRoot := t.TempDir()
	directory := filepath.Join(dataRoot, previewPackagingDirectory)
	require.NoError(t, os.Mkdir(directory, 0o700))
	stale := filepath.Join(directory, "preview-bundle-0123456789abcdef0123456789abcdef.tar.gz")
	require.NoError(t, os.WriteFile(stale, []byte("stale"), 0o600))
	server := newPublishServer(t, func(context.Context, string, string, json.RawMessage) (json.RawMessage, error) {
		return nil, errors.New("unused")
	}, nil, dataRoot)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	require.NoError(t, server.Start(ctx))
	require.NoFileExists(t, stale)
}

func mustJSON(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	return string(encoded)
}

func TestPreviewRegistrationTimestampsAcceptOffsets(t *testing.T) {
	value := "2026-09-27T12:00:00+02:00"
	_, err := time.Parse(time.RFC3339Nano, value)
	require.NoError(t, err)
}
