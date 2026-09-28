package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
)

const (
	CapabilityPackSkillLimit   = 64
	CapabilityPackSurfaceLimit = 16
)

var CapabilityPackReadinessStatuses = []string{"available", "unavailable"}
var CapabilityPackReadinessReasonCodes = []string{"not-selected", "activation-rejected", "active-unverified", "no-supported-surface"}

type CapabilityPackIdentity struct {
	ID      string   `json:"id"`
	Version string   `json:"version"`
	Skills  []string `json:"skills"`
}

type ExpectedCapabilityPack struct {
	ID             string   `json:"id"`
	Version        string   `json:"version"`
	RequiredSkills []string `json:"requiredSkills"`
}

type EffectiveCapabilityPack = CapabilityPackIdentity

type CapabilityPackSurface struct {
	HarnessID string `json:"harnessId"`
	Transport string `json:"transport"`
}

type CapabilityPackReadinessReport struct {
	NodeID     string                  `json:"nodeId"`
	ObservedAt string                  `json:"observedAt"`
	Status     string                  `json:"status"`
	Pack       *CapabilityPackIdentity `json:"pack,omitempty"`
	Surfaces   []CapabilityPackSurface `json:"surfaces"`
	ReasonCode string                  `json:"reasonCode,omitempty"`
}

type CapabilityPackReadinessMessage struct {
	Type   string                        `json:"type"`
	Report CapabilityPackReadinessReport `json:"report"`
}

func validPackString(value string) bool {
	return len(value) <= LabelOrAcceleratorMaximumBytes && LabelOrAcceleratorPattern.MatchString(value)
}

func validPackSkills(skills []string) bool {
	if len(skills) == 0 || len(skills) > CapabilityPackSkillLimit || !sortedUnique(skills) {
		return false
	}
	for _, skill := range skills {
		if !validPackString(skill) {
			return false
		}
	}
	return true
}

func (pack CapabilityPackIdentity) Validate() error {
	if !validPackString(pack.ID) || !IsNormalizedVersion(pack.Version) || !validPackSkills(pack.Skills) {
		return errors.New("capability pack identity is malformed")
	}
	return nil
}

func (pack ExpectedCapabilityPack) Validate() error {
	return CapabilityPackIdentity{ID: pack.ID, Version: pack.Version, Skills: pack.RequiredSkills}.Validate()
}

func (report CapabilityPackReadinessReport) Validate() error {
	if !validPackString(report.NodeID) || !isTimestamp(report.ObservedAt) || !slices.Contains(CapabilityPackReadinessStatuses, report.Status) || report.Surfaces == nil || len(report.Surfaces) > CapabilityPackSurfaceLimit {
		return errors.New("capability pack readiness report is malformed")
	}
	previous := ""
	for _, surface := range report.Surfaces {
		if !slices.Contains(HarnessIDs, surface.HarnessID) || !slices.Contains(HarnessTransports, surface.Transport) {
			return errors.New("capability pack readiness surface is malformed")
		}
		key := surface.HarnessID + "\x00" + surface.Transport
		if previous >= key {
			return errors.New("capability pack readiness surfaces must be sorted and unique")
		}
		previous = key
	}
	if report.Status == "available" {
		if report.Pack == nil || report.Pack.Validate() != nil || len(report.Surfaces) == 0 || report.ReasonCode != "" {
			return errors.New("available capability pack readiness is incomplete")
		}
	} else if report.Pack != nil || len(report.Surfaces) != 0 || !slices.Contains(CapabilityPackReadinessReasonCodes, report.ReasonCode) {
		return errors.New("unavailable capability pack readiness is inconsistent")
	}
	return nil
}

func DecodeCapabilityPackReadinessMessage(data []byte, version string) (CapabilityPackReadinessMessage, error) {
	if !SupportsCapability(version, CapabilityPackReadiness) {
		return CapabilityPackReadinessMessage{}, errors.New("capability pack readiness requires protocol v5")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var message CapabilityPackReadinessMessage
	if err := decoder.Decode(&message); err != nil {
		return CapabilityPackReadinessMessage{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return CapabilityPackReadinessMessage{}, errors.New("capability pack readiness has trailing data")
	}
	if message.Type != "capability-pack.readiness" {
		return CapabilityPackReadinessMessage{}, errors.New("capability pack readiness discriminator is invalid")
	}
	if err := message.Report.Validate(); err != nil {
		return CapabilityPackReadinessMessage{}, err
	}
	return message, nil
}

func v5PackSkills(value any) bool {
	items, ok := value.([]any)
	if !ok || !v5Strings(CapabilityPackSkillLimit, v5String(1, LabelOrAcceleratorMaximumBytes))(value) {
		return false
	}
	previous := ""
	for _, item := range items {
		current := item.(string)
		if previous >= current {
			return false
		}
		previous = current
	}
	return true
}

var v5ExpectedCapabilityPack = v5Object(map[string]v5Rule{
	"id": v5ID, "version": v5NormalizedVersion, "requiredSkills": func(value any) bool {
		items, ok := value.([]any)
		return ok && len(items) > 0 && v5PackSkills(value)
	},
}, nil)
var v5EffectiveCapabilityPack = v5Object(map[string]v5Rule{
	"id": v5ID, "version": v5NormalizedVersion, "skills": func(value any) bool {
		items, ok := value.([]any)
		return ok && len(items) > 0 && v5PackSkills(value)
	},
}, nil)
