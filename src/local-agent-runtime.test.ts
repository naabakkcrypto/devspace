import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import {
  CodexSdkLocalAgentRuntime,
  createIsolatedCodexEnvironment,
  createCodexSdkLocalAgentRuntime,
  MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS,
  resolvePreferredCodexExecutable,
  truncateLocalAgentText,
} from "./local-agent-runtime.js";

class FakeThread {
  prompts: string[] = [];
  responseForPrompt = (prompt: string) => `response:${prompt}`;

  constructor(readonly id: string | null) {}

  async runStreamed(prompt: string): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.prompts.push(prompt);
    const response = this.responseForPrompt(prompt);
    return {
      events: (async function* (): AsyncGenerator<ThreadEvent> {
        yield {
          type: "item.completed",
          item: { id: "message-1", type: "agent_message", text: response },
        };
      })(),
    };
  }
}

class FakeCodex {
  started: ThreadOptions[] = [];
  resumed: Array<{ id: string; options?: ThreadOptions }> = [];
  readonly startThreadInstance = new FakeThread("new-thread");
  readonly resumeThreadInstance = new FakeThread("resumed-thread");

  startThread(options?: ThreadOptions): FakeThread {
    this.started.push(options ?? {});
    return this.startThreadInstance;
  }

  resumeThread(id: string, options?: ThreadOptions): FakeThread {
    this.resumed.push({ id, options });
    return this.resumeThreadInstance;
  }
}

const codex = new FakeCodex();
const runtime = new CodexSdkLocalAgentRuntime(codex);
const readOnly = await runtime.run({
  prompt: "inspect only",
  workspace: "/tmp/project",
});

assert.equal(readOnly.provider, "codex");
assert.equal(readOnly.providerSessionId, "new-thread");
assert.equal(readOnly.finalResponse, "response:inspect only");
assert.equal(readOnly.responseTruncated, false);
assert.deepEqual(readOnly.runtimeIdentity, {
  requested: { provider: "codex", model: undefined, thinking: undefined, writeMode: "read_only" },
  adapterProvider: "codex",
  evidenceLevel: "requested_unverified",
  source: "request",
});
assert.deepEqual(codex.startThreadInstance.prompts, ["inspect only"]);
assert.deepEqual(codex.started[0], {
  workingDirectory: "/tmp/project",
  sandboxMode: "read-only",
  approvalPolicy: "never",
  model: undefined,
  modelReasoningEffort: undefined,
});

await runtime.run({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
});

assert.deepEqual(codex.started[1], {
  workingDirectory: "/tmp/project",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  model: "gpt-5.4",
  modelReasoningEffort: "high",
});

const resumed = await runtime.run({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "read_only",
});

assert.equal(resumed.providerSessionId, "resumed-thread");
assert.deepEqual(codex.resumeThreadInstance.prompts, ["continue"]);
assert.deepEqual(codex.resumed, [
  {
    id: "existing-thread",
    options: {
      workingDirectory: "/tmp/project",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      model: undefined,
      modelReasoningEffort: undefined,
    },
  },
]);

const created = await createCodexSdkLocalAgentRuntime(undefined, () => new FakeCodex());
assert.equal(created.provider, "codex");

const hugeCodex = new FakeCodex();
hugeCodex.startThreadInstance.responseForPrompt = () =>
  "x".repeat(MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS * 2);
const hugeResult = await new CodexSdkLocalAgentRuntime(hugeCodex).run({
  prompt: "large",
  workspace: "/tmp/project",
});
assert.equal(hugeResult.responseTruncated, true);
assert.equal(hugeResult.finalResponse.length, MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS);
assert.match(hugeResult.finalResponse, /truncated/);

const emojiBounded = truncateLocalAgentText(
  "😀".repeat(MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS),
  MAX_LOCAL_AGENT_FINAL_RESPONSE_CHARACTERS,
);
assert.equal(emojiBounded.truncated, true);
assert.doesNotMatch(emojiBounded.text, /[\uD800-\uDBFF](?=\n\[\.\.\.)/u);
assert.equal(Buffer.from(emojiBounded.text, "utf8").toString("utf8"), emojiBounded.text);

const isolatedHomeFixture = mkdtempSync(join(tmpdir(), "devspace-codex-home-test-"));
try {
  const sourceCodexHome = join(isolatedHomeFixture, ".codex");
  const sourceAuth = join(sourceCodexHome, "auth.json");
  mkdirSync(sourceCodexHome);
  writeFileSync(sourceAuth, "test-auth-only", { encoding: "utf8", flag: "wx" });
  const isolated = createIsolatedCodexEnvironment(
    {
      HOME: isolatedHomeFixture,
      PATH: process.env.PATH,
      DEVSPACE_WORKSPACE_CAPABILITY: "must-not-reach-provider",
      OPENAI_API_KEY: "must-not-reach-provider",
    },
    sourceCodexHome,
  );
  const isolatedAuth = join(isolated.home, "auth.json");
  assert.notEqual(isolated.home, sourceCodexHome);
  assert.equal(readFileSync(isolatedAuth, "utf8"), "test-auth-only");
  assert.equal(statSync(isolatedAuth).ino, statSync(sourceAuth).ino);
  assert.equal(isolated.env.CODEX_HOME, isolated.home);
  assert.equal(isolated.env.DEVSPACE_WORKSPACE_CAPABILITY, undefined);
  assert.equal(isolated.env.OPENAI_API_KEY, undefined);
  await isolated.dispose();
  assert.equal(existsSync(isolated.home), false);
  assert.equal(existsSync(sourceAuth), true);
} finally {
  rmSync(isolatedHomeFixture, { recursive: true, force: true });
}

const executableFixture = mkdtempSync(join(tmpdir(), "devspace-codex-executable-test-"));
try {
  const oldDirectory = join(executableFixture, "OpenAI", "Codex", "bin", "old");
  const newDirectory = join(executableFixture, "OpenAI", "Codex", "bin", "new");
  mkdirSync(oldDirectory, { recursive: true });
  mkdirSync(newDirectory, { recursive: true });
  const oldExecutable = join(oldDirectory, "codex.exe");
  const newExecutable = join(newDirectory, "codex.exe");
  writeFileSync(oldExecutable, "old");
  writeFileSync(newExecutable, "new");
  utimesSync(oldExecutable, new Date(1_000), new Date(1_000));
  utimesSync(newExecutable, new Date(2_000), new Date(2_000));
  assert.equal(
    resolvePreferredCodexExecutable({ LOCALAPPDATA: executableFixture }, "win32"),
    newExecutable,
  );
  assert.equal(resolvePreferredCodexExecutable({}, "win32"), undefined);
  assert.equal(resolvePreferredCodexExecutable({ LOCALAPPDATA: executableFixture }, "linux"), undefined);
} finally {
  rmSync(executableFixture, { recursive: true, force: true });
}
