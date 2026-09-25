package setup

import (
	"encoding/json"
	"strings"
	"testing"
)

// secretLikeFixture matches protocol.LooksSecretLike without being a real credential.
const secretLikeFixture = "ghp_abcdefghijklmnop"

func validManifestFixture() Manifest {
	return Manifest{
		ManifestVersion: ManifestVersion,
		Components: []ComponentManifestEntry{
			{
				ID:        "fixture-adapter",
				Kind:      ComponentKindACPAdapter,
				HarnessID: "claude-cli",
				Provider:  "anthropic",
				Label:     "Fixture Adapter",
				Version:   "1.2.3",
				Platforms: map[string]PlatformDistribution{
					"darwin-arm64": {
						Kind:           DistributionKindArchive,
						URL:            "https://downloads.example.com/fixture-adapter.tar.gz",
						SHA256:         strings.Repeat("a", 64),
						SizeBytes:      1024,
						ExecutablePath: "bin/adapter",
					},
				},
				Launch: LaunchTemplate{},
			},
		},
	}
}

func mutateDistribution(manifest *Manifest, mutate func(*PlatformDistribution)) {
	distribution := manifest.Components[0].Platforms["darwin-arm64"]
	mutate(&distribution)
	manifest.Components[0].Platforms["darwin-arm64"] = distribution
}

func marshalManifestFixture(t *testing.T, mutate func(*Manifest)) []byte {
	t.Helper()
	manifest := validManifestFixture()
	if mutate != nil {
		mutate(&manifest)
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest fixture: %v", err)
	}
	return data
}

func TestParseManifest(t *testing.T) {
	testCases := []struct {
		name    string
		mutate  func(*Manifest)
		wantErr string
	}{
		{
			name: "valid manifest",
		},
		{
			name: "secret-like label wins over structural rejection",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Label = "token " + secretLikeFixture
				manifest.Components[0].Version = "not-a-version"
			},
			wantErr: "label looks secret-like",
		},
		{
			name: "secret-like platform url",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.URL = "https://downloads.example.com/?token=" + secretLikeFixture
				})
			},
			wantErr: "platform distribution url looks secret-like",
		},
		{
			name: "secret-like launch environment entry",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Launch.Environment = []string{"API_TOKEN=" + secretLikeFixture}
			},
			wantErr: "launch environment entry looks secret-like",
		},
		{
			name: "secret-like auth docs url",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].AuthDocsURL = "https://docs.example.com/" + secretLikeFixture
			},
			wantErr: "authDocsUrl looks secret-like",
		},
		{
			name: "unknown manifest generation",
			mutate: func(manifest *Manifest) {
				manifest.ManifestVersion = "3"
			},
			wantErr: "schema generation is unknown",
		},
		{
			name: "duplicate component id",
			mutate: func(manifest *Manifest) {
				manifest.Components = append(manifest.Components, manifest.Components[0])
			},
			wantErr: "duplicate id",
		},
		{
			name: "non kebab id",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].ID = "FixtureAdapter"
			},
			wantErr: "id is not kebab-case",
		},
		{
			name: "non kebab harness id",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].HarnessID = "claude_cli"
			},
			wantErr: "harnessId is not kebab-case",
		},
		{
			name: "non kebab provider",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Provider = "Anthropic"
			},
			wantErr: "provider is not kebab-case",
		},
		{
			name: "oversized label",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Label = strings.Repeat("x", 129)
			},
			wantErr: "label is empty or exceeds 128 bytes",
		},
		{
			name: "empty label",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Label = ""
			},
			wantErr: "label is empty or exceeds 128 bytes",
		},
		{
			name: "unparseable version",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Version = "1.2.3-rc1"
			},
			wantErr: "version is not a normalized dotted version",
		},
		{
			name: "no components",
			mutate: func(manifest *Manifest) {
				manifest.Components = nil
			},
			wantErr: "component manifest declares no components",
		},
		{
			name: "empty platforms",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Platforms = map[string]PlatformDistribution{}
			},
			wantErr: "platforms is empty",
		},
		{
			name: "bad platform key shape",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Platforms["darwin_arm64"] = manifest.Components[0].Platforms["darwin-arm64"]
				delete(manifest.Components[0].Platforms, "darwin-arm64")
			},
			wantErr: "platform key is not GOOS-GOARCH shaped",
		},
		{
			name: "unknown distribution kind",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.Kind = "curl-pipe-sh"
				})
			},
			wantErr: `distribution kind must be "archive" or "manual"`,
		},
		{
			name: "archive missing url",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.URL = ""
				})
			},
			wantErr: "archive platform distribution url must use https",
		},
		{
			name: "archive non https url",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.URL = "http://downloads.example.com/fixture-adapter.tar.gz"
				})
			},
			wantErr: "archive platform distribution url must use https",
		},
		{
			name: "archive missing sha256",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.SHA256 = ""
				})
			},
			wantErr: "sha256 must be 64 lowercase hex characters",
		},
		{
			name: "archive short sha256",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.SHA256 = strings.Repeat("a", 63)
				})
			},
			wantErr: "sha256 must be 64 lowercase hex characters",
		},
		{
			name: "archive uppercase sha256",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.SHA256 = strings.Repeat("A", 64)
				})
			},
			wantErr: "sha256 must be 64 lowercase hex characters",
		},
		{
			name: "archive zero size",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.SizeBytes = 0
				})
			},
			wantErr: "sizeBytes must be positive",
		},
		{
			name: "manual carrying url",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Platforms["darwin-arm64"] = PlatformDistribution{
					Kind:           DistributionKindManual,
					URL:            "https://downloads.example.com/fixture-adapter",
					ExecutablePath: "bin/adapter",
				}
			},
			wantErr: "manual platform distribution must not carry a url or sha256",
		},
		{
			name: "manual carrying sha256",
			mutate: func(manifest *Manifest) {
				manifest.Components[0].Platforms["darwin-arm64"] = PlatformDistribution{
					Kind:           DistributionKindManual,
					SHA256:         strings.Repeat("a", 64),
					ExecutablePath: "bin/adapter",
				}
			},
			wantErr: "manual platform distribution must not carry a url or sha256",
		},
		{
			name: "executable path absolute",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.ExecutablePath = "/bin/adapter"
				})
			},
			wantErr: "executablePath must be relative",
		},
		{
			name: "executable path upward traversal",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.ExecutablePath = "bin/../adapter"
				})
			},
			wantErr: "executablePath must not traverse upward",
		},
		{
			name: "executable path backslash",
			mutate: func(manifest *Manifest) {
				mutateDistribution(manifest, func(distribution *PlatformDistribution) {
					distribution.ExecutablePath = `bin\adapter`
				})
			},
			wantErr: "executablePath must use forward slashes",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			data := marshalManifestFixture(t, testCase.mutate)
			manifest, err := ParseManifest(data)
			if testCase.wantErr == "" {
				if err != nil {
					t.Fatalf("ParseManifest() error = %v, want none", err)
				}
				if manifest.Components[0].ID != "fixture-adapter" {
					t.Fatalf("ParseManifest() lost the component id: %q", manifest.Components[0].ID)
				}
				if manifest.Components[0].Kind != ComponentKindACPAdapter {
					t.Fatalf("ParseManifest() lost the component kind: %q", manifest.Components[0].Kind)
				}
				return
			}
			if err == nil {
				t.Fatalf("ParseManifest() succeeded, want error containing %q", testCase.wantErr)
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("ParseManifest() error = %v, want it to contain %q", err, testCase.wantErr)
			}
			if strings.Contains(err.Error(), secretLikeFixture) {
				t.Fatalf("ParseManifest() error echoed the secret-like fixture value: %v", err)
			}
		})
	}
}

func TestParseManifestRejectsUnknownField(t *testing.T) {
	data := marshalManifestFixture(t, nil)
	injected := strings.Replace(string(data), `{"manifestVersion":`, `{"manifestVersion":"`+ManifestVersion+`","unexpectedField":1,"manifestVersion":`, 1)
	if _, err := ParseManifest([]byte(injected)); err == nil {
		t.Fatal("ParseManifest() accepted an unknown field, want rejection")
	}
}

func TestParseManifestRejectsTrailingData(t *testing.T) {
	data := append(marshalManifestFixture(t, nil), []byte("{\"trailing\":true}")...)
	if _, err := ParseManifest(data); err == nil {
		t.Fatal("ParseManifest() accepted trailing data, want rejection")
	}
}

func TestLoadDefaultManifest(t *testing.T) {
	manifest, err := LoadDefaultManifest()
	if err != nil {
		t.Fatalf("LoadDefaultManifest() error = %v", err)
	}
	harnessIDs := make(map[string]ComponentManifestEntry, len(manifest.Components))
	for _, entry := range manifest.Components {
		harnessIDs[entry.HarnessID] = entry
	}
	for _, harnessID := range []string{"claude-cli", "codex-cli"} {
		entry, supported := harnessIDs[harnessID]
		if !supported {
			t.Fatalf("LoadDefaultManifest() has no entry for harness %s", harnessID)
		}
		distribution, ok := entry.Platforms["darwin-arm64"]
		if !ok {
			t.Fatalf("LoadDefaultManifest() entry for %s has no darwin-arm64 distribution", harnessID)
		}
		if distribution.Kind != DistributionKindManual {
			t.Fatalf("LoadDefaultManifest() entry for %s is %q, want manual", harnessID, distribution.Kind)
		}
		if _, hasCompiledProbe := AuthProbeAllowlist[harnessID]; !hasCompiledProbe {
			t.Fatalf("LoadDefaultManifest() harness %s has no compiled-in AuthProbeAllowlist entry", harnessID)
		}
	}
}

// TestParseManifestRejectsUnknownAuthProbeField proves the fix's security property structurally:
// the manifest schema has no field that can name a command to execute. A manifest — including one
// an operator points --manifest at — that tries to add an "authProbe" object (mirroring the shape
// this schema carried before doctor's auth probes became a compiled-in allowlist) is rejected by
// strict decoding rather than silently ignored, so that field can never smuggle a binary or
// argument list into anything doctor runs.
func TestParseManifestRejectsUnknownAuthProbeField(t *testing.T) {
	data := marshalManifestFixture(t, nil)
	injected := strings.Replace(
		string(data),
		`"launch":{}`,
		`"launch":{},"authProbe":{"binary":"rm","arguments":["-rf","/"],"successExitCode":0}`,
		1,
	)
	if injected == string(data) {
		t.Fatal("test fixture does not contain the expected \"launch\":{} anchor")
	}
	if _, err := ParseManifest([]byte(injected)); err == nil {
		t.Fatal("ParseManifest() accepted a manifest-supplied authProbe field, want rejection")
	}
}
