//go:build system && unix

package systemtest

// The subset of the hub's published snapshot the scenarios assert on. Field names follow
// packages/protocol/src/index.ts; the hub is the only producer.

type snapshot struct {
	Agents              []agent             `json:"agents"`
	Nodes               []computeNode       `json:"nodes"`
	Runs                []run               `json:"runs"`
	Threads             []thread            `json:"threads"`
	Tasks               []task              `json:"tasks"`
	TaskMessages        []taskMessage       `json:"taskMessages"`
	Artifacts           []artifact          `json:"artifacts"`
	SessionBindings     []sessionBinding    `json:"sessionBindings"`
	OrchestratorInboxes []orchestratorInbox `json:"orchestratorInboxes"`
	Approvals           []approval          `json:"approvals"`
	// Orchestrator credentials as published: the secret hash is hub-only and never appears here.
	OrchestratorClients     []orchestratorClient     `json:"orchestratorClients"`
	OrchestratorAttachments []orchestratorAttachment `json:"orchestratorAttachments"`
	WorkspaceLeases         []workspaceLease         `json:"workspaceLeases"`
	RunActivity             []map[string]any         `json:"runActivity"`
	Events                  []timelineEvent          `json:"events"`
}

type agent struct {
	ID            string `json:"id"`
	ComputeNodeID string `json:"computeNodeId"`
	State         string `json:"state"`
}

type computeNode struct {
	ID        string           `json:"id"`
	Status    string           `json:"status"`
	Version   string           `json:"version"`
	Harnesses []map[string]any `json:"harnesses"`
}

type transportSelection struct {
	RequestedTransport string         `json:"requestedTransport"`
	SelectedTransport  string         `json:"selectedTransport"`
	FallbackReason     string         `json:"fallbackReason"`
	Adapter            map[string]any `json:"adapter"`
}

type run struct {
	ID                 string              `json:"id"`
	ThreadID           string              `json:"threadId"`
	AgentID            string              `json:"agentId"`
	NodeID             string              `json:"nodeId"`
	HarnessID          string              `json:"harnessId"`
	Workspace          string              `json:"workspace"`
	Status             string              `json:"status"`
	Output             string              `json:"output"`
	Error              string              `json:"error"`
	StartedAt          string              `json:"startedAt"`
	FinishedAt         string              `json:"finishedAt"`
	CreatedAt          string              `json:"createdAt"`
	TaskID             string              `json:"taskId"`
	Attempt            int                 `json:"attempt"`
	Transport          string              `json:"transport"`
	FallbackTransport  string              `json:"fallbackTransport"`
	TransportSelection *transportSelection `json:"transportSelection"`
	SessionBindingID   string              `json:"sessionBindingId"`
	WorkspaceLeaseID   string              `json:"workspaceLeaseId"`
}

type thread struct {
	ID           string `json:"id"`
	OwnerAgentID string `json:"ownerAgentId"`
	Status       string `json:"status"`
	Summary      string `json:"summary"`
}

type unsatisfiedRequirement struct {
	Kind        string `json:"kind"`
	Requirement string `json:"requirement"`
	NodeID      string `json:"nodeId"`
	AgentID     string `json:"agentId"`
	Detail      string `json:"detail"`
}

type placementDiagnostic struct {
	EligibleNodeIDs []string                 `json:"eligibleNodeIds"`
	Unsatisfied     []unsatisfiedRequirement `json:"unsatisfied"`
}

type taskDependency struct {
	TaskID string `json:"taskId"`
	Policy string `json:"policy"`
}

type task struct {
	ID            string               `json:"id"`
	ThreadID      string               `json:"threadId"`
	Title         string               `json:"title"`
	Status        string               `json:"status"`
	Dependencies  []taskDependency     `json:"dependencies"`
	Assignment    map[string]any       `json:"assignment"`
	Placement     *placementDiagnostic `json:"placement"`
	AttemptRunIDs []string             `json:"attemptRunIds"`
	Result        string               `json:"result"`
	Error         string               `json:"error"`
	Progress      map[string]any       `json:"progress"`
	CreatedAt     string               `json:"createdAt"`
	FinishedAt    string               `json:"finishedAt"`
}

type participant struct {
	Type   string `json:"type"`
	TaskID string `json:"taskId"`
}

type taskMessage struct {
	ID                 string      `json:"id"`
	ThreadID           string      `json:"threadId"`
	Sender             participant `json:"sender"`
	Recipient          participant `json:"recipient"`
	Sequence           int         `json:"sequence"`
	Kind               string      `json:"kind"`
	Body               string      `json:"body"`
	CorrelationID      string      `json:"correlationId"`
	InReplyToMessageID string      `json:"inReplyToMessageId"`
	IdempotencyKey     string      `json:"idempotencyKey"`
}

type artifact struct {
	ID       string `json:"id"`
	ThreadID string `json:"threadId"`
	RunID    string `json:"runId"`
	Title    string `json:"title"`
	Size     int    `json:"size"`
	SHA256   string `json:"sha256"`
	Uploaded bool   `json:"uploaded"`
}

type sessionBinding struct {
	ID                  string `json:"id"`
	ThreadID            string `json:"threadId"`
	AgentID             string `json:"agentId"`
	NodeID              string `json:"nodeId"`
	ProviderSessionID   string `json:"providerSessionId"`
	Status              string `json:"status"`
	CreatedByRunID      string `json:"createdByRunId"`
	LastRunID           string `json:"lastRunId"`
	ReplacedByBindingID string `json:"replacedByBindingId"`
}

type orchestratorWake struct {
	ID                        string `json:"id"`
	RunID                     string `json:"runId"`
	FromSequence              int    `json:"fromSequence"`
	ThroughSequence           int    `json:"throughSequence"`
	EventSequences            []int  `json:"eventSequences"`
	Redelivery                bool   `json:"redelivery"`
	RequestedSessionBindingID string `json:"requestedSessionBindingId"`
	SessionOutcome            string `json:"sessionOutcome"`
	Status                    string `json:"status"`
}

type orchestratorInbox struct {
	ThreadID         string             `json:"threadId"`
	DeliveredThrough int                `json:"deliveredThrough"`
	ProcessedThrough int                `json:"processedThrough"`
	Wakes            []orchestratorWake `json:"wakes"`
}

type approvalResolver struct {
	Kind         string `json:"kind"`
	ClientID     string `json:"clientId"`
	AttachmentID string `json:"attachmentId"`
}

// kind reports the resolver kind, or the empty string when the approval is unresolved.
func (resolver *approvalResolver) kind() string {
	if resolver == nil {
		return ""
	}
	return resolver.Kind
}

type approvalDelivery struct {
	Status   string `json:"status"`
	Attempts int    `json:"attempts"`
	Reason   string `json:"reason"`
}

type approval struct {
	ID                string            `json:"id"`
	HarnessApprovalID string            `json:"harnessApprovalId"`
	ThreadID          string            `json:"threadId"`
	TaskID            string            `json:"taskId"`
	RunID             string            `json:"runId"`
	NodeID            string            `json:"nodeId"`
	Status            string            `json:"status"`
	ResolvedBy        *approvalResolver `json:"resolvedBy"`
	SelectedOptionID  string            `json:"selectedOptionId"`
	ExpiresAt         string            `json:"expiresAt"`
	Delivery          *approvalDelivery `json:"delivery"`
}

type orchestratorClient struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	CreatedAt  string   `json:"createdAt"`
	LastSeenAt string   `json:"lastSeenAt"`
	RevokedAt  string   `json:"revokedAt"`
}

type orchestratorAttachment struct {
	ID           string `json:"id"`
	ThreadID     string `json:"threadId"`
	ClientID     string `json:"clientId"`
	ConnectionID string `json:"connectionId"`
	Status       string `json:"status"`
	AttachedAt   string `json:"attachedAt"`
	DetachedAt   string `json:"detachedAt"`
}

type workspaceLease struct {
	ID              string `json:"id"`
	TaskID          string `json:"taskId"`
	RunID           string `json:"runId"`
	NodeID          string `json:"nodeId"`
	Policy          string `json:"policy"`
	Cleanup         string `json:"cleanup"`
	Root            string `json:"root"`
	SourcePath      string `json:"sourcePath"`
	Branch          string `json:"branch"`
	WorktreePath    string `json:"worktreePath"`
	Status          string `json:"status"`
	RetentionReason string `json:"retentionReason"`
}

type timelineEvent struct {
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	ThreadID string `json:"threadId"`
	RunID    string `json:"runId"`
}

func (current snapshot) task(id string) (task, bool) {
	for _, item := range current.Tasks {
		if item.ID == id {
			return item, true
		}
	}
	return task{}, false
}

func (current snapshot) run(id string) (run, bool) {
	for _, item := range current.Runs {
		if item.ID == id {
			return item, true
		}
	}
	return run{}, false
}

func (current snapshot) thread(id string) (thread, bool) {
	for _, item := range current.Threads {
		if item.ID == id {
			return item, true
		}
	}
	return thread{}, false
}

func (current snapshot) lease(id string) (workspaceLease, bool) {
	for _, item := range current.WorkspaceLeases {
		if item.ID == id {
			return item, true
		}
	}
	return workspaceLease{}, false
}

func (current snapshot) inbox(threadID string) (orchestratorInbox, bool) {
	for _, item := range current.OrchestratorInboxes {
		if item.ThreadID == threadID {
			return item, true
		}
	}
	return orchestratorInbox{}, false
}

// threadTasks returns the tasks of a thread keyed by title.
func (current snapshot) threadTasks(threadID string) map[string]task {
	result := map[string]task{}
	for _, item := range current.Tasks {
		if item.ThreadID == threadID {
			result[item.Title] = item
		}
	}
	return result
}

// latestAttempt returns the task's most recent attempt run.
func (current snapshot) latestAttempt(item task) (run, bool) {
	if len(item.AttemptRunIDs) == 0 {
		return run{}, false
	}
	return current.run(item.AttemptRunIDs[len(item.AttemptRunIDs)-1])
}

func (current snapshot) approvalsFor(runID string) []approval {
	result := []approval{}
	for _, item := range current.Approvals {
		if item.RunID == runID {
			result = append(result, item)
		}
	}
	return result
}

func (current snapshot) messagesIn(threadID string) []taskMessage {
	result := []taskMessage{}
	for _, item := range current.TaskMessages {
		if item.ThreadID == threadID {
			result = append(result, item)
		}
	}
	return result
}

// attachmentsFor returns a thread's attachments in the order the hub recorded them.
func (current snapshot) attachmentsFor(threadID string) []orchestratorAttachment {
	result := []orchestratorAttachment{}
	for _, item := range current.OrchestratorAttachments {
		if item.ThreadID == threadID {
			result = append(result, item)
		}
	}
	return result
}

// attachedTo returns the thread's single live attachment, if it has one.
func (current snapshot) attachedTo(threadID string) (orchestratorAttachment, bool) {
	for _, item := range current.attachmentsFor(threadID) {
		if item.Status == "attached" {
			return item, true
		}
	}
	return orchestratorAttachment{}, false
}

func (current snapshot) orchestratorClient(clientID string) (orchestratorClient, bool) {
	for _, item := range current.OrchestratorClients {
		if item.ID == clientID {
			return item, true
		}
	}
	return orchestratorClient{}, false
}

// hubHostedOrchestratorRuns returns the thread's runs that are not task attempts, which is what a
// hub-hosted orchestrator run is. An externally orchestrated thread must never have one.
func (current snapshot) hubHostedOrchestratorRuns(threadID string) []run {
	result := []run{}
	for _, item := range current.Runs {
		if item.ThreadID == threadID && item.TaskID == "" {
			result = append(result, item)
		}
	}
	return result
}

func (current snapshot) activity(runID string) map[string]any {
	for _, item := range current.RunActivity {
		if item["runId"] == runID {
			return item
		}
	}
	return nil
}
