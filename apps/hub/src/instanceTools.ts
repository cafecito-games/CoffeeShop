import {
  validateGetInstanceRequest,
  validateInstanceLifecycleRequest,
  type GetInstanceRequest,
  type InstanceCreator,
  type InstanceLifecycleRequest,
  type InstanceToolResult,
  type ToolSafeInstance,
  type ToolSafeInstanceAllocation
} from "@coffee-shop/protocol";
import { CoordinationError } from "./coordinationError.js";
import {
  applyInstanceLifecycle,
  currentAllocationInState,
  listThreadInstances
} from "./instances.js";
import {
  callerCanDelegate,
  resolveCallerFor,
  type CallerSource
} from "./mailbox.js";
import type { State, Store } from "./store.js";

/** The lifecycle names shared by the run-scoped and external orchestration dispatchers. */
export type InstanceToolName = "spawn_instance" | "get_instance" | "renew_instance" | "release_instance";

interface InstanceToolAuthority {
  threadId: string;
  creator: InstanceCreator;
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationError("invalid_arguments", "Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
};

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], operation: InstanceToolName) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CoordinationError("invalid_arguments", `${operation} arguments contain an unknown field`);
  }
};

/**
 * Derives lifecycle authority exclusively from the authenticated caller. A legacy configured-agent
 * run is never an instance principal, even when its static MCP grant includes delegation tools.
 */
function resolveInstanceToolAuthority(state: Readonly<State>, source: CallerSource): InstanceToolAuthority {
  const caller = resolveCallerFor(state, source);
  if (!callerCanDelegate(caller)) {
    throw new CoordinationError("forbidden", "This caller is not allowed to manage instances");
  }
  if (caller.principal.kind === "external") {
    return {
      threadId: caller.thread.id,
      creator: { kind: "orchestrator-client", clientId: caller.principal.client.id }
    };
  }
  if (caller.principal.runtime !== "instance") {
    throw new CoordinationError("forbidden", "Instance lifecycle tools require a live instance run");
  }
  return {
    threadId: caller.thread.id,
    creator: {
      kind: "run",
      runId: caller.principal.run.id,
      instanceId: caller.principal.instance.id
    }
  };
}

const sameAuthority = (left: InstanceToolAuthority, right: InstanceToolAuthority) =>
  left.threadId === right.threadId && JSON.stringify(left.creator) === JSON.stringify(right.creator);

function lifecycleRequest(
  operation: Exclude<InstanceToolName, "get_instance">,
  values: Record<string, unknown>,
  authority: InstanceToolAuthority
): InstanceLifecycleRequest {
  let candidate: unknown;
  if (operation === "spawn_instance") {
    onlyKeys(values, ["idempotencyKey", "requirements", "purpose", "idleTimeoutSeconds", "initialTask"], operation);
    candidate = {
      operation: "create",
      threadId: authority.threadId,
      idempotency: { caller: authority.creator, key: values.idempotencyKey },
      requirements: values.requirements,
      ...(values.purpose === undefined ? {} : { purpose: values.purpose }),
      ...(values.idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds: values.idleTimeoutSeconds }),
      ...(values.initialTask === undefined ? {} : { initialTask: values.initialTask })
    };
  } else if (operation === "renew_instance") {
    onlyKeys(values, ["instanceId", "idempotencyKey", "idleTimeoutSeconds"], operation);
    candidate = {
      operation: "renew",
      threadId: authority.threadId,
      instanceId: values.instanceId,
      idempotency: { caller: authority.creator, key: values.idempotencyKey },
      ...(values.idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds: values.idleTimeoutSeconds })
    };
  } else {
    onlyKeys(values, ["instanceId", "idempotencyKey", "mode"], operation);
    candidate = {
      operation: "release",
      threadId: authority.threadId,
      instanceId: values.instanceId,
      idempotency: { caller: authority.creator, key: values.idempotencyKey },
      mode: values.mode
    };
  }
  const validated = validateInstanceLifecycleRequest(candidate);
  if (!validated.ok) throw new CoordinationError("invalid_arguments", validated.reason);
  return validated.value;
}

const safeInstance = (instance: ReturnType<typeof listThreadInstances>["instances"][number]): ToolSafeInstance => ({
  id: instance.id,
  threadId: instance.threadId,
  ...(instance.purpose === undefined ? {} : {
    purpose: {
      ...(instance.purpose.name === undefined ? {} : { name: instance.purpose.name }),
      ...(instance.purpose.title === undefined ? {} : { title: instance.purpose.title }),
      ...(instance.purpose.summary === undefined ? {} : { summary: instance.purpose.summary })
    }
  }),
  delegation: { ...instance.delegation },
  requirements: structuredClone(instance.requirements),
  lease: { ...instance.lease },
  status: instance.status,
  createdAt: instance.createdAt,
  updatedAt: instance.updatedAt
});

const safeAllocation = (allocation: NonNullable<ReturnType<typeof currentAllocationInState>>): ToolSafeInstanceAllocation => ({
  id: allocation.id,
  instanceId: allocation.instanceId,
  nodeId: allocation.nodeId,
  harnessId: allocation.harnessId,
  model: allocation.model,
  transport: allocation.transport,
  ...(allocation.expectedCapabilityPack === undefined ? {} : { expectedCapabilityPack: structuredClone(allocation.expectedCapabilityPack) }),
  lease: { ...allocation.lease },
  status: allocation.status,
  createdAt: allocation.createdAt,
  updatedAt: allocation.updatedAt
});

function projectInstance(
  state: Readonly<State>,
  request: GetInstanceRequest,
  resultFields: Pick<InstanceToolResult, "initialTaskId" | "replayed"> = {}
): InstanceToolResult {
  const listing = listThreadInstances(state, request.threadId, true);
  const instance = listing.instances.find((item) => item.id === request.instanceId);
  if (instance === undefined) throw new CoordinationError("not_found", "Instance not found");
  const allocation = currentAllocationInState(state, instance.id);
  return {
    instance: safeInstance(instance),
    ...(allocation === undefined ? {} : { allocation: safeAllocation(allocation) }),
    ...(resultFields.initialTaskId === undefined ? {} : { initialTaskId: resultFields.initialTaskId }),
    ...(resultFields.replayed === undefined ? {} : { replayed: resultFields.replayed })
  };
}

/** A same-thread, terminal-inclusive read that creates no lifecycle receipt or transition. */
export function getInstanceForSource(store: Store, source: CallerSource, argumentsValue: unknown): InstanceToolResult {
  return store.read((state) => {
    const authority = resolveInstanceToolAuthority(state, source);
    const values = record(argumentsValue);
    onlyKeys(values, ["instanceId"], "get_instance");
    const validated = validateGetInstanceRequest({ threadId: authority.threadId, instanceId: values.instanceId });
    if (!validated.ok) throw new CoordinationError("invalid_arguments", validated.reason);
    return projectInstance(state, validated.value);
  });
}

/**
 * Adapts one public mutation to the authoritative lifecycle service. Authority is resolved before
 * arguments and re-resolved inside the service transaction so revocation, attachment replacement,
 * allocation replacement, or delegation removal cannot race the commit.
 */
export async function applyInstanceToolForSource(
  store: Store,
  source: CallerSource,
  operation: Exclude<InstanceToolName, "get_instance">,
  argumentsValue: unknown,
  at = new Date().toISOString()
): Promise<InstanceToolResult> {
  const authority = store.read((state) => resolveInstanceToolAuthority(state, source));
  const request = lifecycleRequest(operation, record(argumentsValue), authority);
  const result = await applyInstanceLifecycle(store, authority.creator, request, at, {
    assertAuthorized: (state) => {
      const current = resolveInstanceToolAuthority(state, source);
      if (!sameAuthority(current, authority)) {
        throw new CoordinationError("forbidden", "The authenticated instance principal changed before the request committed");
      }
    }
  });
  return store.read((state) => projectInstance(state, {
    threadId: authority.threadId,
    instanceId: result.instance.id
  }, {
    ...(result.initialTaskId === undefined ? {} : { initialTaskId: result.initialTaskId }),
    replayed: result.replayed
  }));
}
