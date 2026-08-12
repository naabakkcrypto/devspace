import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import {
  MAX_AGENT_PROMPT_BYTES,
  createLocalAgentPromptEnvelope,
  readLocalAgentPromptEnvelope,
  safeLocalAgentEnvironment,
  serializeLocalAgentPromptEnvelope,
  writePromptEnvelope,
} from "./local-agent-transport.js";

const identity = { agentId: "agent-α", runId: "run-42" };
const prompt = "fragment é🙂\nsecond line";
const envelope = createLocalAgentPromptEnvelope({ ...identity, prompt });

const roundTrip = await readLocalAgentPromptEnvelope(
  Readable.from([Buffer.from(serializeLocalAgentPromptEnvelope(envelope), "utf8").subarray(0, 5), Buffer.from(serializeLocalAgentPromptEnvelope(envelope), "utf8").subarray(5)]),
  identity,
);
assert.equal(roundTrip.prompt, prompt);
assert.equal(roundTrip.agentId, identity.agentId);

assert.throws(
  () => createLocalAgentPromptEnvelope({ ...identity, prompt: "x".repeat(MAX_AGENT_PROMPT_BYTES + 1) }),
  /byte limit/,
);
await assert.rejects(
  readLocalAgentPromptEnvelope(Readable.from([Buffer.from(JSON.stringify({ ...envelope, prompt: "x".repeat(MAX_AGENT_PROMPT_BYTES + 1) }))]), identity),
  /byte limit/,
);
await assert.rejects(readLocalAgentPromptEnvelope(Readable.from([Buffer.from(serializeLocalAgentPromptEnvelope(envelope))]), { ...identity, runId: "other" }), /run mismatch/);
await assert.rejects(readLocalAgentPromptEnvelope(Readable.from([Buffer.from(serializeLocalAgentPromptEnvelope(envelope))]), { ...identity, agentId: "other" }), /agent mismatch/);
await assert.rejects(
  readLocalAgentPromptEnvelope(
    Readable.from([Buffer.from(JSON.stringify({ ...envelope, promptSha256: "0".repeat(64) }))]),
    identity,
  ),
  /hash mismatch/,
);

class DelayedWritable extends Writable {
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    setTimeout(callback, 10);
  }
}

const childStdin = new DelayedWritable({ highWaterMark: 1 });
await writePromptEnvelope(childStdin, envelope);
assert.equal(JSON.parse(Buffer.concat(childStdin.chunks).toString("utf8")).prompt, prompt);

const sourceEnv = {
  PATH: "safe-path",
  Path: "safe-path-windows",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  FOO: "filtered",
  OPENAI_API_KEY: "filtered",
  SECRET_TOKEN: "filtered",
  PASSWORD: "filtered",
  ComSpec: "C:\\attacker.exe",
  DEVSPACE_CONFIG_DIR: "config",
  DEVSPACE_STATE_DIR: "state",
  DEVSPACE_AGENT_DIR: "agent",
  DEVSPACE_ALLOWED_ROOTS: "roots",
  DEVSPACE_SUBAGENTS: "1",
  DEVSPACE_WORKSPACE_ID: "workspace",
  DEVSPACE_WORKSPACE_ROOT: "root",
  DEVSPACE_MODE: "read_only",
  DEVSPACE_WORKSPACE_MODE: "worktree",
  DEVSPACE_WORKSPACE_CAPABILITY: "capability",
};
const safeEnv = safeLocalAgentEnvironment(sourceEnv, { FOO: "override", DEVSPACE_MODE: "full" });
assert.equal(safeEnv.FOO, undefined);
assert.equal(safeEnv.OPENAI_API_KEY, undefined);
assert.equal(safeEnv.SECRET_TOKEN, undefined);
assert.equal(safeEnv.PASSWORD, undefined);
assert.equal(safeEnv.TEMP, sourceEnv.TEMP);
assert.equal(safeEnv.DEVSPACE_MODE, "full");
assert.equal(safeEnv.DEVSPACE_WORKSPACE_MODE, "worktree");
assert.equal(safeEnv.DEVSPACE_WORKSPACE_CAPABILITY, "capability");
if (process.platform === "win32") {
  assert.equal(safeEnv.Path, sourceEnv.Path);
  assert.equal(safeEnv.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.notEqual(safeEnv.ComSpec, sourceEnv.ComSpec);
} else {
  assert.equal(safeEnv.PATH, sourceEnv.PATH);
  assert.equal(safeEnv.ComSpec, undefined);
}

console.log("local-agent-transport tests passed");
