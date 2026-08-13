import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  SandboxMode,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { safeLocalAgentEnvironment } from "./local-agent-transport.js";

export type LocalAgentWriteMode = "read_only" | "allowed";
export const MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS = 64 * 1024;
export const MAX_LOCAL_AGENT_PROVIDER_ERROR_CHARACTERS = 16 * 1024;
const LOCAL_AGENT_TRUNCATION_MARKER = "\n[... local-agent output truncated ...]";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  responseTruncated: boolean;
  runtimeIdentity: LocalAgentRuntimeIdentity;
}

export interface LocalAgentRuntimeIdentity {
  requested: {
    provider: string;
    model?: string;
    thinking?: string;
    writeMode: LocalAgentWriteMode;
  };
  adapterProvider: string;
  evidenceLevel: "requested_unverified" | "observed";
  source: string;
  observed?: {
    provider?: string;
    model?: string;
    thinking?: string;
    writeMode?: LocalAgentWriteMode;
  };
}

export interface LocalAgentRuntime {
  readonly provider: string;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(prompt: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

type CodexFactory = (options?: CodexOptions) => CodexClientLike;

export interface IsolatedCodexEnvironment {
  readonly home: string;
  readonly env: Record<string, string>;
  dispose(): Promise<void>;
}

/**
 * Give a managed Codex worker authentication without loading the user's
 * potentially incompatible config.toml. The auth file is copied so a worker
 * cannot mutate the user's canonical credentials, and the isolated home is
 * removed after the run.
 */
export function createIsolatedCodexEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  sourceCodexHome?: string,
): IsolatedCodexEnvironment {
  const homeRoot = sourceCodexHome ?? resolveSourceCodexHome(sourceEnv);
  const sourceAuth = join(homeRoot, "auth.json");
  if (!existsSync(sourceAuth)) {
    throw new Error("Codex authentication is unavailable for the managed subagent runtime.");
  }

  const isolatedHome = mkdtempSync(join(homeRoot, ".devspace-agent-"));
  let disposed = false;
  try {
    const isolatedAuth = join(isolatedHome, "auth.json");
    copyFileSync(sourceAuth, isolatedAuth);
    chmodSync(isolatedAuth, 0o600);
  } catch (error) {
    rmSync(isolatedHome, { recursive: true, force: true });
    throw new Error(`Unable to isolate Codex authentication: ${errorMessage(error)}`);
  }

  const safeWorkerEnv = safeLocalAgentEnvironment(sourceEnv);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(safeWorkerEnv)) {
    if (value !== undefined && !key.toUpperCase().startsWith("DEVSPACE_")) env[key] = value;
  }
  env.CODEX_HOME = isolatedHome;

  return {
    home: isolatedHome,
    env,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      assertIsolatedCodexHome(homeRoot, isolatedHome);
      let lastError: unknown;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          rmSync(isolatedHome, { recursive: true, force: true });
          return;
        } catch (error) {
          lastError = error;
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
        }
      }
      throw new Error(`Unable to clean up the isolated Codex home: ${errorMessage(lastError)}`);
    },
  };
}

function resolveSourceCodexHome(env: NodeJS.ProcessEnv): string {
  const explicit = env.CODEX_HOME;
  if (explicit) return resolve(explicit);
  const userHome = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  if (!userHome) throw new Error("Unable to resolve the Codex authentication home.");
  return resolve(userHome, ".codex");
}

function assertIsolatedCodexHome(sourceHome: string, isolatedHome: string): void {
  const relativePath = relative(resolve(sourceHome), resolve(isolatedHome));
  if (!relativePath.startsWith(".devspace-agent-") || relativePath.includes("..") || relativePath.includes("/") || relativePath.includes("\\")) {
    throw new Error("Refusing to remove an unexpected Codex home path.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Prefer the current Codex desktop runtime over the SDK's bundled CLI on Windows. */
export function resolvePreferredCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32" || !env.LOCALAPPDATA) return undefined;
  const runtimeRoot = join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  try {
    return readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runtimeRoot, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate) && statSync(candidate).isFile())
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

function sandboxModeFor(writeMode: LocalAgentWriteMode | undefined): SandboxMode {
  switch (writeMode) {
    case "allowed":
      return "workspace-write";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

function threadOptionsFor(input: LocalAgentRunInput): ThreadOptions {
  return {
    workingDirectory: input.workspace,
    sandboxMode: sandboxModeFor(input.writeMode),
    approvalPolicy: "never",
    model: input.model,
    modelReasoningEffort: input.thinking as ModelReasoningEffort | undefined,
  };
}

export class CodexSdkLocalAgentRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly codex: CodexClientLike;

  constructor(codex: CodexClientLike) {
    this.codex = codex;
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const options = threadOptionsFor(input);
    const thread = input.providerSessionId
      ? this.codex.resumeThread(input.providerSessionId, options)
      : this.codex.startThread(options);
    const streamed = await thread.runStreamed(
      input.prompt,
      input.signal ? { signal: input.signal } : undefined,
    );
    let finalResponse = "";
    let responseTruncated = false;
    for await (const event of streamed.events) {
      if (
        (event.type === "item.updated" || event.type === "item.completed") &&
        event.item.type === "agent_message"
      ) {
        const bounded = truncateLocalAgentText(
          event.item.text,
          MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS,
        );
        finalResponse = bounded.text;
        responseTruncated = bounded.truncated;
        continue;
      }
      if (event.type === "turn.failed") {
        throw new Error(boundedProviderError(event.error.message));
      }
      if (event.type === "error") {
        throw new Error(boundedProviderError(event.message));
      }
    }

    return {
      provider: this.provider,
      providerSessionId: thread.id,
      finalResponse,
      responseTruncated,
      runtimeIdentity: requestedRuntimeIdentity(this.provider, input),
    };
  }
}

function boundedProviderError(value: string): string {
  return truncateLocalAgentText(value, MAX_LOCAL_AGENT_PROVIDER_ERROR_CHARACTERS).text;
}

export function requestedRuntimeIdentity(
  provider: string,
  input: Pick<LocalAgentRunInput, "model" | "thinking" | "writeMode">,
): LocalAgentRuntimeIdentity {
  return {
    requested: {
      provider,
      model: input.model,
      thinking: input.thinking,
      writeMode: input.writeMode ?? "read_only",
    },
    adapterProvider: provider,
    evidenceLevel: "requested_unverified",
    source: "request",
  };
}

export function truncateLocalAgentText(
  value: string,
  maximumCharacters: number,
): { text: string; truncated: boolean } {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < LOCAL_AGENT_TRUNCATION_MARKER.length) {
    throw new Error("Local-agent output limit is too small.");
  }
  if (value.length <= maximumCharacters) return { text: value, truncated: false };
  const proposedEnd = maximumCharacters - LOCAL_AGENT_TRUNCATION_MARKER.length;
  const sliceEnd = safeUtf16SliceEnd(value, proposedEnd);
  return {
    text: `${value.slice(0, sliceEnd)}${LOCAL_AGENT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export function isLocalAgentTextTruncated(value: string): boolean {
  return value.includes(LOCAL_AGENT_TRUNCATION_MARKER.trim());
}

function safeUtf16SliceEnd(value: string, proposedEnd: number): number {
  if (proposedEnd <= 0 || proposedEnd >= value.length) return proposedEnd;
  const previous = value.charCodeAt(proposedEnd - 1);
  const next = value.charCodeAt(proposedEnd);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? proposedEnd - 1
    : proposedEnd;
}

export async function createCodexSdkLocalAgentRuntime(
  options?: CodexOptions,
  codexFactory?: CodexFactory,
): Promise<CodexSdkLocalAgentRuntime> {
  const factory = codexFactory ?? (await defaultCodexFactory());
  return new CodexSdkLocalAgentRuntime(factory(options));
}

async function defaultCodexFactory(): Promise<CodexFactory> {
  const module = await import("@openai/codex-sdk");
  return (options) => new module.Codex(options) as Codex;
}
