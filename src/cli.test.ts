import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({
    id: "ws_current",
    root: projectRoot,
    capabilityToken: "cap-current",
  });
  workspaceStore.createSession({
    id: "ws_other",
    root: projectRoot,
    capabilityToken: "cap-other",
  });
  workspaceStore.close();
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  const waiting = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "running" },
  );
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_WORKSPACE_CAPABILITY: "cap-current",
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex requested_model=gpt-5\\.4 requested_thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));
  assert.match(output, /requested_write=read_only/);

  const currentEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKSPACE_ID: "ws_current",
    DEVSPACE_WORKSPACE_ROOT: projectRoot,
    DEVSPACE_WORKSPACE_CAPABILITY: "cap-current",
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
  assert.throws(
    () => execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "show", other.id], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: currentEnv,
      stdio: "pipe",
    }),
    /Unknown subagent id/,
  );
  assert.throws(
    () => execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "wait", current.id, other.id], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: currentEnv,
      stdio: "pipe",
    }),
    /Unknown subagent id/,
  );
  assert.throws(
    () => execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "wait"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: currentEnv,
      stdio: "pipe",
    }),
    /Usage: devspace agents wait <id> \[<id> \.\.\.\]/,
  );

  const waitChild = spawn("node", [
    "--import", "tsx", "src/cli.ts", "agents", "wait", current.id, waiting.id, current.id,
  ], {
    cwd: process.cwd(),
    env: currentEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const waitOutput = collectChildOutput(waitChild);
  const waitCompletion = waitForExit(waitChild, waitOutput);
  await waitForOutput(waitOutput, new RegExp(`${waiting.id} running`));
  const transitionStore = new LocalAgentStore(stateDir);
  transitionStore.update(waiting.id, { status: "idle", latestResponse: "private final response" });
  transitionStore.close();
  const waitResult = await waitCompletion;
  assert.equal(waitResult.code, 0, waitResult.stderr);
  assert.equal((waitResult.stdout.match(new RegExp(`${current.id} idle`, "g")) ?? []).length, 1);
  assert.match(waitResult.stdout, new RegExp(`${waiting.id} running`));
  assert.match(waitResult.stdout, new RegExp(`${waiting.id} idle`));
  assert.match(waitResult.stdout, /Barrier complete: 2\/2 terminal \(idle=2, error=0, stopped=0\)\./);
  assert.doesNotMatch(waitResult.stdout, /private final response/);
  assert.throws(
    () => execFileSync("node", [
      "--import", "tsx", "src/cli.ts", "agents", "__worker", current.id,
      "--prompt-file", "C:/Windows/System32",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: currentEnv,
      stdio: "pipe",
    }),
    /Usage: devspace agents __worker/,
  );

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

interface CollectedChildOutput {
  stdout: string;
  stderr: string;
  listeners: Set<() => void>;
}

function collectChildOutput(child: ChildProcess): CollectedChildOutput {
  const collected: CollectedChildOutput = { stdout: "", stderr: "", listeners: new Set() };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    collected.stdout += chunk;
    for (const listener of collected.listeners) listener();
  });
  child.stderr?.on("data", (chunk: string) => {
    collected.stderr += chunk;
    for (const listener of collected.listeners) listener();
  });
  return collected;
}

async function waitForOutput(collected: CollectedChildOutput, pattern: RegExp): Promise<void> {
  if (pattern.test(collected.stdout)) return;
  await new Promise<void>((resolveWait, rejectWait) => {
    const deadline = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`Timed out waiting for ${pattern}. stdout=${collected.stdout} stderr=${collected.stderr}`));
    }, 10_000);
    const onOutput = (): void => {
      if (!pattern.test(collected.stdout)) return;
      cleanup();
      resolveWait();
    };
    const cleanup = (): void => {
      clearTimeout(deadline);
      collected.listeners.delete(onOutput);
    };
    collected.listeners.add(onOutput);
  });
}

async function waitForExit(
  child: ChildProcess,
  collected: CollectedChildOutput,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    const deadline = setTimeout(() => {
      child.kill();
      rejectExit(new Error(`Timed out waiting for child exit. stdout=${collected.stdout} stderr=${collected.stderr}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      rejectExit(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(deadline);
      resolveExit(exitCode);
    });
  });
  return { code, stdout: collected.stdout, stderr: collected.stderr };
}
