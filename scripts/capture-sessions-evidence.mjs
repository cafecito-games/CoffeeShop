import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const distribution = join(repositoryRoot, "apps", "web", "dist");
const outputDirectory = resolve(process.argv[2] ?? join(repositoryRoot, "docs", "screenshots"));
if (!existsSync(join(distribution, "index.html"))) throw new Error("build the PWA with `task frontend:build` first");
mkdirSync(outputDirectory, { recursive: true });

const playwrightCommand = process.env.PLAYWRIGHT ?? execFileSync("sh", ["-c", "command -v playwright"], { encoding: "utf8" }).trim();
const playwrightModule = join(dirname(realpathSync(playwrightCommand)), "index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const chromiumExecutable = process.env.CHROMIUM ?? execFileSync("sh", ["-c", "command -v chromium"], { encoding: "utf8" }).trim();

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const requested = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const relative = normalize(decodeURIComponent(requested)).replace(/^[/\\]+/, "");
  let path = join(distribution, relative || "index.html");
  if (!path.startsWith(distribution) || !existsSync(path) || requested.endsWith("/")) path = join(distribution, "index.html");
  response.setHeader("content-type", contentTypes[extname(path)] ?? "application/octet-stream");
  response.end(readFileSync(path));
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("evidence server did not bind");

const at = "2026-10-06T12:00:00.000Z";
const node = {
  id: "node-synthetic", name: "Studio Barista", kind: "local", platform: "linux", status: "online",
  lastSeen: at, activeRuns: 0, concurrency: 2, workspaceRoots: ["/synthetic"], harnesses: [], version: "evidence"
};
const session = (overrides = {}) => ({
  hostHarnessSessionId: "host-session-synthetic", nodeId: node.id, harnessId: "codex-cli",
  providerSessionId: "provider-synthetic", workspace: "/synthetic/coffee-shop", source: "provider-history",
  status: "idle", controlMode: "resume", operations: ["attach", "read-history"], revision: 4,
  attachmentEpoch: 0, summary: "Synthetic roast planner", createdAt: "2026-10-06T10:00:00.000Z", updatedAt: at,
  ...overrides
});
const baseSnapshot = (sessions) => ({
  instances: [], allocations: [], templates: [], agents: [], nodes: [node], runs: [], events: [], messages: [],
  threads: [], hostHarnessSessions: sessions, generatedAt: at
});
const active = session({
  status: "running", controlMode: "full", operations: ["attach", "close", "detach", "interrupt", "read-history", "resolve-approval", "start-turn", "steer"],
  attachmentEpoch: 2, attachedThreadId: "thread-synthetic", activeRunId: "run-synthetic", providerTurnId: "turn-synthetic", summary: "Synthetic release review"
});
const activeSnapshot = baseSnapshot([active]);
activeSnapshot.threads = [{
  id: "thread-synthetic", title: "Synthetic release review", objective: "Review synthetic evidence", summary: "Review in progress",
  status: "active", createdBy: "user", createdAt: "2026-10-06T10:00:00.000Z", updatedAt: at
}];
activeSnapshot.runs = [{
  id: "run-synthetic", threadId: "thread-synthetic", nodeId: node.id, harnessId: "codex-cli", model: "synthetic-model",
  workspace: "/synthetic/coffee-shop", prompt: "Synthetic non-secret request", status: "running", output: "", depth: 0,
  createdAt: "2026-10-06T11:55:00.000Z", startedAt: "2026-10-06T11:56:00.000Z",
  hostHarnessSessionId: active.hostHarnessSessionId, providerTurnId: active.providerTurnId
}];

const cases = [
  { name: "empty", snapshot: baseSnapshot([]) },
  { name: "inventory", snapshot: baseSnapshot([
    session(),
    session({ hostHarnessSessionId: "host-session-observe", providerSessionId: "provider-observe", harnessId: "shell", status: "offline", controlMode: "observe", operations: ["read-history"], summary: "Synthetic archived analysis" })
  ]) },
  { name: "active-detail", snapshot: activeSnapshot, selected: active, history: { items: [{ id: "history-active", kind: "assistant", text: "Synthetic bounded provider history", providerTurnId: "turn-synthetic", truncated: false }], truncated: false, omitted: false } },
  { name: "observe-only", snapshot: baseSnapshot([session({ status: "active-elsewhere", controlMode: "observe", operations: ["read-history"], summary: "Synthetic external writer" })]), selected: session({ status: "active-elsewhere", controlMode: "observe", operations: ["read-history"], summary: "Synthetic external writer" }), history: { items: [], truncated: false, omitted: false } },
  { name: "stale", snapshot: baseSnapshot([session()]), stale: true },
  { name: "truncated-history", snapshot: baseSnapshot([session({ summary: "Synthetic bounded archive" })]), selected: session({ summary: "Synthetic bounded archive" }), history: { items: [{ id: "history-truncated", kind: "assistant", text: "Synthetic history excerpt", truncated: true }], nextCursor: "synthetic-cursor", truncated: true, omitted: false } }
];

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
try {
  for (const fixture of cases) {
    for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
      await page.addInitScript(({ snapshot, stale }) => {
        globalThis.__SESSION_EVIDENCE__ = { snapshot, stale };
        class EvidenceWebSocket {
          static OPEN = 1;
          readyState = 0;
          onopen;
          onmessage;
          onerror;
          onclose;
          constructor() {
            setTimeout(() => {
              this.readyState = 1;
              this.onopen?.({});
              this.onmessage?.({ data: JSON.stringify({ type: "snapshot", data: globalThis.__SESSION_EVIDENCE__.snapshot }) });
              if (globalThis.__SESSION_EVIDENCE__.stale) setTimeout(() => this.onclose?.({}), 75);
            }, 10);
          }
          close() { this.readyState = 3; }
          send() {}
        }
        Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: EvidenceWebSocket });
      }, { snapshot: fixture.snapshot, stale: fixture.stale === true });
      await page.route("**/api/snapshot", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture.snapshot) }));
      if (fixture.selected) {
        const detail = { session: fixture.selected, links: {
          ...(fixture.selected.attachedThreadId ? { threadId: fixture.selected.attachedThreadId } : {}),
          ...(fixture.selected.activeRunId ? { runId: fixture.selected.activeRunId } : {})
        } };
        const history = {
          hostHarnessSessionId: fixture.selected.hostHarnessSessionId, nodeId: fixture.selected.nodeId,
          harnessId: fixture.selected.harnessId, providerSessionId: fixture.selected.providerSessionId,
          workspace: fixture.selected.workspace, revision: fixture.selected.revision, stale: false, observedAt: at, ...fixture.history
        };
        await page.route(`**/api/host-sessions/${fixture.selected.hostHarnessSessionId}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) }));
        await page.route(`**/api/host-sessions/${fixture.selected.hostHarnessSessionId}/history`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(history) }));
      }
      const selectedQuery = fixture.selected ? `&session=${fixture.selected.hostHarnessSessionId}` : "";
      await page.goto(`http://127.0.0.1:${address.port}/?view=sessions${selectedQuery}`, { waitUntil: "networkidle" });
      if (fixture.stale) await page.getByText("Last known inventory", { exact: true }).waitFor();
      else if (fixture.selected) await page.getByText("Imported evidence", { exact: true }).waitFor();
      else await page.getByRole("heading", { name: fixture.name === "empty" ? "No matching sessions" : "Sessions", exact: true }).waitFor();
      if (fixture.selected && viewport.name === "mobile") {
        await page.locator(".sessions-view").evaluate((element) => { element.scrollTop = 0; });
      }
      if (fixture.name === "truncated-history" && viewport.name === "mobile") {
        await page.getByText("Showing a bounded history extent; additional provider history is not displayed.", { exact: true }).scrollIntoViewIfNeeded();
        await page.locator(".sessions-view").evaluate((element) => { element.scrollLeft = 0; });
      }
      await page.screenshot({ path: join(outputDirectory, `sessions-${fixture.name}-${viewport.name}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(`wrote ${cases.length * 2} sanitized Sessions screenshots to ${outputDirectory}`);
