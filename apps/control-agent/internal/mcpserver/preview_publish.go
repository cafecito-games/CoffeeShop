package mcpserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// UploadError carries only the transport fact needed to classify a publication retry. It never
// retains an endpoint, response body, credential, or archive byte.
type UploadError struct {
	StatusCode int
	Uncertain  bool
}

func (failure *UploadError) Error() string {
	if failure.Uncertain {
		return "artifact upload outcome is uncertain"
	}
	if failure.StatusCode != 0 {
		return http.StatusText(failure.StatusCode)
	}
	return "artifact upload failed"
}

type publishPreviewArguments struct {
	RelativePath   string
	Entrypoint     string
	Title          string
	Summary        string
	TTLSeconds     int64
	IdempotencyKey string
}

var lowercaseSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (server *Server) publishPreview(
	ctx context.Context,
	activeGrant grant,
	raw json.RawMessage,
) (result json.RawMessage, returnedErr error) {
	arguments, err := parsePublishPreviewArguments(raw)
	if err != nil {
		return nil, err
	}
	bundle, err := buildPreviewArchive(ctx, previewPackageRequest{
		Workspace: activeGrant.workspace, RelativePath: arguments.RelativePath,
		Entrypoint: arguments.Entrypoint, DataRoot: server.dataRoot,
	}, previewPackagerHooks{})
	if err != nil {
		return nil, previewLocalToolError(err)
	}
	defer func() {
		if cleanupErr := bundle.cleanup(); cleanupErr != nil {
			result = nil
			returnedErr = &ToolError{Code: "scratch_unavailable", Message: "Preview packaging scratch could not be cleaned"}
		}
	}()

	requestArguments, err := json.Marshal(map[string]any{
		"relativePath": arguments.RelativePath, "entrypoint": arguments.Entrypoint,
		"title": arguments.Title, "summary": arguments.Summary, "ttlSeconds": arguments.TTLSeconds,
		"idempotencyKey": arguments.IdempotencyKey, "kind": protocol.PreviewBundleArtifactKind,
		"mediaType": protocol.PreviewBundleMediaType, "size": bundle.size, "sha256": bundle.sha256,
	})
	if err != nil {
		return nil, &ToolError{Code: "packaging_failed", Message: "Preview metadata could not be encoded"}
	}
	if err := contextError(ctx); err != nil {
		return nil, previewLocalToolError(err)
	}
	if server.caller == nil {
		return nil, &ToolError{Code: "hub_unavailable", Message: "Preview registration is unavailable", Retryable: true}
	}
	registrationBytes, err := server.caller(ctx, activeGrant.runID, "publish_preview", requestArguments)
	if err != nil {
		var typed *ToolError
		if errors.As(err, &typed) {
			return nil, typed
		}
		return nil, previewLocalToolError(err)
	}
	registration, uploadPath, err := validatePreviewRegistration(
		registrationBytes, activeGrant.runID, arguments, bundle.size, bundle.sha256,
	)
	if err != nil {
		return nil, &ToolError{Code: "invalid_result", Message: "Hub returned an invalid preview registration", Retryable: true}
	}

	if !registration.Artifact.Uploaded {
		if server.uploader == nil {
			return nil, &ToolError{Code: "upload_unavailable", Message: "Preview upload is unavailable"}
		}
		file, err := bundle.open()
		if err != nil {
			return nil, previewLocalToolError(err)
		}
		verifier := &previewUploadVerifier{
			ctx: ctx, reader: file, hash: sha256.New(), expectedSize: bundle.size,
		}
		uploadErr := server.uploader(ctx, uploadPath, verifier, bundle.size)
		closeErr := file.Close()
		if uploadErr != nil {
			return nil, previewUploadToolError(ctx, uploadErr)
		}
		if closeErr != nil || verifier.count != bundle.size || hex.EncodeToString(verifier.hash.Sum(nil)) != bundle.sha256 {
			return nil, &ToolError{Code: "upload_uncertain", Message: "Preview upload completion could not be verified", Retryable: true}
		}
		if err := contextError(ctx); err != nil {
			return nil, previewLocalToolError(err)
		}
		registration.Artifact.Uploaded = true
	}
	encoded, err := json.Marshal(registration)
	if err != nil {
		return nil, &ToolError{Code: "invalid_result", Message: "Preview result could not be encoded", Retryable: true}
	}
	return encoded, nil
}

func parsePublishPreviewArguments(raw json.RawMessage) (publishPreviewArguments, error) {
	object, err := decodeUniquePreviewObject(raw)
	if err != nil {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	allowed := map[string]bool{
		"relativePath": true, "entrypoint": true, "title": true, "summary": true,
		"ttlSeconds": true, "idempotencyKey": true,
	}
	for key := range object {
		if !allowed[key] {
			return publishPreviewArguments{}, invalidPreviewArguments()
		}
	}
	relativePath, ok := requiredPreviewString(object, "relativePath")
	if !ok || protocol.ValidatePreviewBundlePath(relativePath, false) != nil {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	entrypoint, ok := requiredPreviewString(object, "entrypoint")
	if !ok || protocol.ValidatePreviewBundlePath(entrypoint, true) != nil {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	title, ok := requiredPreviewString(object, "title")
	if !ok {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	title = strings.TrimSpace(title)
	if title == "" || utf16Length(title) > 256 {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	idempotencyKey, ok := requiredPreviewString(object, "idempotencyKey")
	if !ok {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if idempotencyKey == "" || utf16Length(idempotencyKey) > 128 {
		return publishPreviewArguments{}, invalidPreviewArguments()
	}
	summary := ""
	if value, present := object["summary"]; present {
		if err := json.Unmarshal(value, &summary); err != nil {
			return publishPreviewArguments{}, invalidPreviewArguments()
		}
		summary = truncateUTF16(strings.TrimSpace(summary), 2_000)
	}
	ttlSeconds := protocol.PreviewBundleContract.DefaultTTLSeconds
	if value, present := object["ttlSeconds"]; present {
		if err := json.Unmarshal(value, &ttlSeconds); err != nil ||
			ttlSeconds < protocol.PreviewBundleContract.MinimumTTLSeconds ||
			ttlSeconds > protocol.PreviewBundleContract.MaximumLifetimeSeconds {
			return publishPreviewArguments{}, invalidPreviewArguments()
		}
	}
	for _, value := range []string{relativePath, entrypoint, title, summary, idempotencyKey} {
		if protocol.LooksSecretLike(value) {
			return publishPreviewArguments{}, invalidPreviewArguments()
		}
	}
	return publishPreviewArguments{
		RelativePath: relativePath, Entrypoint: entrypoint, Title: title, Summary: summary,
		TTLSeconds: ttlSeconds, IdempotencyKey: idempotencyKey,
	}, nil
}

func decodeUniquePreviewObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, errors.New("arguments are not an object")
	}
	object := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("argument name is invalid")
		}
		if _, duplicate := object[key]; duplicate {
			return nil, errors.New("argument is duplicated")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		object[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, errors.New("arguments object is incomplete")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("arguments contain trailing data")
	}
	return object, nil
}

func requiredPreviewString(object map[string]json.RawMessage, key string) (string, bool) {
	raw, present := object[key]
	if !present {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || !utf8.ValidString(value) {
		return "", false
	}
	return value, true
}

func utf16Length(value string) int {
	length := 0
	for _, character := range value {
		if character > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

func truncateUTF16(value string, maximum int) string {
	length := 0
	for index, character := range value {
		width := 1
		if character > 0xffff {
			width = 2
		}
		if length+width > maximum {
			return value[:index]
		}
		length += width
	}
	return value
}

func invalidPreviewArguments() *ToolError {
	return &ToolError{Code: "invalid_arguments", Message: "publish_preview arguments are invalid"}
}

func previewLocalToolError(err error) *ToolError {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &ToolError{Code: "cancelled", Message: "Preview publication was cancelled"}
	}
	switch {
	case errors.Is(err, errPreviewInvalidPath), errors.Is(err, errPreviewEntrypoint):
		return &ToolError{Code: "invalid_source", Message: "Preview source paths or entrypoint are invalid"}
	case errors.Is(err, errPreviewSymlink):
		return &ToolError{Code: "invalid_source", Message: "Preview source contains a symbolic link"}
	case errors.Is(err, errPreviewUnsupportedType):
		return &ToolError{Code: "invalid_source", Message: "Preview source contains an unsupported entry"}
	case errors.Is(err, errPreviewLimit), errors.Is(err, errPreviewRatio):
		return &ToolError{Code: "limit_exceeded", Message: "Preview source exceeds the bundle limits"}
	case errors.Is(err, errPreviewSourceRace):
		return &ToolError{Code: "source_changed", Message: "Preview source changed during packaging"}
	case errors.Is(err, errPreviewSource):
		return &ToolError{Code: "invalid_source", Message: "Preview source is unavailable"}
	case errors.Is(err, errPreviewScratch):
		return &ToolError{Code: "scratch_unavailable", Message: "Preview packaging scratch is unavailable"}
	default:
		return &ToolError{Code: "packaging_failed", Message: "Preview bundle could not be finalized"}
	}
}

func previewUploadToolError(ctx context.Context, err error) *ToolError {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &ToolError{Code: "cancelled", Message: "Preview publication was cancelled"}
	}
	var upload *UploadError
	if errors.As(err, &upload) {
		if upload.Uncertain {
			return &ToolError{Code: "upload_uncertain", Message: "Preview upload outcome is uncertain", Retryable: true}
		}
		retryable := upload.StatusCode == http.StatusRequestTimeout || upload.StatusCode == http.StatusTooEarly ||
			upload.StatusCode == http.StatusTooManyRequests || upload.StatusCode >= 500
		return &ToolError{Code: "upload_failed", Message: "Hub rejected the preview upload", Retryable: retryable}
	}
	return &ToolError{Code: "upload_uncertain", Message: "Preview upload outcome is uncertain", Retryable: true}
}

type previewUploadVerifier struct {
	ctx          context.Context
	reader       io.Reader
	hash         hash.Hash
	count        int64
	expectedSize int64
}

func (reader *previewUploadVerifier) Read(data []byte) (int, error) {
	if err := contextError(reader.ctx); err != nil {
		return 0, err
	}
	read, err := reader.reader.Read(data)
	if read > 0 {
		reader.count += int64(read)
		_, _ = reader.hash.Write(data[:read])
		if reader.count > reader.expectedSize {
			return read, errPreviewScratch
		}
	}
	return read, err
}

type previewRegistrationWire struct {
	Artifact   *previewArtifactWire `json:"artifact"`
	Preview    *previewRecordWire   `json:"preview"`
	UploadPath *string              `json:"uploadPath"`
	Created    *bool                `json:"created"`
}

type previewArtifactWire struct {
	ID             *string `json:"id"`
	ThreadID       *string `json:"threadId"`
	RunID          *string `json:"runId"`
	AgentID        *string `json:"agentId"`
	InstanceID     *string `json:"instanceId"`
	AllocationID   *string `json:"allocationId"`
	RelativePath   *string `json:"relativePath"`
	Title          *string `json:"title"`
	Kind           *string `json:"kind"`
	MediaType      *string `json:"mediaType"`
	Summary        *string `json:"summary"`
	Size           *int64  `json:"size"`
	SHA256         *string `json:"sha256"`
	DownloadPath   *string `json:"downloadPath"`
	Uploaded       *bool   `json:"uploaded"`
	IdempotencyKey *string `json:"idempotencyKey"`
	CreatedAt      *string `json:"createdAt"`
}

type previewRecordWire struct {
	ID                   *string `json:"id"`
	ArtifactID           *string `json:"artifactId"`
	ArtifactSHA256       *string `json:"artifactSha256"`
	ThreadID             *string `json:"threadId"`
	RunID                *string `json:"runId"`
	AgentID              *string `json:"agentId"`
	InstanceID           *string `json:"instanceId"`
	AllocationID         *string `json:"allocationId"`
	Entrypoint           *string `json:"entrypoint"`
	Status               *string `json:"status"`
	ProcessingGeneration *int64  `json:"processingGeneration"`
	CreatedAt            *string `json:"createdAt"`
	UpdatedAt            *string `json:"updatedAt"`
	ExpiresAt            *string `json:"expiresAt"`
	ReadyAt              *string `json:"readyAt"`
	FailedAt             *string `json:"failedAt"`
	FailureCode          *string `json:"failureCode"`
	ExpiredAt            *string `json:"expiredAt"`
	AccessState          *string `json:"accessState"`
}

func validatePreviewRegistration(
	raw json.RawMessage,
	runID string,
	expected publishPreviewArguments,
	size int64,
	digest string,
) (protocol.PreviewPublicationResult, string, error) {
	var wire previewRegistrationWire
	if err := json.Unmarshal(raw, &wire); err != nil || wire.Artifact == nil || wire.Preview == nil ||
		wire.UploadPath == nil || wire.Created == nil {
		return protocol.PreviewPublicationResult{}, "", errors.New("invalid registration")
	}
	artifact, err := validatePreviewArtifact(wire.Artifact, runID, expected, size, digest, *wire.UploadPath)
	if err != nil {
		return protocol.PreviewPublicationResult{}, "", err
	}
	preview, err := validatePreviewRecord(wire.Preview, artifact, expected.Entrypoint)
	if err != nil {
		return protocol.PreviewPublicationResult{}, "", err
	}
	if *wire.Created && (artifact.Uploaded || preview.Status != "upload-pending" ||
		preview.ProcessingGeneration != 0 || preview.AccessState != "unavailable") {
		return protocol.PreviewPublicationResult{}, "", errors.New("created registration is inconsistent")
	}
	if !artifact.Uploaded && preview.ProcessingGeneration > 0 {
		return protocol.PreviewPublicationResult{}, "", errors.New("preview processing predates upload")
	}
	return protocol.PreviewPublicationResult{Artifact: artifact, Preview: preview, Created: *wire.Created}, *wire.UploadPath, nil
}

func validatePreviewArtifact(
	wire *previewArtifactWire,
	runID string,
	expected publishPreviewArguments,
	size int64,
	digest string,
	uploadPath string,
) (protocol.PreviewArtifact, error) {
	if !requiredWireStrings(
		wire.ID, wire.ThreadID, wire.RunID, wire.RelativePath, wire.Title, wire.Kind, wire.MediaType,
		wire.Summary, wire.SHA256, wire.DownloadPath, wire.IdempotencyKey, wire.CreatedAt,
	) || wire.Size == nil || wire.Uploaded == nil {
		return protocol.PreviewArtifact{}, errors.New("artifact is incomplete")
	}
	if !validPreviewIdentifier(*wire.ID) || !validPreviewIdentifier(*wire.ThreadID) ||
		!validPreviewIdentifier(*wire.RunID) || *wire.RunID != runID ||
		*wire.RelativePath != expected.RelativePath || *wire.Title != expected.Title ||
		*wire.Kind != protocol.PreviewBundleArtifactKind || *wire.MediaType != protocol.PreviewBundleMediaType ||
		*wire.Summary != expected.Summary || *wire.Size != size || *wire.SHA256 != digest ||
		!lowercaseSHA256Pattern.MatchString(*wire.SHA256) || *wire.IdempotencyKey != expected.IdempotencyKey {
		return protocol.PreviewArtifact{}, errors.New("artifact does not match request")
	}
	expectedUploadPath := "/api/artifacts/" + url.PathEscape(*wire.ID) + "/content"
	if uploadPath != expectedUploadPath || *wire.DownloadPath != expectedUploadPath {
		return protocol.PreviewArtifact{}, errors.New("upload path is invalid")
	}
	if _, err := parsePreviewTime(*wire.CreatedAt); err != nil {
		return protocol.PreviewArtifact{}, err
	}
	agentID, instanceID, allocationID, err := validatePreviewActor(wire.AgentID, wire.InstanceID, wire.AllocationID)
	if err != nil {
		return protocol.PreviewArtifact{}, err
	}
	return protocol.PreviewArtifact{
		ID: *wire.ID, ThreadID: *wire.ThreadID, RunID: *wire.RunID, AgentID: agentID,
		InstanceID: instanceID, AllocationID: allocationID, RelativePath: *wire.RelativePath,
		Title: *wire.Title, Kind: *wire.Kind, MediaType: *wire.MediaType, Summary: *wire.Summary,
		Size: *wire.Size, SHA256: *wire.SHA256, DownloadPath: *wire.DownloadPath,
		Uploaded: *wire.Uploaded, IdempotencyKey: *wire.IdempotencyKey, CreatedAt: *wire.CreatedAt,
	}, nil
}

func validatePreviewRecord(
	wire *previewRecordWire,
	artifact protocol.PreviewArtifact,
	entrypoint string,
) (protocol.ArtifactPreview, error) {
	if !requiredWireStrings(
		wire.ID, wire.ArtifactID, wire.ArtifactSHA256, wire.ThreadID, wire.RunID, wire.Entrypoint,
		wire.Status, wire.CreatedAt, wire.UpdatedAt, wire.ExpiresAt, wire.AccessState,
	) || wire.ProcessingGeneration == nil {
		return protocol.ArtifactPreview{}, errors.New("preview is incomplete")
	}
	if !validPreviewIdentifier(*wire.ID) || *wire.ArtifactID != artifact.ID || *wire.ArtifactSHA256 != artifact.SHA256 ||
		*wire.ThreadID != artifact.ThreadID || *wire.RunID != artifact.RunID || *wire.Entrypoint != entrypoint ||
		!protocol.IsArtifactPreviewStatus(*wire.Status) || !protocol.IsArtifactPreviewAccessState(*wire.AccessState) ||
		*wire.ProcessingGeneration < 0 {
		return protocol.ArtifactPreview{}, errors.New("preview identity is invalid")
	}
	agentID, instanceID, allocationID, err := validatePreviewActor(wire.AgentID, wire.InstanceID, wire.AllocationID)
	if err != nil || agentID != artifact.AgentID || instanceID != artifact.InstanceID || allocationID != artifact.AllocationID {
		return protocol.ArtifactPreview{}, errors.New("preview actor is invalid")
	}
	created, err := parsePreviewTime(*wire.CreatedAt)
	if err != nil || *wire.CreatedAt != artifact.CreatedAt {
		return protocol.ArtifactPreview{}, errors.New("preview creation time is invalid")
	}
	updated, err := parsePreviewTime(*wire.UpdatedAt)
	if err != nil || updated.Before(created) {
		return protocol.ArtifactPreview{}, errors.New("preview update time is invalid")
	}
	expires, err := parsePreviewTime(*wire.ExpiresAt)
	minimumExpiry := created.Add(time.Duration(protocol.PreviewBundleContract.MinimumTTLSeconds) * time.Second)
	maximumExpiry := created.Add(time.Duration(protocol.PreviewBundleContract.MaximumLifetimeSeconds) * time.Second)
	if err != nil || expires.Before(minimumExpiry) || expires.After(maximumExpiry) {
		return protocol.ArtifactPreview{}, errors.New("preview expiry is invalid")
	}
	if err := validatePreviewLifecycle(wire, created, updated, expires); err != nil {
		return protocol.ArtifactPreview{}, err
	}
	return protocol.ArtifactPreview{
		ID: *wire.ID, ArtifactID: *wire.ArtifactID, ArtifactSHA256: *wire.ArtifactSHA256,
		ThreadID: *wire.ThreadID, RunID: *wire.RunID, AgentID: agentID, InstanceID: instanceID,
		AllocationID: allocationID, Entrypoint: *wire.Entrypoint, Status: *wire.Status,
		ProcessingGeneration: *wire.ProcessingGeneration, CreatedAt: *wire.CreatedAt,
		UpdatedAt: *wire.UpdatedAt, ExpiresAt: *wire.ExpiresAt, ReadyAt: optionalWireString(wire.ReadyAt),
		FailedAt: optionalWireString(wire.FailedAt), FailureCode: optionalWireString(wire.FailureCode),
		ExpiredAt: optionalWireString(wire.ExpiredAt), AccessState: *wire.AccessState,
	}, nil
}

func validatePreviewLifecycle(wire *previewRecordWire, created, updated, expires time.Time) error {
	status := *wire.Status
	generation := *wire.ProcessingGeneration
	if status != "ready" && *wire.AccessState != "unavailable" {
		return errors.New("preview access state is invalid")
	}
	if status != "expired" && !updated.Before(expires) {
		return errors.New("preview is past expiry")
	}
	switch status {
	case "upload-pending":
		if generation != 0 || wire.ReadyAt != nil || wire.FailedAt != nil || wire.FailureCode != nil || wire.ExpiredAt != nil {
			return errors.New("pending preview is invalid")
		}
	case "processing":
		if generation < 1 || wire.ReadyAt != nil || wire.FailedAt != nil || wire.FailureCode != nil || wire.ExpiredAt != nil {
			return errors.New("processing preview is invalid")
		}
	case "ready":
		if generation < 1 || wire.ReadyAt == nil || wire.FailedAt != nil || wire.FailureCode != nil || wire.ExpiredAt != nil {
			return errors.New("ready preview is invalid")
		}
		ready, err := parsePreviewTime(*wire.ReadyAt)
		if err != nil || ready.Before(created) || ready.After(updated) {
			return errors.New("ready preview time is invalid")
		}
	case "failed":
		if wire.ReadyAt != nil || wire.FailedAt == nil || wire.FailureCode == nil || wire.ExpiredAt != nil ||
			!protocol.IsArtifactPreviewFailureCode(optionalWireString(wire.FailureCode)) {
			return errors.New("failed preview is invalid")
		}
		failed, err := parsePreviewTime(*wire.FailedAt)
		if err != nil || failed.Before(created) || failed.After(updated) {
			return errors.New("failed preview time is invalid")
		}
	case "expired":
		if wire.ReadyAt != nil || wire.FailedAt != nil || wire.FailureCode != nil || wire.ExpiredAt == nil || updated.Before(expires) {
			return errors.New("expired preview is invalid")
		}
		expired, err := parsePreviewTime(*wire.ExpiredAt)
		if err != nil || expired.Before(expires) || expired.After(updated) {
			return errors.New("expired preview time is invalid")
		}
	default:
		return errors.New("preview status is invalid")
	}
	return nil
}

func validatePreviewActor(agent, instance, allocation *string) (string, string, string, error) {
	agentActor := agent != nil && validPreviewIdentifier(*agent) && instance == nil && allocation == nil
	instanceActor := agent == nil && instance != nil && allocation != nil &&
		validPreviewIdentifier(*instance) && validPreviewIdentifier(*allocation)
	if agentActor == instanceActor {
		return "", "", "", errors.New("preview actor is invalid")
	}
	if agentActor {
		return *agent, "", "", nil
	}
	return "", *instance, *allocation, nil
}

func requiredWireStrings(values ...*string) bool {
	for _, value := range values {
		if value == nil || !utf8.ValidString(*value) {
			return false
		}
	}
	return true
}

func validPreviewIdentifier(value string) bool {
	return value != "" && utf8.ValidString(value) && len(value) <= 256 && !protocol.LooksSecretLike(value)
}

func parsePreviewTime(value string) (time.Time, error) {
	if value == "" || !utf8.ValidString(value) {
		return time.Time{}, errors.New("timestamp is invalid")
	}
	return time.Parse(time.RFC3339Nano, value)
}

func optionalWireString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
