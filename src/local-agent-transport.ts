import { createHash, timingSafeEqual } from "node:crypto";
import { Writable } from "node:stream";

/** Maximum UTF-8 size accepted for a composed local-agent prompt. */
export const MAX_AGENT_PROMPT_BYTES = 256 * 1024;

const ENVELOPE_VERSION = 1 as const;
const MAX_ENVELOPE_BYTES = MAX_AGENT_PROMPT_BYTES + 64 * 1024;

export interface LocalAgentPromptEnvelope {
  readonly version: typeof ENVELOPE_VERSION;
  readonly agentId: string;
  readonly runId: string;
  readonly promptSha256: string;
  readonly prompt: string;
}

export interface LocalAgentPromptIdentity {
  readonly agentId: string;
  readonly runId: string;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function assertIdentity(agentId: string, runId: string): void {
  if (typeof agentId !== "string" || agentId.length === 0) throw new Error("agentId must be a non-empty string.");
  if (typeof runId !== "string" || runId.length === 0) throw new Error("runId must be a non-empty string.");
}

function assertPromptSize(prompt: string): void {
  if (utf8ByteLength(prompt) > MAX_AGENT_PROMPT_BYTES) {
    throw new Error(`Agent prompt exceeds the ${MAX_AGENT_PROMPT_BYTES}-byte limit.`);
  }
}

export function createLocalAgentPromptEnvelope(input: {
  agentId: string;
  runId: string;
  prompt: string;
}): LocalAgentPromptEnvelope {
  assertIdentity(input.agentId, input.runId);
  if (typeof input.prompt !== "string") throw new Error("prompt must be a string.");
  assertPromptSize(input.prompt);
  return {
    version: ENVELOPE_VERSION,
    agentId: input.agentId,
    runId: input.runId,
    promptSha256: promptDigest(input.prompt),
    prompt: input.prompt,
  };
}

export function serializeLocalAgentPromptEnvelope(envelope: LocalAgentPromptEnvelope): string {
  if (envelope.version !== ENVELOPE_VERSION) throw new Error("Unsupported local-agent prompt envelope version.");
  assertIdentity(envelope.agentId, envelope.runId);
  if (typeof envelope.prompt !== "string") throw new Error("prompt must be a string.");
  assertPromptSize(envelope.prompt);
  const expectedHash = promptDigest(envelope.prompt);
  if (!constantTimeStringEqual(envelope.promptSha256, expectedHash)) {
    throw new Error("Local-agent prompt envelope hash does not match the prompt.");
  }
  const serialized = JSON.stringify({
    version: ENVELOPE_VERSION,
    agentId: envelope.agentId,
    runId: envelope.runId,
    promptSha256: envelope.promptSha256,
    prompt: envelope.prompt,
  });
  if (utf8ByteLength(serialized) > MAX_ENVELOPE_BYTES) {
    throw new Error("Local-agent prompt envelope exceeds the byte limit.");
  }
  return serialized;
}

export async function readLocalAgentPromptEnvelope(
  stream: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  identity: LocalAgentPromptIdentity,
): Promise<LocalAgentPromptEnvelope> {
  assertIdentity(identity.agentId, identity.runId);
  let totalBytes = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_ENVELOPE_BYTES) throw new Error("Local-agent prompt envelope exceeds the byte limit.");
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds the byte limit")) throw error;
    throw new Error(`Unable to read local-agent prompt envelope: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid local-agent prompt envelope JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid local-agent prompt envelope.");
  }
  const record = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["version", "agentId", "runId", "promptSha256", "prompt"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid local-agent prompt envelope fields.");
  }
  const expectedKeys = ["version", "agentId", "runId", "promptSha256", "prompt"];
  if (Object.keys(record).length !== expectedKeys.length || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error("Invalid local-agent prompt envelope.");
  }
  if (record.version !== ENVELOPE_VERSION || typeof record.agentId !== "string" || typeof record.runId !== "string" ||
      typeof record.promptSha256 !== "string" || typeof record.prompt !== "string") {
    throw new Error("Invalid local-agent prompt envelope.");
  }
  const envelope = record as unknown as LocalAgentPromptEnvelope;
  assertPromptSize(envelope.prompt);
  if (!constantTimeStringEqual(envelope.agentId, identity.agentId)) throw new Error("Local-agent prompt envelope agent mismatch.");
  if (!constantTimeStringEqual(envelope.runId, identity.runId)) throw new Error("Local-agent prompt envelope run mismatch.");
  if (!constantTimeStringEqual(envelope.promptSha256, promptDigest(envelope.prompt))) {
    throw new Error("Local-agent prompt envelope hash mismatch.");
  }
  return envelope;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Write one envelope and close stdin, resolving only after the write is flushed. */
export async function writePromptEnvelope(childStdin: Writable, envelope: LocalAgentPromptEnvelope): Promise<void> {
  const payload = Buffer.from(`${serializeLocalAgentPromptEnvelope(envelope)}\n`, "utf8");
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let drainDone = true;
    let finished = false;
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      if (error) {
        settled = true;
        reject(error);
        return;
      }
      if (callbackDone && drainDone && finished) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onDrain = (): void => {
      drainDone = true;
      settle();
    };
    const onFinish = (): void => {
      finished = true;
      // `finish` means all buffered writes have been flushed; some custom
      // Writable implementations do not emit `drain` when `end()` follows
      // a back-pressured write.
      drainDone = true;
      settle();
    };
    const onError = (error: Error): void => settle(error);
    const cleanup = (): void => {
      childStdin.off("drain", onDrain);
      childStdin.off("finish", onFinish);
      childStdin.off("error", onError);
    };
    childStdin.once("drain", onDrain);
    childStdin.once("finish", onFinish);
    childStdin.once("error", onError);
    drainDone = childStdin.write(payload, (error?: Error | null) => {
      if (error) return settle(error);
      callbackDone = true;
      settle();
    });
    if (drainDone) drainDone = true;
    childStdin.end();
  });
}

const COMMON_ENVIRONMENT_KEYS = [
  "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles",
  "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
];
const DEVSPACE_ENVIRONMENT_KEYS = [
  "DEVSPACE_CONFIG_DIR", "DEVSPACE_STATE_DIR", "DEVSPACE_AGENT_DIR", "DEVSPACE_ALLOWED_ROOTS", "DEVSPACE_SUBAGENTS",
  "DEVSPACE_WORKSPACE_ID", "DEVSPACE_ROOT", "DEVSPACE_WORKSPACE_ROOT", "DEVSPACE_WORKSPACE_MODE",
  "DEVSPACE_WORKSPACE_CAPABILITY", "DEVSPACE_MODE",
];

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, key)) return env[key];
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

export function safeLocalAgentEnvironment(
  env: NodeJS.ProcessEnv,
  requiredOverrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  const keys = [
    ...COMMON_ENVIRONMENT_KEYS,
    ...(process.platform === "win32" ? ["Path"] : ["PATH"]),
    ...DEVSPACE_ENVIRONMENT_KEYS,
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const override = envValue(requiredOverrides, key);
    const value = override ?? envValue(env, key);
    if (value !== undefined) result[key] = value;
  }
  if (windows) {
    const systemRoot = envValue(requiredOverrides, "SystemRoot") ?? envValue(env, "SystemRoot");
    if (systemRoot) result.ComSpec = `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\cmd.exe`;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
