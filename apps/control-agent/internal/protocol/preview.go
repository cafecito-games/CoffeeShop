package protocol

import (
	"errors"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	PreviewBundleArtifactKind = "preview-bundle"
	PreviewBundleMediaType    = "application/vnd.coffee-shop.preview-bundle+tar+gzip"
)

// PreviewBundleContractValue is the typed Go mirror of previewBundleContract. The producer-owned
// fixture in packages/protocol/test/fixtures/preview-v1 keeps every value in byte-independent
// parity with TypeScript; Barista never silently supplies a second set of limits.
type PreviewBundleContractValue struct {
	SchemaVersion          int      `json:"schemaVersion"`
	ArtifactKind           string   `json:"artifactKind"`
	MediaType              string   `json:"mediaType"`
	AllowedEntryTypes      []string `json:"allowedEntryTypes"`
	MaximumCompressedBytes int64    `json:"maximumCompressedBytes"`
	MaximumExpandedBytes   int64    `json:"maximumExpandedBytes"`
	MaximumRegularFiles    int      `json:"maximumRegularFiles"`
	MaximumFileBytes       int64    `json:"maximumFileBytes"`
	MaximumPathBytes       int      `json:"maximumPathBytes"`
	MaximumExpansionRatio  int64    `json:"maximumExpansionRatio"`
	MinimumTTLSeconds      int64    `json:"minimumTtlSeconds"`
	DefaultTTLSeconds      int64    `json:"defaultTtlSeconds"`
	MaximumLifetimeSeconds int64    `json:"maximumLifetimeSeconds"`
}

var PreviewBundleContract = PreviewBundleContractValue{
	SchemaVersion:          1,
	ArtifactKind:           PreviewBundleArtifactKind,
	MediaType:              PreviewBundleMediaType,
	AllowedEntryTypes:      []string{"regular-file", "directory"},
	MaximumCompressedBytes: 10 * 1024 * 1024,
	MaximumExpandedBytes:   100 * 1024 * 1024,
	MaximumRegularFiles:    2_000,
	MaximumFileBytes:       10 * 1024 * 1024,
	MaximumPathBytes:       1_024,
	MaximumExpansionRatio:  20,
	MinimumTTLSeconds:      5 * 60,
	DefaultTTLSeconds:      24 * 60 * 60,
	MaximumLifetimeSeconds: 7 * 24 * 60 * 60,
}

var ArtifactPreviewStatuses = []string{"upload-pending", "processing", "ready", "failed", "expired"}

var ArtifactPreviewFailureCodes = []string{
	"upload-failed",
	"bundle-invalid",
	"path-invalid",
	"entrypoint-invalid",
	"limit-exceeded",
	"storage-conflict",
	"processing-cancelled",
	"processing-failed",
}

var ArtifactPreviewAccessStates = []string{"eligible", "unavailable"}

func IsArtifactPreviewStatus(value string) bool {
	return slices.Contains(ArtifactPreviewStatuses, value)
}

func IsArtifactPreviewFailureCode(value string) bool {
	return slices.Contains(ArtifactPreviewFailureCodes, value)
}

func IsArtifactPreviewAccessState(value string) bool {
	return slices.Contains(ArtifactPreviewAccessStates, value)
}

// ValidatePreviewBundlePath mirrors validatePreviewBundlePath without rewriting ambiguous input.
func ValidatePreviewBundlePath(value string, entrypoint bool) error {
	if value == "" {
		return errors.New("preview path must be a non-empty string")
	}
	if !utf8.ValidString(value) {
		return errors.New("preview path must use valid UTF-8")
	}
	if !norm.NFC.IsNormalString(value) {
		return errors.New("preview path must use NFC normalization")
	}
	if strings.HasPrefix(value, "/") || isWindowsSlashAbsolute(value) {
		return errors.New("preview path must be relative")
	}
	if strings.Contains(value, `\`) || strings.ContainsFunc(value, unicode.IsControl) {
		return errors.New("preview path contains an unsupported character")
	}
	if len(value) > PreviewBundleContract.MaximumPathBytes {
		return errors.New("preview path exceeds its byte limit")
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return errors.New("preview path contains an empty or traversal segment")
		}
	}
	if entrypoint && !strings.HasSuffix(value, ".html") {
		return errors.New("preview entrypoint must end in .html")
	}
	return nil
}

func isWindowsSlashAbsolute(value string) bool {
	if len(value) < 3 || value[1] != ':' || value[2] != '/' {
		return false
	}
	return value[0] >= 'A' && value[0] <= 'Z' || value[0] >= 'a' && value[0] <= 'z'
}

// PreviewBundlePathCollisionKey applies only the shared ASCII fold. Unicode case mapping is
// intentionally absent because locale-sensitive or full-Unicode folding would reject a different
// vocabulary of paths than ingestion.
func PreviewBundlePathCollisionKey(value string) string {
	return strings.Map(func(character rune) rune {
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		return character
	}, value)
}

// PreviewArtifact and ArtifactPreview are the authority-bearing records returned by the Hub's
// dedicated preview registration service. Barista validates an untrusted wire response into these
// structs before it exposes any field or follows the upload path.
type PreviewArtifact struct {
	ID             string `json:"id"`
	ThreadID       string `json:"threadId"`
	RunID          string `json:"runId"`
	AgentID        string `json:"agentId,omitempty"`
	InstanceID     string `json:"instanceId,omitempty"`
	AllocationID   string `json:"allocationId,omitempty"`
	RelativePath   string `json:"relativePath"`
	Title          string `json:"title"`
	Kind           string `json:"kind"`
	MediaType      string `json:"mediaType"`
	Summary        string `json:"summary"`
	Size           int64  `json:"size"`
	SHA256         string `json:"sha256"`
	DownloadPath   string `json:"downloadPath"`
	Uploaded       bool   `json:"uploaded"`
	IdempotencyKey string `json:"idempotencyKey"`
	CreatedAt      string `json:"createdAt"`
}

type ArtifactPreview struct {
	ID                   string `json:"id"`
	ArtifactID           string `json:"artifactId"`
	ArtifactSHA256       string `json:"artifactSha256"`
	ThreadID             string `json:"threadId"`
	RunID                string `json:"runId"`
	AgentID              string `json:"agentId,omitempty"`
	InstanceID           string `json:"instanceId,omitempty"`
	AllocationID         string `json:"allocationId,omitempty"`
	Entrypoint           string `json:"entrypoint"`
	Status               string `json:"status"`
	ProcessingGeneration int64  `json:"processingGeneration"`
	CreatedAt            string `json:"createdAt"`
	UpdatedAt            string `json:"updatedAt"`
	ExpiresAt            string `json:"expiresAt"`
	ReadyAt              string `json:"readyAt,omitempty"`
	FailedAt             string `json:"failedAt,omitempty"`
	FailureCode          string `json:"failureCode,omitempty"`
	ExpiredAt            string `json:"expiredAt,omitempty"`
	AccessState          string `json:"accessState"`
}

type PreviewPublicationResult struct {
	Artifact PreviewArtifact `json:"artifact"`
	Preview  ArtifactPreview `json:"preview"`
	Created  bool            `json:"created"`
}
