import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionDetail } from "./SessionDetail.js";
import { buildSessionsReadModel, emptySessionFilters } from "./sessionReadModel.js";
import { sessionFixture, sessionsSnapshot } from "./sessionTestFixtures.js";

describe("SessionDetail", () => {
  it("labels bounded imported history and never renders mutation controls", () => {
    const session = sessionFixture({ status: "active-elsewhere", controlMode: "observe", operations: ["read-history"] });
    const model = buildSessionsReadModel({ snapshot: sessionsSnapshot([session]), connection: "connected", filters: emptySessionFilters(), selectedId: session.hostHarnessSessionId,
      detail: { session, links: {} }, history: {
        hostHarnessSessionId: session.hostHarnessSessionId, nodeId: session.nodeId, harnessId: session.harnessId,
        providerSessionId: session.providerSessionId, workspace: session.workspace, revision: session.revision,
        items: [{ id: "history-one", kind: "assistant", text: "Synthetic provider output", truncated: true }],
        stale: false, truncated: true, omitted: false
      } });
    render(<SessionDetail model={model} loading={false} unavailable={false} onBack={() => undefined} />);
    expect(screen.getByText("Imported evidence")).toBeInTheDocument();
    expect(screen.getByText("Item truncated by the host")).toBeInTheDocument();
    expect(screen.getByText(/additional provider history is not displayed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /adopt|attach|interrupt|close/i })).not.toBeInTheDocument();
  });
});
