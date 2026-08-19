import { createServer, type Server } from "node:http";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  DEFAULT_MCP_BRIDGE_OAUTH_CALLBACK_PORT,
  PersistentMcpBridgeOAuthProvider,
  loadMcpBridgeOAuthTarget,
  mcpBridgeOAuthCallbackUrl,
} from "./mcp-bridge-oauth.js";

const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CALLBACK_VALUE_LENGTH = 4_096;

export interface McpBridgeAuthCommandOptions {
  codexConfigPath: string;
  stateDir: string;
  serverName: string;
  callbackPort: number;
  timeoutMs: number;
}

export interface McpBridgeAuthHooks {
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

export interface McpBridgeAuthReceipt {
  ready: true;
  server: string;
  callbackUrl: string;
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

function integerArgument(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function parseMcpBridgeAuthCommand(argumentsValue: string[]): McpBridgeAuthCommandOptions {
  const callbackPortRaw = optionalArgumentValue(argumentsValue, "--callback-port");
  const timeoutSecondsRaw = optionalArgumentValue(argumentsValue, "--timeout-sec");
  return {
    codexConfigPath: resolve(argumentValue(argumentsValue, "--codex-config")),
    stateDir: resolve(argumentValue(argumentsValue, "--state-dir")),
    serverName: argumentValue(argumentsValue, "--server"),
    callbackPort: callbackPortRaw === undefined
      ? DEFAULT_MCP_BRIDGE_OAUTH_CALLBACK_PORT
      : integerArgument(callbackPortRaw, "--callback-port", 1, 65535),
    timeoutMs: timeoutSecondsRaw === undefined
      ? DEFAULT_AUTH_TIMEOUT_MS
      : integerArgument(timeoutSecondsRaw, "--timeout-sec", 1, 30 * 60) * 1_000,
  };
}

function writeCallbackResponse(response: import("node:http").ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(message);
}

function callbackValue(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name) ?? undefined;
  if (value !== undefined && (value.length < 1 || value.length > MAX_CALLBACK_VALUE_LENGTH)) {
    throw new Error(`OAuth callback ${name} is invalid`);
  }
  return value;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

export async function runMcpBridgeAuthCommand(
  options: McpBridgeAuthCommandOptions,
  hooks: McpBridgeAuthHooks = {},
): Promise<McpBridgeAuthReceipt> {
  const target = loadMcpBridgeOAuthTarget(options.codexConfigPath, options.serverName);
  const callbackUrl = mcpBridgeOAuthCallbackUrl(options.serverName, options.callbackPort);
  const provider = new PersistentMcpBridgeOAuthProvider({
    stateDir: options.stateDir,
    serverName: options.serverName,
    serverUrl: target.serverUrl,
    redirectUrl: callbackUrl,
    onRedirect: hooks.onAuthorizationUrl,
  });

  let settleCallback!: () => void;
  let rejectCallback!: (error: Error) => void;
  const callbackCompleted = new Promise<void>((resolvePromise, reject) => {
    settleCallback = resolvePromise;
    rejectCallback = reject;
  });

  const callbackServer = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "GET") {
          writeCallbackResponse(response, 405, "Method not allowed.");
          return;
        }
        const requestUrl = new URL(request.url ?? "/", callbackUrl.origin);
        if (requestUrl.pathname !== callbackUrl.pathname) {
          writeCallbackResponse(response, 404, "Not found.");
          return;
        }
        const oauthError = callbackValue(requestUrl, "error");
        if (oauthError) {
          writeCallbackResponse(response, 400, "Netlify authorization was not completed.");
          rejectCallback(new Error(`MCP bridge OAuth authorization failed: ${oauthError.slice(0, 120)}`));
          return;
        }
        const code = callbackValue(requestUrl, "code");
        const state = callbackValue(requestUrl, "state");
        if (!code || !state || !await provider.consumeAuthorizationState(state)) {
          writeCallbackResponse(response, 400, "Invalid OAuth callback.");
          return;
        }
        const result = await auth(provider, {
          serverUrl: target.serverUrl,
          authorizationCode: code,
        });
        if (result !== "AUTHORIZED") throw new Error("MCP bridge OAuth code exchange did not authorize the client");
        writeCallbackResponse(response, 200, "Netlify authorization complete. You can close this tab.");
        settleCallback();
      } catch (error) {
        if (!response.headersSent) writeCallbackResponse(response, 500, "OAuth authorization failed.");
        rejectCallback(error instanceof Error ? error : new Error("MCP bridge OAuth callback failed"));
      }
    })();
  });

  await listen(callbackServer, options.callbackPort);
  try {
    const initial = await auth(provider, { serverUrl: target.serverUrl });
    if (initial === "AUTHORIZED") {
      return { ready: true, server: target.serverName, callbackUrl: callbackUrl.toString() };
    }
    if (initial !== "REDIRECT") throw new Error("MCP bridge OAuth authorization did not start");

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        callbackCompleted,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("MCP bridge OAuth authorization timed out")),
            options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return { ready: true, server: target.serverName, callbackUrl: callbackUrl.toString() };
  } finally {
    await close(callbackServer);
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  return await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1]);
}

if (await isMainModule()) {
  try {
    const options = parseMcpBridgeAuthCommand(process.argv.slice(2));
    const receipt = await runMcpBridgeAuthCommand(options, {
      onAuthorizationUrl: (url) => {
        console.log(JSON.stringify({
          ready: false,
          authorizationRequired: true,
          server: options.serverName,
          authorizationUrl: url.toString(),
        }));
      },
    });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(JSON.stringify({
      ready: false,
      error: error instanceof Error ? error.message.slice(0, 500) : "MCP bridge OAuth authorization failed",
    }));
    process.exitCode = 1;
  }
}
