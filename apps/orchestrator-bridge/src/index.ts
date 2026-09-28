import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeServer } from "./bridgeServer.js";
import { bridgeEnvironmentVariableNames, createSecretRedactor, readBridgeConfiguration } from "./configuration.js";
import { HubConnection } from "./hubConnection.js";
import { canonicalWorkingRoot, createArtifactHttpUploader, LocalArtifactService } from "./localArtifact.js";

const version = "0.1.0";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main(): Promise<void> {
  const configuration = readBridgeConfiguration(process.env);
  if (!configuration.ok) {
    // Refuse before the MCP stream opens, so a misconfigured bridge never looks available.
    process.stderr.write(
      `coffeeshop orchestrator bridge cannot start.\n${configuration.problems.map((problem) => `  - ${problem}\n`).join("")}`
        + `Set ${Object.values(bridgeEnvironmentVariableNames).join(", ")} in the MCP server entry for this bridge.\n`
    );
    process.exitCode = 1;
    return;
  }

  const { hubUrl, clientId, clientSecret } = configuration.configuration;
  const redact = createSecretRedactor(clientSecret);
  /** stdout carries the MCP stream, so every diagnostic goes to stderr, redacted without exception. */
  const logError = (message: string) => {
    process.stderr.write(`${redact(message)}\n`);
  };

  let workingRoot: string;
  try {
    // Captured once: no tool argument or environment override can widen local file authority.
    workingRoot = await canonicalWorkingRoot(process.cwd());
  } catch {
    logError("coffeeshop orchestrator bridge cannot establish its working root");
    process.exitCode = 1;
    return;
  }
  const localArtifacts = new LocalArtifactService(workingRoot, createArtifactHttpUploader(hubUrl));

  let bridge: BridgeServer | undefined;

  const hub = new HubConnection({
    hubUrl,
    clientId,
    clientSecret,
    logError,
    onDoorbell: (doorbell) => void bridge?.announceDoorbell(doorbell),
    onAttachmentReplaced: (replaced) => void bridge?.announceAttachmentReplaced(replaced),
    onRevoked: () => void bridge?.announceRevocation(),
    onScopesChanged: (scopes) => void bridge?.refreshToolListForScopes(scopes),
    onReattachFailed: (threadId, error) => logError(`could not re-attach thread ${threadId} after reconnecting: ${error.code} ${error.message}`)
  });

  bridge = new BridgeServer({ hub, orchestratorClientId: clientId, serverVersion: version, logError, localArtifacts });
  const server = bridge.server;

  const shutdown = () => {
    hub.stop();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  hub.start();

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    logError(`the MCP stdio transport could not start: ${describe(error)}`);
    hub.stop();
    process.exitCode = 1;
  }
}

await main();
