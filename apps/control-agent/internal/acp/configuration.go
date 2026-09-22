package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrConfigRejected reports that the adapter does not offer, or refused, a configuration value the
// run explicitly requested. Barista never substitutes the adapter's default for it.
var ErrConfigRejected = errors.New("acp adapter rejected the requested session configuration")

// maximumConfigValues bounds the values Barista reads from one session configuration option.
const maximumConfigValues = 256

// ConfigRequirement says what an unsatisfiable ConfigSelection means for the run.
type ConfigRequirement int

const (
	// ConfigPolicy marks Barista-owned execution policy, such as the sandbox and approval preset.
	// An adapter that cannot apply it lacks a capability Barista requires (ErrMissingCapability).
	ConfigPolicy ConfigRequirement = iota
	// ConfigRequested marks a value the run asked for, such as a model. An adapter that cannot
	// apply it rejected the request (ErrConfigRejected).
	ConfigRequested
)

// ConfigSelection sets one ACP session configuration option to one of its offered values before
// the prompt is sent. The option identifier and value must come from Barista's compiled-in
// provider policy or the dispatched run, never from the adapter.
type ConfigSelection struct {
	ID          string
	Value       string
	Requirement ConfigRequirement
}

func (selection ConfigSelection) failure(format string) error {
	cause := ErrMissingCapability
	if selection.Requirement == ConfigRequested {
		cause = ErrConfigRejected
	}
	return fmt.Errorf("%w: "+format, cause, selection.ID)
}

// configState is the adapter's current value and offered values for each configuration option.
type configState map[string]configOptionState

type configOptionState struct {
	current string
	offered map[string]bool
}

func newConfigState(options []sessionConfigOption) configState {
	state := configState{}
	for _, option := range options {
		if option.ID == "" || len(option.ID) > eventIdentifierBytes {
			continue
		}
		var current string
		if json.Unmarshal(option.CurrentValue, &current) != nil {
			continue
		}
		state[option.ID] = configOptionState{current: current, offered: offeredValues(option.Options)}
	}
	return state
}

// offeredValues flattens a select option's values, accepting both the flat and the grouped shape.
func offeredValues(raw json.RawMessage) map[string]bool {
	offered := map[string]bool{}
	var entries []sessionConfigValue
	if json.Unmarshal(raw, &entries) != nil {
		return offered
	}
	for _, entry := range entries {
		if len(offered) >= maximumConfigValues {
			break
		}
		if entry.Value != nil {
			offered[*entry.Value] = true
			continue
		}
		if entry.Group == nil {
			continue
		}
		var grouped []sessionConfigValue
		if json.Unmarshal(entry.Options, &grouped) != nil {
			continue
		}
		for _, value := range grouped {
			if value.Value != nil && len(offered) < maximumConfigValues {
				offered[*value.Value] = true
			}
		}
	}
	return offered
}

// configure applies every selection and then confirms that all of them hold together, since
// changing one option may reset another.
func (client *Client) configure(ctx context.Context, sessionID string, state configState, selections []ConfigSelection) error {
	for _, selection := range selections {
		option, offered := state[selection.ID]
		if !offered {
			return selection.failure("adapter offers no %s session option")
		}
		if !option.offered[selection.Value] {
			return selection.failure("adapter does not offer the required value for its %s session option")
		}
		if option.current == selection.Value {
			continue
		}
		requestContext, cancel := context.WithTimeout(ctx, client.options.RequestTimeout)
		var response setConfigOptionResponse
		err := client.peer.call(requestContext, methodSetConfigOption, setConfigOptionRequest{SessionID: sessionID, ConfigID: selection.ID, Value: selection.Value}, &response)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("%w before %s completed", ErrCancelled, methodSetConfigOption)
			}
			var responseError *ResponseError
			if errors.As(err, &responseError) {
				return selection.failure("adapter refused to set its %s session option")
			}
			return client.setupError(ctx, methodSetConfigOption, err)
		}
		state = newConfigState(response.ConfigOptions)
	}
	for _, selection := range selections {
		if state[selection.ID].current != selection.Value {
			return selection.failure("adapter did not apply the required value for its %s session option")
		}
	}
	return nil
}
