package capabilitypack

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

// HubToolsReferencePath is the one generated file inside the pack: a bounded restatement of the hub
// tool *vocabulary* — names, which of them only a delegating run is served, the task message kinds,
// and the wait bounds. It deliberately carries no tool input or output schema, because the
// run-scoped MCP server owns those and a second copy could drift from the served one.
const HubToolsReferencePath = "references/hub-tools.md"

// RenderHubToolsReference regenerates the vocabulary reference from the running vocabulary and the
// protocol bounds. It is a pure function of its inputs, so regenerating it on a clean checkout
// produces no diff, and a rename upstream changes the committed bytes rather than leaving stale
// prose in the pack.
func RenderHubToolsReference(vocabulary Vocabulary) []byte {
	var builder strings.Builder
	builder.WriteString("# Coffee Shop hub tool vocabulary\n\n")
	builder.WriteString("Generated from the Coffee Shop protocol vocabulary. Do not edit by hand: reseal the pack instead.\n\n")
	builder.WriteString("This reference lists **names only**. Every tool's input and output shape comes from the run-scoped\n")
	builder.WriteString("Coffee Shop MCP server that lists it, which is also the only layer that authorizes an action. Read the\n")
	builder.WriteString("served tool description in the run; never assume a shape from this file.\n\n")
	builder.WriteString("| Tool | Availability |\n| --- | --- |\n")
	for _, name := range vocabulary.ToolNames {
		availability := "every run"
		if vocabulary.isDelegationOnly(name) {
			availability = "only a run allowed to delegate"
		}
		builder.WriteString("| `" + name + "` | " + availability + " |\n")
	}
	builder.WriteString("\nA tool that is not listed for your run is not available to you. Report the unsupported capability and\n")
	builder.WriteString("stop; never substitute another tool and never describe an action you did not complete.\n\n")
	builder.WriteString("## Task message kinds\n\n")
	for _, kind := range protocol.TaskMessageKinds {
		builder.WriteString("- " + kind + "\n")
	}
	builder.WriteString("\n## Waiting bounds\n\n")
	builder.WriteString("- Longest wait accepted, in milliseconds: " + strconv.Itoa(protocol.MaximumWaitMilliseconds) + "\n")
	builder.WriteString("- Most events returned by one wait: " + strconv.Itoa(protocol.MaximumEventsPerWait) + "\n")
	builder.WriteString("\nA wait that returns no event is an ordinary result, not a failure. Pass the cursor it returns back into\n")
	builder.WriteString("the next wait so no event is skipped or replayed.\n")
	return []byte(builder.String())
}

// Seal regenerates every derived part of a pack tree — the vocabulary reference and the pack
// manifest's schema generation, declared vocabulary, and per-file digests — while preserving every
// authored field, and returns the resealed tree. Sealing is the producer of pack.json: the committed
// bytes must equal what Seal emits, which is what makes the digests reviewable rather than asserted.
//
// Seal validates the result before returning it, so it can never produce a pack that would fail to
// build or fail to activate.
func Seal(tree Tree, vocabulary Vocabulary) (Tree, PackManifest, error) {
	if err := vocabulary.validate(); err != nil {
		return nil, PackManifest{}, err
	}
	manifestBytes, present := tree[PackManifestPath]
	if !present {
		return nil, PackManifest{}, errNoPackManifest
	}
	authored, err := ParsePackManifest(manifestBytes)
	if err != nil {
		return nil, PackManifest{}, err
	}
	sealed := Tree{}
	maps.Copy(sealed, tree)
	sealed[HubToolsReferencePath] = RenderHubToolsReference(vocabulary)
	manifest := PackManifest{
		PackSchemaVersion:             PackSchemaVersion,
		ID:                            authored.ID,
		Version:                       authored.Version,
		Label:                         authored.Label,
		Summary:                       authored.Summary,
		MinimumControlProtocolVersion: authored.MinimumControlProtocolVersion,
		ToolVocabulary:                slices.Clone(vocabulary.ToolNames),
		DelegationToolVocabulary:      slices.Clone(vocabulary.DelegationToolNames),
		Skills:                        authored.Skills,
		Files:                         make([]PackFile, 0, len(sealed)),
	}
	for _, path := range sealed.Paths() {
		if path == PackManifestPath {
			continue
		}
		digest := sha256.Sum256(sealed[path])
		manifest.Files = append(manifest.Files, PackFile{Path: path, SHA256: hex.EncodeToString(digest[:])})
	}
	encoded, err := encodePackManifest(manifest)
	if err != nil {
		return nil, PackManifest{}, err
	}
	sealed[PackManifestPath] = encoded
	validated, err := Validate(sealed, vocabulary)
	if err != nil {
		return nil, PackManifest{}, err
	}
	return sealed, validated, nil
}

// encodePackManifest writes the pack manifest in the one canonical JSON form: the struct's field
// order, two-space indentation, no HTML escaping, and a single trailing newline. A second encoding
// would make the committed bytes differ from the sealed bytes for no semantic reason.
func encodePackManifest(manifest PackManifest) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(manifest); err != nil {
		return nil, fmt.Errorf("encode pack manifest: %w", err)
	}
	return buffer.Bytes(), nil
}
