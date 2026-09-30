package protocol

import (
	"encoding/json"
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
	nextPage.Generation = generation.Generation + 2
	nextPage.Sessions = append([]HostHarnessSessionObservation(nil), page.Sessions...)
	nextPage.Sessions[0].Revision++
	nextPage.Sessions[0].Status = "running"
	nextPage.Sessions[0].UpdatedAt = "2026-09-30T12:01:00Z"
	nextComplete := complete
	nextComplete.Generation = nextPage.Generation
	nextGeneration, err := ValidateHostHarnessSessionInventoryGeneration([]HostSessionControlMessage{nextPage}, nextComplete)
	require.NoError(t, err)
	require.Error(t, ValidateHostHarnessSessionInventoryTransition(generation, nextGeneration), "generation gaps fail closed")
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

	startResult, err := DecodeHostSessionControlMessage(loadHostSessionFixture(t, "command-result-start"), "6")
	require.NoError(t, err)
	require.NoError(t, ValidateHostHarnessSessionCommandResponse(command, startResult))
	wrongEpoch := startResult
	wrongEpochValue := *startResult.AttachmentEpoch + 1
	wrongEpoch.AttachmentEpoch = &wrongEpochValue
	require.Error(t, ValidateHostHarnessSessionCommandResponse(command, wrongEpoch))

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

func slicesContain(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
