import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  McpBridgeOAuthRegistry,
  mcpBridgeOAuthCallbackUrl,
} from "./mcp-bridge-oauth.js";
import {
  createSdkMcpBridgeConnection,
  generateMcpBridgeCatalog,
  loadMcpBridgeRuntimeProfile,
  writeMcpBridgeCatalog,
  type McpBridgeConnectorFactory,
  type McpBridgeProfilePaths,
} from "./mcp-bridge.js";

interface CatalogCommandOptions extends McpBridgeProfilePaths {
  outputPath: string;
  oauthStateDir?: string;
  oauthCallbackPort?: number;
}

function argumentValue(argumentsValue: string[], name: string): string {
  const index = argumentsValue.indexOf(name);
  const value = index >= 0 ? argumentsValue[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required ${name}`);
  return value;
}

function optionalArgumentValue(argumentsValue: string[], name: string): string | undefined {
  const index = argumentsValue.indexOf(name);
  if (index < 0) return undefined;
  const value = argumentsValue[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing required value for ${name}`);
  return value;
}

function optionalPort(argumentsValue: string[], name: string): number | undefined {
  const raw = optionalArgumentValue(argumentsValue, name);
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${name}: ${raw}`);
  return port;
}

export function parseCatalogCommand(argumentsValue: string[]): CatalogCommandOptions {
  return {
    codexConfigPath: argumentValue(argumentsValue, "--codex-config"),
    profileStatePath: argumentValue(argumentsValue, "--profile-state"),
    profileRegistryRoot: argumentValue(argumentsValue, "--profile-registry"),
    outputPath: argumentValue(argumentsValue, "--output"),
    oauthStateDir: optionalArgumentValue(argumentsValue, "--oauth-state-dir"),
    oauthCallbackPort: optionalPort(argumentsValue, "--oauth-callback-port"),
  };
}

export async function runCatalogCommand(options: CatalogCommandOptions): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const runtime = loadMcpBridgeRuntimeProfile(options);
  const oauthRegistry = options.oauthStateDir
    ? new McpBridgeOAuthRegistry({
        stateDir: options.oauthStateDir,
        redirectUrlFor: (serverName) => mcpBridgeOAuthCallbackUrl(serverName, options.oauthCallbackPort),
      })
    : undefined;
  const connector: McpBridgeConnectorFactory = oauthRegistry
    ? async (serverName, config, scopeKey) => {
        const provider = config.transport === "streamable-http"
          ? oauthRegistry.providerFor(serverName, new URL(config.url))
          : undefined;
        return await createSdkMcpBridgeConnection(serverName, config, scopeKey, provider);
      }
    : createSdkMcpBridgeConnection;
  const catalog = await generateMcpBridgeCatalog(runtime, connector);
  await writeMcpBridgeCatalog(options.outputPath, catalog);
  return {
    ready: true,
    profile: catalog.profile,
    servers: catalog.servers.length,
    tools: catalog.servers.reduce((count, server) => count + server.tools.length, 0),
    aggregateSha256: catalog.aggregateSha256,
    stateConfigDrift: catalog.stateConfigDrift,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  return await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1]);
}

if (await isMainModule()) {
  try {
    console.log(JSON.stringify(await runCatalogCommand(parseCatalogCommand(process.argv.slice(2)))));
  } catch (error) {
    console.error(JSON.stringify({
      ready: false,
      error: error instanceof Error ? error.message.slice(0, 500) : "MCP bridge catalog failed",
    }));
    process.exitCode = 1;
  }
}
