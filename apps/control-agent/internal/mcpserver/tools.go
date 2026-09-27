package mcpserver

import "github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"

const instructions = "Use get_task_context for the durable thread, your task, its lineage, and your mailbox cursor. " +
	"Workers report with update_task, ask or answer through send_task_message, and wait for replies or task changes with wait_for_task_events, passing back the cursor it returns. " +
	"Orchestrators inspect get_execution_inventory and submit parallel work with submit_tasks, describing capabilities rather than machines. " +
	"Refine or complete the thread with update_thread, post durable files with post_artifact, and publish static directories with publish_preview. " +
	"Every mutation takes a stable idempotency key: retry with the same key and arguments after a retryable error."

type schema = map[string]any

func object(properties schema, required ...string) schema {
	result := schema{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

// result describes structured tool output. Output objects stay open so the hub can add fields
// without breaking clients that validate structured content.
func result(properties schema, required ...string) schema {
	output := schema{"type": "object", "properties": properties}
	if len(required) > 0 {
		output["required"] = required
	}
	return output
}

func text() schema                 { return schema{"type": "string"} }
func boolean() schema              { return schema{"type": "boolean"} }
func integer() schema              { return schema{"type": "integer"} }
func anyObject() schema            { return schema{"type": "object"} }
func enum(values ...string) schema { return schema{"type": "string", "enum": values} }
func list(items schema) schema     { return schema{"type": "array", "items": items} }
func objects() schema              { return list(anyObject()) }

func requirementsSchema() schema {
	strings := list(text())
	return object(schema{
		"skills": strings, "harnessIds": list(enum(protocol.HarnessIDs...)), "models": strings,
		"transports": list(enum(protocol.HarnessTransports...)), "operatingSystems": strings, "architectures": strings,
		"labels": strings, "minimumConcurrency": integer(), "minimumMemoryMegabytes": integer(), "projectProfileId": text(),
		"workspace":   object(schema{"repository": text(), "path": text(), "writable": boolean()}, "writable"),
		"preferences": object(schema{"nodeIds": strings, "harnessIds": list(enum(protocol.HarnessIDs...)), "models": strings, "labels": strings}),
	})
}

type toolDefinition struct {
	title, description string
	input, output      schema
	readOnly           bool
}

var definitions = map[string]toolDefinition{
	"get_task_context": {
		title:       "Get task context",
		description: "Get the durable thread, your task or a visible related task, its dependencies, attempts, child tasks, artifacts, your mailbox summary and cursor, and limits.",
		input:       object(schema{"taskId": text()}),
		output: result(schema{
			"thread": anyObject(), "caller": anyObject(), "task": anyObject(), "durableTask": anyObject(),
			"childTasks": objects(), "taskGraph": objects(), "taskGraphTruncated": boolean(), "delegations": objects(),
			"mailbox": anyObject(), "artifacts": objects(), "availableAgents": objects(), "limits": anyObject(), "version": text(),
		}, "thread", "task", "delegations", "artifacts", "availableAgents", "limits", "version"),
		readOnly: true,
	},
	"post_artifact": {
		title:       "Post artifact",
		description: "Publish a regular file from the current run workspace. Use a relative path and a stable idempotency key.",
		input: object(schema{
			"relativePath": text(), "title": text(), "kind": enum("patch", "report", "test-results", "log", "image", "other"),
			"mediaType": text(), "summary": text(), "idempotencyKey": text(),
		}, "relativePath", "title", "kind", "mediaType", "idempotencyKey"),
		output: result(schema{
			"id": text(), "runId": text(), "title": text(), "kind": text(), "downloadPath": text(), "uploaded": boolean(),
		}, "id", "runId", "title", "kind", "downloadPath", "uploaded"),
	},
	"publish_preview": {
		title:       "Publish preview",
		description: "Package and publish a static directory from the current run workspace as a deterministic preview bundle. Paths are relative, and retries use the same stable idempotency key and unchanged arguments.",
		input: object(schema{
			"relativePath": text(), "entrypoint": text(), "title": text(), "summary": text(),
			"ttlSeconds": schema{
				"type": "integer", "minimum": protocol.PreviewBundleContract.MinimumTTLSeconds,
				"maximum": protocol.PreviewBundleContract.MaximumLifetimeSeconds,
			},
			"idempotencyKey": text(),
		}, "relativePath", "entrypoint", "title", "idempotencyKey"),
		output: result(schema{
			"artifact": result(schema{
				"id": text(), "threadId": text(), "runId": text(), "agentId": text(), "instanceId": text(),
				"allocationId": text(), "relativePath": text(), "title": text(),
				"kind": enum(protocol.PreviewBundleArtifactKind), "mediaType": enum(protocol.PreviewBundleMediaType),
				"summary": text(), "size": integer(), "sha256": text(), "downloadPath": text(),
				"uploaded": boolean(), "idempotencyKey": text(), "createdAt": text(),
			}, "id", "threadId", "runId", "relativePath", "title", "kind", "mediaType", "summary", "size", "sha256", "downloadPath", "uploaded", "idempotencyKey", "createdAt"),
			"preview": result(schema{
				"id": text(), "artifactId": text(), "artifactSha256": text(), "threadId": text(), "runId": text(),
				"agentId": text(), "instanceId": text(), "allocationId": text(), "entrypoint": text(),
				"status": enum(protocol.ArtifactPreviewStatuses...), "processingGeneration": integer(),
				"createdAt": text(), "updatedAt": text(), "expiresAt": text(), "readyAt": text(),
				"failedAt": text(), "failureCode": enum(protocol.ArtifactPreviewFailureCodes...),
				"expiredAt": text(), "accessState": enum(protocol.ArtifactPreviewAccessStates...),
			}, "id", "artifactId", "artifactSha256", "threadId", "runId", "entrypoint", "status", "processingGeneration", "createdAt", "updatedAt", "expiresAt", "accessState"),
			"created": boolean(),
		}, "artifact", "preview", "created"),
	},
	"update_thread": {
		title:       "Update thread",
		description: "Refine the current thread title, objective, or summary, or mark it active or completed. Archival is reserved for the operator.",
		input: func() schema {
			input := object(schema{"title": text(), "objective": text(), "summary": text(), "status": enum("active", "completed")})
			input["minProperties"] = 1
			return input
		}(),
		output: result(schema{"thread": anyObject()}, "thread"),
	},
	"delegate_task": {
		title:       "Delegate task",
		description: "Create a bounded task pinned to another available agent. It is scheduled like any other task; retain the returned task id and inspect it with get_task_context.",
		input: object(schema{
			"agentId": text(), "task": text(), "artifactIds": list(text()), "idempotencyKey": text(),
		}, "agentId", "task", "idempotencyKey"),
		output: result(schema{
			"taskId": text(), "status": text(), "agentId": text(), "created": boolean(), "assignment": anyObject(), "placement": anyObject(),
		}, "taskId", "status", "agentId", "created"),
	},
	"get_execution_inventory": {
		title:       "Get execution inventory",
		description: "List configured agents with their skills and compute nodes with harnesses, capacity, and worker-reported capabilities and their freshness, to write task requirements.",
		input:       object(schema{}),
		output: result(schema{
			"generatedAt": text(), "agents": objects(), "nodes": objects(), "truncated": anyObject(),
		}, "generatedAt", "agents", "nodes", "truncated"),
		readOnly: true,
	},
	"submit_tasks": {
		title: "Submit tasks",
		description: "Atomically submit a batch of tasks. Name tasks with local keys, depend on sibling keys or existing task ids, and state hard requirements and preferences as capabilities. " +
			"An optional pin narrows placement to an agent or node and never bypasses requirements. Submission succeeds even when no node can run a task yet.",
		input: object(schema{
			"idempotencyKey": text(),
			"tasks": list(object(schema{
				"key": text(), "title": text(), "instructions": text(), "requirements": requirementsSchema(),
				"dependencies": list(object(schema{"key": text(), "taskId": text(), "policy": enum("require-success", "allow-failure")})),
				"pin":          object(schema{"agentId": text(), "nodeId": text()}),
			}, "key", "title", "instructions")),
		}, "idempotencyKey", "tasks"),
		output: result(schema{
			"created": boolean(), "submissionId": text(), "taskIdsByKey": anyObject(), "tasks": objects(),
		}, "created", "submissionId", "taskIdsByKey", "tasks"),
	},
	"send_task_message": {
		title:       "Send task message",
		description: "Send an immutable message to the thread orchestrator or to a task in your lineage, optionally correlated with or replying to an earlier message and referencing uploaded artifacts.",
		input: object(schema{
			"idempotencyKey": text(),
			"recipient":      object(schema{"type": enum("task", "orchestrator"), "taskId": text()}, "type"),
			"kind":           enum(protocol.TaskMessageKinds...), "body": text(), "correlationId": text(),
			"inReplyToMessageId": text(), "artifactIds": list(text()),
		}, "idempotencyKey", "recipient", "kind", "body"),
		output: result(schema{
			"created": boolean(), "messageId": text(), "sequence": integer(), "recipient": anyObject(), "createdAt": text(),
		}, "created", "messageId", "sequence", "recipient", "createdAt"),
	},
	"wait_for_task_events": {
		title:       "Wait for task events",
		description: "Wait until messages to you or changes to visible tasks commit after the cursor, or until the timeout. Always pass the returned cursor to the next call; optionally acknowledge messages you have handled.",
		input: object(schema{
			"cursor":                text(),
			"timeoutMilliseconds":   schema{"type": "integer", "minimum": 0, "maximum": protocol.MaximumWaitMilliseconds},
			"maximumEvents":         schema{"type": "integer", "minimum": 1, "maximum": protocol.MaximumEventsPerWait},
			"acknowledgeMessageIds": list(text()),
		}),
		output: result(schema{
			"events": objects(), "cursor": text(), "hasMore": boolean(), "timedOut": boolean(),
		}, "events", "cursor", "hasMore", "timedOut"),
	},
	"update_task": {
		title:       "Update task",
		description: "As the task's current assignee, report progress, an advisory blocked reason (null clears it), or completion fields. Task status still follows your run.",
		input: object(schema{
			"idempotencyKey": text(), "progress": text(), "blockedReason": schema{"type": []string{"string", "null"}},
			"completion": object(schema{"summary": text(), "artifactIds": list(text())}, "summary"),
		}, "idempotencyKey"),
		output: result(schema{"created": boolean(), "updateId": text(), "task": anyObject()}, "created", "updateId", "task"),
	},
}

// ToolNames lists the tools a run may call, in the shared vocabulary's order.
func ToolNames(canDelegate bool) []string {
	names := make([]string, 0, len(protocol.HubToolNames))
	for _, name := range protocol.HubToolNames {
		if protocol.IsDelegationHubToolName(name) && !canDelegate {
			continue
		}
		names = append(names, name)
	}
	return names
}

func tools(canDelegate bool) []map[string]any {
	names := ToolNames(canDelegate)
	listed := make([]map[string]any, 0, len(names))
	for _, name := range names {
		definition := definitions[name]
		listed = append(listed, map[string]any{
			"name": name, "title": definition.title, "description": definition.description,
			"inputSchema": definition.input, "outputSchema": definition.output,
			"annotations": map[string]bool{"readOnlyHint": definition.readOnly, "destructiveHint": false, "idempotentHint": true},
		})
	}
	return listed
}
