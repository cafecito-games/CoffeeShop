package protocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPreviewBundleContractMatchesProducerFixture(t *testing.T) {
	// Produced from packages/protocol/src/index.ts by
	// packages/protocol/test/preview-contract-fixture-producer.mjs:4-10.
	data, err := os.ReadFile("../../../../packages/protocol/test/fixtures/preview-v1/limits.json")
	require.NoError(t, err)
	var fixture PreviewBundleContractValue
	require.NoError(t, json.Unmarshal(data, &fixture))
	require.Equal(t, PreviewBundleContract, fixture)
	require.Equal(t, []string{"regular-file", "directory"}, PreviewBundleContract.AllowedEntryTypes)
	require.Equal(t, "preview-bundle", PreviewBundleArtifactKind)
	require.Equal(t, "application/vnd.coffee-shop.preview-bundle+tar+gzip", PreviewBundleMediaType)
}

func TestValidatePreviewBundlePathMatchesSharedBoundaryAndCollisionRules(t *testing.T) {
	for _, path := range []string{"index.html", "assets/app.js", "caf\u00e9/index.html", strings.Repeat("x", 1024)} {
		require.NoError(t, ValidatePreviewBundlePath(path, false), path)
	}
	require.NoError(t, ValidatePreviewBundlePath("nested/index.html", true))
	for _, path := range []string{
		"", "/index.html", "C:/index.html", "./index.html", "../index.html", "a/../index.html",
		"a//index.html", `a\index.html`, "a\x00/index.html", "a\u0085/index.html",
		"cafe\u0301/index.html", strings.Repeat("x", 1025),
	} {
		require.Error(t, ValidatePreviewBundlePath(path, false), path)
	}
	for _, path := range []string{"index.htm", "index.HTML", "directory", "site/app.js"} {
		require.Error(t, ValidatePreviewBundlePath(path, true), path)
	}
	require.Equal(t, PreviewBundlePathCollisionKey("assets/App.js"), PreviewBundlePathCollisionKey("ASSETS/app.js"))
	require.Equal(t, "assets/caf\u00c9.html", PreviewBundlePathCollisionKey("Assets/CAF\u00c9.HTML"))
}

func TestPreviewLifecycleVocabulariesAreClosed(t *testing.T) {
	require.Equal(t, []string{"upload-pending", "processing", "ready", "failed", "expired"}, ArtifactPreviewStatuses)
	require.Equal(t, []string{"eligible", "unavailable"}, ArtifactPreviewAccessStates)
	require.Equal(t, []string{
		"upload-failed", "bundle-invalid", "path-invalid", "entrypoint-invalid", "limit-exceeded",
		"storage-conflict", "processing-cancelled", "processing-failed",
	}, ArtifactPreviewFailureCodes)
	for _, status := range ArtifactPreviewStatuses {
		require.True(t, IsArtifactPreviewStatus(status), status)
	}
	require.False(t, IsArtifactPreviewStatus("published"))
}
