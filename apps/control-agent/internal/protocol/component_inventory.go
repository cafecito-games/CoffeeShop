package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
)

const (
	ComponentInventoryLimit  = 64
	ComponentVersionLimit    = 32
	ComponentDiagnosticLimit = 16
)

var ComponentKinds = []string{"harness", "acp-adapter", "capability-pack"}
var ComponentProvenances = []string{"managed", "external", "none", "rejected"}
var ComponentReadinesses = []string{"ready", "inactive", "unavailable", "rejected", "unhealthy", "not-applicable"}
var ComponentDiagnosticCodes = []string{
	"activation-rejected", "not-activated", "active-unverified", "harness-unavailable",
	"auth-unavailable", "auth-unhealthy", "platform-unsupported", "update-available", "rollback-available",
}

type ComponentInventoryEntry struct {
	Kind              string   `json:"kind"`
	ID                string   `json:"id"`
	HarnessID         string   `json:"harnessId,omitempty"`
	DeclaredVersion   string   `json:"declaredVersion"`
	InstalledVersions []string `json:"installedVersions"`
	ActiveVersion     string   `json:"activeVersion,omitempty"`
	RollbackVersion   string   `json:"rollbackVersion,omitempty"`
	Provenance        string   `json:"provenance"`
	Readiness         string   `json:"readiness"`
	UpdateVersion     string   `json:"updateVersion,omitempty"`
	RollbackAvailable bool     `json:"rollbackAvailable"`
	DiagnosticCodes   []string `json:"diagnosticCodes"`
}

type ComponentInventoryReport struct {
	NodeID     string                    `json:"nodeId"`
	ObservedAt string                    `json:"observedAt"`
	Components []ComponentInventoryEntry `json:"components"`
}

type ComponentInventoryMessage struct {
	Type   string                   `json:"type"`
	Report ComponentInventoryReport `json:"report"`
}

func sortedUnique(values []string) bool {
	return slices.IsSorted(values) && !hasAdjacentDuplicate(values)
}

func hasAdjacentDuplicate(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] == values[index] {
			return true
		}
	}
	return false
}

func (entry ComponentInventoryEntry) Validate() error {
	if !slices.Contains(ComponentKinds, entry.Kind) || len(entry.ID) > 128 || !LabelOrAcceleratorPattern.MatchString(entry.ID) ||
		!IsNormalizedVersion(entry.DeclaredVersion) {
		return errors.New("component inventory entry identity is malformed")
	}
	if entry.Kind == "capability-pack" {
		if entry.HarnessID != "" {
			return errors.New("component inventory harness identity does not match its kind")
		}
	} else if len(entry.HarnessID) > 128 || !LabelOrAcceleratorPattern.MatchString(entry.HarnessID) {
		return errors.New("component inventory harness identity does not match its kind")
	}
	if entry.InstalledVersions == nil || len(entry.InstalledVersions) > ComponentVersionLimit || !sortedUnique(entry.InstalledVersions) {
		return errors.New("component inventory installed versions are malformed")
	}
	for _, version := range entry.InstalledVersions {
		if !IsNormalizedVersion(version) {
			return errors.New("component inventory installed versions are malformed")
		}
	}
	for _, version := range []string{entry.ActiveVersion, entry.RollbackVersion, entry.UpdateVersion} {
		if version != "" && !IsNormalizedVersion(version) {
			return errors.New("component inventory version is malformed")
		}
	}
	if !slices.Contains(ComponentProvenances, entry.Provenance) || !slices.Contains(ComponentReadinesses, entry.Readiness) ||
		entry.DiagnosticCodes == nil || len(entry.DiagnosticCodes) > ComponentDiagnosticLimit || !sortedUnique(entry.DiagnosticCodes) {
		return errors.New("component inventory status is malformed")
	}
	for _, code := range entry.DiagnosticCodes {
		if !slices.Contains(ComponentDiagnosticCodes, code) {
			return errors.New("component inventory diagnostic is unknown")
		}
	}
	rollbackVerified := entry.RollbackVersion != "" && slices.Contains(entry.InstalledVersions, entry.RollbackVersion)
	if entry.RollbackAvailable != rollbackVerified {
		return errors.New("component inventory rollback facts conflict")
	}
	if entry.Kind == "capability-pack" && entry.Readiness != "not-applicable" {
		return errors.New("capability pack readiness must be not-applicable")
	}
	return nil
}

func (report ComponentInventoryReport) Validate() error {
	if len(report.NodeID) > 128 || !LabelOrAcceleratorPattern.MatchString(report.NodeID) || !isTimestamp(report.ObservedAt) ||
		report.Components == nil || len(report.Components) > ComponentInventoryLimit {
		return errors.New("component inventory report is malformed")
	}
	previous := ""
	for index, entry := range report.Components {
		if err := entry.Validate(); err != nil {
			return fmt.Errorf("component inventory entry %d: %w", index, err)
		}
		key := entry.Kind + "\x00" + entry.ID
		if previous != "" && previous >= key {
			return errors.New("component inventory keys must be sorted and unique")
		}
		previous = key
	}
	return nil
}

func DecodeComponentInventoryMessage(data []byte, version string) (ComponentInventoryMessage, error) {
	if !SupportsCapability(version, CapabilityComponentInventory) {
		return ComponentInventoryMessage{}, errors.New("component inventory requires protocol v5")
	}
	if err := validateComponentInventoryJSONKeys(data); err != nil {
		return ComponentInventoryMessage{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var message ComponentInventoryMessage
	if err := decoder.Decode(&message); err != nil {
		return ComponentInventoryMessage{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ComponentInventoryMessage{}, errors.New("component inventory has trailing data")
	}
	if message.Type != "component.inventory" {
		return ComponentInventoryMessage{}, errors.New("component inventory discriminator is invalid")
	}
	if err := message.Report.Validate(); err != nil {
		return ComponentInventoryMessage{}, err
	}
	return message, nil
}

func validateComponentInventoryJSONKeys(data []byte) error {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}
	if !hasExactJSONKeys(envelope, []string{"type", "report"}, nil) {
		return errors.New("component inventory envelope keys are malformed")
	}
	var report map[string]json.RawMessage
	if err := json.Unmarshal(envelope["report"], &report); err != nil {
		return errors.New("component inventory report must be an object")
	}
	if !hasExactJSONKeys(report, []string{"nodeId", "observedAt", "components"}, nil) {
		return errors.New("component inventory report keys are malformed")
	}
	var components []json.RawMessage
	if err := json.Unmarshal(report["components"], &components); err != nil {
		return errors.New("component inventory components must be an array")
	}
	required := []string{"kind", "id", "declaredVersion", "installedVersions", "provenance", "readiness", "rollbackAvailable", "diagnosticCodes"}
	optional := []string{"harnessId", "activeVersion", "rollbackVersion", "updateVersion"}
	for index, encoded := range components {
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &entry); err != nil || !hasExactJSONKeys(entry, required, optional) {
			return fmt.Errorf("component inventory entry %d keys are malformed", index)
		}
	}
	return nil
}

func hasExactJSONKeys(value map[string]json.RawMessage, required, optional []string) bool {
	if value == nil || len(value) < len(required) || len(value) > len(required)+len(optional) {
		return false
	}
	allowed := append(slices.Clone(required), optional...)
	for _, key := range required {
		if _, present := value[key]; !present {
			return false
		}
	}
	for key := range value {
		if !slices.Contains(allowed, key) {
			return false
		}
	}
	return true
}
