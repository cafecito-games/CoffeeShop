// Package workspace provisions and cleans up hub-granted workspace leases on this Barista.
//
// The hub owns lease identity; this package owns what actually exists on disk. Every decision is
// made by re-reading local Git state (`git worktree list --porcelain -z`, refs, and the lease
// identity recorded in the repository's branch configuration), and anything that does not match
// the grant exactly is retained for an operator instead of being reused, reset, or deleted.
package workspace

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/safepath"
)

const (
	tombstoneDirectory = ".coffee-shop/tombstones"
	leaseConfigName    = "coffeeShopLease"
	baseConfigName     = "coffeeShopBase"
)

// Cleanup modes. ModeRun is Barista's own cleanup after the lease's run ended; the others come
// from a hub workspace.cleanup request.
const (
	ModeRun       = "run"
	ModeReconcile = protocol.WorkspaceCleanupModeReconcile
	ModeOperator  = protocol.WorkspaceCleanupModeOperator
)

// Outcome is the verified local result of provisioning or cleanup, phrased as the lease status to
// report. Detail is a fixed diagnostic that never repeats a path, URL, or Git output.
type Outcome struct {
	Status               string
	RetentionReason      string
	ResolvedBaseRevision string
	Detail               string
	// Path is the verified isolated cwd, set only when Status is "active".
	Path string
}

func (outcome Outcome) Update(leaseID string) protocol.WorkspaceLeaseUpdate {
	return protocol.WorkspaceLeaseUpdate{
		LeaseID:              leaseID,
		Status:               outcome.Status,
		RetentionReason:      outcome.RetentionReason,
		ResolvedBaseRevision: outcome.ResolvedBaseRevision,
		Detail:               outcome.Detail,
	}
}

func failed(detail string) Outcome { return Outcome{Status: "failed", Detail: detail} }

func retained(reason, detail string) Outcome {
	return Outcome{Status: "retained", RetentionReason: reason, Detail: detail}
}

// Manager serializes lease operations per repository and tracks which leases a live Barista
// operation currently owns.
type Manager struct {
	roots []string
	git   *Git

	mutex        sync.Mutex
	repositories map[string]*sync.Mutex
	owners       map[string]struct{}
	exclusive    map[string]string
	tombstones   map[string]struct{}

	// interleave lets tests act between provisioning steps, where a concurrent same-account
	// process could; it is nil in production.
	interleave func(step string, path string)
}

// NewManager accepts the canonical authorized roots from configuration. A nil git disables the
// git-worktree policy; exclusive-existing leases remain available.
func NewManager(roots []string, git *Git) *Manager {
	return &Manager{
		roots:        slices.Clone(roots),
		git:          git,
		repositories: map[string]*sync.Mutex{},
		owners:       map[string]struct{}{},
		exclusive:    map[string]string{},
		tombstones:   map[string]struct{}{},
	}
}

// Supports reports whether this Barista can provision leases of the given isolation policy.
func (manager *Manager) Supports(policy string) bool {
	switch policy {
	case protocol.WorkspaceIsolationExclusiveExisting:
		return true
	case protocol.WorkspaceIsolationGitWorktree:
		return manager.git != nil
	}
	return false
}

// ErrLeaseOwned means another operation, in this or another Barista process, owns the lease.
var ErrLeaseOwned = errors.New("workspace lease is owned by another operation")

const leaseLockDirectory = ".coffee-shop/leases"

// Own marks a lease as held by one live operation for as long as the returned release function
// has not been called. A git-worktree lease is additionally held by a non-blocking exclusive
// advisory lock on <root>/.coffee-shop/leases/<leaseId>.lock, so a second Barista process
// registered under the same node can never provision or clean up a worktree the first is still
// using. ErrLeaseOwned means the lease is held elsewhere; any other error means ownership could
// not be established safely. Either way nothing may touch the lease.
func (manager *Manager) Own(grant protocol.WorkspaceLeaseGrant) (func(), error) {
	if !protocol.IsWorkspaceLeaseIdentity(grant.ID) || !slices.Contains(manager.roots, grant.Root) {
		return nil, errors.New("the workspace lease cannot be owned on this Barista")
	}
	manager.mutex.Lock()
	if _, held := manager.owners[grant.ID]; held {
		manager.mutex.Unlock()
		return nil, ErrLeaseOwned
	}
	manager.owners[grant.ID] = struct{}{}
	manager.mutex.Unlock()
	forget := func() {
		manager.mutex.Lock()
		delete(manager.owners, grant.ID)
		manager.mutex.Unlock()
	}
	var lock *os.File
	if grant.Policy == protocol.WorkspaceIsolationGitWorktree {
		file, err := openLeaseLock(grant)
		if err != nil {
			forget()
			return nil, err
		}
		lock = file
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			if lock != nil {
				_ = unlockFile(lock)
				lock.Close()
			}
			forget()
		})
	}, nil
}

// openLeaseLock opens (never follows a link to) the lease's lock file beneath a component-wise
// verified, private directory and locks it without blocking.
func openLeaseLock(grant protocol.WorkspaceLeaseGrant) (*os.File, error) {
	directory, err := safepath.EnsureDirectoryWithinRoot(grant.Root, filepath.Join(grant.Root, filepath.FromSlash(leaseLockDirectory)), 0o700)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(directory, grant.ID+".lock"), openLockFlags, 0o600)
	if err != nil {
		return nil, err
	}
	information, err := file.Stat()
	if err != nil || !information.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("the lease lock is not a regular file")
	}
	if err := lockFile(file); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func (manager *Manager) step(name string, path string) {
	if manager.interleave != nil {
		manager.interleave(name, path)
	}
}

func (manager *Manager) repositoryLock(sourcePath string) *sync.Mutex {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	lock := manager.repositories[sourcePath]
	if lock == nil {
		lock = &sync.Mutex{}
		manager.repositories[sourcePath] = lock
	}
	return lock
}

// Provision creates or adopts the exact workspace a grant names and returns an "active" outcome
// with the verified cwd, or the "failed"/"retained" status to report. taskID and runID come from
// the dispatch and must reproduce the grant's branch.
func (manager *Manager) Provision(ctx context.Context, grant protocol.WorkspaceLeaseGrant, taskID, runID string) Outcome {
	if problem := manager.checkGrant(grant, runID); problem != "" {
		return failed(problem)
	}
	if !slices.Contains([]string{"requested", "provisioning", "active"}, grant.Status) {
		return failed("the workspace lease is not in a provisionable status")
	}
	if manager.tombstoned(grant) {
		return failed("workspace lease was already settled on this Barista")
	}
	if grant.Policy == protocol.WorkspaceIsolationExclusiveExisting {
		return manager.provisionExclusive(grant)
	}
	if !protocol.IsWorkspaceLeaseIdentity(taskID) || grant.Branch != protocol.WorkspaceLeaseBranch(taskID, runID) {
		return failed("workspace lease branch does not match its task and run")
	}
	if manager.git == nil {
		return failed("git is not available on this Barista")
	}
	lock := manager.repositoryLock(grant.SourcePath)
	lock.Lock()
	defer lock.Unlock()

	if problem := manager.verifyRepository(ctx, grant); problem != "" {
		return failed(problem)
	}
	state, err := manager.inspect(ctx, grant)
	if err != nil {
		return failed("local worktree state could not be read")
	}
	switch {
	case state.target != nil:
		return manager.adopt(ctx, grant, state)
	case state.pathExists:
		return retained("unregistered", "the lease's worktree path exists but is not a registered worktree")
	case state.branchHead != "":
		return retained("identity-mismatch", "the lease's branch already exists without its worktree")
	case state.recordedLease != "" && state.recordedLease != grant.ID:
		return failed("the lease's branch name is recorded for a different lease")
	}

	base, problem := manager.resolveBase(ctx, grant)
	if problem != "" {
		return failed(problem)
	}
	if grant.ResolvedBaseRevision != "" && grant.ResolvedBaseRevision != base {
		return failed("the base ref no longer resolves to the lease's recorded base revision")
	}
	managed := filepath.Dir(grant.WorktreePath)
	if _, err := safepath.EnsureDirectoryWithinRoot(grant.Root, managed, 0o700); err != nil {
		return failed("the managed worktree directory could not be created safely")
	}
	if err := createLeaf(grant.Root, grant.WorktreePath); err != nil {
		return retained("ambiguous", "the lease's worktree directory could not be created exclusively")
	}
	manager.step("leaf-created", grant.WorktreePath)
	if err := manager.recordIdentity(ctx, grant, base); err != nil {
		return manager.reconcileFailedProvision(ctx, grant, "the lease identity could not be recorded")
	}
	if _, err := safepath.VerifyDirectoryWithinRoot(grant.Root, grant.WorktreePath); err != nil {
		return retained("identity-mismatch", "the lease's worktree directory was replaced before checkout")
	}
	if _, err := manager.git.Run(ctx, grant.SourcePath, "worktree", "add", "--quiet", "-b", grant.Branch, "--", grant.WorktreePath, base); err != nil {
		return manager.reconcileFailedProvision(ctx, grant, "git worktree add failed")
	}
	manager.step("worktree-added", grant.WorktreePath)
	state, err = manager.inspect(ctx, grant)
	if err != nil || state.target == nil {
		return manager.reconcileFailedProvision(ctx, grant, "the new worktree is not registered")
	}
	return manager.adopt(ctx, grant, state)
}

// reconcileFailedProvision re-reads local state after a failed mutation. It removes only the lease
// identity this call recorded, and only when nothing else of the lease exists; any leftover
// worktree, branch, or path is retained rather than guessed about.
func (manager *Manager) reconcileFailedProvision(ctx context.Context, grant protocol.WorkspaceLeaseGrant, detail string) Outcome {
	state, err := manager.inspect(ctx, grant)
	if err != nil {
		return retained("ambiguous", detail+"; local state could not be re-read")
	}
	if state.target != nil {
		if outcome := manager.adopt(ctx, grant, state); outcome.Status == "active" {
			return outcome
		}
		return retained("ambiguous", detail+"; a partial worktree remains")
	}
	if state.pathExists && removeEmptyLeaf(grant.Root, grant.WorktreePath) {
		state.pathExists = false
	}
	// No worktree was registered, so a branch or path now present is not provably this lease's:
	// the recorded identity is withdrawn so no later cleanup can mistake it for the lease's own.
	if state.recordedLease == grant.ID {
		manager.forgetIdentity(ctx, grant)
	}
	if state.pathExists || state.branchHead != "" {
		return retained("ambiguous", detail+"; a partial worktree remains")
	}
	return failed(detail)
}

func (manager *Manager) provisionExclusive(grant protocol.WorkspaceLeaseGrant) Outcome {
	if err := canonicalDirectory(grant.SourcePath); err != nil {
		return failed("the exclusive workspace is missing, not a directory, or reached through a symbolic link")
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if holder, held := manager.exclusive[grant.SourcePath]; held && holder != grant.ID {
		return failed("the exclusive workspace is held by another lease")
	}
	manager.exclusive[grant.SourcePath] = grant.ID
	return Outcome{Status: "active", Path: grant.SourcePath}
}

func (manager *Manager) releaseExclusive(grant protocol.WorkspaceLeaseGrant) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if manager.exclusive[grant.SourcePath] == grant.ID {
		delete(manager.exclusive, grant.SourcePath)
	}
}

// adopt verifies that an existing registered worktree is exactly the lease's own.
func (manager *Manager) adopt(ctx context.Context, grant protocol.WorkspaceLeaseGrant, state localState) Outcome {
	if reason, detail := manager.ownership(ctx, grant, state); reason != "" {
		return retained(reason, detail)
	}
	if state.target.Head != state.recordedBase {
		_, err := manager.git.Run(ctx, grant.SourcePath, "merge-base", "--is-ancestor", state.recordedBase, state.target.Head)
		if err != nil {
			return retained("identity-mismatch", "the existing worktree does not descend from the lease's base revision")
		}
	}
	return Outcome{Status: "active", Path: grant.WorktreePath, ResolvedBaseRevision: state.recordedBase}
}

// ownership returns a retention reason when the registered worktree at the lease's path is not
// provably the lease's own, or "" when every identity field matches.
func (manager *Manager) ownership(ctx context.Context, grant protocol.WorkspaceLeaseGrant, state localState) (string, string) {
	target := state.target
	switch {
	case target.Locked:
		return "locked", "the worktree is locked"
	case target.Prunable || target.Unrecognized || target.Bare || target.Detached:
		return "ambiguous", "the worktree is prunable, detached, or reported with unknown attributes"
	case target.Branch != "refs/heads/"+grant.Branch:
		return "identity-mismatch", "the worktree has a different branch checked out"
	case state.branchCheckouts != 1:
		return "ambiguous", "the lease's branch is checked out in more than one worktree"
	case state.recordedLease != grant.ID:
		return "identity-mismatch", "the branch is not recorded as owned by this lease"
	case !protocol.IsResolvedRevision(state.recordedBase):
		return "identity-mismatch", "the branch has no recorded base revision"
	case grant.ResolvedBaseRevision != "" && grant.ResolvedBaseRevision != state.recordedBase:
		return "identity-mismatch", "the recorded base revision differs from the lease"
	case !protocol.IsResolvedRevision(target.Head):
		return "ambiguous", "the worktree HEAD is not a commit"
	}
	if _, err := safepath.VerifyDirectoryWithinRoot(grant.Root, grant.WorktreePath); err != nil {
		return "ambiguous", "the worktree path is missing or reached through a symbolic link"
	}
	if err := canonicalDirectory(grant.WorktreePath); err != nil {
		return "ambiguous", "the worktree path is missing or reached through a symbolic link"
	}
	if !linkedToRepository(grant) {
		return "identity-mismatch", "the worktree's .git file does not point into its repository"
	}
	output, err := manager.git.Run(ctx, grant.WorktreePath, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
	if err != nil {
		return "ambiguous", "the worktree's repository could not be read"
	}
	lines := strings.Split(strings.TrimSuffix(string(output), "\n"), "\n")
	if len(lines) != 2 || lines[0] != grant.WorktreePath || !sameCanonicalPath(lines[1], filepath.Join(grant.SourcePath, ".git")) {
		return "identity-mismatch", "the worktree belongs to a different repository"
	}
	return "", ""
}

// Cleanup removes a lease's workspace only when it is provably the lease's own and nothing would
// be lost; otherwise it reports why the workspace is retained. The caller must hold the lease via
// Own, so no live run uses it. beforeMutation runs once, just before the first change on disk, so
// the caller can record `cleaning` first. Outside ModeOperator the lease's cleanup policy applies.
func (manager *Manager) Cleanup(ctx context.Context, grant protocol.WorkspaceLeaseGrant, runID, mode string, beforeMutation func()) Outcome {
	if problem := manager.checkGrant(grant, runID); problem != "" {
		return retained("identity-mismatch", problem)
	}
	if grant.Policy == protocol.WorkspaceIsolationExclusiveExisting {
		manager.releaseExclusive(grant)
		return manager.settle(grant)
	}
	if manager.git == nil {
		return retained("ambiguous", "git is not available to verify the workspace")
	}
	lock := manager.repositoryLock(grant.SourcePath)
	lock.Lock()
	defer lock.Unlock()

	if problem := manager.verifyRepository(ctx, grant); problem != "" {
		return retained("identity-mismatch", problem)
	}
	state, err := manager.inspect(ctx, grant)
	if err != nil {
		return retained("ambiguous", "local worktree state could not be read")
	}
	mutating := false
	mutate := func() {
		if !mutating && beforeMutation != nil {
			beforeMutation()
		}
		mutating = true
	}
	if state.target == nil && !state.pathExists && state.branchHead == "" {
		if state.recordedLease == grant.ID {
			mutate()
			manager.forgetIdentity(ctx, grant)
		}
		return manager.settle(grant)
	}
	if mode != ModeOperator && grant.Cleanup != protocol.WorkspaceCleanupWhenUnchanged {
		return retained("policy", "the project's cleanup policy retains finished workspaces")
	}
	if state.target == nil {
		if state.pathExists {
			return retained("unregistered", "the lease's worktree path exists but is not a registered worktree")
		}
		if state.recordedLease != grant.ID || state.branchCheckouts != 0 {
			return retained("identity-mismatch", "the lease's branch is not provably owned by this lease")
		}
		if state.branchHead != state.recordedBase {
			return retained("diverged", "the lease's branch has commits beyond its base revision")
		}
		mutate()
		return manager.removeBranch(ctx, grant, state)
	}
	if reason, detail := manager.ownership(ctx, grant, state); reason != "" {
		return retained(reason, detail)
	}
	output, err := manager.git.Run(ctx, grant.WorktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none")
	if err != nil {
		return retained("ambiguous", "the worktree status could not be read")
	}
	summary, err := ParseStatus(output)
	switch {
	case err != nil:
		return retained("ambiguous", "the worktree status could not be parsed")
	case summary.Modified > 0:
		return retained("dirty", "the worktree has uncommitted changes")
	case summary.Untracked > 0 || summary.Ignored > 0:
		return retained("untracked", "the worktree has untracked or ignored files")
	case state.target.Head != state.recordedBase:
		return retained("diverged", "the lease's branch has commits beyond its base revision")
	}
	mutate()
	if _, err := manager.git.Run(ctx, grant.SourcePath, "worktree", "remove", "--", grant.WorktreePath); err != nil {
		return retained("ambiguous", "git refused to remove the worktree")
	}
	state, err = manager.inspect(ctx, grant)
	if err != nil || state.target != nil || state.pathExists {
		return retained("ambiguous", "the worktree is still present after removal")
	}
	return manager.removeBranch(ctx, grant, state)
}

// removeBranch deletes the lease's branch only while it still points at the recorded base, using
// Git's compare-and-delete so a concurrent commit is never discarded.
func (manager *Manager) removeBranch(ctx context.Context, grant protocol.WorkspaceLeaseGrant, state localState) Outcome {
	if state.branchHead != "" {
		if _, err := manager.git.Run(ctx, grant.SourcePath, "update-ref", "-d", "refs/heads/"+grant.Branch, state.recordedBase); err != nil {
			return retained("ambiguous", "the lease's branch could not be removed")
		}
	}
	manager.forgetIdentity(ctx, grant)
	state, err := manager.inspect(ctx, grant)
	if err != nil || state.target != nil || state.pathExists || state.branchHead != "" {
		return retained("ambiguous", "the lease's workspace is still present after removal")
	}
	return manager.settle(grant)
}

// settle records a tombstone so a replayed grant can never recreate the workspace, and reports a
// lease that never produced a workspace as failed rather than cleaned.
func (manager *Manager) settle(grant protocol.WorkspaceLeaseGrant) Outcome {
	manager.writeTombstone(grant)
	if grant.Status == "requested" || grant.Status == "provisioning" {
		return failed("no workspace exists for this lease")
	}
	return Outcome{Status: "cleaned"}
}

func (manager *Manager) tombstonePath(grant protocol.WorkspaceLeaseGrant) string {
	return filepath.Join(grant.Root, filepath.FromSlash(tombstoneDirectory), grant.ID)
}

func (manager *Manager) tombstoned(grant protocol.WorkspaceLeaseGrant) bool {
	manager.mutex.Lock()
	_, remembered := manager.tombstones[grant.ID]
	manager.mutex.Unlock()
	if remembered || grant.Policy != protocol.WorkspaceIsolationGitWorktree {
		return remembered
	}
	_, err := os.Lstat(manager.tombstonePath(grant))
	return !errors.Is(err, fs.ErrNotExist)
}

func (manager *Manager) writeTombstone(grant protocol.WorkspaceLeaseGrant) {
	manager.mutex.Lock()
	manager.tombstones[grant.ID] = struct{}{}
	manager.mutex.Unlock()
	if grant.Policy != protocol.WorkspaceIsolationGitWorktree {
		return
	}
	if _, err := safepath.EnsureDirectoryWithinRoot(grant.Root, filepath.Join(grant.Root, filepath.FromSlash(tombstoneDirectory)), 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(manager.tombstonePath(grant), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		file.Close()
	}
}

// checkGrant verifies a grant against this Barista's configuration without touching Git. Every
// path must be exactly what the lease grammar derives from the authorized root and lease identity.
func (manager *Manager) checkGrant(grant protocol.WorkspaceLeaseGrant, runID string) string {
	if err := grant.Validate(); err != nil {
		return "the workspace lease grant is malformed"
	}
	if !slices.Contains(manager.roots, grant.Root) {
		return "the workspace lease root is not an authorized root on this Barista"
	}
	if filepath.Clean(grant.SourcePath) != grant.SourcePath || !within(grant.Root, grant.SourcePath) {
		return "the workspace lease source is not beneath its authorized root"
	}
	if grant.Policy == protocol.WorkspaceIsolationExclusiveExisting {
		return ""
	}
	taskID, run, found := strings.Cut(strings.TrimPrefix(grant.Branch, protocol.WorkspaceLeaseBranchPrefix), "/")
	if !found || !protocol.IsWorkspaceLeaseIdentity(taskID) || run != runID || !protocol.IsWorkspaceLeaseIdentity(runID) {
		return "workspace lease branch does not match its task and run"
	}
	if grant.WorktreePath != filepath.Join(grant.Root, filepath.FromSlash(protocol.WorkspaceLeaseManagedDirectory), grant.ID) {
		return "the workspace lease worktree path is not its managed path"
	}
	return ""
}

// verifyRepository proves the source checkout is the top level of a non-bare repository whose
// common directory is its own `.git`, and that one of its remotes has the lease's identity.
func (manager *Manager) verifyRepository(ctx context.Context, grant protocol.WorkspaceLeaseGrant) string {
	if err := canonicalDirectory(grant.SourcePath); err != nil {
		return "the source checkout is missing, not a directory, or reached through a symbolic link"
	}
	commonDirectory := filepath.Join(grant.SourcePath, ".git")
	if info, err := os.Lstat(commonDirectory); err != nil || !info.IsDir() {
		return "the source checkout is not the main worktree of a repository"
	}
	output, err := manager.git.Run(ctx, grant.SourcePath, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--is-bare-repository")
	if err != nil {
		return "the source checkout is not a readable Git repository"
	}
	lines := strings.Split(strings.TrimSuffix(string(output), "\n"), "\n")
	if len(lines) != 3 || lines[0] != grant.SourcePath || !sameCanonicalPath(lines[1], commonDirectory) || lines[2] != "false" {
		return "the source checkout is not the top level of its own repository"
	}
	output, err = manager.git.Run(ctx, grant.SourcePath, "config", "--null", "--get-regexp", `^remote\..*\.url$`)
	if err != nil {
		return "the source checkout has no remote with the lease's repository identity"
	}
	for entry := range strings.SplitSeq(strings.TrimSuffix(string(output), "\x00"), "\x00") {
		_, url, found := strings.Cut(entry, "\n")
		if identity, ok := protocol.NormalizeRepositoryIdentity(url); found && ok && identity == grant.Repository {
			return ""
		}
	}
	return "the source checkout has no remote with the lease's repository identity"
}

func (manager *Manager) resolveBase(ctx context.Context, grant protocol.WorkspaceLeaseGrant) (string, string) {
	if _, err := manager.git.Run(ctx, grant.SourcePath, "check-ref-format", grant.BaseRevision); err != nil {
		return "", "the base ref is not a valid ref name"
	}
	if _, err := manager.git.Run(ctx, grant.SourcePath, "check-ref-format", "refs/heads/"+grant.Branch); err != nil {
		return "", "the lease branch is not a valid ref name"
	}
	output, err := manager.git.Run(ctx, grant.SourcePath, "rev-parse", "--verify", "--quiet", grant.BaseRevision+"^{commit}")
	if exitedWith(err, 1) {
		return "", "the base ref does not exist"
	}
	if err != nil {
		return "", "the base ref could not be resolved"
	}
	base := strings.TrimSuffix(string(output), "\n")
	if !protocol.IsResolvedRevision(base) {
		return "", "the base ref did not resolve to one commit"
	}
	return base, ""
}

type localState struct {
	target          *Worktree
	branchCheckouts int
	branchHead      string
	pathExists      bool
	recordedLease   string
	recordedBase    string
}

// inspect re-reads everything local that decides a lease's fate.
func (manager *Manager) inspect(ctx context.Context, grant protocol.WorkspaceLeaseGrant) (localState, error) {
	var state localState
	output, err := manager.git.Run(ctx, grant.SourcePath, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return state, err
	}
	worktrees, err := ParseWorktreeList(output)
	if err != nil {
		return state, err
	}
	branchRef := "refs/heads/" + grant.Branch
	for index := range worktrees {
		if worktrees[index].Path == grant.WorktreePath {
			if state.target != nil {
				return state, errMalformedInventory
			}
			state.target = &worktrees[index]
		}
		if worktrees[index].Branch == branchRef {
			state.branchCheckouts++
		}
	}
	output, err = manager.git.Run(ctx, grant.SourcePath, "rev-parse", "--verify", "--quiet", branchRef)
	switch {
	case err == nil:
		state.branchHead = strings.TrimSuffix(string(output), "\n")
		if !protocol.IsResolvedRevision(state.branchHead) {
			return state, errMalformedInventory
		}
	case !exitedWith(err, 1):
		return state, err
	}
	if state.recordedLease, err = manager.configValue(ctx, grant, leaseConfigName); err != nil {
		return state, err
	}
	if state.recordedBase, err = manager.configValue(ctx, grant, baseConfigName); err != nil {
		return state, err
	}
	_, err = os.Lstat(grant.WorktreePath)
	switch {
	case err == nil:
		state.pathExists = true
	case !errors.Is(err, fs.ErrNotExist):
		return state, err
	}
	return state, nil
}

func (manager *Manager) configKey(grant protocol.WorkspaceLeaseGrant, name string) string {
	return "branch." + grant.Branch + "." + name
}

// configValue reads one single-valued key; a missing key is "", and a repeated key is an error.
func (manager *Manager) configValue(ctx context.Context, grant protocol.WorkspaceLeaseGrant, name string) (string, error) {
	output, err := manager.git.Run(ctx, grant.SourcePath, "config", "--local", "--get", manager.configKey(grant, name))
	if exitedWith(err, 1) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(string(output), "\n"), nil
}

func (manager *Manager) recordIdentity(ctx context.Context, grant protocol.WorkspaceLeaseGrant, base string) error {
	if _, err := manager.git.Run(ctx, grant.SourcePath, "config", "--local", manager.configKey(grant, leaseConfigName), grant.ID); err != nil {
		return err
	}
	_, err := manager.git.Run(ctx, grant.SourcePath, "config", "--local", manager.configKey(grant, baseConfigName), base)
	return err
}

func (manager *Manager) forgetIdentity(ctx context.Context, grant protocol.WorkspaceLeaseGrant) {
	for _, name := range []string{leaseConfigName, baseConfigName} {
		_, _ = manager.git.Run(ctx, grant.SourcePath, "config", "--local", "--unset-all", manager.configKey(grant, name))
	}
}

// canonicalDirectory requires an existing directory whose path contains no symbolic links.
func canonicalDirectory(path string) error {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if resolved != path {
		return errors.New("path is reached through a symbolic link")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("path is not a directory")
	}
	return nil
}

func sameCanonicalPath(reported, expected string) bool {
	resolved, err := filepath.EvalSymlinks(reported)
	return err == nil && resolved == expected
}

// within reports whether path is root or lexically beneath it.
func within(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

// createLeaf creates the lease's worktree directory itself, beneath a component-wise verified
// parent, so it fails if anything already occupies the path and Git then checks out into a
// directory Barista created and verified.
func createLeaf(root, path string) error {
	if _, err := safepath.VerifyDirectoryWithinRoot(root, filepath.Dir(path)); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		return err
	}
	information, err := os.Lstat(path)
	if err != nil {
		return err
	}
	return safepath.RejectUnsafeAncestor(path, information)
}

// removeEmptyLeaf removes the lease's worktree directory only while it is a real, empty directory
// beneath a verified parent; os.Remove never follows a link and refuses a non-empty directory.
func removeEmptyLeaf(root, path string) bool {
	if _, err := safepath.VerifyDirectoryWithinRoot(root, path); err != nil {
		return false
	}
	return os.Remove(path) == nil
}

// maximumGitFileBytes bounds the `.git` file a linked worktree contains.
const maximumGitFileBytes = 4096

// linkedToRepository verifies that the worktree's `.git` is a regular file whose gitdir resolves
// to an administrative directory of the source repository, whose own gitdir file points back at
// this worktree.
func linkedToRepository(grant protocol.WorkspaceLeaseGrant) bool {
	gitFile := filepath.Join(grant.WorktreePath, ".git")
	information, err := os.Lstat(gitFile)
	if err != nil || !information.Mode().IsRegular() || information.Size() > maximumGitFileBytes {
		return false
	}
	content, err := os.ReadFile(gitFile)
	if err != nil {
		return false
	}
	reported, found := strings.CutPrefix(strings.TrimSuffix(string(content), "\n"), "gitdir: ")
	if !found || !filepath.IsAbs(reported) {
		return false
	}
	administrative, err := filepath.EvalSymlinks(reported)
	administrativeRoot := filepath.Join(grant.SourcePath, ".git", "worktrees")
	if err != nil || filepath.Dir(administrative) != administrativeRoot {
		return false
	}
	backLink, err := os.ReadFile(filepath.Join(administrative, "gitdir"))
	if err != nil || len(backLink) > maximumGitFileBytes {
		return false
	}
	return strings.TrimSuffix(string(backLink), "\n") == gitFile
}
