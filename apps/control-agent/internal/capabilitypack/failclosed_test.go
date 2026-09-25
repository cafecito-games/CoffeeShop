package capabilitypack

import (
	"bytes"
	"slices"
	"strings"
	"testing"
)

// TestValidateFailsClosed is the fail-closed table: one distinct negative case per row of the pack's
// own contract. Every case starts from the real canonical tree and changes exactly one thing, so each
// row is isolated — a case that needed the digests re-pinned to reach the rule under test says so,
// rather than passing on the digest rule by accident.
//
// The invariant every row shares: malformed input is a rejection, never the absent case, and an
// unknown value is never defaulted to a known one.
func TestValidateFailsClosed(t *testing.T) {
	canonical := canonicalTree(t)
	testCases := []struct {
		name    string
		tree    func(t *testing.T) Tree
		wantErr string
	}{
		{
			name: "pack manifest is absent",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				delete(tree, PackManifestPath)
				return tree
			},
			wantErr: "no pack manifest",
		},
		{
			name: "pack tree is empty",
			tree: func(t *testing.T) Tree { return Tree{} },
			// An empty tree is the absent case, not a pack with nothing in it.
			wantErr: "no pack manifest",
		},
		{
			name: "pack manifest is malformed",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree[PackManifestPath] = []byte("{\"packSchemaVersion\": \"1\",")
				return tree
			},
			wantErr: "decode pack manifest",
		},
		{
			name: "pack manifest carries a trailing object",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree[PackManifestPath] = append(slices.Clone(canonical[PackManifestPath]), []byte("{}\n")...)
				return tree
			},
			wantErr: "trailing data",
		},
		{
			name: "pack manifest carries an unknown field",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree[PackManifestPath] = bytes.Replace(canonical[PackManifestPath],
					[]byte(`"packSchemaVersion": "1",`), []byte(`"packSchemaVersion": "1",`+"\n  "+`"mcpEndpoint": "redacted",`), 1)
				return tree
			},
			// The decode error names the field, never a value.
			wantErr: "mcpEndpoint",
		},
		{
			name: "pack schema generation is absent",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.PackSchemaVersion = "" })
			},
			wantErr: "schema generation is absent or unknown",
		},
		{
			name: "pack schema generation is unknown",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.PackSchemaVersion = "2" })
			},
			wantErr: `only generation "1" is supported`,
		},
		{
			name: "pack id is not kebab-case",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.ID = "Coffee_Shop_Pack" })
			},
			wantErr: "id is not kebab-case",
		},
		{
			name: "pack version is not a normalized dotted version",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.Version = "1.0.0-rc.1" })
			},
			wantErr: "version is not a normalized dotted version",
		},
		{
			name: "declared file is missing from the tree",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				delete(tree, "references/coordination-model.md")
				return tree
			},
			wantErr: "declared by the pack manifest but missing from the tree",
		},
		{
			name: "tree carries a file the manifest does not declare",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/extra.md"] = []byte("# Extra\n\nNot declared.\n")
				return tree
			},
			wantErr: "present in the tree but not declared",
		},
		{
			name: "declared digest is absent",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.Files[0].SHA256 = "" })
			},
			wantErr: "sha256 is not 64 lowercase hex characters",
		},
		{
			name: "declared digest is uppercase",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Files[0].SHA256 = strings.ToUpper(manifest.Files[0].SHA256)
				})
			},
			// An uppercase digest is rejected, never normalized into one that passes.
			wantErr: "sha256 is not 64 lowercase hex characters",
		},
		{
			name: "declared digest is short",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Files[0].SHA256 = manifest.Files[0].SHA256[:63]
				})
			},
			wantErr: "sha256 is not 64 lowercase hex characters",
		},
		{
			name: "declared digest does not match the file",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/coordination-model.md"] = append(slices.Clone(canonical["references/coordination-model.md"]), []byte("\nOne more line.\n")...)
				return tree
			},
			wantErr: "does not match the digest the pack manifest pins it at",
		},
		{
			name: "declared path is absolute",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.Files[0].Path = "/etc/shadow" })
			},
			wantErr: "path is not a relative",
		},
		{
			name: "declared path traverses upward",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) { manifest.Files[0].Path = "../outside.md" })
			},
			wantErr: "path is not a relative",
		},
		{
			name: "tree carries an escaping path",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["../outside.md"] = []byte("escaped\n")
				return tree
			},
			wantErr: "unsafe path",
		},
		{
			name: "pack manifest declares its own digest",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Files = append(slices.Clone(manifest.Files), PackFile{Path: PackManifestPath, SHA256: strings.Repeat("0", 64)})
					slices.SortFunc(manifest.Files, func(left PackFile, right PackFile) int { return strings.Compare(left.Path, right.Path) })
				})
			},
			wantErr: "must not declare its own digest",
		},
		{
			name: "declared files are unsorted or duplicated",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Files = append(slices.Clone(manifest.Files), manifest.Files[0])
				})
			},
			wantErr: "must be sorted by path and unique",
		},
		{
			name: "a declared skill's SKILL.md is missing",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				delete(tree, "skills/coffeeshop-artifacts/SKILL.md")
				return refreshDigests(t, tree)
			},
			wantErr: "SKILL.md is missing",
		},
		{
			name: "a SKILL.md has no metadata block",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["skills/coffeeshop-artifacts/SKILL.md"] = []byte("# Publish artifacts\n\nJust prose.\n")
				return refreshDigests(t, tree)
			},
			wantErr: "has no metadata block",
		},
		{
			name: "a SKILL.md has no description",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["skills/coffeeshop-artifacts/SKILL.md"] = []byte("---\nid: coffeeshop-artifacts\nname: Artifacts\n---\n\nBody.\n")
				return refreshDigests(t, tree)
			},
			wantErr: "missing a non-empty description",
		},
		{
			name: "a SKILL.md description states no activation conditions",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				body := string(canonical["skills/coffeeshop-artifacts/SKILL.md"])
				original := "description: Use when"
				tree["skills/coffeeshop-artifacts/SKILL.md"] = []byte(strings.Replace(body, original, "description: Publishes", 1))
				return refreshDigests(t, tree)
			},
			wantErr: "must state its activation conditions",
		},
		{
			name: "a SKILL.md declares a different skill id than the manifest",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				body := string(canonical["skills/coffeeshop-artifacts/SKILL.md"])
				tree["skills/coffeeshop-artifacts/SKILL.md"] = []byte(strings.Replace(body, "id: coffeeshop-artifacts", "id: coffeeshop-other", 1))
				return refreshDigests(t, tree)
			},
			wantErr: "declares a different skill id",
		},
		{
			name: "a SKILL.md metadata block carries an unknown key",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				body := string(canonical["skills/coffeeshop-artifacts/SKILL.md"])
				tree["skills/coffeeshop-artifacts/SKILL.md"] = []byte(strings.Replace(body, "id: coffeeshop-artifacts", "id: coffeeshop-artifacts\nallowedTools: everything", 1))
				return refreshDigests(t, tree)
			},
			wantErr: "unknown key",
		},
		{
			name: "two declared skills share a skill id",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Skills = append(slices.Clone(manifest.Skills), manifest.Skills[0])
				})
			},
			wantErr: "duplicate skill id",
		},
		{
			name: "a skill declares a tool that does not exist",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Skills[1].RequiredTools = append(slices.Clone(manifest.Skills[1].RequiredTools), "zz_publish_everything")
				})
			},
			wantErr: "which is not a hub tool",
		},
		{
			name: "a skill declares a delegation-only tool without declaring the delegation requirement",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Skills[1].RequiredTools = []string{"get_task_context", "post_artifact", "submit_tasks", "update_task"}
				})
			},
			wantErr: "is delegation-only and must be declared in delegationTools",
		},
		{
			name: "a skill declares an every-run tool as delegation-only",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Skills[1].DelegationTools = []string{"update_thread"}
				})
			},
			wantErr: "is served to every run and must be declared in requiredTools",
		},
		{
			name: "a skill's workflow names a tool it does not declare",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				body := string(canonical["skills/coffeeshop-artifacts/SKILL.md"])
				tree["skills/coffeeshop-artifacts/SKILL.md"] = []byte(body + "\nAlso call `delegate_task` whenever you feel like it.\n")
				return refreshDigests(t, tree)
			},
			wantErr: "which the skill does not declare",
		},
		{
			name: "a skill declares a tool its workflow never teaches",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.Skills[2].RequiredTools = []string{"get_task_context", "send_task_message", "update_task", "update_thread"}
				})
			},
			wantErr: "but its workflow never teaches it",
		},
		{
			name: "the declared minimum protocol generation is unknown",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.MinimumControlProtocolVersion = "99"
				})
			},
			wantErr: "this build does not support",
		},
		{
			name: "the declared minimum protocol generation is absent",
			tree: func(t *testing.T) Tree {
				return editManifest(t, cloneTree(canonical), func(manifest *PackManifest) {
					manifest.MinimumControlProtocolVersion = ""
				})
			},
			wantErr: "this build does not support",
		},
		{
			name: "pack content carries an endpoint",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/coordination-model.md"] = []byte("# Model\n\nConnect to wss://hub.example/coffee-shop to act.\n")
				return refreshDigests(t, tree)
			},
			wantErr: "contains a URL scheme",
		},
		{
			name: "pack content carries a credential",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/coordination-model.md"] = []byte("# Model\n\nAuthenticate with sk-abcdefghijklmnop when asked.\n")
				return refreshDigests(t, tree)
			},
			wantErr: "contains a secret-like value",
		},
		{
			name: "pack content carries an absolute machine path",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/coordination-model.md"] = []byte("# Model\n\nThe workspace is at /home/operator/projects/thing.\n")
				return refreshDigests(t, tree)
			},
			wantErr: "contains an absolute machine path",
		},
		{
			name: "pack content restates a tool schema",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/coordination-model.md"] = []byte("# Model\n\nInput: {\"type\": \"object\", \"additionalProperties\": false}\n")
				return refreshDigests(t, tree)
			},
			wantErr: "restates a tool schema",
		},
		{
			name: "pack content is not UTF-8 text",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["references/coordination-model.md"] = []byte{0xff, 0xfe, 0x00}
				return refreshDigests(t, tree)
			},
			wantErr: "not valid UTF-8 text",
		},
		{
			name: "an evaluation fixture is missing",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				delete(tree, "evaluations/coffeeshop-artifacts.json")
				return refreshDigests(t, tree)
			},
			wantErr: "evaluations/coffeeshop-artifacts.json is missing",
		},
		{
			name: "an evaluation fixture declares an unknown generation",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["evaluations/coffeeshop-artifacts.json"] = bytes.Replace(canonical["evaluations/coffeeshop-artifacts.json"],
					[]byte(`"evaluationSchemaVersion": "1"`), []byte(`"evaluationSchemaVersion": "7"`), 1)
				return refreshDigests(t, tree)
			},
			wantErr: "absent or unknown schema generation",
		},
		{
			name: "an evaluation fixture belongs to another skill",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["evaluations/coffeeshop-artifacts.json"] = bytes.Replace(canonical["evaluations/coffeeshop-artifacts.json"],
					[]byte(`"skillId": "coffeeshop-artifacts"`), []byte(`"skillId": "coffeeshop-coordination"`), 1)
				return refreshDigests(t, tree)
			},
			wantErr: "declares a different skill id than the skill that names it",
		},
		{
			name: "an unrelated prompt does not assert non-activation",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["evaluations/coffeeshop-artifacts.json"] = bytes.Replace(canonical["evaluations/coffeeshop-artifacts.json"],
					[]byte("\"class\": \"unrelated\",\n      \"prompt\": \"Write a temporary scratch file while you work through this calculation.\",\n      \"activates\": false,\n      \"outcome\": \"no-activation\""),
					[]byte("\"class\": \"unrelated\",\n      \"prompt\": \"Write a temporary scratch file while you work through this calculation.\",\n      \"activates\": true,\n      \"outcome\": \"follow-workflow\""), 1)
				return refreshDigests(t, tree)
			},
			wantErr: "cannot expect outcome follow-workflow",
		},
		{
			name: "an evaluation class is missing entirely",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["evaluations/coffeeshop-artifacts.json"] = []byte(`{"evaluationSchemaVersion":"1","skillId":"coffeeshop-artifacts","cases":[` +
					`{"id":"only","class":"direct","prompt":"Publish the patch.","activates":true,"outcome":"follow-workflow","claimsSuccess":false}]}`)
				return refreshDigests(t, tree)
			},
			wantErr: "covers no indirect prompt",
		},
		{
			name: "an evaluation case claims success",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["evaluations/coffeeshop-artifacts.json"] = bytes.Replace(canonical["evaluations/coffeeshop-artifacts.json"],
					[]byte(`"claimsSuccess": false`), []byte(`"claimsSuccess": true`), 1)
				return refreshDigests(t, tree)
			},
			wantErr: "claimsSuccess must be false",
		},
		{
			name: "an evaluation fixture carries an unknown field",
			tree: func(t *testing.T) Tree {
				tree := cloneTree(canonical)
				tree["evaluations/coffeeshop-artifacts.json"] = bytes.Replace(canonical["evaluations/coffeeshop-artifacts.json"],
					[]byte(`"skillId": "coffeeshop-artifacts"`), []byte(`"skillId": "coffeeshop-artifacts",`+"\n  "+`"expectedTool": "post_artifact"`), 1)
				return refreshDigests(t, tree)
			},
			wantErr: "expectedTool",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			tree := testCase.tree(t)
			manifest, err := Validate(tree, DefaultVocabulary())
			if err == nil {
				t.Fatalf("Validate() accepted the pack, want a rejection; got %s", manifest.Ref())
			}
			if !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("Validate() error = %v, want it to contain %q", err, testCase.wantErr)
			}
			// No archive is ever produced from a rejected pack.
			if archive, _, buildErr := BuildArchive(tree, DefaultVocabulary()); buildErr == nil || archive != nil {
				t.Fatalf("BuildArchive() produced %d bytes for a rejected pack", len(archive))
			}
		})
	}
}

// TestRejectionsNeverEchoPackContent proves a diagnostic derived from pack bytes carries neither the
// rejected content nor a secret-like value. A rejection message reaches an operator's terminal and the
// activation ledger's rejection field, so it must not become an oracle for the thing it caught.
func TestRejectionsNeverEchoPackContent(t *testing.T) {
	const credential = "sk-abcdefghijklmnopqrstuvwxyz"
	tree := refreshDigests(t, func() Tree {
		tree := cloneTree(canonicalTree(t))
		tree["references/coordination-model.md"] = []byte("# Model\n\nUse " + credential + " to authenticate.\n")
		return tree
	}())
	_, err := Validate(tree, DefaultVocabulary())
	if err == nil {
		t.Fatal("Validate() accepted a pack carrying a credential")
	}
	if strings.Contains(err.Error(), credential) {
		t.Fatalf("the rejection echoed the credential: %v", err)
	}
	if !strings.Contains(err.Error(), "references/coordination-model.md") {
		t.Fatalf("the rejection does not name the offending file: %v", err)
	}
	// A strict decoder quotes an unknown field name straight from the file, so the same screen applies
	// to a decode failure.
	broken := cloneTree(canonicalTree(t))
	broken[PackManifestPath] = []byte(`{"packSchemaVersion":"1","` + credential + `":1}`)
	if _, err := Validate(broken, DefaultVocabulary()); err == nil {
		t.Fatal("Validate() accepted a manifest with an unknown field")
	} else if strings.Contains(err.Error(), credential) {
		t.Fatalf("the decode rejection echoed the credential: %v", err)
	}
}

// TestBoundsRejectOversizedPacks proves the bounds are enforced rather than documented, so a hostile
// archive cannot be expanded without limit before it is refused.
func TestBoundsRejectOversizedPacks(t *testing.T) {
	oversizedFile := refreshDigests(t, func() Tree {
		tree := cloneTree(canonicalTree(t))
		tree["references/coordination-model.md"] = bytes.Repeat([]byte("a"), MaximumFileBytes+1)
		return tree
	}())
	if _, err := Validate(oversizedFile, DefaultVocabulary()); err == nil {
		t.Fatal("Validate() accepted a file past the per-file bound")
	}
	tooManyFiles := cloneTree(canonicalTree(t))
	for index := 0; index <= MaximumPackFiles; index++ {
		tooManyFiles["references/filler-"+strings.Repeat("a", index%8+1)+string(rune('a'+index%26))+".md"] = []byte("filler\n")
	}
	if len(tooManyFiles) <= MaximumPackFiles {
		t.Skip("the filler did not exceed the file bound")
	}
	if _, err := Validate(tooManyFiles, DefaultVocabulary()); err == nil {
		t.Fatal("Validate() accepted a tree past the file-count bound")
	}
}
