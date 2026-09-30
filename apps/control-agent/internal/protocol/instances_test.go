package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/stretchr/testify/require"
)

const instanceFixtureDirectory = "../../../../packages/protocol/test/fixtures/control-v5"
const instanceAt = "2026-09-24T12:00:00Z"

func instancePointer[T any](value T) *T { return &value }

// instanceFixtureProducer exercises the real Go wire structs and encoding/json producer.
// The committed fixtures are its exact output, not separately maintained JSON examples.
func instanceFixtureProducer() map[string]any {
	i := AgentInstance{
		ID: "instance-one", ThreadID: "thread-one",
		Creator:      InstanceCreator{Kind: "operator", OperatorID: "operator-one"},
		Purpose:      &InstancePurpose{Name: instancePointer("Issue 73 Developer"), Instructions: instancePointer("Implement the shared contracts.")},
		Delegation:   InstanceDelegationPolicy{CanDelegate: false},
		Requirements: InstanceExecutionRequirements{TemplateID: instancePointer("template-one"), HarnessIDs: instancePointer([]string{"claude-cli"}), OperatingSystems: instancePointer([]string{"darwin"})},
		Lease:        InstanceLease{IdleTimeoutSeconds: DefaultInstanceIdleTimeoutSeconds, ExpiresAt: "2026-09-24T12:30:00Z"},
		Status:       "provisioning", CreatedAt: instanceAt, UpdatedAt: instanceAt,
	}
	a := InstanceAllocation{
		ID: "allocation-one", InstanceID: i.ID, NodeID: "node-one", HarnessID: "claude-cli", Model: "fable",
		Transport: "native-cli", Workspace: "/workspace", Lease: i.Lease, Status: "provisioning", CreatedAt: instanceAt, UpdatedAt: instanceAt,
	}
	provision := InstanceHubMessage{Type: "instance.provision", Instance: instancePointer(i), Allocation: instancePointer(a)}
	i.Status = "ready"
	a.Status = "active"
	dispatch := InstanceHubMessage{Type: "dispatch", Instance: instancePointer(i), Allocation: instancePointer(a), Run: &InstanceRun{
		ID: "run-one", ThreadID: i.ThreadID, InstanceID: i.ID, AllocationID: a.ID, NodeID: a.NodeID, HarnessID: a.HarnessID, Model: a.Model,
		Workspace: a.Workspace, Transport: a.Transport, Prompt: "Implement the shared contracts.", Status: "queued", Output: "", Depth: 0, CreatedAt: instanceAt,
	}}
	packInstance := i
	packSkills := []string{"coffeeshop-review", "coffeeshop-preview"}
	packInstance.Requirements.Skills = &packSkills
	packAllocation := a
	packAllocation.ExpectedCapabilityPack = &ExpectedCapabilityPack{
		ID: "coffeeshop-capability-pack", Version: "1.2.0",
		RequiredSkills: []string{"coffeeshop-preview", "coffeeshop-review", "template-skill"},
	}
	packProvisionInstance := packInstance
	packProvisionInstance.Status = "provisioning"
	packProvisionAllocation := packAllocation
	packProvisionAllocation.Status = "provisioning"
	packProvision := InstanceHubMessage{Type: "instance.provision", Instance: instancePointer(packProvisionInstance), Allocation: instancePointer(packProvisionAllocation)}
	packDispatch := dispatch
	packDispatch.Instance = instancePointer(packInstance)
	packDispatch.Allocation = instancePointer(packAllocation)
	sessionBindingID := "session-one"
	resumeRun := *dispatch.Run
	resumeAllocation := *dispatch.Allocation
	resumeRun.Transport = "acp-v1"
	resumeAllocation.Transport = "acp-v1"
	resumeRun.SessionBindingID = &sessionBindingID
	dispatchResume := InstanceHubMessage{Type: "dispatch", Instance: dispatch.Instance, Allocation: &resumeAllocation, Run: &resumeRun, SessionBinding: &DispatchSessionBinding{
		ID: sessionBindingID, ProviderSessionID: "provider-session-one", ResumePrompt: "Continue the shared contracts.",
	}}
	result := map[string]any{
		"provision": provision, "provision-pack": packProvision, "dispatch": dispatch, "dispatch-pack": packDispatch, "dispatch-resume": dispatchResume,
		"release":         InstanceHubMessage{Type: "instance.release", InstanceID: i.ID, AllocationID: a.ID, Mode: "drain"},
		"heartbeat":       InstanceControlMessage{Type: "heartbeat", NodeID: a.NodeID, ActiveRuns: instancePointer(0), ActiveInstances: instancePointer(1), ActiveInstanceIDs: instancePointer([]string{i.ID}), At: instanceAt},
		"heartbeat-empty": InstanceControlMessage{Type: "heartbeat", NodeID: a.NodeID, ActiveRuns: instancePointer(0), ActiveInstances: instancePointer(0), ActiveInstanceIDs: instancePointer([]string{}), At: instanceAt},
		"sync":            Outbound{Type: "sync.complete", NodeID: a.NodeID, ActiveRunIDs: instancePointer([]string{}), ActiveInstanceIDs: instancePointer([]string{i.ID}), At: instanceAt},
		"sync-empty":      Outbound{Type: "sync.complete", NodeID: a.NodeID, ActiveInstanceIDs: instancePointer([]string{}), At: instanceAt},
		"sync-absent":     Outbound{Type: "sync.complete", NodeID: a.NodeID, At: instanceAt},
		// register is produced from Outbound, the struct controlplane.Client.attach actually writes.
		// Producing it from InstanceControlMessage instead hid a real defect: that struct's
		// ActiveRuns is a pointer, so the fixture carried three top-level keys and passed the v5
		// validator, while Outbound's non-pointer ActiveRuns put a fourth key on every real frame
		// and a v5 hub refused it. A fixture must come from the producer it claims to represent.
		"register": Outbound{Type: "register", ProtocolVersion: Version, Node: &ComputeNode{
			ID: a.NodeID, Name: "Build Mac", Kind: "local", Platform: "darwin/arm64", Status: "online", LastSeen: instanceAt,
			ActiveRuns: 0, Concurrency: 2, InstanceCapacity: instancePointer(4), ActiveInstances: instancePointer(1),
			WorkspaceRoots: []string{"/workspace"}, Harnesses: []HarnessProfile{{ID: "claude-cli", Label: "Claude", Description: "Local account", Available: true, AuthMode: "local-subscription", Models: []string{"fable"}}}, Version: "0.1.0",
		}},
		"create":   InstanceLifecycleRequest{Operation: "create", ThreadID: i.ThreadID, Idempotency: InstanceIdempotency{Caller: i.Creator, Key: "create-one"}, Purpose: i.Purpose, Requirements: &i.Requirements, InitialTask: &InstanceInitialTask{Title: "Contracts", Instructions: "Implement the shared contracts."}},
		"template": AgentTemplate{ID: "template-one", Name: "Developer", Purpose: i.Purpose, Skills: instancePointer([]string{}), Requirements: &i.Requirements},
	}
	for _, name := range []string{"ready", "released", "failed"} {
		message := InstanceControlMessage{Type: "instance." + name, NodeID: a.NodeID, InstanceID: i.ID, AllocationID: a.ID, At: instanceAt}
		if name == "failed" {
			message.Error = instancePointer("workspace unavailable")
		}
		result[name] = message
	}
	return result
}

func TestInstanceProducerFixtures(t *testing.T) {
	for name, produced := range instanceFixtureProducer() {
		t.Run(name, func(t *testing.T) {
			encoded, err := json.MarshalIndent(produced, "", "  ")
			require.NoError(t, err)
			encoded = append(encoded, '\n')
			if os.Getenv("INSTANCE_FIXTURE_PRINT") == "1" {
				record, err := json.Marshal(map[string]string{"name": name, "data": string(encoded)})
				require.NoError(t, err)
				fmt.Println("INSTANCE_FIXTURE " + string(record))
				return
			}
			data, err := os.ReadFile(filepath.Join(instanceFixtureDirectory, name+".json"))
			require.NoError(t, err)
			require.Equal(t, string(data), string(encoded), "fixture must be real producer output byte-for-byte")
			var decoded any
			switch name {
			case "provision", "provision-pack", "dispatch", "dispatch-pack", "dispatch-resume", "release":
				decoded, err = DecodeInstanceHubMessage(data, "5")
				_, compatibleError := DecodeInstanceHubMessage(data, "6")
				require.NoError(t, compatibleError, "v6 must accept a historical v5 hub frame")
				_, legacyError := DecodeInbound(data)
				require.Error(t, legacyError, "the legacy decoder must not erase instance identity")
				for _, version := range []string{"1", "2", "3", "4", ""} {
					_, rejected := DecodeInstanceHubMessage(data, version)
					require.Error(t, rejected)
				}
			case "create":
				decoded, err = DecodeInstanceLifecycleRequest(data)
			case "template":
				decoded, err = DecodeAgentTemplate(data)
			default:
				decoded, err = DecodeInstanceControlMessage(data, "5")
				_, compatibleError := DecodeInstanceControlMessage(data, "6")
				require.NoError(t, compatibleError, "v6 must accept a historical v5 control frame")
				for _, version := range []string{"1", "2", "3", "4", ""} {
					_, rejected := DecodeInstanceControlMessage(data, version)
					require.Error(t, rejected)
				}
			}
			require.NoError(t, err)
			roundtrip, err := json.MarshalIndent(decoded, "", "  ")
			require.NoError(t, err)
			require.Equal(t, string(data), string(append(roundtrip, '\n')))
		})
	}
}

func TestSkillBoundInstanceMessagesRequireCoveringPackExpectation(t *testing.T) {
	message := instanceFixtureProducer()["provision"].(InstanceHubMessage)
	skills := []string{"coffeeshop-review", "coffeeshop-preview"}
	message.Instance.Requirements.Skills = &skills
	encoded, err := json.Marshal(message)
	require.NoError(t, err)
	_, err = DecodeInstanceHubMessage(encoded, "5")
	require.Error(t, err)

	message.Allocation.ExpectedCapabilityPack = &ExpectedCapabilityPack{
		ID: "coffeeshop-capability-pack", Version: "1.2.0", RequiredSkills: []string{"coffeeshop-preview", "coffeeshop-review", "template-skill"},
	}
	encoded, err = json.Marshal(message)
	require.NoError(t, err)
	_, err = DecodeInstanceHubMessage(encoded, "5")
	require.NoError(t, err)

	message.Allocation.ExpectedCapabilityPack.RequiredSkills = []string{"coffeeshop-preview"}
	encoded, err = json.Marshal(message)
	require.NoError(t, err)
	_, err = DecodeInstanceHubMessage(encoded, "5")
	require.Error(t, err)

	message.Instance.Requirements.Skills = nil
	message.Allocation.ExpectedCapabilityPack.RequiredSkills = []string{"template-skill"}
	encoded, err = json.Marshal(message)
	require.NoError(t, err)
	require.Error(t, ValidateCurrentInstanceHubMessage(message), "a current no-skill allocation cannot carry an expectation")
	decoded, err := DecodeInstanceHubMessage(encoded, "5")
	require.NoError(t, err, "one release accepts an old Hub's in-flight frame")
	require.Nil(t, decoded.Allocation.ExpectedCapabilityPack, "the obsolete expectation is ignored, never readiness authority")
}

func TestInstanceVocabularyAndTransitionsMatchTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(instanceFixtureDirectory, "vocabulary.json"))
	require.NoError(t, err)
	var vocabulary struct {
		InstanceStatuses            []string            `json:"instanceStatuses"`
		AllocationStatuses          []string            `json:"allocationStatuses"`
		InstanceReleaseModes        []string            `json:"instanceReleaseModes"`
		InstanceCreatorKinds        []string            `json:"instanceCreatorKinds"`
		InstanceLifecycleOperations []string            `json:"instanceLifecycleOperations"`
		InstanceHubMessageTypes     []string            `json:"instanceHubMessageTypes"`
		InstanceControlMessageTypes []string            `json:"instanceControlMessageTypes"`
		InstanceTransitions         map[string][]string `json:"instanceTransitions"`
		AllocationTransitions       map[string][]string `json:"allocationTransitions"`
		InstanceLimits              map[string]int      `json:"instanceLimits"`
	}
	require.NoError(t, json.Unmarshal(data, &vocabulary))
	require.Equal(t, vocabulary.InstanceStatuses, InstanceStatuses)
	require.Equal(t, vocabulary.AllocationStatuses, AllocationStatuses)
	require.Equal(t, vocabulary.InstanceReleaseModes, InstanceReleaseModes)
	require.Equal(t, vocabulary.InstanceCreatorKinds, InstanceCreatorKinds)
	require.Equal(t, vocabulary.InstanceLifecycleOperations, InstanceLifecycleOperations)
	require.Equal(t, vocabulary.InstanceHubMessageTypes, InstanceHubMessageTypes)
	require.Equal(t, vocabulary.InstanceControlMessageTypes, InstanceControlMessageTypes)
	for _, from := range InstanceStatuses {
		for _, to := range InstanceStatuses {
			require.Equal(t, slices.Contains(vocabulary.InstanceTransitions[from], to), CanTransitionInstance(from, to), "%s -> %s", from, to)
		}
	}
	for _, from := range AllocationStatuses {
		for _, to := range AllocationStatuses {
			require.Equal(t, slices.Contains(vocabulary.AllocationTransitions[from], to), CanTransitionAllocation(from, to), "%s -> %s", from, to)
		}
	}
	require.Equal(t, map[string]int{
		"identifierBytes": identifierBytes, "nameBytes": InstanceNameBytes, "summaryBytes": InstanceSummaryBytes, "instructionsBytes": InstanceInstructionsBytes,
		"idempotencyKeyBytes": InstanceIdempotencyKeyBytes, "workspaceBytes": InstanceWorkspaceBytes, "collectionEntries": InstanceCollectionEntries,
		"requirementEntries": InstanceRequirementEntries, "count": InstanceCountMaximum, "minimumIdleTimeoutSeconds": MinimumInstanceIdleTimeoutSeconds,
		"defaultIdleTimeoutSeconds": DefaultInstanceIdleTimeoutSeconds, "maximumIdleTimeoutSeconds": MaximumInstanceIdleTimeoutSeconds,
	}, vocabulary.InstanceLimits)
}

func TestInstanceReconciliationEvidence(t *testing.T) {
	for _, name := range []string{"sync", "sync-empty", "sync-absent"} {
		data, err := os.ReadFile(filepath.Join(instanceFixtureDirectory, name+".json"))
		require.NoError(t, err)
		message, err := DecodeInstanceControlMessage(data, "5")
		require.NoError(t, err)
		require.Equal(t, name != "sync-absent", message.HasAuthoritativeInstanceEvidence())
	}
	for _, name := range []string{"heartbeat", "heartbeat-empty"} {
		data, err := os.ReadFile(filepath.Join(instanceFixtureDirectory, name+".json"))
		require.NoError(t, err)
		message, err := DecodeInstanceControlMessage(data, "5")
		require.NoError(t, err)
		require.True(t, message.HasAuthoritativeInstanceEvidence(), "%s carries resident identity evidence", name)
	}
}

// The shared malformed corpus is generated through TypeScript's real encoder from the Go
// producer fixtures, then consumed unchanged by both language validators.
func TestInstanceSharedRejections(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(instanceFixtureDirectory, "invalid.json"))
	require.NoError(t, err)
	var cases []struct {
		Name  string          `json:"name"`
		Kind  string          `json:"kind"`
		Value json.RawMessage `json:"value"`
	}
	require.NoError(t, json.Unmarshal(data, &cases))
	require.Greater(t, len(cases), 20)
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			switch item.Kind {
			case "hub":
				_, err = DecodeInstanceHubMessage(item.Value, "5")
			case "control":
				_, err = DecodeInstanceControlMessage(item.Value, "5")
			case "lifecycle":
				_, err = DecodeInstanceLifecycleRequest(item.Value)
			case "instance":
				_, err = DecodeAgentInstance(item.Value)
			case "allocation":
				_, err = DecodeInstanceAllocation(item.Value)
			case "template":
				_, err = DecodeAgentTemplate(item.Value)
			default:
				t.Fatalf("unknown corpus kind %s", item.Kind)
			}
			require.Error(t, err)
		})
	}
}
