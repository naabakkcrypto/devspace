import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalAgentExecutionRoot } from "./local-agent-execution-root.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "devspace-agent-execution-root-"));
try {
  const workspaceRoot = join(fixtureRoot, "workspace");
  const nestedRepository = join(workspaceRoot, "nested-repository");
  const outsideRoot = join(fixtureRoot, "outside");
  mkdirSync(nestedRepository, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });

  assert.equal(
    resolveLocalAgentExecutionRoot(workspaceRoot, nestedRepository),
    realpathSync.native(nestedRepository),
  );
  assert.equal(
    resolveLocalAgentExecutionRoot(workspaceRoot, workspaceRoot),
    realpathSync.native(workspaceRoot),
  );
  assert.throws(
    () => resolveLocalAgentExecutionRoot(workspaceRoot, outsideRoot),
    /outside the active DevSpace workspace/,
  );

  const escape = join(workspaceRoot, "escape");
  try {
    symlinkSync(outsideRoot, escape, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => resolveLocalAgentExecutionRoot(workspaceRoot, escape),
      /outside the active DevSpace workspace/,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
