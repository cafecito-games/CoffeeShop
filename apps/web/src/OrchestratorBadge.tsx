import { Plug, Robot } from "@phosphor-icons/react";
import type { ThreadOrchestratorDescription } from "./orchestratorPresentation.js";

/**
 * Who orchestrates a thread: a hub-hosted agent, or an operator's own Claude Code session and
 * whether that session is currently attached.
 */
export function OrchestratorBadge({ description }: { description: ThreadOrchestratorDescription }) {
  const external = description.kind === "external";
  return (
    <span className={`orchestrator-badge orchestrator-badge-${description.kind}${external && description.attached ? " attached" : ""}`}>
      {external ? <Plug size={12} weight={description.attached ? "fill" : "regular"} /> : <Robot size={12} />}
      <strong>{description.name}</strong>
      {description.detail && <small>{description.detail}</small>}
    </span>
  );
}
