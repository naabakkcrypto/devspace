import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createSdkMcpBridgeConnection,
  generateMcpBridgeCatalog,
  loadMcpBridgeRuntimeProfile,
  writeMcpBridgeCatalog,
  type McpBridgeProfilePaths,
} from "./mcp-bridge.js";

interface CatalogCommandOptions extends McpBridgeProfilePaths {
  outputPath: string;
}

function argumentValue(argumentsValue: string[], name: string): string {
  const index = argumentsValue.indexOf(name);
  const value = index >= 0 ? argumentsValue[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required ${name}`);
  return value;
}

export function parseCatalogCommand(argumentsValue: string[]): CatalogCommandOptions {
  return {
    codexConfigPath: argumentValue(argumentsValue, "--codex-config"),
    profileStatePath: argumentValue(argumentsValue, "--profile-state"),
    profileRegistryRoot: argumentValue(argumentsValue, "--profile-registry"),
    outputPath: argumentValue(argumentsValue, "--output"),
  };
}

export async function runCatalogCommand(options: CatalogCommandOptions): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const runtime = loadMcpBridgeRuntimeProfile(options);
  const catalog = await generateMcpBridgeCatalog(runtime, createSdkMcpBridgeConnection);
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
