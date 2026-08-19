import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bridgedToolName,
  bridgeToolInputSchema,
  catalogAggregateSha256,
  generateMcpBridgeCatalog,
  loadMcpBridgeRuntimeProfile,
  loadMcpBridgeCatalog,
  McpBridgeManager,
  McpBridgeRuntimeProfile,
  resolveActiveMcpProfile,
  scopeMcpArguments,
  scopeLifecycleServerConfig,
  writeMcpBridgeCatalog,
} from "./mcp-bridge.js";

const rawConfig = "profile=max\nservers=openmemory,serena,graphify,docs\n";
const configSha256 = createHash("sha256").update(rawConfig).digest("hex").toUpperCase();

test("active profile resolution exposes exact enabled MCP set and excludes disabled and host-managed entries", () => {
  const profile = resolveActiveMcpProfile({
    profileState: {
      observed_active_profile: "max",
      activation_status: "active_loaded_verified",
      active_config_sha256: configSha256,
      raw_config: rawConfig,
    },
    profileDefinition: {
      name: "max",
      enabled_servers: ["openmemory", "serena", "graphify", "docs"],
      configured_disabled_servers: ["netlify"],
      host_managed_servers: ["node_repl"],
      preserve_unmanaged_servers: true,
    },
    codexConfig: {
      mcp_servers: {
        openmemory: { enabled: true, command: "python", args: ["memory.py"], env: { TOKEN: "secret" } },
        serena: { enabled: true, command: "python", args: ["serena.py"] },
        graphify: { enabled: true, command: "python", args: ["graph.py"] },
        docs: { enabled: true, url: "https://docs.example.test/mcp" },
        netlify: { enabled: false, url: "https://netlify.example.test/mcp" },
        node_repl: { enabled: true, command: "node", args: ["repl.js"] },
        custom: { enabled: true, command: "custom" },
      },
    },
  });

  assert.equal(profile.name, "max");
  assert.deepEqual(profile.servers.map((server) => server.name), [
    "openmemory",
    "serena",
    "graphify",
    "docs",
    "custom",
  ]);
  assert.deepEqual(profile.servers.map((server) => server.transport), [
    "stdio",
    "stdio",
    "stdio",
    "streamable-http",
    "stdio",
  ]);
  assert.equal(profile.configSha256, configSha256.toLowerCase());
  assert.equal(profile.stateConfigDrift, false);
  assert.doesNotMatch(JSON.stringify(profile), /secret|memory\.py|serena\.py|graph\.py|docs\.example/);
});

test("active profile resolution reports historical config drift and fails closed on profile drift", () => {
  const base = {
    profileState: {
      observed_active_profile: "max",
      activation_status: "active_loaded_verified",
      active_config_sha256: "0".repeat(64),
      raw_config: rawConfig,
    },
    profileDefinition: { name: "max", enabled_servers: ["serena"] },
    codexConfig: { mcp_servers: { serena: { enabled: true, command: "python" } } },
  };
  assert.equal(resolveActiveMcpProfile(base).stateConfigDrift, true);
  assert.throws(
    () => resolveActiveMcpProfile({
      ...base,
      profileState: { ...base.profileState, observed_active_profile: "full", active_config_sha256: configSha256 },
    }),
    /profile/i,
  );
});

test("runtime profile loads TOML privately and serializes no command, URL, argument, or environment value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-mcp-profile-"));
  try {
    const profiles = join(directory, "profiles");
    await mkdir(profiles);
    const configPath = join(directory, "config.toml");
    const statePath = join(directory, "current-profile.json");
    const config = [
      "[mcp_servers.memory]",
      "enabled = true",
      'command = "python"',
      'args = ["memory.py"]',
      "startup_timeout_sec = 7",
      "[mcp_servers.memory.env]",
      'TOKEN = "top-secret"',
      "[mcp_servers.docs]",
      "enabled = true",
      'url = "https://docs.example.test/mcp"',
      "",
    ].join("\n");
    const hash = createHash("sha256").update(config).digest("hex").toUpperCase();
    await writeFile(configPath, config);
    await writeFile(statePath, JSON.stringify({
      observed_active_profile: "max",
      activation_status: "active_loaded_verified",
      active_config_sha256: hash,
    }));
    await writeFile(join(profiles, "max.json"), JSON.stringify({
      name: "max",
      enabled_servers: ["memory", "docs"],
      configured_disabled_servers: [],
      host_managed_servers: [],
    }));

    const runtime = loadMcpBridgeRuntimeProfile({
      codexConfigPath: configPath,
      profileStatePath: statePath,
      profileRegistryRoot: profiles,
    });
    assert.deepEqual(runtime.publicProfile.servers.map((server) => server.name), ["memory", "docs"]);
    assert.equal(runtime.serverConfig("memory").transport, "stdio");
    assert.equal(runtime.serverConfig("docs").transport, "streamable-http");
    assert.doesNotMatch(JSON.stringify(runtime), /top-secret|memory\.py|docs\.example|python/);
    assert.throws(() => runtime.serverConfig("missing"), /not active/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridged tool names are stable and collision-proof", () => {
  assert.equal(bridgedToolName("openmemory", "openmemory_query"), "mcp__openmemory__openmemory_query");
  assert.throws(() => bridgedToolName("bad server", "query"), /invalid/i);
  assert.throws(() => bridgedToolName("serena", "bad/tool"), /invalid/i);
});

test("workspace scoping overrides project routes and injects exact OpenMemory tenant", () => {
  const scope = {
    workspaceRoot: "C:\\A - PROJETS\\Example",
    projectId: "proj_0123456789abcdef",
    instanceId: "inst_0123456789abcdef0123456789abcdef",
  };
  assert.deepEqual(
    scopeMcpArguments("serena", "activate_project", { project: "C:\\Outside" }, scope),
    { project: scope.workspaceRoot },
  );
  assert.deepEqual(
    scopeMcpArguments("graphify", "graph_stats", { project_path: "C:\\Outside" }, scope),
    { project_path: scope.workspaceRoot },
  );
  assert.deepEqual(
    scopeMcpArguments("openmemory", "openmemory_query", { query: "status", max_items: 3 }, scope),
    {
      query: "status",
      max_items: 3,
      project_id: scope.projectId,
      instance_id: scope.instanceId,
    },
  );
  assert.throws(
    () => scopeMcpArguments("openmemory", "openmemory_query", { project_id: "proj_bad" }, scope),
    /tenant/i,
  );
});

test("workspace scoping rejects absolute paths outside the workspace and relative traversal", () => {
  const scope = { workspaceRoot: "C:\\A - PROJETS\\Example" };
  assert.throws(
    () => scopeMcpArguments("semgrep", "semgrep_scan", { path: "C:\\Windows\\System32" }, scope),
    /outside workspace/i,
  );
  assert.throws(
    () => scopeMcpArguments("ast-grep", "find_code", { path: "..\\Other" }, scope),
    /traversal/i,
  );
});

test("lifecycle launchers unwrap the approved MCP child without reusing Codex supervisor state", () => {
  const original = {
    transport: "stdio" as const,
    command: "launcher.exe",
    args: [
      "--recovery-entrypoint", "recover.ps1",
      "--transaction-root", "tx-root",
      "--transaction-id", "tx-old",
      "--",
      "python.exe", "mcp-process-supervisor.py",
      "--server-id", "context7",
      "--policy", "policy.json",
      "--", "node.exe", "server.js",
    ],
    env: {},
    startupTimeoutMs: 20_000,
  };
  const scoped = scopeLifecycleServerConfig("context7", "workspace-1", original);
  assert.equal(scoped.transport, "stdio");
  if (scoped.transport !== "stdio") throw new Error("unexpected transport");
  assert.doesNotMatch(scoped.args.join(" "), /recovery-entrypoint|transaction-root|tx-old/);
  assert.equal(scoped.command, "node.exe");
  assert.deepEqual(scoped.args, ["server.js"]);
  assert.equal(original.args[1], "recover.ps1");
});

test("Graphify uses its pinned Python entrypoint instead of the PowerShell compatibility wrapper", () => {
  const scoped = scopeLifecycleServerConfig("graphify", "C:\\A - PROJETS\\Example", {
    transport: "stdio",
    command: "launcher.exe",
    args: ["python.exe", "mcp-process-supervisor.py", "--server-id", "graphify", "--", "pwsh.exe", "-File", "start-graphify-mcp.ps1"],
    env: {
      GRAPHIFY_REPO: "C:\\Graphify",
      GRAPHIFY_DEFAULT_GRAPH: "C:\\Graphs\\default.json",
    },
    startupTimeoutMs: 60_000,
  });
  assert.equal(scoped.transport, "stdio");
  if (scoped.transport !== "stdio") throw new Error("unexpected transport");
  assert.equal(scoped.command, "C:\\Graphify\\.venv\\Scripts\\python.exe");
  assert.deepEqual(scoped.args, ["-m", "graphify.serve", "C:\\Graphs\\default.json"]);
  assert.equal(scoped.env.PYTHONPATH, "C:\\Graphify");
});

test("catalog discovery preserves schemas while excluding runtime commands and secrets", async () => {
  const runtime = new McpBridgeRuntimeProfile(
    {
      name: "max",
      configSha256: "a".repeat(64),
      stateConfigDrift: false,
      servers: [
        { name: "serena", transport: "stdio" },
        { name: "docs", transport: "streamable-http" },
      ],
    },
    new Map([
      ["serena", { transport: "stdio", command: "secret-command", args: ["private"], env: { TOKEN: "secret" }, startupTimeoutMs: 1_000 }],
      ["docs", { transport: "streamable-http", url: "https://private.example/mcp", headers: { Authorization: "secret" }, startupTimeoutMs: 1_000 }],
    ]),
  );
  const closed: string[] = [];
  const catalog = await generateMcpBridgeCatalog(runtime, async (serverName) => ({
    async listTools() {
      return {
        tools: [{
          name: `${serverName}_query`,
          description: `Query ${serverName}`,
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          annotations: { readOnlyHint: true },
        }],
      };
    },
    async callTool() { return {}; },
    async close() { closed.push(serverName); },
  }));
  assert.deepEqual(closed.sort(), ["docs", "serena"]);
  assert.equal(catalog.servers[0]?.tools[0]?.inputSchema.type, "object");
  assert.match(catalog.aggregateSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(catalog), /secret-command|private\.example|Authorization|secret/);
});

test("tool schema projection adds workspaceId and preserves required, enum, arrays, and closed objects", () => {
  const schema = bridgeToolInputSchema({
    type: "object",
    properties: {
      query: { type: "string", minLength: 2 },
      mode: { enum: ["fast", "deep"] },
      paths: { type: "array", items: { type: "string" } },
    },
    required: ["query", "mode"],
    additionalProperties: false,
  });
  assert.deepEqual(schema.parse({ workspaceId: "w1", query: "ok", mode: "fast", paths: ["src"] }), {
    workspaceId: "w1",
    query: "ok",
    mode: "fast",
    paths: ["src"],
  });
  assert.throws(() => schema.parse({ query: "ok", mode: "fast" }), /workspaceId/i);
  assert.throws(() => schema.parse({ workspaceId: "w1", query: "x", mode: "other" }));
  assert.throws(() => schema.parse({ workspaceId: "w1", query: "ok", mode: "fast", extra: true }));
  assert.throws(() => bridgeToolInputSchema({ type: "string" }), /object/i);
});

test("tool schema projection fails closed on ReDoS-prone upstream patterns", () => {
  assert.throws(
    () =>
      bridgeToolInputSchema({
        type: "object",
        properties: {
          value: { type: "string", pattern: "^(a+)+$" },
        },
        required: ["value"],
      }),
    /unsafe MCP bridge JSON schema pattern/i,
  );

  const safe = bridgeToolInputSchema({
    type: "object",
    properties: {
      value: { type: "string", pattern: "^[a-z0-9-]+$" },
    },
    required: ["value"],
  });
  assert.deepEqual(safe.parse({ workspaceId: "w1", value: "safe-slug-1" }), {
    workspaceId: "w1",
    value: "safe-slug-1",
  });
  assert.throws(() => safe.parse({ workspaceId: "w1", value: "INVALID!" }));
});

test("catalog persistence is atomic, validated, and round-trips only its public receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-mcp-catalog-"));
  try {
    const path = join(directory, "catalog.json");
    const servers = [{
      name: "docs",
      transport: "streamable-http" as const,
      tools: [{ name: "search", inputSchema: { type: "object" } }],
    }];
    const catalog = {
      schemaVersion: 1 as const,
      profile: "max",
      configSha256: "a".repeat(64),
      stateConfigDrift: false,
      servers,
      aggregateSha256: catalogAggregateSha256("max", "a".repeat(64), false, servers),
    };
    await writeMcpBridgeCatalog(path, catalog);
    assert.deepEqual(loadMcpBridgeCatalog(path), catalog);
    await writeFile(path, JSON.stringify({ ...catalog, aggregateSha256: "0".repeat(64) }));
    assert.throws(() => loadMcpBridgeCatalog(path), /aggregate/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manager opens routes lazily per workspace, activates Serena scope, and closes every connection", async () => {
  const runtime = new McpBridgeRuntimeProfile(
    {
      name: "max",
      configSha256: "a".repeat(64),
      stateConfigDrift: false,
      servers: [{ name: "serena", transport: "stdio" }],
    },
    new Map([
      ["serena", { transport: "stdio", command: "python", args: [], env: {}, startupTimeoutMs: 1_000 }],
    ]),
  );
  const calls: Array<{ workspace: number; name: string; args: Record<string, unknown> }> = [];
  let connections = 0;
  let closes = 0;
  const factory = async () => {
    const workspace = ++connections;
    return {
      async listTools() { return { tools: [] }; },
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ workspace, name, args });
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() { closes += 1; },
    };
  };
  const catalog = {
    schemaVersion: 1 as const,
    profile: "max",
    configSha256: "a".repeat(64),
    stateConfigDrift: false,
    aggregateSha256: "",
    servers: [{
      name: "serena",
      transport: "stdio" as const,
      tools: [{ name: "find_symbol", inputSchema: { type: "object" } }],
    }],
  };
  catalog.aggregateSha256 = catalogAggregateSha256(
    catalog.profile,
    catalog.configSha256,
    catalog.stateConfigDrift,
    catalog.servers,
  );
  const manager = new McpBridgeManager(runtime, catalog, factory);
  const base = {
    serverName: "serena",
    toolName: "find_symbol",
    argumentsValue: { name_path_pattern: "main" },
    scope: { workspaceRoot: "C:\\A - PROJETS\\Example" },
  };
  await manager.call({ ...base, workspaceId: "workspace-1" });
  await manager.call({ ...base, workspaceId: "workspace-1" });
  await manager.call({ ...base, workspaceId: "workspace-2" });
  assert.equal(connections, 2);
  assert.deepEqual(calls.map(({ workspace, name }) => `${workspace}:${name}`), [
    "1:activate_project",
    "1:find_symbol",
    "1:find_symbol",
    "2:activate_project",
    "2:find_symbol",
  ]);
  assert.equal(calls[0]?.args.project, "C:\\A - PROJETS\\Example");
  await manager.close();
  assert.equal(closes, 2);
});

test("manager evicts idle upstream connections and reconnects without reducing the MCP surface", async () => {
  let now = 0;
  const runtime = new McpBridgeRuntimeProfile(
    {
      name: "max",
      configSha256: "a".repeat(64),
      stateConfigDrift: false,
      servers: [{ name: "serena", transport: "stdio" }],
    },
    new Map([
      ["serena", { transport: "stdio", command: "python", args: [], env: {}, startupTimeoutMs: 1_000 }],
    ]),
  );
  let connections = 0;
  let closes = 0;
  const calls: string[] = [];
  const catalog = {
    schemaVersion: 1 as const,
    profile: "max",
    configSha256: "a".repeat(64),
    stateConfigDrift: false,
    aggregateSha256: "",
    servers: [{
      name: "serena",
      transport: "stdio" as const,
      tools: [{ name: "find_symbol", inputSchema: { type: "object" } }],
    }],
  };
  catalog.aggregateSha256 = catalogAggregateSha256(
    catalog.profile,
    catalog.configSha256,
    catalog.stateConfigDrift,
    catalog.servers,
  );
  const manager = new McpBridgeManager(runtime, catalog, async () => {
    const identity = ++connections;
    return {
      async listTools() { return { tools: [] }; },
      async callTool(name: string) {
        calls.push(`${identity}:${name}`);
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() { closes += 1; },
    };
  }, { now: () => now });

  const input = {
    workspaceId: "workspace-1",
    serverName: "serena",
    toolName: "find_symbol",
    argumentsValue: { name_path_pattern: "main" },
    scope: { workspaceRoot: "C:\\A - PROJETS\\Example" },
  };
  await manager.call(input);
  assert.equal(manager.connectionCount, 1);

  now = 299_999;
  assert.equal(await manager.closeIdle(300_000), 0);
  assert.equal(closes, 0);

  now = 300_000;
  assert.equal(await manager.closeIdle(300_000), 1);
  assert.equal(closes, 1);
  assert.equal(manager.connectionCount, 0);

  await manager.call(input);
  assert.equal(connections, 2);
  assert.equal(manager.connectionCount, 1);
  assert.deepEqual(calls, [
    "1:activate_project",
    "1:find_symbol",
    "2:activate_project",
    "2:find_symbol",
  ]);
  assert.equal(catalog.servers[0]?.tools.length, 1);
  await manager.close();
});

test("manager rejects stale catalogs and tools outside the discovered surface", async () => {
  const runtime = new McpBridgeRuntimeProfile({
    name: "max",
    configSha256: "a".repeat(64),
    stateConfigDrift: false,
    servers: [{ name: "docs", transport: "streamable-http" }],
  }, new Map([
    ["docs", { transport: "streamable-http", url: "https://docs.example/mcp", headers: {}, startupTimeoutMs: 1_000 }],
  ]));
  const stale = {
    schemaVersion: 1 as const,
    profile: "max",
    configSha256: "c".repeat(64),
    stateConfigDrift: false,
    aggregateSha256: "b".repeat(64),
    servers: [{ name: "docs", transport: "streamable-http" as const, tools: [] }],
  };
  assert.throws(() => new McpBridgeManager(runtime, stale, async () => { throw new Error("unused"); }), /stale/i);
});
