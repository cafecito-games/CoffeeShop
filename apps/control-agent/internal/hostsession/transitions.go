package hostsession

import (
	"fmt"
	"slices"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

func requireTransition(from, to string) error {
	if protocol.CanTransitionHostHarnessSession(from, to) {
		return nil
	}
	return fmt.Errorf("%w: %s to %s", ErrInvalidTransition, from, to)
}

func supports(values []string, operation string) bool { return slices.Contains(values, operation) }

func validateCapabilities(capabilities Capabilities) error {
	if len(capabilities.DriverOperations) > len(protocol.HostHarnessDriverOperations) || len(capabilities.SessionOperations) > protocol.HostHarnessSessionLimits.OperationCapabilities {
		return ErrInvalidObservation
	}
	if !sortedVocabulary(capabilities.DriverOperations, protocol.HostHarnessDriverOperations) || !sortedVocabulary(capabilities.SessionOperations, protocol.HostHarnessSessionOperations) {
		return ErrInvalidObservation
	}
	return nil
}

func sortedVocabulary(values, vocabulary []string) bool {
	for index, value := range values {
		if !slices.Contains(vocabulary, value) || index > 0 && values[index-1] >= value {
			return false
		}
	}
	return true
}
