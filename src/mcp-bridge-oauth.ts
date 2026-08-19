import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { parse as parseToml } from "smol-toml";

const OAUTH_SCHEMA_VERSION = 1;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DEFAULT_MCP_BRIDGE_OAUTH_CALLBACK_PORT = 7677;

interface PersistedMcpBridgeOAuthCredentials {
  schemaVersion: 1;
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  authorizationState?: string;
  authorizationUrl?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface PersistentMcpBridgeOAuthProviderOptions {
  stateDir: string;
  serverName: string;
  serverUrl: URL;
  redirectUrl: URL;
  onRedirect?: (url: URL) => void | Promise<void>;
}

export interface McpBridgeOAuthTarget {
  serverName: string;
  serverUrl: URL;
  enabled: boolean;
}

export interface McpBridgeOAuthRegistryOptions {
  stateDir: string;
  redirectUrlFor: (serverName: string) => URL;
  onRedirect?: (serverName: string, url: URL) => void | Promise<void>;
}

function validateServerName(serverName: string): void {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`MCP bridge OAuth server name is invalid: ${serverName}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function initialCredentials(serverUrl: URL): PersistedMcpBridgeOAuthCredentials {
  return {
    schemaVersion: OAUTH_SCHEMA_VERSION,
    serverUrl: serverUrl.toString(),
  };
}

export function mcpBridgeOAuthCredentialPath(stateDir: string, serverName: string): string {
  validateServerName(serverName);
  return join(stateDir, "mcp-bridge-oauth", `${serverName}.json`);
}

export function mcpBridgeOAuthCallbackUrl(
  serverName: string,
  port = DEFAULT_MCP_BRIDGE_OAUTH_CALLBACK_PORT,
): URL {
  validateServerName(serverName);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MCP bridge OAuth callback port is invalid: ${port}`);
  }
  return new URL(`/mcp-bridge/oauth/callback/${encodeURIComponent(serverName)}`, `http://127.0.0.1:${port}`);
}

async function readCredentials(
  path: string,
  serverUrl: URL,
): Promise<PersistedMcpBridgeOAuthCredentials> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialCredentials(serverUrl);
    throw error;
  }
  const parsed = record(JSON.parse(raw), "MCP bridge OAuth credentials");
  if (parsed.schemaVersion !== OAUTH_SCHEMA_VERSION || parsed.serverUrl !== serverUrl.toString()) {
    throw new Error("MCP bridge OAuth credential metadata does not match the configured upstream server");
  }
  return parsed as unknown as PersistedMcpBridgeOAuthCredentials;
}

async function writeCredentials(
  path: string,
  credentials: PersistedMcpBridgeOAuthCredentials,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credentials)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class PersistentMcpBridgeOAuthProvider implements OAuthClientProvider {
  readonly #path: string;
  readonly #serverName: string;
  readonly #serverUrl: URL;
  readonly #redirectUrl: URL;
  readonly #onRedirect?: (url: URL) => void | Promise<void>;
  #mutation = Promise.resolve();

  constructor(options: PersistentMcpBridgeOAuthProviderOptions) {
    validateServerName(options.serverName);
    if (options.serverUrl.protocol !== "https:") {
      throw new Error("MCP bridge OAuth upstream server must use HTTPS");
    }
    if (options.redirectUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(options.redirectUrl.hostname)) {
      throw new Error("MCP bridge OAuth redirect URL must use loopback HTTP");
    }
    this.#serverName = options.serverName;
    this.#serverUrl = new URL(options.serverUrl);
    this.#redirectUrl = new URL(options.redirectUrl);
    this.#onRedirect = options.onRedirect;
    this.#path = mcpBridgeOAuthCredentialPath(options.stateDir, options.serverName);
  }

  get serverName(): string {
    return this.#serverName;
  }

  get serverUrl(): URL {
    return new URL(this.#serverUrl);
  }

  get redirectUrl(): URL {
    return new URL(this.#redirectUrl);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `DevSpace MCP bridge (${this.#serverName})`,
      redirect_uris: [this.#redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.#read()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.#update((credentials) => ({ ...credentials, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.#read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#update((credentials) => ({ ...credentials, tokens }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.#update((credentials) => ({ ...credentials, authorizationUrl: authorizationUrl.toString() }));
    await this.#onRedirect?.(new URL(authorizationUrl));
  }

  async authorizationUrl(): Promise<URL | undefined> {
    const value = (await this.#read()).authorizationUrl;
    return value ? new URL(value) : undefined;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!codeVerifier) throw new Error("MCP bridge OAuth code verifier is empty");
    await this.#update((credentials) => ({ ...credentials, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.#read()).codeVerifier;
    if (!verifier) throw new Error("MCP bridge OAuth code verifier is unavailable");
    return verifier;
  }

  async state(): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    await this.#update((credentials) => ({ ...credentials, authorizationState: state }));
    return state;
  }

  async consumeAuthorizationState(candidate: string): Promise<boolean> {
    let consumed = false;
    await this.#update((credentials) => {
      const expected = credentials.authorizationState;
      if (!expected || !candidate) return credentials;
      const expectedBytes = Buffer.from(expected);
      const candidateBytes = Buffer.from(candidate);
      if (expectedBytes.length !== candidateBytes.length || !timingSafeEqual(expectedBytes, candidateBytes)) {
        return credentials;
      }
      consumed = true;
      const next = { ...credentials };
      delete next.authorizationState;
      delete next.authorizationUrl;
      return next;
    });
    return consumed;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.#update((credentials) => ({ ...credentials, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.#read()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.#update((credentials) => {
      if (scope === "all") return initialCredentials(this.#serverUrl);
      const next = { ...credentials };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      if (scope === "discovery") delete next.discoveryState;
      if (scope === "verifier") {
        delete next.codeVerifier;
        delete next.authorizationState;
        delete next.authorizationUrl;
      }
      return next;
    });
  }

  async #read(): Promise<PersistedMcpBridgeOAuthCredentials> {
    await this.#mutation;
    return await readCredentials(this.#path, this.#serverUrl);
  }

  async #update(
    mutation: (credentials: PersistedMcpBridgeOAuthCredentials) => PersistedMcpBridgeOAuthCredentials,
  ): Promise<void> {
    const update = this.#mutation.then(async () => {
      const current = await readCredentials(this.#path, this.#serverUrl);
      await writeCredentials(this.#path, mutation(current));
    });
    this.#mutation = update.catch(() => undefined);
    await update;
  }
}

export class McpBridgeOAuthRegistry {
  readonly #providers = new Map<string, PersistentMcpBridgeOAuthProvider>();

  constructor(private readonly options: McpBridgeOAuthRegistryOptions) {}

  providerFor(serverName: string, serverUrl: URL): PersistentMcpBridgeOAuthProvider {
    validateServerName(serverName);
    const existing = this.#providers.get(serverName);
    if (existing) {
      if (existing.serverUrl.toString() !== serverUrl.toString()) {
        throw new Error(`MCP bridge OAuth URL drift detected for ${serverName}`);
      }
      return existing;
    }
    const provider = new PersistentMcpBridgeOAuthProvider({
      stateDir: this.options.stateDir,
      serverName,
      serverUrl,
      redirectUrl: this.options.redirectUrlFor(serverName),
      ...(this.options.onRedirect
        ? { onRedirect: (url) => this.options.onRedirect?.(serverName, url) }
        : {}),
    });
    this.#providers.set(serverName, provider);
    return provider;
  }
}

export function loadMcpBridgeOAuthTarget(configPath: string, serverName: string): McpBridgeOAuthTarget {
  validateServerName(serverName);
  const raw = readFileSync(configPath, "utf8");
  const parsed = parseToml(raw) as Record<string, unknown>;
  const servers = record(parsed.mcp_servers, "Codex MCP server configuration");
  if (!Object.hasOwn(servers, serverName)) {
    throw new Error(`MCP bridge OAuth target ${serverName} is missing from Codex configuration`);
  }
  const config = record(servers[serverName], `MCP bridge OAuth target ${serverName}`);
  if (typeof config.url !== "string" || !config.url) {
    throw new Error(`MCP bridge OAuth target ${serverName} is not a streamable HTTP URL`);
  }
  const serverUrl = new URL(config.url);
  if (serverUrl.protocol !== "https:") {
    throw new Error(`MCP bridge OAuth target ${serverName} must use HTTPS`);
  }
  if (typeof config.command === "string" || Array.isArray(config.args)) {
    throw new Error(`MCP bridge OAuth target ${serverName} must not use stdio command or arguments`);
  }
  return {
    serverName,
    serverUrl,
    enabled: config.enabled !== false,
  };
}
