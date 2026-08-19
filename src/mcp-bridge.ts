import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, win32 as path } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import safeRegex from "safe-regex2";
import { parse as parseToml } from "smol-toml";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);

export interface ActiveMcpProfileInput {
  profileState: Record<string, unknown>;
  profileDefinition: Record<string, unknown>;
  codexConfig: Record<string, unknown>;
}

export interface ActiveMcpServer {
  name: string;
  transport: "stdio" | "streamable-http";
}

export interface ActiveMcpProfile {
  name: string;
  servers: ActiveMcpServer[];
  configSha256: string;
  stateConfigDrift: boolean;
}

export interface WorkspaceMcpScope {
  workspaceRoot: string;
  projectId?: string;
  instanceId?: string;
}

export interface McpBridgeProfilePaths {
  codexConfigPath: string;
  profileStatePath: string;
  profileRegistryRoot: string;
}

export type McpBridgeRuntimeServerConfig =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      startupTimeoutMs: number;
    }
  | {
      transport: "streamable-http";
      url: string;
      headers: Record<string, string>;
      startupTimeoutMs: number;
    };

export function scopeLifecycleServerConfig(
  serverName: string,
  scopeKey: string,
  config: McpBridgeRuntimeServerConfig,
): McpBridgeRuntimeServerConfig {
  if (config.transport !== "stdio") return config;
  if (serverName === "graphify") {
    const repo = config.env.GRAPHIFY_REPO;
    const defaultGraph = config.env.GRAPHIFY_DEFAULT_GRAPH;
    if (!repo || !defaultGraph) {
      throw new Error("MCP bridge Graphify pinned runtime configuration is incomplete");
    }
    const workspaceGraph = path.isAbsolute(scopeKey)
      ? path.join(scopeKey, "graphify-out", "graph.json")
      : undefined;
    const graph = workspaceGraph && existsSync(workspaceGraph) ? workspaceGraph : defaultGraph;
    return {
      ...config,
      command: path.join(repo, ".venv", "Scripts", "python.exe"),
      args: ["-m", "graphify.serve", graph],
      env: {
        ...config.env,
        PYTHONPATH: repo,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    };
  }
  let args = [...config.args];
  const recoveryIndex = args.indexOf("--recovery-entrypoint");
  if (recoveryIndex >= 0) {
    const commandSeparator = args.indexOf("--", recoveryIndex);
    if (commandSeparator < 0 || commandSeparator === args.length - 1) {
      throw new Error(`MCP bridge lifecycle recovery wrapper for ${serverName} is invalid`);
    }
    args = args.slice(commandSeparator + 1);
  }
  const supervisorIndex = args.findIndex((entry) => /(?:^|[\\/])mcp-process-supervisor\.py$/i.test(entry));
  if (supervisorIndex >= 0) {
    const childSeparator = args.indexOf("--", supervisorIndex);
    if (childSeparator < 0 || childSeparator === args.length - 1) {
      throw new Error(`MCP bridge supervised command for ${serverName} is invalid`);
    }
    return {
      ...config,
      command: args[childSeparator + 1]!,
      args: args.slice(childSeparator + 2),
    };
  }
  const serverIdIndex = args.indexOf("--server-id");
  if (serverIdIndex >= 0) {
    if (serverIdIndex === args.length - 1) {
      throw new Error(`MCP bridge lifecycle server identity for ${serverName} is invalid`);
    }
    const suffix = createHash("sha256")
      .update(`${serverName}\u0000${scopeKey}`)
      .digest("hex")
      .slice(0, 12);
    args[serverIdIndex + 1] = `${serverName}-stonks-${suffix}`;
  }
  return { ...config, args };
}

export class McpBridgeRuntimeProfile {
  readonly #serverConfigs: ReadonlyMap<string, McpBridgeRuntimeServerConfig>;

  constructor(
    readonly publicProfile: ActiveMcpProfile,
    serverConfigs: ReadonlyMap<string, McpBridgeRuntimeServerConfig> = new Map(),
  ) {
    this.#serverConfigs = serverConfigs;
  }

  serverConfig(name: string): McpBridgeRuntimeServerConfig {
    const config = this.#serverConfigs.get(name);
    if (!config) throw new Error(`MCP bridge server ${name} is not active`);
    return config;
  }

  toJSON(): ActiveMcpProfile {
    return this.publicProfile;
  }
}

export function loadMcpBridgeRuntimeProfile(paths: McpBridgeProfilePaths): McpBridgeRuntimeProfile {
  const rawConfig = readFileSync(paths.codexConfigPath, "utf8");
  const profileState = JSON.parse(readFileSync(paths.profileStatePath, "utf8")) as Record<string, unknown>;
  const activeProfileName = profileState.observed_active_profile;
  if (typeof activeProfileName !== "string" || !/^[A-Za-z0-9_-]+$/.test(activeProfileName)) {
    throw new Error("MCP bridge active profile name is invalid");
  }
  const profileDefinition = JSON.parse(
    readFileSync(join(paths.profileRegistryRoot, `${activeProfileName}.json`), "utf8"),
  ) as Record<string, unknown>;
  const codexConfig = parseToml(rawConfig) as Record<string, unknown>;
  const publicProfile = resolveActiveMcpProfile({
    profileState: { ...profileState, raw_config: rawConfig },
    profileDefinition,
    codexConfig,
  });
  const configuredServers = record(codexConfig.mcp_servers, "Codex server configuration");
  const serverConfigs = new Map<string, McpBridgeRuntimeServerConfig>();
  for (const server of publicProfile.servers) {
    const config = record(configuredServers[server.name], `server ${server.name}`);
    const startupTimeout = config.startup_timeout_sec === undefined ? 60 : Number(config.startup_timeout_sec);
    if (!Number.isFinite(startupTimeout) || startupTimeout <= 0 || startupTimeout > 300) {
      throw new Error(`MCP bridge server ${server.name} has an invalid startup timeout`);
    }
    if (server.transport === "stdio") {
      const command = config.command;
      if (typeof command !== "string" || !command) {
        throw new Error(`MCP bridge stdio server ${server.name} has no command`);
      }
      const args = config.args === undefined ? [] : stringArray(config.args, `${server.name} arguments`);
      const envRecord = config.env === undefined ? {} : record(config.env, `${server.name} environment`);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(envRecord)) {
        if (typeof value !== "string") throw new Error(`MCP bridge environment ${key} is not a string`);
        env[key] = value;
      }
      serverConfigs.set(server.name, {
        transport: "stdio",
        command,
        args,
        env,
        startupTimeoutMs: Math.round(startupTimeout * 1_000),
      });
      continue;
    }
    const url = config.url;
    if (typeof url !== "string") throw new Error(`MCP bridge HTTP server ${server.name} has no URL`);
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname)) {
      throw new Error(`MCP bridge HTTP server ${server.name} must use HTTPS or loopback`);
    }
    const headersRecord = config.http_headers === undefined
      ? {}
      : record(config.http_headers, `${server.name} HTTP headers`);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(headersRecord)) {
      if (typeof value !== "string") throw new Error(`MCP bridge HTTP header ${key} is not a string`);
      headers[key] = value;
    }
    serverConfigs.set(server.name, {
      transport: "streamable-http",
      url: parsedUrl.toString(),
      headers,
      startupTimeoutMs: Math.round(startupTimeout * 1_000),
    });
  }
  return new McpBridgeRuntimeProfile(publicProfile, serverConfigs);
}

export interface McpBridgeToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpBridgeCatalogServer {
  name: string;
  transport: "stdio" | "streamable-http";
  tools: McpBridgeToolDescriptor[];
}

export interface McpBridgeCatalog {
  schemaVersion: 1;
  profile: string;
  configSha256: string;
  stateConfigDrift: boolean;
  servers: McpBridgeCatalogServer[];
  aggregateSha256: string;
}

function schemaReference(root: Record<string, unknown>, reference: string): Record<string, unknown> {
  if (!reference.startsWith("#/")) throw new Error(`MCP bridge external schema reference is unsupported: ${reference}`);
  let value: unknown = root;
  for (const rawPart of reference.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    value = record(value, `schema reference ${reference}`)[part];
  }
  return record(value, `schema reference ${reference}`);
}

function jsonSchemaToZod(
  schemaValue: unknown,
  root: Record<string, unknown>,
  depth = 0,
): z.ZodTypeAny {
  if (depth > 32) throw new Error("MCP bridge JSON schema nesting exceeds 32 levels");
  if (schemaValue === true) return z.unknown();
  if (schemaValue === false) return z.never();
  const schema = record(schemaValue, "JSON schema");
  if (typeof schema.$ref === "string") {
    return jsonSchemaToZod(schemaReference(root, schema.$ref), root, depth + 1);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((value) => z.literal(value as string | number | boolean | null));
    return literals.length === 1 ? literals[0]! : z.union(literals as [z.ZodLiteral, z.ZodLiteral, ...z.ZodLiteral[]]);
  }
  if (Object.hasOwn(schema, "const")) {
    return z.literal(schema.const as string | number | boolean | null);
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      const variants = schema[key].map((entry) => jsonSchemaToZod(entry, root, depth + 1));
      return variants.length === 1 ? variants[0]! : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const variants = schema.allOf.map((entry) => jsonSchemaToZod(entry, root, depth + 1));
    return variants.slice(1).reduce((current, next) => z.intersection(current, next), variants[0]!);
  }
  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((type) => jsonSchemaToZod({ ...schema, type }, root, depth + 1));
    return variants.length === 1 ? variants[0]! : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  let output: z.ZodTypeAny;
  switch (schema.type) {
    case "object":
    case undefined: {
      if (schema.type === undefined && schema.properties === undefined) {
        output = z.unknown();
        break;
      }
      const properties = schema.properties === undefined ? {} : record(schema.properties, "object properties");
      const required = new Set(schema.required === undefined ? [] : stringArray(schema.required, "required fields"));
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [name, property] of Object.entries(properties)) {
        const projected = jsonSchemaToZod(property, root, depth + 1);
        shape[name] = required.has(name) ? projected : projected.optional();
      }
      let object = z.object(shape);
      if (schema.additionalProperties === false) object = object.strict();
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        object = object.catchall(jsonSchemaToZod(schema.additionalProperties, root, depth + 1));
      } else {
        object = object.catchall(z.unknown());
      }
      output = object;
      break;
    }
    case "array": {
      let array = z.array(schema.items === undefined ? z.unknown() : jsonSchemaToZod(schema.items, root, depth + 1));
      if (typeof schema.minItems === "number") array = array.min(schema.minItems);
      if (typeof schema.maxItems === "number") array = array.max(schema.maxItems);
      output = array;
      break;
    }
    case "string": {
      let string = z.string();
      if (typeof schema.minLength === "number") string = string.min(schema.minLength);
      if (typeof schema.maxLength === "number") string = string.max(schema.maxLength);
      if (typeof schema.pattern === "string") {
        if (!safeRegex(schema.pattern)) {
          throw new Error("Unsafe MCP bridge JSON schema pattern");
        }
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        string = string.regex(new RegExp(schema.pattern));
      }
      output = string;
      break;
    }
    case "integer": {
      let number = z.number().int();
      if (typeof schema.minimum === "number") number = number.min(schema.minimum);
      if (typeof schema.maximum === "number") number = number.max(schema.maximum);
      output = number;
      break;
    }
    case "number": {
      let number = z.number();
      if (typeof schema.minimum === "number") number = number.min(schema.minimum);
      if (typeof schema.maximum === "number") number = number.max(schema.maximum);
      output = number;
      break;
    }
    case "boolean": output = z.boolean(); break;
    case "null": output = z.null(); break;
    default: throw new Error(`MCP bridge JSON schema type is unsupported: ${String(schema.type)}`);
  }
  if (schema.nullable === true) output = output.nullable();
  if (typeof schema.description === "string") output = output.describe(schema.description);
  return output;
}

export function bridgeToolInputSchema(schema: Record<string, unknown>): z.ZodType {
  if (schema.type !== "object" && schema.properties === undefined) {
    throw new Error("MCP bridge tool input schema must be an object");
  }
  const properties = schema.properties === undefined ? {} : record(schema.properties, "tool input properties");
  if (Object.hasOwn(properties, "workspaceId")) {
    throw new Error("MCP bridge upstream schema already defines workspaceId");
  }
  const required = schema.required === undefined ? [] : stringArray(schema.required, "tool required fields");
  const projected = {
    ...schema,
    type: "object",
    properties: {
      workspaceId: { type: "string", minLength: 1, description: "Open DevSpace workspace ID." },
      ...properties,
    },
    required: ["workspaceId", ...required],
  };
  return jsonSchemaToZod(projected, projected);
}

function validateCatalog(value: unknown): McpBridgeCatalog {
  const source = record(value, "catalog");
  if (source.schemaVersion !== 1) throw new Error("MCP bridge catalog schema is unsupported");
  if (typeof source.profile !== "string" || !/^[A-Za-z0-9_-]+$/.test(source.profile)) {
    throw new Error("MCP bridge catalog profile is invalid");
  }
  for (const key of ["configSha256", "aggregateSha256"] as const) {
    if (typeof source[key] !== "string" || !/^[a-f0-9]{64}$/.test(source[key])) {
      throw new Error(`MCP bridge catalog ${key} is invalid`);
    }
  }
  if (typeof source.stateConfigDrift !== "boolean" || !Array.isArray(source.servers)) {
    throw new Error("MCP bridge catalog fields are invalid");
  }
  const serverNames = new Set<string>();
  const servers = source.servers.map((entry): McpBridgeCatalogServer => {
    const server = record(entry, "catalog server");
    if (typeof server.name !== "string" || serverNames.has(server.name)) {
      throw new Error("MCP bridge catalog server name is invalid or duplicated");
    }
    const serverName = server.name;
    bridgedToolName(serverName, "probe");
    serverNames.add(serverName);
    if (server.transport !== "stdio" && server.transport !== "streamable-http") {
      throw new Error(`MCP bridge catalog transport is invalid for ${server.name}`);
    }
    if (!Array.isArray(server.tools)) throw new Error(`MCP bridge catalog tools are invalid for ${server.name}`);
    const toolNames = new Set<string>();
    const tools = server.tools.map((entry): McpBridgeToolDescriptor => {
      const tool = record(entry, "catalog tool");
      if (typeof tool.name !== "string" || toolNames.has(tool.name)) {
        throw new Error(`MCP bridge catalog tool is invalid or duplicated for ${server.name}`);
      }
      const toolName = tool.name;
      bridgedToolName(serverName, toolName);
      toolNames.add(toolName);
      return {
        name: toolName,
        ...(typeof tool.title === "string" ? { title: tool.title } : {}),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        inputSchema: structuredClone(record(tool.inputSchema, "catalog input schema")),
        ...(tool.outputSchema === undefined ? {} : {
          outputSchema: structuredClone(record(tool.outputSchema, "catalog output schema")),
        }),
        ...(tool.annotations === undefined ? {} : {
          annotations: structuredClone(record(tool.annotations, "catalog annotations")),
        }),
      };
    });
    return { name: serverName, transport: server.transport, tools };
  });
  const catalog: McpBridgeCatalog = {
    schemaVersion: 1,
    profile: source.profile as string,
    configSha256: source.configSha256 as string,
    stateConfigDrift: source.stateConfigDrift,
    servers,
    aggregateSha256: source.aggregateSha256 as string,
  };
  const aggregate = catalogAggregateSha256(
    catalog.profile,
    catalog.configSha256,
    catalog.stateConfigDrift,
    catalog.servers,
  );
  if (aggregate !== catalog.aggregateSha256) throw new Error("MCP bridge catalog aggregate is invalid");
  return catalog;
}

export function loadMcpBridgeCatalog(pathValue: string): McpBridgeCatalog {
  return validateCatalog(JSON.parse(readFileSync(pathValue, "utf8")));
}

export async function writeMcpBridgeCatalog(pathValue: string, catalog: McpBridgeCatalog): Promise<void> {
  const validated = validateCatalog(catalog);
  await mkdir(dirname(pathValue), { recursive: true });
  const temporaryPath = `${pathValue}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, pathValue);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export interface McpBridgeConnection {
  listTools(): Promise<{ tools: McpBridgeToolDescriptor[] }>;
  callTool(name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type McpBridgeConnectorFactory = (
  serverName: string,
  config: McpBridgeRuntimeServerConfig,
  scopeKey?: string,
) => Promise<McpBridgeConnection>;

export interface McpBridgeManagerOptions {
  now?: () => number;
}

interface McpBridgeConnectionEntry {
  connection: Promise<McpBridgeConnection>;
  lastUsedAt: number;
  inFlight: number;
}

const MCP_BRIDGE_TOOL_TIMEOUT_MS = 120_000;

export async function createSdkMcpBridgeConnection(
  serverName: string,
  config: McpBridgeRuntimeServerConfig,
  scopeKey = "shared",
  authProvider?: OAuthClientProvider,
): Promise<McpBridgeConnection> {
  config = scopeLifecycleServerConfig(serverName, scopeKey, config);
  const client = new Client({
    name: `devspace-mcp-bridge-${serverName}`,
    version: "1.0.0",
  });
  let stderr = "";
  const transport = config.transport === "stdio"
    ? new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(new URL(config.url), {
        ...(authProvider ? { authProvider } : {}),
        requestInit: Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : undefined,
      });
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    });
  }
  try {
    await client.connect(transport, { timeout: config.startupTimeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    if (error instanceof UnauthorizedError) {
      throw new Error(`MCP bridge upstream authorization required for ${serverName}`, { cause: error });
    }
    const diagnostic = redactMcpDiagnostic(stderr);
    throw new Error(
      diagnostic ? `MCP bridge upstream startup failed: ${diagnostic}` : "MCP bridge upstream startup failed",
      { cause: error },
    );
  }
  return {
    async listTools() {
      const result = await client.listTools(undefined, { timeout: config.startupTimeoutMs });
      return { tools: result.tools as McpBridgeToolDescriptor[] };
    },
    async callTool(name, argumentsValue) {
      return await client.callTool(
        { name, arguments: argumentsValue },
        undefined,
        { timeout: MCP_BRIDGE_TOOL_TIMEOUT_MS },
      ) as Record<string, unknown>;
    },
    async close() {
      await client.close();
    },
  };
}

function redactMcpDiagnostic(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "<path>")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ")
    .slice(0, 500);
}

export function catalogAggregateSha256(
  profile: string,
  configSha256: string,
  stateConfigDrift: boolean,
  servers: McpBridgeCatalogServer[],
): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    profile,
    configSha256,
    stateConfigDrift,
    servers,
  })).digest("hex");
}

export async function generateMcpBridgeCatalog(
  runtime: McpBridgeRuntimeProfile,
  connectorFactory: McpBridgeConnectorFactory,
): Promise<McpBridgeCatalog> {
  const servers = await Promise.all(runtime.publicProfile.servers.map(async (server) => {
    let connection: McpBridgeConnection;
    try {
      connection = await connectorFactory(server.name, runtime.serverConfig(server.name), "catalog");
    } catch (error) {
      throw new Error(`MCP bridge catalog connect failed for ${server.name}`, { cause: error });
    }
    try {
      let listed: { tools: McpBridgeToolDescriptor[] };
      try {
        listed = await connection.listTools();
      } catch (error) {
        throw new Error(`MCP bridge catalog tools/list failed for ${server.name}`, { cause: error });
      }
      const seen = new Set<string>();
      const tools = listed.tools.map((tool): McpBridgeToolDescriptor => {
        bridgedToolName(server.name, tool.name);
        if (seen.has(tool.name)) throw new Error(`MCP bridge server ${server.name} returned duplicate tool ${tool.name}`);
        seen.add(tool.name);
        const inputSchema = record(tool.inputSchema, `${server.name}.${tool.name} input schema`);
        const outputSchema = tool.outputSchema === undefined
          ? undefined
          : record(tool.outputSchema, `${server.name}.${tool.name} output schema`);
        return {
          name: tool.name,
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          inputSchema: structuredClone(inputSchema),
          ...(outputSchema ? { outputSchema: structuredClone(outputSchema) } : {}),
          ...(tool.annotations ? { annotations: structuredClone(tool.annotations) } : {}),
        };
      });
      return { name: server.name, transport: server.transport, tools };
    } finally {
      await connection.close();
    }
  }));
  const { name, configSha256, stateConfigDrift } = runtime.publicProfile;
  return {
    schemaVersion: 1,
    profile: name,
    configSha256,
    stateConfigDrift,
    servers,
    aggregateSha256: catalogAggregateSha256(name, configSha256, stateConfigDrift, servers),
  };
}

export interface McpBridgeCallInput {
  workspaceId: string;
  serverName: string;
  toolName: string;
  argumentsValue: Record<string, unknown>;
  scope: WorkspaceMcpScope;
}

export class McpBridgeManager {
  readonly #runtime: McpBridgeRuntimeProfile;
  readonly #catalog: McpBridgeCatalog;
  readonly #connectorFactory: McpBridgeConnectorFactory;
  readonly #connections = new Map<string, McpBridgeConnectionEntry>();
  readonly #serenaActivated = new Set<string>();
  readonly #now: () => number;

  constructor(
    runtime: McpBridgeRuntimeProfile,
    catalog: McpBridgeCatalog,
    connectorFactory: McpBridgeConnectorFactory,
    options: McpBridgeManagerOptions = {},
  ) {
    if (catalog.schemaVersion !== 1) throw new Error("MCP bridge catalog schema is unsupported");
    if (catalog.profile !== runtime.publicProfile.name) throw new Error("MCP bridge catalog profile is stale");
    if (catalog.configSha256 !== runtime.publicProfile.configSha256) {
      throw new Error("MCP bridge catalog config hash is stale");
    }
    const expectedServers = runtime.publicProfile.servers.map(({ name, transport }) => ({ name, transport }));
    const actualServers = catalog.servers.map(({ name, transport }) => ({ name, transport }));
    if (JSON.stringify(actualServers) !== JSON.stringify(expectedServers)) {
      throw new Error("MCP bridge catalog server surface is stale");
    }
    const aggregate = catalogAggregateSha256(
      catalog.profile,
      catalog.configSha256,
      catalog.stateConfigDrift,
      catalog.servers,
    );
    if (aggregate !== catalog.aggregateSha256) throw new Error("MCP bridge catalog aggregate is stale");
    this.#runtime = runtime;
    this.#catalog = catalog;
    this.#connectorFactory = connectorFactory;
    this.#now = options.now ?? Date.now;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  #connectionKey(workspaceId: string, serverName: string): string {
    return `${workspaceId}\u0000${serverName}`;
  }

  #connection(workspaceId: string, serverName: string, workspaceRoot: string): McpBridgeConnectionEntry {
    const key = this.#connectionKey(workspaceId, serverName);
    let entry = this.#connections.get(key);
    if (!entry) {
      const connection = this.#connectorFactory(serverName, this.#runtime.serverConfig(serverName), workspaceRoot);
      entry = { connection, lastUsedAt: this.#now(), inFlight: 0 };
      this.#connections.set(key, entry);
      void connection.catch(() => {
        if (this.#connections.get(key) === entry) this.#connections.delete(key);
      });
    }
    entry.lastUsedAt = this.#now();
    return entry;
  }

  async call(input: McpBridgeCallInput): Promise<Record<string, unknown>> {
    if (!input.workspaceId) throw new Error("MCP bridge workspaceId is required");
    const server = this.#catalog.servers.find((entry) => entry.name === input.serverName);
    if (!server) throw new Error(`MCP bridge server ${input.serverName} is not in the active catalog`);
    if (!server.tools.some((tool) => tool.name === input.toolName)) {
      throw new Error(`MCP bridge tool ${input.serverName}.${input.toolName} is not in the active catalog`);
    }
    const key = this.#connectionKey(input.workspaceId, input.serverName);
    const entry = this.#connection(input.workspaceId, input.serverName, input.scope.workspaceRoot);
    entry.inFlight += 1;
    try {
      const connection = await entry.connection;
      const scopedArguments = scopeMcpArguments(
        input.serverName,
        input.toolName,
        input.argumentsValue,
        input.scope,
      );
      if (input.serverName === "serena" && !this.#serenaActivated.has(key)) {
        if (input.toolName !== "activate_project") {
          await connection.callTool("activate_project", { project: input.scope.workspaceRoot });
        }
        this.#serenaActivated.add(key);
      }
      return await connection.callTool(input.toolName, scopedArguments);
    } finally {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastUsedAt = this.#now();
    }
  }

  async closeIdle(maxIdleMs: number): Promise<number> {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs < 0) {
      throw new Error("MCP bridge idle timeout must be a non-negative finite number");
    }
    const cutoff = this.#now() - maxIdleMs;
    const idle: Array<{ key: string; entry: McpBridgeConnectionEntry }> = [];
    for (const [key, entry] of this.#connections) {
      if (entry.inFlight > 0 || entry.lastUsedAt > cutoff) continue;
      this.#connections.delete(key);
      this.#serenaActivated.delete(key);
      idle.push({ key, entry });
    }
    await Promise.allSettled(idle.map(async ({ entry }) => (await entry.connection).close()));
    return idle.length;
  }

  async close(): Promise<void> {
    const connections = [...this.#connections.values()].map(({ connection }) => connection);
    this.#connections.clear();
    this.#serenaActivated.clear();
    await Promise.allSettled(connections.map(async (connection) => (await connection).close()));
  }
}

export async function resolveMcpBridgeTenant(
  resolverPath: string,
  workspaceRoot: string,
): Promise<{ projectId: string; instanceId: string }> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolverPath, "-ProjectRoot", workspaceRoot, "-Json"],
    { timeout: 15_000, maxBuffer: 64 * 1_024, windowsHide: true },
  );
  const receipt = record(JSON.parse(stdout), "tenant resolver receipt");
  if (receipt.ready !== true) throw new Error("MCP bridge tenant resolver is not ready");
  const projectId = receipt.project_id;
  const instanceId = receipt.instance_id;
  if (typeof projectId !== "string" || !/^proj_[a-f0-9]{16}$/.test(projectId)) {
    throw new Error("MCP bridge tenant resolver returned an invalid project_id");
  }
  if (typeof instanceId !== "string" || !/^inst_[a-f0-9]{32}$/.test(instanceId)) {
    throw new Error("MCP bridge tenant resolver returned an invalid instance_id");
  }
  return { projectId, instanceId };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid MCP bridge ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Invalid MCP bridge ${label}`);
  }
  return value as string[];
}

export function resolveActiveMcpProfile(input: ActiveMcpProfileInput): ActiveMcpProfile {
  const profileName = input.profileState.observed_active_profile;
  if (typeof profileName !== "string" || profileName !== input.profileDefinition.name) {
    throw new Error("MCP bridge active profile does not match its profile definition");
  }
  if (input.profileState.activation_status !== "active_loaded_verified") {
    throw new Error("MCP bridge profile is not active and verified");
  }

  const rawConfig = input.profileState.raw_config;
  const expectedHash = input.profileState.active_config_sha256;
  if (typeof rawConfig !== "string" || typeof expectedHash !== "string") {
    throw new Error("MCP bridge config hash evidence is missing");
  }
  const actualHash = createHash("sha256").update(rawConfig).digest("hex");
  if (!/^[a-fA-F0-9]{64}$/.test(expectedHash)) throw new Error("MCP bridge state config hash is invalid");

  const enabledServers = stringArray(input.profileDefinition.enabled_servers, "enabled server list");
  const disabledServers = new Set(
    input.profileDefinition.configured_disabled_servers === undefined
      ? []
      : stringArray(input.profileDefinition.configured_disabled_servers, "disabled server list"),
  );
  const hostManagedServers = new Set(
    input.profileDefinition.host_managed_servers === undefined
      ? []
      : stringArray(input.profileDefinition.host_managed_servers, "host-managed server list"),
  );
  const removedServers = new Set(
    input.profileDefinition.removed_servers === undefined
      ? []
      : stringArray(input.profileDefinition.removed_servers, "removed server list"),
  );
  const configuredServers = record(input.codexConfig.mcp_servers, "Codex server configuration");

  const selectedServers = [...enabledServers];
  if (input.profileDefinition.preserve_unmanaged_servers === true) {
    for (const [name, value] of Object.entries(configuredServers)) {
      const config = record(value, `server ${name}`);
      if (
        config.enabled !== false
        && !selectedServers.includes(name)
        && !disabledServers.has(name)
        && !hostManagedServers.has(name)
        && !removedServers.has(name)
      ) {
        selectedServers.push(name);
      }
    }
  }

  const servers = selectedServers.map((name): ActiveMcpServer => {
    if (disabledServers.has(name) || hostManagedServers.has(name)) {
      throw new Error(`MCP bridge profile classifies enabled server ${name} as unavailable`);
    }
    const config = record(configuredServers[name], `server ${name}`);
    if (config.enabled === false) {
      throw new Error(`MCP bridge enabled server ${name} is disabled in Codex configuration`);
    }
    const hasCommand = typeof config.command === "string" && config.command.length > 0;
    const hasUrl = typeof config.url === "string" && config.url.length > 0;
    if (hasCommand === hasUrl) {
      throw new Error(`MCP bridge server ${name} must define exactly one transport`);
    }
    return {
      name,
      transport: hasCommand ? "stdio" : "streamable-http",
    };
  });

  return {
    name: profileName,
    servers,
    configSha256: actualHash,
    stateConfigDrift: actualHash !== expectedHash.toLowerCase(),
  };
}

export function bridgedToolName(serverName: string, toolName: string): string {
  const segment = /^[A-Za-z0-9_-]+$/;
  const name = `mcp__${serverName}__${toolName}`;
  if (!segment.test(serverName) || !segment.test(toolName) || name.length > 128) {
    throw new Error("Invalid MCP bridge server or tool name");
  }
  return name;
}

const PATH_ARGUMENT = /^(?:path|paths|root|cwd|directory|file|files|project_path|repo_path|working_directory)$/i;

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validatePathValue(key: string, value: unknown, workspaceRoot: string): void {
  if (!PATH_ARGUMENT.test(key)) return;
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry !== "string" || !entry) continue;
    const normalized = entry.replaceAll("/", "\\");
    if (normalized.split("\\").includes("..")) {
      throw new Error(`MCP bridge path traversal rejected for ${key}`);
    }
    if (path.isAbsolute(normalized) && !isInsideRoot(normalized, workspaceRoot)) {
      throw new Error(`MCP bridge path is outside workspace for ${key}`);
    }
  }
}

function validateScopedPaths(value: unknown, workspaceRoot: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) validateScopedPaths(entry, workspaceRoot);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validatePathValue(key, entry, workspaceRoot);
    if (!PATH_ARGUMENT.test(key)) validateScopedPaths(entry, workspaceRoot);
  }
}

export function scopeMcpArguments(
  serverName: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
  scope: WorkspaceMcpScope,
): Record<string, unknown> {
  const result = structuredClone(argumentsValue);
  if (serverName === "serena" && toolName === "activate_project") {
    result.project = scope.workspaceRoot;
  }
  if (serverName === "graphify") {
    result.project_path = scope.workspaceRoot;
  }
  validateScopedPaths(result, scope.workspaceRoot);

  if (serverName === "openmemory") {
    if (!scope.projectId || !scope.instanceId) {
      throw new Error("MCP bridge OpenMemory tenant is unavailable for this workspace");
    }
    for (const [key, expected] of [
      ["project_id", scope.projectId],
      ["instance_id", scope.instanceId],
    ] as const) {
      if (result[key] !== undefined && result[key] !== expected) {
        throw new Error(`MCP bridge OpenMemory tenant mismatch for ${key}`);
      }
      result[key] = expected;
    }
    if (toolName === "openmemory_query") {
      const maxItems = result.max_items;
      const tokenBudget = result.token_budget;
      if (typeof maxItems === "number" && maxItems > 3) {
        throw new Error("MCP bridge OpenMemory max_items exceeds the initial budget");
      }
      if (typeof tokenBudget === "number" && tokenBudget > 600) {
        throw new Error("MCP bridge OpenMemory token_budget exceeds the initial budget");
      }
    }
  }
  return result;
}
