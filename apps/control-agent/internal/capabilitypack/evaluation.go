package capabilitypack

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
)

// EvaluationSchemaVersion is the only evaluation fixture generation this validator supports.
const EvaluationSchemaVersion = "1"

// Evaluation prompt classes. Every skill must carry at least one case of each: a pack that only
// proved its skill activates has proved nothing about the cases where activating, guessing, or
// claiming success would be wrong.
const (
	// EvaluationClassDirect is a request that names the workflow outright.
	EvaluationClassDirect = "direct"
	// EvaluationClassIndirect is a request that implies the workflow without naming it.
	EvaluationClassIndirect = "indirect"
	// EvaluationClassIncomplete is a request missing an input the workflow needs.
	EvaluationClassIncomplete = "incomplete"
	// EvaluationClassUnrelated is a request the skill must not activate for, including one that
	// explicitly chooses another workflow.
	EvaluationClassUnrelated = "unrelated"
	// EvaluationClassEdge is a boundary case: a tool the run does not serve, an ambiguous scope, or a
	// request that sits just outside the workflow.
	EvaluationClassEdge = "edge"
	// EvaluationClassAuthorizationBoundary is a request whose tool result refuses on authorization
	// grounds, or that asks the skill to widen its own authority.
	EvaluationClassAuthorizationBoundary = "authorization-boundary"
)

// EvaluationClasses is the single enumeration of prompt classes, so the coverage check and the
// per-class expectation rules cannot disagree about which classes exist.
var EvaluationClasses = []string{
	EvaluationClassDirect,
	EvaluationClassIndirect,
	EvaluationClassIncomplete,
	EvaluationClassUnrelated,
	EvaluationClassEdge,
	EvaluationClassAuthorizationBoundary,
}

// Evaluation outcomes. They are a closed vocabulary because an outcome nobody enumerated could not
// be asserted against, and "the model did something reasonable" is not an assertion.
const (
	// OutcomeFollowWorkflow means the skill activates and runs its documented workflow.
	OutcomeFollowWorkflow = "follow-workflow"
	// OutcomeRequestMissingInput means the skill activates and asks for the missing input rather than
	// inventing a task id, thread id, or artifact.
	OutcomeRequestMissingInput = "request-missing-input"
	// OutcomeReportUnsupportedCapability means the skill reports that the run does not serve a tool it
	// needs and stops, substituting no other tool.
	OutcomeReportUnsupportedCapability = "report-unsupported-capability"
	// OutcomeReportRefusal means the skill reports an authorization refusal and stops, without
	// retrying with broader scope and without claiming success.
	OutcomeReportRefusal = "report-refusal"
	// OutcomeNoActivation means the skill does not activate at all.
	OutcomeNoActivation = "no-activation"
)

// EvaluationOutcomes is the single enumeration of outcomes.
var EvaluationOutcomes = []string{
	OutcomeFollowWorkflow,
	OutcomeRequestMissingInput,
	OutcomeReportUnsupportedCapability,
	OutcomeReportRefusal,
	OutcomeNoActivation,
}

// EvaluationCase is one prompt and the behavior it must produce.
type EvaluationCase struct {
	ID        string `json:"id"`
	Class     string `json:"class"`
	Prompt    string `json:"prompt"`
	Activates bool   `json:"activates"`
	Outcome   string `json:"outcome"`
	// ClaimsSuccess is always false and is stated explicitly: for a refusal or an unsupported
	// capability, "did not claim success" is the assertion that matters, so the fixture records it
	// rather than leaving it implied.
	ClaimsSuccess bool `json:"claimsSuccess"`
}

// EvaluationSuite is one skill's evaluation fixture.
type EvaluationSuite struct {
	EvaluationSchemaVersion string           `json:"evaluationSchemaVersion"`
	SkillID                 string           `json:"skillId"`
	Cases                   []EvaluationCase `json:"cases"`
}

const maximumEvaluationPromptBytes = 512

// ParseEvaluationSuite strictly decodes an evaluation fixture. An unknown generation, an unknown
// field, trailing data, an unknown class or outcome, and any expectation that contradicts its class
// are rejected: an evaluation nobody can fail is not evidence.
func ParseEvaluationSuite(path string, data []byte) (EvaluationSuite, error) {
	var suite EvaluationSuite
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&suite); err != nil {
		return EvaluationSuite{}, fmt.Errorf("decode evaluation fixture %s: %s", path, screenDetail(err.Error()))
	}
	if decoder.More() {
		return EvaluationSuite{}, fmt.Errorf("decode evaluation fixture %s: trailing data after the object", path)
	}
	if suite.EvaluationSchemaVersion != EvaluationSchemaVersion {
		return EvaluationSuite{}, fmt.Errorf("evaluation fixture %s declares an absent or unknown schema generation; only generation %q is supported", path, EvaluationSchemaVersion)
	}
	return suite, nil
}

// validate holds one fixture to its skill and to the per-class expectation rules.
func (suite EvaluationSuite) validate(path string, skillID string) error {
	if suite.SkillID != skillID {
		return fmt.Errorf("evaluation fixture %s declares a different skill id than the skill that names it", path)
	}
	if len(suite.Cases) == 0 {
		return fmt.Errorf("evaluation fixture %s declares no cases", path)
	}
	seenIDs := map[string]bool{}
	covered := map[string]bool{}
	for index, evaluation := range suite.Cases {
		if evaluation.ID == "" || seenIDs[evaluation.ID] {
			return fmt.Errorf("evaluation fixture %s case at index %d: id is empty or duplicated", path, index)
		}
		seenIDs[evaluation.ID] = true
		if !slices.Contains(EvaluationClasses, evaluation.Class) {
			return fmt.Errorf("evaluation fixture %s case at index %d: class is absent or unknown", path, index)
		}
		if !slices.Contains(EvaluationOutcomes, evaluation.Outcome) {
			return fmt.Errorf("evaluation fixture %s case at index %d: outcome is absent or unknown", path, index)
		}
		if evaluation.Prompt == "" || len(evaluation.Prompt) > maximumEvaluationPromptBytes {
			return fmt.Errorf("evaluation fixture %s case at index %d: prompt is empty or exceeds %d bytes", path, index, maximumEvaluationPromptBytes)
		}
		if evaluation.ClaimsSuccess {
			return fmt.Errorf("evaluation fixture %s case at index %d: claimsSuccess must be false; a skill never claims an action it did not complete", path, index)
		}
		if (evaluation.Outcome == OutcomeNoActivation) == evaluation.Activates {
			return fmt.Errorf("evaluation fixture %s case at index %d: activates and outcome contradict each other", path, index)
		}
		if err := evaluation.validateClassExpectation(path, index); err != nil {
			return err
		}
		covered[evaluation.Class] = true
	}
	for _, class := range EvaluationClasses {
		if !covered[class] {
			return fmt.Errorf("evaluation fixture %s covers no %s prompt", path, class)
		}
	}
	return nil
}

// validateClassExpectation is the per-class rule table. It is what makes the fixtures assertions
// rather than notes: an unrelated prompt must assert non-activation, an incomplete prompt must assert
// a request for the missing input, and an authorization refusal must assert the refusal is reported.
func (evaluation EvaluationCase) validateClassExpectation(path string, index int) error {
	allowed := map[string][]string{
		EvaluationClassDirect:                {OutcomeFollowWorkflow},
		EvaluationClassIndirect:              {OutcomeFollowWorkflow},
		EvaluationClassIncomplete:            {OutcomeRequestMissingInput},
		EvaluationClassUnrelated:             {OutcomeNoActivation},
		EvaluationClassEdge:                  {OutcomeFollowWorkflow, OutcomeReportUnsupportedCapability, OutcomeNoActivation},
		EvaluationClassAuthorizationBoundary: {OutcomeReportRefusal},
	}
	outcomes, known := allowed[evaluation.Class]
	if !known {
		// Unreachable while EvaluationClasses and this table agree; a class added without a rule fails
		// closed rather than accepting any outcome.
		return fmt.Errorf("evaluation fixture %s case at index %d: class has no expectation rule", path, index)
	}
	if !slices.Contains(outcomes, evaluation.Outcome) {
		return fmt.Errorf("evaluation fixture %s case at index %d: a %s prompt cannot expect outcome %s", path, index, evaluation.Class, evaluation.Outcome)
	}
	return nil
}
