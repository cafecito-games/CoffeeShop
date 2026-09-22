import { orchestratorClientProtocolVersion, validateOrchestratorClientMessage } from "@coffee-shop/protocol";

/** Environment variables the operator sets in the Claude Code MCP server entry. */
export const bridgeEnvironmentVariableNames = {
  hubUrl: "COFFEE_SHOP_HUB_URL",
  clientId: "COFFEE_SHOP_CLIENT_ID",
  clientSecret: "COFFEE_SHOP_CLIENT_SECRET"
} as const;

export interface BridgeConfiguration {
  hubUrl: string;
  clientId: string;
  clientSecret: string;
}

export type BridgeConfigurationResult =
  | { ok: true; configuration: BridgeConfiguration }
  | { ok: false; problems: string[] };

const acceptedHubProtocols = new Set(["ws:", "wss:"]);

/**
 * Reads and validates the bridge credential from the environment. Problems name the offending
 * variable but never its value, so a malformed secret cannot reach stderr through this path.
 * The credential is additionally checked against the real `client.hello` contract, so a value the
 * hub would reject is refused before the process ever opens a socket.
 */
export function readBridgeConfiguration(environment: Record<string, string | undefined>): BridgeConfigurationResult {
  const problems: string[] = [];
  const hubUrl = environment[bridgeEnvironmentVariableNames.hubUrl]?.trim() ?? "";
  const clientId = environment[bridgeEnvironmentVariableNames.clientId]?.trim() ?? "";
  const clientSecret = environment[bridgeEnvironmentVariableNames.clientSecret] ?? "";

  if (hubUrl === "") {
    problems.push(`${bridgeEnvironmentVariableNames.hubUrl} is required (for example wss://hub.example.com/orchestrator-client)`);
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(hubUrl);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      problems.push(`${bridgeEnvironmentVariableNames.hubUrl} is not a valid URL`);
    } else if (!acceptedHubProtocols.has(parsed.protocol)) {
      problems.push(`${bridgeEnvironmentVariableNames.hubUrl} must use the ws:// or wss:// scheme`);
    }
  }

  if (clientId === "") problems.push(`${bridgeEnvironmentVariableNames.clientId} is required`);
  if (clientSecret === "") problems.push(`${bridgeEnvironmentVariableNames.clientSecret} is required`);

  if (problems.length === 0) {
    const hello = validateOrchestratorClientMessage({
      type: "client.hello",
      protocolVersion: orchestratorClientProtocolVersion,
      clientId,
      secret: clientSecret
    });
    if (!hello.ok) {
      problems.push(`${bridgeEnvironmentVariableNames.clientId}/${bridgeEnvironmentVariableNames.clientSecret} are rejected by the orchestrator-client contract: ${hello.reason}`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, configuration: { hubUrl, clientId, clientSecret } };
}

/**
 * Replaces every occurrence of the client secret with a placeholder. Every line the bridge writes
 * to stderr passes through this, including messages built from hub frames and thrown errors.
 */
export function createSecretRedactor(secret: string): (text: string) => string {
  if (secret === "") return (text) => text;
  return (text) => text.split(secret).join("[redacted]");
}
