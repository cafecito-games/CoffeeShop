import { readFileSync } from "node:fs";
import * as protocol from "../dist/index.js";

export const readInstanceFixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/control-v5/${name}.json`, import.meta.url), "utf8"));
/** Real exported TypeScript vocabulary and JSON encoder, compared byte-for-byte in tests. */
export function instanceVocabularyFixture() {
  return Object.fromEntries([
    "instanceStatuses", "allocationStatuses", "instanceReleaseModes", "instanceCreatorKinds",
    "instanceLifecycleOperations", "instanceHubMessageTypes", "instanceControlMessageTypes",
    "instanceTransitions", "allocationTransitions", "instanceLimits"
  ].map((name) => [name, protocol[name]]));
}
/** Mutations of real Go-produced wire values; both language loaders consume these exact bytes. */
export function invalidInstanceFixtures() {
  const cases = [];
  const mutate = (name, kind, fixture, change) => {
    const value = readInstanceFixture(fixture); change(value); cases.push({ name, kind, value });
  };
  const remove = (name, kind, fixture, key) => mutate(name, kind, fixture, (value) => { delete value[key]; });
  for (const name of ["provision", "dispatch", "release"]) {
    mutate(`${name} extra field`, "hub", name, (v) => { v.extra = true; });
    mutate(`${name} unknown discriminator`, "hub", name, (v) => { v.type = "instance.teleport"; });
  }
  for (const name of ["ready", "released", "failed"]) {
    for (const key of ["nodeId", "instanceId", "allocationId", "at"]) remove(`${name} missing ${key}`, "control", name, key);
  }
  mutate("release unknown mode", "hub", "release", (v) => { v.mode = "immediate"; });
  mutate("provision allocation mismatch", "hub", "provision", (v) => { v.allocation.instanceId = "other"; });
  mutate("provision lease mismatch", "hub", "provision", (v) => { v.allocation.lease.idleTimeoutSeconds = 60; });
  mutate("provision missing delegation authority", "hub", "provision", (v) => { v.instance.delegation = {}; });
  mutate("provision unknown creator", "hub", "provision", (v) => { v.instance.creator.kind = "admin"; });
  mutate("provision ambiguous creator", "hub", "provision", (v) => { v.instance.creator.runId = "run-other"; });
  mutate("provision unknown requirement", "hub", "provision", (v) => { v.instance.requirements.admin = true; });
  mutate("provision relative workspace", "hub", "provision", (v) => { v.allocation.workspace = "workspace"; });
  mutate("provision unknown status", "hub", "provision", (v) => { v.instance.status = "magic"; });
  mutate("provision unknown allocation status", "hub", "provision", (v) => { v.allocation.status = "magic"; });
  for (const field of ["instanceId", "allocationId", "nodeId", "harnessId", "model", "workspace", "threadId", "transport"]) {
    mutate(`dispatch mismatched ${field}`, "hub", "dispatch", (v) => { v.run[field] = "other"; });
  }
  mutate("dispatch legacy actor ambiguity", "hub", "dispatch", (v) => { v.run.agentId = "legacy"; });
  mutate("dispatch template prohibited", "hub", "dispatch", (v) => { v.agent = { id: "legacy" }; });
  mutate("dispatch allocation missing", "hub", "dispatch", (v) => { delete v.run.allocationId; });
  mutate("dispatch released allocation", "hub", "dispatch", (v) => { v.allocation.status = "released"; });
  mutate("dispatch draining instance", "hub", "dispatch", (v) => { v.instance.status = "draining"; });
  for (const ids of [null, ["same", "same"], [""], ["bad/id"]]) mutate(`invalid resident IDs ${JSON.stringify(ids)}`, "control", "sync", (v) => { v.activeInstanceIds = ids; });
  mutate("too many resident IDs", "control", "sync", (v) => { v.activeInstanceIds = Array.from({ length: 1025 }, (_, n) => `i-${n}`); });
  for (const ids of [null, ["same", "same"], [""], ["bad/id"]]) mutate(`invalid heartbeat resident IDs ${JSON.stringify(ids)}`, "control", "heartbeat", (v) => { v.activeInstanceIds = ids; });
  mutate("too many heartbeat resident IDs", "control", "heartbeat", (v) => { v.activeInstanceIds = Array.from({ length: 1025 }, (_, n) => `i-${n}`); });
  for (const count of [-1, 1.5, 65536, null, "0"]) mutate(`invalid count ${JSON.stringify(count)}`, "control", "heartbeat", (v) => { v.activeInstances = count; });
  mutate("registration unknown nested field", "control", "register", (v) => { v.node.harnesses[0].extra = true; });
  mutate("registration over capacity", "control", "register", (v) => { v.node.activeInstances = 5; });
  mutate("registration version mismatch", "control", "register", (v) => { v.protocolVersion = "4"; });
  for (const timeout of [59, 86401, 60.5, null]) mutate(`idle lease bound ${timeout}`, "hub", "provision", (v) => { v.instance.lease.idleTimeoutSeconds = timeout; });
  mutate("purpose UTF8 bytes", "hub", "provision", (v) => { v.instance.purpose.name = "é".repeat(129); });
  mutate("instructions byte limit", "lifecycle", "create", (v) => { v.purpose.instructions = "x".repeat(65537); });
  mutate("idempotency byte limit", "lifecycle", "create", (v) => { v.idempotency.key = "é".repeat(65); });
  mutate("empty idempotency key", "lifecycle", "create", (v) => { v.idempotency.key = ""; });
  mutate("missing idempotency caller", "lifecycle", "create", (v) => { delete v.idempotency.caller; });
  mutate("unknown lifecycle operation", "lifecycle", "create", (v) => { v.operation = "spawn"; });
  mutate("create cannot grant delegation", "lifecycle", "create", (v) => { v.delegation = { canDelegate: true }; });
  mutate("initial task unknown field", "lifecycle", "create", (v) => { v.initialTask.nodeId = "node-one"; });
  for (const field of ["nodeId", "state", "sessionId", "capacity", "instanceId", "inbox"]) mutate(`template rejects ${field}`, "template", "template", (v) => { v[field] = "forbidden"; });
  return cases;
}
