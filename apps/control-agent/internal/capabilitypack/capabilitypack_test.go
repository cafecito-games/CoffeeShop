package capabilitypack

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/setup"
)

// packRoot is the canonical pack tree in this repository. The tests read the real committed tree
// rather than a hand-written approximation of one: the pack is the producer, and a fixture that
// merely resembled it could pass while the shipped pack failed.
func packRoot() string { return filepath.Join("..", "..", "..", "..", "capability-pack") }

// sharedVocabularyFixture is the language-neutral hub tool fixture both the TypeScript and the Go
// vocabulary are already checked against. It is the real producer of the tool names this pack is
// authored to.
func sharedVocabularyFixture() string {
	return filepath.Join("..", "..", "..", "..", "packages", "protocol", "test", "fixtures", "hub-tools", "vocabulary.json")
}

func canonicalTree(t *testing.T) Tree {
	t.Helper()
	tree, err := ReadTree(packRoot())
	if err != nil {
		t.Fatalf("ReadTree(%s) error = %v", packRoot(), err)
	}
	return tree
}

func cloneTree(tree Tree) Tree {
	clone := Tree{}
	maps.Copy(clone, tree)
	return clone
}

// refreshDigests re-pins every declared per-file digest without validating anything. A fail-closed
// test needs it so that mutating one file exercises the rule under test instead of tripping the
// digest rule first.
func refreshDigests(t *testing.T, tree Tree) Tree {
	t.Helper()
	manifest, err := ParsePackManifest(tree[PackManifestPath])
	if err != nil {
		t.Fatalf("ParsePackManifest() error = %v", err)
	}
	manifest.Files = make([]PackFile, 0, len(tree))
	for _, path := range tree.Paths() {
		if path == PackManifestPath {
			continue
		}
		digest := sha256.Sum256(tree[path])
		manifest.Files = append(manifest.Files, PackFile{Path: path, SHA256: hex.EncodeToString(digest[:])})
	}
	encoded, err := encodePackManifest(manifest)
	if err != nil {
		t.Fatalf("encodePackManifest() error = %v", err)
	}
	tree[PackManifestPath] = encoded
	return tree
}

// editManifest rewrites pack.json through the manifest struct, leaving digests exactly as they were
// so a test can target one manifest rule at a time.
func editManifest(t *testing.T, tree Tree, edit func(*PackManifest)) Tree {
	t.Helper()
	manifest, err := ParsePackManifest(tree[PackManifestPath])
	if err != nil {
		t.Fatalf("ParsePackManifest() error = %v", err)
	}
	edit(&manifest)
	encoded, err := encodePackManifest(manifest)
	if err != nil {
		t.Fatalf("encodePackManifest() error = %v", err)
	}
	tree[PackManifestPath] = encoded
	return tree
}

// TestCanonicalPackValidates proves the shipped pack tree satisfies every rule the validator
// enforces, and that its declared identity is exactly the identity the component manifest pins. The
// manifest entry and the pack must never be able to drift: activation records the manifest's version
// and the probe accepts only a pack that declares the same one.
func TestCanonicalPackValidates(t *testing.T) {
	manifest, err := Validate(canonicalTree(t), DefaultVocabulary())
	if err != nil {
		t.Fatalf("Validate(canonical pack) error = %v", err)
	}
	if len(manifest.Skills) != 3 {
		t.Fatalf("canonical pack declares %d skills, want the three focused workflows", len(manifest.Skills))
	}
	wantSkills := []string{"coffeeshop-artifacts", "coffeeshop-coordination", "coffeeshop-task-reporting"}
	got := slices.Sorted(slices.Values(manifest.SkillIDs()))
	if !slices.Equal(got, wantSkills) {
		t.Fatalf("canonical pack skills = %v, want %v", got, wantSkills)
	}
	components, err := setup.LoadDefaultManifest()
	if err != nil {
		t.Fatalf("setup.LoadDefaultManifest() error = %v", err)
	}
	packs := components.ComponentsOfKind(setup.ComponentKindCapabilityPack)
	if len(packs) != 1 {
		t.Fatalf("the component manifest declares %d capability packs, want exactly one", len(packs))
	}
	if packs[0].ID != manifest.ID || packs[0].Version != manifest.Version {
		t.Fatalf("component manifest declares %s@%s but the pack declares %s", packs[0].ID, packs[0].Version, manifest.Ref())
	}
}

// TestCommittedPackIsSealed proves every derived byte in the committed tree is reproducible: the
// generated vocabulary reference and every pinned digest are exactly what sealing emits on a clean
// checkout, so the digests are reviewable rather than asserted and regeneration produces no diff.
func TestCommittedPackIsSealed(t *testing.T) {
	tree := canonicalTree(t)
	sealed, _, err := Seal(cloneTree(tree), DefaultVocabulary())
	if err != nil {
		t.Fatalf("Seal(canonical pack) error = %v", err)
	}
	if !slices.Equal(sealed.Paths(), tree.Paths()) {
		t.Fatalf("sealing changed the pack's file set: %v vs %v", sealed.Paths(), tree.Paths())
	}
	for _, path := range tree.Paths() {
		if !bytes.Equal(sealed[path], tree[path]) {
			t.Fatalf("committed %s is not what sealing produces; run `task capability-pack:seal`", path)
		}
	}
}

// TestBuildArchiveIsDeterministic builds the same tree twice and compares digests. It deliberately
// compares built bytes rather than recording whatever one build produced, because a recorded digest
// would pass on the machine that recorded it no matter how much producer state leaked into it.
func TestBuildArchiveIsDeterministic(t *testing.T) {
	tree := canonicalTree(t)
	first, _, err := BuildArchive(tree, DefaultVocabulary())
	if err != nil {
		t.Fatalf("BuildArchive() error = %v", err)
	}
	second, _, err := BuildArchive(tree, DefaultVocabulary())
	if err != nil {
		t.Fatalf("BuildArchive() second error = %v", err)
	}
	if ArchiveDigest(first) != ArchiveDigest(second) {
		t.Fatalf("two builds of the same tree produced different digests: %s vs %s", ArchiveDigest(first), ArchiveDigest(second))
	}
	if !bytes.Equal(first, second) {
		t.Fatal("two builds of the same tree produced different bytes")
	}
	// A build from a tree whose iteration order differs must still produce the same bytes: the packer
	// sorts paths rather than following map order.
	shuffled := Tree{}
	for path, content := range tree {
		shuffled[path] = content
	}
	third, _, err := BuildArchive(shuffled, DefaultVocabulary())
	if err != nil {
		t.Fatalf("BuildArchive(reinserted tree) error = %v", err)
	}
	if !bytes.Equal(first, third) {
		t.Fatal("archive bytes depended on the tree's insertion order")
	}
	// And the archive must round trip: expanding it and rebuilding reproduces the same bytes.
	expanded, err := ArchiveTree(first)
	if err != nil {
		t.Fatalf("ArchiveTree() error = %v", err)
	}
	if len(expanded) != len(tree) {
		t.Fatalf("round trip produced %d files, want %d", len(expanded), len(tree))
	}
	rebuilt, _, err := BuildArchive(expanded, DefaultVocabulary())
	if err != nil {
		t.Fatalf("BuildArchive(round-tripped tree) error = %v", err)
	}
	if !bytes.Equal(first, rebuilt) {
		t.Fatal("rebuilding a round-tripped tree did not reproduce the archive bytes")
	}
}

// TestArchiveCarriesNoProducerMetadata inspects the archive headers directly. Determinism is a
// property of the bytes, not of one lucky comparison, so the metadata that would otherwise vary per
// machine is asserted to be pinned.
func TestArchiveCarriesNoProducerMetadata(t *testing.T) {
	archive, _, err := BuildArchive(canonicalTree(t), DefaultVocabulary())
	if err != nil {
		t.Fatalf("BuildArchive() error = %v", err)
	}
	gzipReader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatalf("gzip.NewReader() error = %v", err)
	}
	defer gzipReader.Close()
	if gzipReader.Name != "" || gzipReader.Comment != "" || !gzipReader.ModTime.IsZero() {
		t.Fatalf("gzip header carries producer state: name=%q comment=%q modTime=%v", gzipReader.Name, gzipReader.Comment, gzipReader.ModTime)
	}
	reader := tar.NewReader(gzipReader)
	previous := ""
	for {
		header, err := reader.Next()
		if err != nil {
			break
		}
		if header.Mode != archiveEntryMode || header.ModTime.Unix() != 0 ||
			header.Uid != 0 || header.Gid != 0 || header.Uname != "" || header.Gname != "" {
			t.Fatalf("entry %s carries producer metadata: %+v", header.Name, header)
		}
		if header.Format != tar.FormatUSTAR {
			t.Fatalf("entry %s uses format %v, want USTAR so no PAX records are written", header.Name, header.Format)
		}
		if header.Name <= previous {
			t.Fatalf("entry %s is not in sorted order after %s", header.Name, previous)
		}
		previous = header.Name
	}
}

// TestArchiveTreeRejectsArchivesNobodyCouldHaveProducedDeterministically covers the reader half of
// the determinism contract: an archive whose entries carry a real timestamp, a different mode, an
// owner, a directory entry, or an out-of-order name is rejected rather than normalized into
// something that looks like a deterministic pack.
func TestArchiveTreeRejectsArchivesNobodyCouldHaveProducedDeterministically(t *testing.T) {
	tree := canonicalTree(t)
	testCases := []struct {
		name    string
		mutate  func(header *tar.Header)
		reverse bool
		wantErr string
	}{
		{name: "real modification time", mutate: func(header *tar.Header) { header.ModTime = time.Unix(1_700_000_000, 0) }, wantErr: "normalized metadata"},
		{name: "executable mode", mutate: func(header *tar.Header) { header.Mode = 0o755 }, wantErr: "normalized metadata"},
		{name: "recorded owner", mutate: func(header *tar.Header) { header.Uname = "builder"; header.Uid = 1000 }, wantErr: "normalized metadata"},
		{name: "unsorted entries", reverse: true, wantErr: "out of sorted order"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			paths := tree.Paths()
			if testCase.reverse {
				slices.Reverse(paths)
			}
			var buffer bytes.Buffer
			gzipWriter := gzip.NewWriter(&buffer)
			tarWriter := tar.NewWriter(gzipWriter)
			for _, path := range paths {
				header := &tar.Header{
					Typeflag: tar.TypeReg, Name: path, Size: int64(len(tree[path])),
					Mode: archiveEntryMode, ModTime: archiveEntryModTime, Format: tar.FormatUSTAR,
				}
				if testCase.mutate != nil {
					testCase.mutate(header)
				}
				if err := tarWriter.WriteHeader(header); err != nil {
					t.Fatalf("WriteHeader() error = %v", err)
				}
				if _, err := tarWriter.Write(tree[path]); err != nil {
					t.Fatalf("Write() error = %v", err)
				}
			}
			if err := tarWriter.Close(); err != nil {
				t.Fatalf("tar Close() error = %v", err)
			}
			if err := gzipWriter.Close(); err != nil {
				t.Fatalf("gzip Close() error = %v", err)
			}
			if _, err := ArchiveTree(buffer.Bytes()); err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("ArchiveTree() error = %v, want it to contain %q", err, testCase.wantErr)
			}
		})
	}
	// A directory entry carries mode and ownership metadata of its own and is never written by the
	// packer, so it is refused rather than skipped.
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: "skills", Mode: 0o755, Format: tar.FormatUSTAR}); err != nil {
		t.Fatalf("WriteHeader() error = %v", err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("tar Close() error = %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("gzip Close() error = %v", err)
	}
	if _, err := ArchiveTree(buffer.Bytes()); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("ArchiveTree(directory entry) error = %v, want a regular-file refusal", err)
	}
}

// TestProbeInstalledArtifactMatchesTheDeclaredIdentity proves the activation probe accepts the built
// artifact, and refuses a tampered one and one whose declared identity is not the version the
// component manifest pinned — the case where a well-formed pack of another version could otherwise be
// recorded as this one.
func TestProbeInstalledArtifactMatchesTheDeclaredIdentity(t *testing.T) {
	archive, manifest, err := BuildArchive(canonicalTree(t), DefaultVocabulary())
	if err != nil {
		t.Fatalf("BuildArchive() error = %v", err)
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "coffeeshop-capability-pack.tar.gz")
	if err := os.WriteFile(path, archive, 0o755); err != nil {
		t.Fatalf("write archive: %v", err)
	}
	// Mode 0o755 is what the applier publishes every managed component as. It is cosmetic for an
	// archive, and the probe must not care.
	if _, err := ProbeInstalledArtifact(path, manifest.ID, manifest.Version); err != nil {
		t.Fatalf("ProbeInstalledArtifact() error = %v", err)
	}
	if _, err := ProbeInstalledArtifact(path, manifest.ID, "9.9.9"); err == nil {
		t.Fatal("ProbeInstalledArtifact() accepted a version the pack does not declare")
	}
	if _, err := ProbeInstalledArtifact(path, "some-other-pack", manifest.Version); err == nil {
		t.Fatal("ProbeInstalledArtifact() accepted a pack id the component manifest does not declare")
	}
	tampered := slices.Clone(archive)
	tampered[len(tampered)/2] ^= 0xff
	if err := os.WriteFile(path, tampered, 0o644); err != nil {
		t.Fatalf("write tampered archive: %v", err)
	}
	if _, err := ProbeInstalledArtifact(path, manifest.ID, manifest.Version); err == nil {
		t.Fatal("ProbeInstalledArtifact() accepted a tampered archive")
	}
	if _, err := ProbeInstalledArtifact(filepath.Join(directory, "absent.tar.gz"), manifest.ID, manifest.Version); err == nil {
		t.Fatal("ProbeInstalledArtifact() accepted an absent artifact")
	}
	if _, err := ProbeInstalledArtifact(directory, manifest.ID, manifest.Version); err == nil {
		t.Fatal("ProbeInstalledArtifact() accepted a directory as an artifact")
	}
}

// TestSharedFixtureIsTheVocabularyThePackIsValidatedAgainst closes the loop between the three copies
// of the hub tool vocabulary: the TypeScript source of truth, the shared language-neutral fixture it
// is checked against, and the Go mirror this validator uses. A pack validated against the Go mirror
// is therefore validated against packages/protocol/src/index.ts, transitively and provably.
func TestSharedFixtureIsTheVocabularyThePackIsValidatedAgainst(t *testing.T) {
	data, err := os.ReadFile(sharedVocabularyFixture())
	if err != nil {
		t.Fatalf("read shared vocabulary fixture: %v", err)
	}
	var fixture struct {
		ToolNames           []string `json:"toolNames"`
		DelegationToolNames []string `json:"delegationToolNames"`
		TaskMessageKinds    []string `json:"taskMessageKinds"`
		MaximumWait         int      `json:"maximumWaitMilliseconds"`
		MaximumEvents       int      `json:"maximumEventsPerWait"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode shared vocabulary fixture: %v", err)
	}
	vocabulary := DefaultVocabulary()
	if !slices.Equal(fixture.ToolNames, vocabulary.ToolNames) {
		t.Fatalf("shared fixture tool names %v differ from the validator's vocabulary %v", fixture.ToolNames, vocabulary.ToolNames)
	}
	if !slices.Equal(fixture.DelegationToolNames, vocabulary.DelegationToolNames) {
		t.Fatalf("shared fixture delegation names %v differ from the validator's %v", fixture.DelegationToolNames, vocabulary.DelegationToolNames)
	}
	// The generated reference restates the fixture's message kinds and bounds, so they must agree too.
	if !slices.Equal(fixture.TaskMessageKinds, protocol.TaskMessageKinds) {
		t.Fatalf("shared fixture message kinds %v differ from the Go mirror %v", fixture.TaskMessageKinds, protocol.TaskMessageKinds)
	}
	if fixture.MaximumWait != protocol.MaximumWaitMilliseconds || fixture.MaximumEvents != protocol.MaximumEventsPerWait {
		t.Fatal("shared fixture wait bounds differ from the Go mirror")
	}
}

// TestVocabularyDriftBreaksValidation performs the mutation upstream drift would cause — a rename, an
// addition, and a removal — against an in-memory copy of the vocabulary, and asserts the canonical
// pack stops validating each time. Without this, a renamed tool would ship as prose naming a tool
// that no longer exists.
func TestVocabularyDriftBreaksValidation(t *testing.T) {
	tree := canonicalTree(t)
	testCases := []struct {
		name       string
		vocabulary Vocabulary
		wantErr    string
	}{
		{
			name: "a tool is renamed",
			vocabulary: func() Vocabulary {
				vocabulary := DefaultVocabulary()
				vocabulary.ToolNames = slices.Clone(vocabulary.ToolNames)
				vocabulary.ToolNames[slices.Index(vocabulary.ToolNames, "post_artifact")] = "publish_artifact"
				return vocabulary
			}(),
			wantErr: "toolVocabulary does not equal the running hub tool vocabulary",
		},
		{
			name: "a tool is added",
			vocabulary: func() Vocabulary {
				vocabulary := DefaultVocabulary()
				vocabulary.ToolNames = append(slices.Clone(vocabulary.ToolNames), "cancel_task")
				return vocabulary
			}(),
			wantErr: "toolVocabulary does not equal the running hub tool vocabulary",
		},
		{
			name: "a tool is removed",
			vocabulary: func() Vocabulary {
				vocabulary := DefaultVocabulary()
				vocabulary.ToolNames = slices.Delete(slices.Clone(vocabulary.ToolNames), 0, 1)
				return vocabulary
			}(),
			wantErr: "toolVocabulary does not equal the running hub tool vocabulary",
		},
		{
			name: "a tool becomes delegation-only",
			vocabulary: func() Vocabulary {
				vocabulary := DefaultVocabulary()
				vocabulary.DelegationToolNames = append(slices.Clone(vocabulary.DelegationToolNames), "post_artifact")
				return vocabulary
			}(),
			wantErr: "delegationToolVocabulary does not equal",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := Validate(tree, testCase.vocabulary); err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("Validate() under drift error = %v, want it to contain %q", err, testCase.wantErr)
			}
		})
	}
	// A rename the pack manifest was resealed for still fails, because the prose and the skill
	// declarations name the old tool. Drift cannot be papered over by resealing.
	renamed := DefaultVocabulary()
	renamed.ToolNames = slices.Clone(renamed.ToolNames)
	renamed.ToolNames[slices.Index(renamed.ToolNames, "post_artifact")] = "publish_artifact"
	resealed := editManifest(t, cloneTree(tree), func(manifest *PackManifest) {
		manifest.ToolVocabulary = slices.Clone(renamed.ToolNames)
	})
	if _, err := Validate(resealed, renamed); err == nil {
		t.Fatal("Validate() accepted a pack whose prose names a renamed tool once its manifest was resealed")
	}
	// A vocabulary that could not have come from the protocol is refused outright rather than
	// accepting every name a pack might declare.
	if _, err := Validate(tree, Vocabulary{}); err == nil {
		t.Fatal("Validate() accepted an empty vocabulary")
	}
	if _, err := Validate(tree, Vocabulary{ToolNames: []string{"NotATool"}}); err == nil {
		t.Fatal("Validate() accepted a malformed vocabulary")
	}
}

// TestEveryHubToolIsTaughtBySomeSkill proves the pack covers the whole served vocabulary, so adding a
// tool upstream leaves the pack failing validation rather than quietly incomplete.
func TestEveryHubToolIsTaughtBySomeSkill(t *testing.T) {
	manifest, err := Validate(canonicalTree(t), DefaultVocabulary())
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	taught := map[string]bool{}
	for _, skill := range manifest.Skills {
		for _, name := range skill.declaredTools() {
			taught[name] = true
		}
	}
	for _, name := range protocol.HubToolNames {
		if !taught[name] {
			t.Fatalf("no pack skill teaches %s", name)
		}
	}
}

// TestCanonicalEvaluationsCoverEveryPromptClass proves the shipped fixtures are assertions rather than
// notes: every skill carries every prompt class, unrelated prompts assert non-activation, incomplete
// prompts assert a request for the missing input, and authorization refusals assert the refusal is
// reported without a claim of success.
func TestCanonicalEvaluationsCoverEveryPromptClass(t *testing.T) {
	tree := canonicalTree(t)
	manifest, err := Validate(tree, DefaultVocabulary())
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	for _, skill := range manifest.Skills {
		suite, err := ParseEvaluationSuite(skill.EvaluationPath, tree[skill.EvaluationPath])
		if err != nil {
			t.Fatalf("ParseEvaluationSuite(%s) error = %v", skill.EvaluationPath, err)
		}
		byClass := map[string][]EvaluationCase{}
		for _, evaluation := range suite.Cases {
			byClass[evaluation.Class] = append(byClass[evaluation.Class], evaluation)
		}
		for _, class := range EvaluationClasses {
			if len(byClass[class]) == 0 {
				t.Fatalf("%s carries no %s prompt", skill.ID, class)
			}
		}
		for _, evaluation := range byClass[EvaluationClassUnrelated] {
			if evaluation.Activates || evaluation.Outcome != OutcomeNoActivation {
				t.Fatalf("%s case %s is unrelated but does not assert non-activation", skill.ID, evaluation.ID)
			}
		}
		for _, evaluation := range byClass[EvaluationClassIncomplete] {
			if evaluation.Outcome != OutcomeRequestMissingInput {
				t.Fatalf("%s case %s is incomplete but does not assert a request for the missing input", skill.ID, evaluation.ID)
			}
		}
		for _, evaluation := range byClass[EvaluationClassAuthorizationBoundary] {
			if evaluation.Outcome != OutcomeReportRefusal || evaluation.ClaimsSuccess {
				t.Fatalf("%s case %s is an authorization boundary but does not assert a reported refusal", skill.ID, evaluation.ID)
			}
		}
		// At least one edge prompt per pack must cover the unsupported-capability path, which is the
		// run-time half of the fail-closed contract: a skill that needs a tool the run does not serve
		// reports it and stops.
		unsupported := false
		for _, evaluation := range byClass[EvaluationClassEdge] {
			if evaluation.Outcome == OutcomeReportUnsupportedCapability {
				unsupported = true
			}
		}
		if !unsupported {
			t.Fatalf("%s carries no edge prompt asserting an unsupported capability is reported", skill.ID)
		}
	}
}

// TestCoordinationContractNamesNoAbsentTool holds the bounded fallback prompt contract to the same
// vocabulary as the pack. The contract is retained unchanged by this change, because no equivalent
// skill activation is guaranteed yet; what must not happen is it naming a tool that does not exist.
func TestCoordinationContractNamesNoAbsentTool(t *testing.T) {
	// The contract lives in internal/harness, which this package must not import; its text is read
	// from the source file so the assertion is against the real producer rather than a copy.
	data, err := os.ReadFile(filepath.Join("..", "harness", "runner.go"))
	if err != nil {
		t.Fatalf("read the fallback contract source: %v", err)
	}
	source := string(data)
	start := strings.Index(source, "const coordinationContract = `")
	if start < 0 {
		t.Fatal("coordinationContract is no longer declared where this test reads it")
	}
	remainder := source[start+len("const coordinationContract = `"):]
	end := strings.Index(remainder, "`")
	if end < 0 {
		t.Fatal("coordinationContract literal is unterminated")
	}
	contract := remainder[:end]
	for _, token := range strings.FieldsFunc(contract, func(character rune) bool {
		return !(character == '_' || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'))
	}) {
		if hubToolNamePattern.MatchString(token) && !protocol.IsHubToolName(token) {
			t.Fatalf("the fallback coordination contract names %q, which is not a hub tool", token)
		}
	}
}
