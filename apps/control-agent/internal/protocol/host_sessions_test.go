package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const controlV6FixtureDirectory = "../../../../packages/protocol/test/fixtures/control-v6"

var hostSessionHubFixtureNames = []string{
	"create", "adopt", "attach", "detach", "history-read", "turn-start", "turn-steer",
	"turn-interrupt", "approval-decision", "close",
}

var hostSessionControlFixtureNames = []string{
	"inventory-page", "inventory-complete", "update", "history-page", "harness-event", "command-ack",
	"command-result-start", "command-result-create", "command-result-close",
}

func loadHostSessionFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(controlV6FixtureDirectory, name+".json"))
	require.NoError(t, err)
	return data
}

func mutateHostSessionFixture(t *testing.T, name string, mutate func(map[string]any)) []byte {
	t.Helper()
	var value map[string]any
	require.NoError(t, json.Unmarshal(loadHostSessionFixture(t, name), &value))
	mutate(value)
	data, err := json.Marshal(value)
	require.NoError(t, err)
	return data
}

func TestHostSessionVocabulariesAndLimitsMatchLanguageNeutralFixture(t *testing.T) {
	var vocabulary struct {
		ControlProtocolVersions               []string                   `json:"controlProtocolVersions"`
		HostHarnessSessionSources             []string                   `json:"hostHarnessSessionSources"`
		HostHarnessSessionStatuses            []string                   `json:"hostHarnessSessionStatuses"`
		HostHarnessSessionControlModes        []string                   `json:"hostHarnessSessionControlModes"`
		HostHarnessSessionOperations          []string                   `json:"hostHarnessSessionOperations"`
		HostHarnessDriverOperations           []string                   `json:"hostHarnessDriverOperations"`
		HostHarnessSessionCommandOperations   []string                   `json:"hostHarnessSessionCommandOperations"`
		HostHarnessSessionCommandDispositions []string                   `json:"hostHarnessSessionCommandDispositions"`
		HostHarnessSessionCommandOutcomes     []string                   `json:"hostHarnessSessionCommandOutcomes"`
		HostHarnessSessionHistoryKinds        []string                   `json:"hostHarnessSessionHistoryKinds"`
		HostHarnessSessionHistoryOrder        string                     `json:"hostHarnessSessionHistoryOrder"`
		RuntimeActorKinds                     []string                   `json:"runtimeActorKinds"`
		ThreadOrchestratorKinds               []string                   `json:"threadOrchestratorKinds"`
		HostSessionHubMessageTypes            []string                   `json:"hostSessionHubMessageTypes"`
		HostSessionControlMessageTypes        []string                   `json:"hostSessionControlMessageTypes"`
		HostHarnessSessionTransitions         map[string][]string        `json:"hostHarnessSessionTransitions"`
		HostHarnessSessionLimits              HostHarnessSessionLimitSet `json:"hostHarnessSessionLimits"`
	}
	require.NoError(t, json.Unmarshal(loadHostSessionFixture(t, "vocabulary"), &vocabulary))
	require.Equal(t, vocabulary.ControlProtocolVersions, SupportedVersions)
	require.Equal(t, vocabulary.HostHarnessSessionSources, HostHarnessSessionSources)
	require.Equal(t, vocabulary.HostHarnessSessionStatuses, HostHarnessSessionStatuses)
	require.Equal(t, vocabulary.HostHarnessSessionControlModes, HostHarnessSessionControlModes)
	require.Equal(t, vocabulary.HostHarnessSessionOperations, HostHarnessSessionOperations)
	require.Equal(t, vocabulary.HostHarnessDriverOperations, HostHarnessDriverOperations)
	require.Equal(t, vocabulary.HostHarnessSessionCommandOperations, HostHarnessSessionCommandOperations)
	require.Equal(t, vocabulary.HostHarnessSessionCommandDispositions, HostHarnessSessionCommandDispositions)
	require.Equal(t, vocabulary.HostHarnessSessionCommandOutcomes, HostHarnessSessionCommandOutcomes)
	require.Equal(t, vocabulary.HostHarnessSessionHistoryKinds, HostHarnessSessionHistoryKinds)
	require.Equal(t, vocabulary.HostHarnessSessionHistoryOrder, HostHarnessSessionHistoryOrder)
	require.Equal(t, vocabulary.RuntimeActorKinds, RuntimeActorKinds)
	require.Equal(t, vocabulary.ThreadOrchestratorKinds, ThreadOrchestratorKinds)
	require.Equal(t, vocabulary.HostSessionHubMessageTypes, HostSessionHubMessageTypes)
	require.Equal(t, vocabulary.HostSessionControlMessageTypes, HostSessionControlMessageTypes)
	require.Equal(t, vocabulary.HostHarnessSessionTransitions, HostHarnessSessionTransitions)
	require.Equal(t, vocabulary.HostHarnessSessionLimits, HostHarnessSessionLimits)

	for from, allowed := range HostHarnessSessionTransitions {
		for _, to := range HostHarnessSessionStatuses {
			require.Equal(t, slicesContain(allowed, to), CanTransitionHostHarnessSession(from, to), "%s -> %s", from, to)
		}
	}
}

func TestHostSessionActorThreadAndRunFixturesAreStrictAndVersionSixOnly(t *testing.T) {
	actor, err := DecodeHostHarnessSessionActor(loadHostSessionFixture(t, "runtime-actor"), "6")
	require.NoError(t, err)
	require.NoError(t, actor.Validate())
	orchestrator, err := DecodeHostHarnessSessionThreadOrchestrator(loadHostSessionFixture(t, "thread-orchestrator"), "6")
	require.NoError(t, err)
	require.NoError(t, orchestrator.Validate())
	run, err := DecodeHostHarnessSessionRun(loadHostSessionFixture(t, "runtime-run"), "6", orchestrator)
	require.NoError(t, err)
	require.NoError(t, run.Validate(orchestrator))

	for _, version := range []string{"1", "2", "3", "4", "5", "7", ""} {
		_, err = DecodeHostHarnessSessionActor(loadHostSessionFixture(t, "runtime-actor"), version)
		require.Error(t, err)
		_, err = DecodeHostHarnessSessionThreadOrchestrator(loadHostSessionFixture(t, "thread-orchestrator"), version)
		require.Error(t, err)
		_, err = DecodeHostHarnessSessionRun(loadHostSessionFixture(t, "runtime-run"), version, orchestrator)
		require.Error(t, err)
	}

	_, err = DecodeHostHarnessSessionRun(mutateHostSessionFixture(t, "runtime-run", func(value map[string]any) {
		value["agentId"] = "agent-one"
	}), "6", orchestrator)
	require.Error(t, err)
	_, err = DecodeHostHarnessSessionRun(mutateHostSessionFixture(t, "runtime-run", func(value map[string]any) {
		value["providerTurnId"] = "provider-turn-one"
	}), "6", orchestrator)
	require.Error(t, err, "queued Runs cannot claim provider acceptance")
	_, err = DecodeHostHarnessSessionRun(mutateHostSessionFixture(t, "runtime-run", func(value map[string]any) {
		value["workspace"] = "/"
	}), "6", orchestrator)
	require.NoError(t, err, "the canonical POSIX root must match TypeScript workspace validation")

	_, err = DecodeHostHarnessSessionActor([]byte(`{"kind":"host-session","hostHarnessSessionId":"\ud800"}`), "6")
	require.Error(t, err, "a lone surrogate escape must not be normalized into a replacement character")
	_, err = DecodeHostHarnessSessionActor([]byte(`{"kind":"host-session","hostHarnessSessionId":"\ud83d\ude00"}`), "6")
	require.NoError(t, err, "a paired surrogate escape is valid Unicode")
	_, err = DecodeHostHarnessSessionActor([]byte(`{"kind":"host-session","hostHarnessSessionId":"literal-\\ud800"}`), "6")
	require.NoError(t, err, "an escaped backslash followed by surrogate text is not a Unicode escape")

	providerTurn := "provider-turn-one"
	accepted := run
	accepted.Status = "running"
	accepted.ProviderTurnID = &providerTurn
	require.NoError(t, ValidateHostHarnessSessionRunTransition(run, accepted, orchestrator))
	otherTurn := "provider-turn-two"
	changed := accepted
	changed.ProviderTurnID = &otherTurn
	require.Error(t, ValidateHostHarnessSessionRunTransition(accepted, changed, orchestrator))
}

func TestHostSessionHubFixturesValidateDigestAndRouteOnlyOnVersionSix(t *testing.T) {
	for _, name := range hostSessionHubFixtureNames {
		t.Run(name, func(t *testing.T) {
			data := loadHostSessionFixture(t, name)
			message, err := DecodeHostSessionHubMessage(data, "6")
			require.NoError(t, err)
			roundTrip, err := json.Marshal(message)
			require.NoError(t, err)
			_, err = DecodeHostSessionHubMessage(roundTrip, "6")
			require.NoError(t, err)
			digest, err := HostHarnessSessionCommandDigest(message)
			require.NoError(t, err)
			require.Equal(t, message.CommandDigest, digest)
			for _, version := range []string{"1", "2", "3", "4", "5", "7", ""} {
				_, err := DecodeHostSessionHubMessage(data, version)
				require.Error(t, err, version)
			}

			_, err = DecodeHostSessionHubMessage(mutateHostSessionFixture(t, name, func(value map[string]any) { value["extra"] = true }), "6")
			require.Error(t, err)
			_, err = DecodeHostSessionHubMessage(mutateHostSessionFixture(t, name, func(value map[string]any) { delete(value, "nodeId") }), "6")
			require.Error(t, err)
			_, err = DecodeHostSessionHubMessage(mutateHostSessionFixture(t, name, func(value map[string]any) { value["commandDigest"] = strings.Repeat("0", 64) }), "6")
			require.Error(t, err)
		})
	}
}

func TestHostSessionJSONIntegerSpellingsShareTheSemanticDigest(t *testing.T) {
	data := string(loadHostSessionFixture(t, "attach"))
	for _, spelling := range []string{"3.0", "3e0"} {
		t.Run(spelling, func(t *testing.T) {
			changed := strings.Replace(data, `"attachmentEpoch": 3`, `"attachmentEpoch": `+spelling, 1)
			require.NotEqual(t, data, changed)
			message, err := DecodeHostSessionHubMessage([]byte(changed), "6")
			require.NoError(t, err)
			require.NotNil(t, message.AttachmentEpoch)
			require.Equal(t, int64(3), *message.AttachmentEpoch)
		})
	}
}

func TestHostSessionCanonicalDigestsDistinguishUnicodeFromLiteralEscapes(t *testing.T) {
	epoch := int64(3)
	base := HostSessionHubMessage{
		Type: "host-session.turn.start", NodeID: "node-one", CommandID: "command-unicode",
		HostHarnessSessionID: "host-session-one", AttachmentEpoch: &epoch, RunID: "run-one",
	}
	cases := []struct {
		name     string
		prompt   string
		expected string
	}{
		{"line separator", "line\u2028separator", "8eee57d3f1a2c21da8f8bf30d833a7d3e74110e01fb979f5c59e8b089927fe0f"},
		{"literal line separator escape", `line\u2028separator`, "cb9994acf757e1a376e7b24828e57f0b7afc7331b88c1a9b7253ee65e3bd1a4f"},
		{"paragraph separator", "paragraph\u2029separator", "c32a072210d400027e93fe2b25b4be0ce49e24577c142f28d1d0e48ffb6dcc33"},
		{"literal paragraph separator escape", `paragraph\u2029separator`, "dabc9357b0e28eb38e4d60140696623f83dd59051756c1b4b02102faba2c32f9"},
		{"backslash then line separator", `line\` + "\u2028" + "separator", "1533b0a298ab90d535428bbb9bd2cda81363b56f95717ad76d6de2ca5c457822"},
	}
	digests := make(map[string]string, len(cases))
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			command := base
			command.Prompt = testCase.prompt
			digest, err := HostHarnessSessionCommandDigest(command)
			require.NoError(t, err)
			require.Equal(t, testCase.expected, digest)
			digests[testCase.name] = digest
		})
	}
	require.NotEqual(t, digests["line separator"], digests["literal line separator escape"])
	require.NotEqual(t, digests["paragraph separator"], digests["literal paragraph separator escape"])
	require.NotEqual(t, digests["literal line separator escape"], digests["backslash then line separator"])
}

func TestHostSessionRegistrationMirrorsTheVersionSixInteractiveProfile(t *testing.T) {
	registration := []byte(`{"type":"register","protocolVersion":"6","node":{"id":"node-one","name":"Local","kind":"local","platform":"linux","status":"online","lastSeen":"2026-09-30T12:00:00Z","activeRuns":0,"concurrency":1,"instanceCapacity":1,"activeInstances":0,"workspaceRoots":["/workspaces"],"harnesses":[{"id":"codex-cli","label":"Codex","description":"Local Codex","available":true,"authMode":"local-subscription","models":["gpt-5"],"interactiveSessions":{"operations":["adopt","create","discover"]}}],"version":"0.1.0"}}`)
	message, err := DecodeInstanceControlMessage(registration, "6")
	require.NoError(t, err)
	roundTrip, err := json.Marshal(message)
	require.NoError(t, err)
	require.JSONEq(t, string(registration), string(roundTrip), "the Go wire struct must preserve the TS-valid profile")

	_, err = DecodeInstanceControlMessage(registration, "5")
	require.Error(t, err, "v5 must reject a v6 registration")
	declaredV5 := []byte(strings.Replace(string(registration), `"protocolVersion":"6"`, `"protocolVersion":"5"`, 1))
	_, err = DecodeInstanceControlMessage(declaredV5, "6")
	require.Error(t, err, "a historical registration cannot advertise a v6-only profile")
	unsorted := []byte(strings.Replace(string(registration), `"adopt","create","discover"`, `"discover","create","adopt"`, 1))
	_, err = DecodeInstanceControlMessage(unsorted, "6")
	require.Error(t, err, "interactive operations must be sorted and unique")
}

func TestHostSessionControlFixturesAreStrictAndVersionSixOnly(t *testing.T) {
	for _, name := range hostSessionControlFixtureNames {
		t.Run(name, func(t *testing.T) {
			data := loadHostSessionFixture(t, name)
			message, err := DecodeHostSessionControlMessage(data, "6")
			require.NoError(t, err)
			roundTrip, err := json.Marshal(message)
			require.NoError(t, err)
			_, err = DecodeHostSessionControlMessage(roundTrip, "6")
			require.NoError(t, err)
			for _, version := range []string{"1", "2", "3", "4", "5", "7", ""} {
				_, err := DecodeHostSessionControlMessage(data, version)
				require.Error(t, err, version)
			}
			_, err = DecodeHostSessionControlMessage(mutateHostSessionFixture(t, name, func(value map[string]any) { value["extra"] = true }), "6")
			require.Error(t, err)
			_, err = DecodeHostSessionControlMessage(mutateHostSessionFixture(t, name, func(value map[string]any) { delete(value, "nodeId") }), "6")
			require.Error(t, err)
		})
	}

	_, err := DecodeHostSessionControlMessage([]byte{'{', '"', 't', 'y', 'p', 'e', '"', ':', '"', 0xff, '"', '}'}, "6")
	require.Error(t, err)
	_, err = DecodeHostSessionControlMessage(append(loadHostSessionFixture(t, "inventory-complete"), []byte(` {}`)...), "6")
	require.Error(t, err, "a second JSON value must not be ignored during normalized decoding")
}

func TestHostSessionObservationTransitionsAndInventoryFailClosed(t *testing.T) {
	page, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "inventory-page"), "6")
	require.NoError(t, err)
	complete, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "inventory-complete"), "6")
	require.NoError(t, err)
	generation, err := ValidateHostHarnessSessionInventoryGeneration([]HostSessionControlMessage{page}, complete)
	require.NoError(t, err)
	require.Len(t, generation.Sessions, 1)
	require.NoError(t, ValidateHostHarnessSessionInventoryTransition(generation, generation))

	changed := generation
	changed.Sessions = append([]HostHarnessSessionObservation(nil), generation.Sessions...)
	changed.Sessions[0].Summary = "changed"
	require.Error(t, ValidateHostHarnessSessionInventoryTransition(generation, changed))

	previous := generation.Sessions[0]
	next := previous
	next.Revision = 2
	next.Status = "running"
	next.UpdatedAt = "2026-09-30T12:01:00Z"
	require.NoError(t, ValidateHostHarnessSessionObservationTransition(previous, next))
	sameStatus := previous
	sameStatus.Revision = 2
	sameStatus.ControlMode = "full"
	sameStatus.Operations = []string{"attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"}
	sameStatus.UpdatedAt = "2026-09-30T12:01:00Z"
	require.NoError(t, ValidateHostHarnessSessionObservationTransition(previous, sameStatus))
	next.Status = "awaiting-approval"
	require.Error(t, ValidateHostHarnessSessionObservationTransition(previous, next))
	terminal := previous
	terminal.Status = "closed"
	terminal.Revision = 2
	next = terminal
	next.Status = "idle"
	next.Revision = 3
	require.Error(t, ValidateHostHarnessSessionObservationTransition(terminal, next))

	_, err = ValidateHostHarnessSessionInventoryGeneration(nil, complete)
	require.Error(t, err, "completion without pages must not replace inventory")
	wrongCount := complete
	wrongCount.SessionCount = 0
	_, err = ValidateHostHarnessSessionInventoryGeneration([]HostSessionControlMessage{page}, wrongCount)
	require.Error(t, err)

	nextPage := page
	nextPage.Generation = generation.Generation + 20
	nextPage.Sessions = append([]HostHarnessSessionObservation(nil), page.Sessions...)
	nextPage.Sessions[0].Revision++
	nextPage.Sessions[0].Status = "running"
	nextPage.Sessions[0].UpdatedAt = "2026-09-30T12:01:00Z"
	nextComplete := complete
	nextComplete.Generation = nextPage.Generation
	nextGeneration, err := ValidateHostHarnessSessionInventoryGeneration([]HostSessionControlMessage{nextPage}, nextComplete)
	require.NoError(t, err)
	require.NoError(t, ValidateHostHarnessSessionInventoryTransition(generation, nextGeneration), "generation values need only increase")
	replacementPage := nextPage
	replacementPage.Generation++
	replacementPage.Sessions = append([]HostHarnessSessionObservation(nil), nextPage.Sessions...)
	replacementPage.Sessions[0].HostHarnessSessionID = "host-session-replacement"
	replacementComplete := nextComplete
	replacementComplete.Generation = replacementPage.Generation
	replacementGeneration, err := ValidateHostHarnessSessionInventoryGeneration([]HostSessionControlMessage{replacementPage}, replacementComplete)
	require.NoError(t, err)
	require.NoError(t, ValidateHostHarnessSessionInventoryTransition(generation, replacementGeneration), "an omitted provider identity may receive a fresh host-session id")
}

func TestHostSessionInventoryAndHistoryCollectionLimits(t *testing.T) {
	pageFixture, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "inventory-page"), "6")
	require.NoError(t, err)
	base := pageFixture.Sessions[0]
	sessions := make([]HostHarnessSessionObservation, HostHarnessSessionLimits.SessionsPerGeneration)
	for index := range sessions {
		session := base
		session.HostHarnessSessionID = fmt.Sprintf("host-session-%04d", index)
		session.ProviderSessionID = fmt.Sprintf("provider-session-%04d", index)
		sessions[index] = session
	}
	pages := make([]HostSessionControlMessage, HostHarnessSessionLimits.PagesPerGeneration)
	for pageIndex := range pages {
		start := pageIndex * HostHarnessSessionLimits.SessionsPerInventoryPage
		end := start + HostHarnessSessionLimits.SessionsPerInventoryPage
		pages[pageIndex] = HostSessionControlMessage{
			Type: "host-session.inventory.page", NodeID: "node-one", Generation: 8, PageIndex: int64(pageIndex),
			Sessions: sessions[start:end], At: "2026-09-30T12:00:00Z",
		}
	}
	complete := HostSessionControlMessage{
		Type: "host-session.inventory.complete", NodeID: "node-one", Generation: 8,
		PageCount:    int64(HostHarnessSessionLimits.PagesPerGeneration),
		SessionCount: int64(HostHarnessSessionLimits.SessionsPerGeneration), At: "2026-09-30T12:00:00Z",
	}
	require.NoError(t, validateHostSessionControlMessageValue(pages[len(pages)-1]))
	require.NoError(t, validateHostSessionControlMessageValue(complete))
	assembled, err := ValidateHostHarnessSessionInventoryGeneration(pages, complete)
	require.NoError(t, err)
	require.Len(t, assembled.Sessions, HostHarnessSessionLimits.SessionsPerGeneration)

	pageOver := pages[0]
	pageOver.Sessions = sessions[:HostHarnessSessionLimits.SessionsPerInventoryPage+1]
	require.Error(t, validateHostSessionControlMessageValue(pageOver))
	pageIndexOver := pages[0]
	pageIndexOver.PageIndex = int64(HostHarnessSessionLimits.PagesPerGeneration)
	require.Error(t, validateHostSessionControlMessageValue(pageIndexOver))
	pageCountOver := complete
	pageCountOver.PageCount++
	require.Error(t, validateHostSessionControlMessageValue(pageCountOver))
	sessionCountOver := complete
	sessionCountOver.SessionCount++
	require.Error(t, validateHostSessionControlMessageValue(sessionCountOver))

	items := make([]HostHarnessSessionHistoryItem, HostHarnessSessionLimits.HistoryItemsPerPage)
	for index := range items {
		items[index] = HostHarnessSessionHistoryItem{ID: fmt.Sprintf("history-%d", index), Kind: "assistant", Text: "bounded"}
	}
	history := HostSessionControlMessage{
		Type: "host-session.history.page", NodeID: "node-one", HostHarnessSessionID: "host-session-one",
		RequestID: "request-history", Items: items, At: "2026-09-30T12:00:00Z",
	}
	require.NoError(t, validateHostSessionControlMessageValue(history))
	historyOver := history
	historyOver.Items = append(append([]HostHarnessSessionHistoryItem(nil), items...),
		HostHarnessSessionHistoryItem{ID: "history-over", Kind: "assistant", Text: "bounded"})
	require.Error(t, validateHostSessionControlMessageValue(historyOver))
}

func TestHostSessionReplayAndCloseOutcomesFailClosed(t *testing.T) {
	command, err := DecodeHostSessionHubMessage(loadHostSessionFixture(t, "turn-start"), "6")
	require.NoError(t, err)
	require.Equal(t, HostHarnessSessionCommandReplayNew, ClassifyHostHarnessSessionCommandReplay(nil, command))
	require.Equal(t, HostHarnessSessionCommandReplayReplay, ClassifyHostHarnessSessionCommandReplay(&command, command))

	changedBytes := mutateHostSessionFixture(t, "turn-start", func(value map[string]any) {
		value["prompt"] = "Different"
		delete(value, "commandDigest")
	})
	var changed HostSessionHubMessage
	require.NoError(t, json.Unmarshal(changedBytes, &changed))
	changed.CommandDigest, err = HostHarnessSessionCommandDigest(changed)
	require.NoError(t, err)
	require.Equal(t, HostHarnessSessionCommandReplayConflict, ClassifyHostHarnessSessionCommandReplay(&command, changed))

	differentCommand := command
	differentCommand.CommandID = "command-other"
	differentCommand.CommandDigest = ""
	differentCommand.CommandDigest, err = HostHarnessSessionCommandDigest(differentCommand)
	require.NoError(t, err)
	require.Equal(t, HostHarnessSessionCommandReplayConflict, ClassifyHostHarnessSessionCommandReplay(&command, differentCommand),
		"a lookup collision on a different command ID must fail closed")

	startResult, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "command-result-start"), "6")
	require.NoError(t, err)
	require.NoError(t, ValidateHostHarnessSessionCommandResponse(command, startResult))
	wrongEpoch := startResult
	wrongEpochValue := *startResult.AttachmentEpoch + 1
	wrongEpoch.AttachmentEpoch = &wrongEpochValue
	require.Error(t, ValidateHostHarnessSessionCommandResponse(command, wrongEpoch))
	wrongCommand := startResult
	wrongCommand.CommandID = "command-other"
	require.Error(t, ValidateHostHarnessSessionCommandResponse(command, wrongCommand))

	emptyPrompt := command
	emptyPrompt.Prompt = ""
	emptyPrompt.CommandDigest = ""
	emptyPrompt.CommandDigest, err = HostHarnessSessionCommandDigest(emptyPrompt)
	require.NoError(t, err)
	emptyPromptBytes, err := json.Marshal(emptyPrompt)
	require.NoError(t, err)
	_, err = DecodeHostSessionHubMessage(emptyPromptBytes, "6")
	require.NoError(t, err, "a required but empty bounded prompt must survive Go round-trip")

	closeResult := mutateHostSessionFixture(t, "command-result-close", func(value map[string]any) { value["outcome"] = "uncertain" })
	_, err = DecodeHostSessionControlMessage(closeResult, "6")
	require.Error(t, err, "uncertain close cannot manufacture closed")

	uncertainStartResult := mutateHostSessionFixture(t, "command-result-start", func(value map[string]any) { value["outcome"] = "uncertain" })
	_, err = DecodeHostSessionControlMessage(uncertainStartResult, "6")
	require.Error(t, err, "uncertain start cannot claim a provider turn")
}

func TestHostSessionEventCorrelationFencesTheOnlyWriter(t *testing.T) {
	event, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "harness-event"), "6")
	require.NoError(t, err)
	page, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "inventory-page"), "6")
	require.NoError(t, err)
	orchestrator, err := DecodeHostHarnessSessionThreadOrchestrator(loadHostSessionFixture(t, "thread-orchestrator"), "6")
	require.NoError(t, err)
	run, err := DecodeHostHarnessSessionRun(loadHostSessionFixture(t, "runtime-run"), "6", orchestrator)
	require.NoError(t, err)
	providerTurn := "provider-turn-one"
	run.Status = "running"
	run.ProviderTurnID = &providerTurn
	session := HostHarnessSession{
		HostHarnessSessionObservation: page.Sessions[0],
		AttachedThreadID:              run.ThreadID,
		ActiveRunID:                   run.ID,
		AttachmentEpoch:               *event.AttachmentEpoch,
	}
	session.Status = "running"
	session.Revision = 2
	session.ProviderTurnID = providerTurn
	session.UpdatedAt = "2026-09-30T12:01:00Z"
	require.NoError(t, ValidateHostHarnessSessionEventCorrelation(event, session, run))

	wrongEpoch := event
	stale := *event.AttachmentEpoch - 1
	wrongEpoch.AttachmentEpoch = &stale
	require.Error(t, ValidateHostHarnessSessionEventCorrelation(wrongEpoch, session, run))
	queued := run
	queued.Status = "queued"
	queued.ProviderTurnID = nil
	require.Error(t, ValidateHostHarnessSessionEventCorrelation(event, session, queued))
	terminal := run
	terminal.Status = "completed"
	require.Error(t, ValidateHostHarnessSessionEventCorrelation(event, session, terminal))
}

func TestHostSessionBoundsAndSecretScreeningUseUTF8Bytes(t *testing.T) {
	data := mutateHostSessionFixture(t, "inventory-page", func(value map[string]any) {
		session := value["sessions"].([]any)[0].(map[string]any)
		session["hostHarnessSessionId"] = strings.Repeat("é", 128) + "a"
	})
	_, err := DecodeHostSessionControlMessage(data, "6")
	require.Error(t, err)

	data = mutateHostSessionFixture(t, "inventory-page", func(value map[string]any) {
		session := value["sessions"].([]any)[0].(map[string]any)
		session["providerSessionId"] = "sk-live_123456789012345"
	})
	_, err = DecodeHostSessionControlMessage(data, "6")
	require.Error(t, err)

	data = mutateHostSessionFixture(t, "harness-event", func(value map[string]any) {
		event := value["event"].(map[string]any)
		event["text"] = "Bearer abcdefghijklmnopqrstuvwxyz"
	})
	_, err = DecodeHostSessionControlMessage(data, "6")
	require.Error(t, err)
}

func TestHostSessionTurnPromptFieldsUseExactUTF8ByteBoundary(t *testing.T) {
	exact := strings.Repeat("é", HostHarnessSessionLimits.PromptBytes/2)
	over := exact + "a"
	tests := []struct {
		fixture string
		set     func(*HostSessionHubMessage, string)
	}{
		{fixture: "turn-start", set: func(message *HostSessionHubMessage, value string) { message.Prompt = value }},
		{fixture: "turn-steer", set: func(message *HostSessionHubMessage, value string) { message.Text = value }},
	}
	for _, test := range tests {
		t.Run(test.fixture, func(t *testing.T) {
			// Start from the exact language-neutral command producer shape and vary only its bounded field.
			var message HostSessionHubMessage
			require.NoError(t, json.Unmarshal(loadHostSessionFixture(t, test.fixture), &message))
			test.set(&message, exact)
			message.CommandDigest = ""
			digest, err := HostHarnessSessionCommandDigest(message)
			require.NoError(t, err)
			message.CommandDigest = digest
			data, err := json.Marshal(message)
			require.NoError(t, err)
			_, err = DecodeHostSessionHubMessage(data, "6")
			require.NoError(t, err, "65,536 UTF-8 bytes must be accepted")

			test.set(&message, over)
			message.CommandDigest = ""
			_, err = HostHarnessSessionCommandDigest(message)
			require.Error(t, err, "65,537 UTF-8 bytes must be rejected")
		})
	}
}

func slicesContain(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
