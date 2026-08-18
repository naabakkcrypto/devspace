import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadConfig,
  type ServerConfig,
  type ToolMode,
  type WidgetMode,
} from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import {
  classifyMcpRequestMode,
  createMcpServer,
  createServer,
  handleStatelessMcpRequest,
} from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.ok(Array.isArray(firstStructured.agents));
  const firstAgent = (firstStructured.agents as Array<Record<string, unknown>>)[0];
  assert.equal(firstAgent?.writeMode, "read_only");
  assert.match(String(firstAgent?.profileHash), /^[a-f0-9]{64}$/);
  const catalogOnlyAgent = (firstStructured.agents as Array<Record<string, unknown>>)
    .find((agent) => agent.name === "z-claude-catalog");
  assert.equal(catalogOnlyAgent?.providerAvailable, false);
  assert.match(String(catalogOnlyAgent?.providerUnavailableReason), /Codex-only|catalog-only/);
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  const contextReceipt = firstStructured.contextReceipt as Record<string, unknown>;
  assert.equal(contextReceipt.status, "ready");
  assert.match(String(contextReceipt.aggregateSha256), /^[a-f0-9]{64}$/);
  assert.equal(
    (contextReceipt.capabilities as Record<string, unknown>).nativeMcpRoutesExposed,
    false,
  );
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.ok(Array.isArray(card.agents));
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.ok(Array.isArray(structured.agentProviders));
    assert.ok(Array.isArray(structured.agents));
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
  } finally {
    await closeRestored();
  }
});

test("reopening a stale conversation refreshes its full context before tools resume", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-stale");
  const workspaceId = String(structuredContent(first).workspaceId);
  await writeFile(join(context.config.agentDir, "AGENTS.md"), "changed global instructions\n");

  const stale = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.equal(stale.isError, true);
  assert.match(responseText(stale), /Workspace context changed.*open_workspace again/);

  const refreshed = await callOpen(context.client, context.project, "chat-stale");
  assert.equal(structuredContent(refreshed).workspaceId, workspaceId);
  assert.ok(Array.isArray(structuredContent(refreshed).agentsFiles));
  assert.match(responseText(refreshed), /Refreshed workspace context/);
  await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
});

test("codex mode applies an adaptive tool-efficiency policy", async (t) => {
  const context = await fixture(t, { toolMode: "codex", widgets: "off", subagents: false });

  const instructions = context.client.getInstructions() ?? "";
  assert.match(instructions, /Use the fewest tool calls that preserve correctness, completeness, and verifiability/i);
  assert.match(
    instructions,
    /Keep one active user objective per turn/i,
  );
  assert.match(
    instructions,
    /Broad authorization removes repeated confirmation gates but does not authorize starting later backlog or TODO items/i,
  );
  assert.match(
    instructions,
    /After roughly 30 direct tool calls for the same objective, perform a soft efficiency checkpoint/i,
  );
  assert.match(
    instructions,
    /Repeated calls that produce no new evidence are diminishing returns/i,
  );
  assert.doesNotMatch(instructions, /Use as many read or exec_command calls as needed/i);
  assert.doesNotMatch(instructions, /subagent work/i);
  assert.match(instructions, /On Windows, exec_command runs through cmd\.exe/i);
  assert.match(
    instructions,
    /Never pass PowerShell-only syntax such as 2>\$null directly to cmd\.exe/i,
  );

  const tools = await context.client.listTools();
  const readTool = tools.tools.find((tool) => tool.name === "read");
  const execTool = tools.tools.find((tool) => tool.name === "exec_command");
  assert.match(readTool?.description ?? "", /Prefer the smallest set of reads that preserves complete relevant context/i);
  assert.match(readTool?.description ?? "", /Repeated reads without new evidence are diminishing returns/i);
  assert.match(
    readTool?.description ?? "",
    /Split the work whenever output size, ambiguity, truncation risk, or independent verification/i,
  );
  assert.match(
    execTool?.description ?? "",
    /Prefer grouped commands over equivalent micro-calls when this preserves complete relevant evidence and clear file provenance/i,
  );
  assert.match(
    execTool?.description ?? "",
    /Use multiple commands whenever output size, ambiguity, truncation risk, or independent verification/i,
  );
  assert.match(execTool?.description ?? "", /Repeated commands without new evidence are diminishing returns/i);
  assert.match(execTool?.description ?? "", /On Windows, this runs through cmd\.exe/i);
});

test("disabling subagents preserves the exact Codex inline tool catalog and schemas", async (t) => {
  const enabled = await fixture(t, { toolMode: "codex", widgets: "off", subagents: true });
  const disabled = await fixture(t, { toolMode: "codex", widgets: "off", subagents: false });
  const enabledTools = (await enabled.client.listTools()).tools;
  const disabledTools = (await disabled.client.listTools()).tools;

  assert.deepEqual(disabledTools, enabledTools);
  assert.ok(disabledTools.length > 0);
});

test("healthz reports the bounded Codex inline-full posture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-health-test-"));
  const agentDir = join(root, ".codex");
  const globalRules = "required global instructions\n";
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), globalRules);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_REQUIRE_GLOBAL_AGENTS: "1",
    DEVSPACE_SKILLS: "1",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    HOST: "127.0.0.1",
    PORT: "1",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.deepEqual(await response.json(), {
    ok: true,
    name: "devspace",
    version: packageMetadata.version,
    contextProfile: "codex-inline-full",
    toolMode: "codex",
    widgets: "off",
    skillsEnabled: true,
    subagentsEnabled: false,
    delegationEnabled: false,
    agentProvidersLoaded: 0,
    globalRulesReady: true,
    globalRulesRequired: true,
    globalRulesSha256: createHash("sha256").update(globalRules).digest("hex"),
    inFlightMcpRequests: 0,
  });

  await writeFile(join(agentDir, "AGENTS.md"), "");
  const failedResponse = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(failedResponse.status, 503);
  const failedHealth = await failedResponse.json() as Record<string, unknown>;
  assert.equal(failedHealth.ok, false);
  assert.equal(failedHealth.globalRulesReady, false);
});

test("sessionless tunnel tool calls use the stateless compatibility transport", () => {
  assert.equal(classifyMcpRequestMode(undefined, false), "stateless");
  assert.equal(classifyMcpRequestMode(undefined, true), "initialize");
  assert.equal(classifyMcpRequestMode("existing-session", false), "existing");
});

test("a sessionless tunnel tools/call succeeds without an initialize round trip", async (t) => {
  const app = createMcpExpressApp();
  app.post("/mcp", async (req, res) => {
    const server = new McpServer({ name: "sessionless-compat-test", version: "1.0.0" });
    server.registerTool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
    await handleStatelessMcpRequest(server, req, res);
  });
  const httpServer = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /pong/);
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close: () => Promise<void>;
}

interface FixtureOptions {
  git?: boolean;
  toolMode?: ToolMode;
  widgets?: WidgetMode;
  subagents?: boolean;
}

async function fixture(t: TestContext, options: FixtureOptions = {}): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));
  await writeFile(join(project, ".devspace", "agents", "z-claude-catalog.md"), [
    "---",
    "name: z-claude-catalog",
    "description: Catalog-only compatibility profile.",
    "provider: claude",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: options.subagents === false ? "0" : "1",
    DEVSPACE_WIDGETS: options.widgets ?? "full",
    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
