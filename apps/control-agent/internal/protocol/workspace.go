package protocol

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Workspace lease naming grammar, mirroring the TypeScript source of truth exactly. Every value is
// derived from hub-issued identities, never from task text.
const (
	WorkspaceLeaseManagedDirectory       = ".coffee-shop/worktrees"
	WorkspaceLeaseBranchPrefix           = "coffee-shop/"
	WorkspaceLeaseBaseBranchMaximumBytes = 200
	WorkspaceIsolationGitWorktree        = "git-worktree"
	WorkspaceIsolationExclusiveExisting  = "exclusive-existing"
	WorkspaceCleanupRetain               = "retain"
	WorkspaceCleanupWhenUnchanged        = "when-unchanged"
	WorkspaceCleanupModeReconcile        = "reconcile"
	WorkspaceCleanupModeOperator         = "operator"
)

var (
	WorkspaceIsolationPolicies = []string{WorkspaceIsolationGitWorktree, WorkspaceIsolationExclusiveExisting}
	WorkspaceCleanupPolicies   = []string{WorkspaceCleanupRetain, WorkspaceCleanupWhenUnchanged}
	WorkspaceCleanupModes      = []string{WorkspaceCleanupModeReconcile, WorkspaceCleanupModeOperator}

	workspaceLeaseIdentityPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,95}$`)
	workspaceLeaseBaseBranchPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$`)
	resolvedRevisionPattern         = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
	schemeRepositoryURLPattern      = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.-]*://)([^/]*)((?s).*)$`)
)

// WorkspaceLeaseTransitions is the canonical lease state machine, identical to the TypeScript table.
var WorkspaceLeaseTransitions = map[string][]string{
	"requested":    {"provisioning", "failed"},
	"provisioning": {"active", "released", "retained", "failed"},
	"active":       {"released", "retained"},
	"released":     {"cleaning", "retained"},
	"cleaning":     {"cleaned", "retained", "failed"},
	"retained":     {"cleaning"},
	"cleaned":      {},
	"failed":       {},
}

func CanTransitionWorkspaceLease(from, to string) bool {
	return slices.Contains(WorkspaceLeaseTransitions[from], to)
}

// WorkspaceLeasePath returns the statuses a report must pass through, in order, to move a lease
// the hub last knew as from to status to. It is the shortest path through the canonical table,
// preferring earlier-listed transitions, and is empty when from already equals to or to is
// unreachable, so a report never skips a transition the hub would reject.
func WorkspaceLeasePath(from, to string) []string {
	if from == to {
		return nil
	}
	previous := map[string]string{from: ""}
	queue := []string{from}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, next := range WorkspaceLeaseTransitions[current] {
			if _, seen := previous[next]; seen {
				continue
			}
			previous[next] = current
			if next == to {
				path := []string{to}
				for step := current; step != from; step = previous[step] {
					path = append([]string{step}, path...)
				}
				return path
			}
			queue = append(queue, next)
		}
	}
	return nil
}

func IsWorkspaceLeaseIdentity(value string) bool {
	return workspaceLeaseIdentityPattern.MatchString(value)
}

// IsWorkspaceLeaseBaseBranch accepts a default branch Barista can resolve as refs/heads/<name>.
// Git's own ref-format rules are applied again before any Git command uses it.
func IsWorkspaceLeaseBaseBranch(value string) bool {
	if len(value) > WorkspaceLeaseBaseBranchMaximumBytes || !workspaceLeaseBaseBranchPattern.MatchString(value) || strings.Contains(value, "..") {
		return false
	}
	for component := range strings.SplitSeq(value, "/") {
		if strings.HasSuffix(component, ".") || strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	return true
}

func IsResolvedRevision(value string) bool {
	return resolvedRevisionPattern.MatchString(value)
}

func WorkspaceLeaseBaseRef(defaultBranch string) string {
	return "refs/heads/" + defaultBranch
}

func WorkspaceLeaseBranch(taskID, runID string) string {
	return WorkspaceLeaseBranchPrefix + taskID + "/" + runID
}

// NormalizeRepositoryIdentity returns the credential-free identity of a repository URL, or false
// when none can be proven, applying exactly the rules of the TypeScript normalizeRepositoryIdentity:
// userinfo is removed by splitting at the last "@" (within a scheme URL's authority, or within the
// text before the first "/" of an scp-style or other scheme-less location), one trailing "/" and
// ".git" are ignored, and a result whose authority still contains "@", that lacks a host, or that
// looks secret-like is rejected rather than repaired.
func NormalizeRepositoryIdentity(url string) (string, bool) {
	var authority, identity string
	var requiresHost bool
	if match := schemeRepositoryURLPattern.FindStringSubmatch(url); match != nil {
		authority = match[2][strings.LastIndex(match[2], "@")+1:]
		identity = match[1] + authority + match[3]
		requiresHost = !strings.HasPrefix(strings.ToLower(match[1]), "file:")
	} else {
		prefix, _, _ := strings.Cut(url, "/")
		identity = url[strings.LastIndex(prefix, "@")+1:]
		authority = identity
		if index := strings.IndexAny(identity, "/:"); index >= 0 {
			authority = identity[:index]
		}
		requiresHost = !strings.HasPrefix(url, "/")
	}
	identity = strings.TrimSuffix(identity, "/")
	identity = strings.TrimSuffix(identity, ".git")
	if identity == "" || strings.Contains(authority, "@") || (requiresHost && authority == "") || LooksSecretLike(identity) {
		return "", false
	}
	return identity, true
}

// Validate checks the grant's shape and grammar only. Whether this Barista may provision it —
// authorized roots, canonical containment, repository identity — is decided by the workspace
// package against local state. Errors name fields, never values.
func (grant WorkspaceLeaseGrant) Validate() error {
	if !IsWorkspaceLeaseIdentity(grant.ID) {
		return fmt.Errorf("workspace lease id is malformed")
	}
	if !slices.Contains(WorkspaceLeaseStatuses, grant.Status) {
		return fmt.Errorf("workspace lease status is missing or unknown")
	}
	if !slices.Contains(WorkspaceIsolationPolicies, grant.Policy) {
		return fmt.Errorf("workspace lease policy is missing or unknown")
	}
	if !slices.Contains(WorkspaceCleanupPolicies, grant.Cleanup) {
		return fmt.Errorf("workspace lease cleanup policy is missing or unknown")
	}
	for name, path := range map[string]string{"root": grant.Root, "sourcePath": grant.SourcePath, "worktreePath": grant.WorktreePath} {
		if !strings.HasPrefix(path, "/") || !isBounded(path, textBytes) || strings.ContainsRune(path, 0) {
			return fmt.Errorf("workspace lease %s must be an absolute path", name)
		}
	}
	if grant.ResolvedBaseRevision != "" && !IsResolvedRevision(grant.ResolvedBaseRevision) {
		return fmt.Errorf("workspace lease resolved base revision is malformed")
	}
	if grant.Policy == WorkspaceIsolationExclusiveExisting {
		if grant.Repository != "" || grant.BaseRevision != "" || grant.ResolvedBaseRevision != "" || grant.Branch != "" {
			return fmt.Errorf("exclusive-existing workspace lease must not name a repository, base, or branch")
		}
		if grant.WorktreePath != grant.SourcePath {
			return fmt.Errorf("exclusive-existing workspace lease must use its source path")
		}
		return nil
	}
	if identity, ok := NormalizeRepositoryIdentity(grant.Repository); !ok || !isBounded(grant.Repository, 512) || identity != grant.Repository {
		return fmt.Errorf("workspace lease repository identity is missing or not normalized")
	}
	if !strings.HasPrefix(grant.BaseRevision, "refs/heads/") || !IsWorkspaceLeaseBaseBranch(strings.TrimPrefix(grant.BaseRevision, "refs/heads/")) {
		return fmt.Errorf("workspace lease base revision is malformed")
	}
	if !strings.HasPrefix(grant.Branch, WorkspaceLeaseBranchPrefix) {
		return fmt.Errorf("workspace lease branch is malformed")
	}
	return nil
}

// WorkspaceLeaseMessage is the exact workspace.lease envelope. It is sent instead of Outbound
// because the hub rejects orchestration envelopes that carry undeclared fields such as activeRuns.
type WorkspaceLeaseMessage struct {
	Type  string               `json:"type"`
	RunID string               `json:"runId"`
	Lease WorkspaceLeaseUpdate `json:"lease"`
	At    string               `json:"at"`
}

func NewWorkspaceLeaseMessage(runID string, update WorkspaceLeaseUpdate, at string) WorkspaceLeaseMessage {
	update.Detail = truncateDiagnostic(update.Detail)
	return WorkspaceLeaseMessage{Type: "workspace.lease", RunID: runID, Lease: update, At: at}
}

func (message WorkspaceLeaseMessage) Validate() error {
	if !isIdentifier(message.RunID) || !isTimestamp(message.At) {
		return fmt.Errorf("workspace.lease is missing run identity or timestamp")
	}
	return message.Lease.Validate()
}
