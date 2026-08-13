import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { fingerprintWorkspaceContext } from "./context-integrity.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("disabling subagents preserves all inline context except delegation-only data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-context-parity-"));
  const project = join(root, "project");
  const nested = join(project, "nested");
  const agentDir = join(root, ".codex");
  const skillsDir = join(agentDir, "skills");
  await mkdir(join(skillsDir, "ordinary-skill"), { recursive: true });
  await mkdir(join(skillsDir, "subagent-delegation"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(nested, "AGENTS.md"), "nested instructions\n");
  await writeFile(
    join(skillsDir, "ordinary-skill", "SKILL.md"),
    "---\nname: ordinary-skill\ndescription: Ordinary inline skill.\n---\n\n# Ordinary\n",
  );
  await writeFile(
    join(skillsDir, "subagent-delegation", "SKILL.md"),
    "---\nname: subagent-delegation\ndescription: Delegation only.\n---\n\n# Delegate\n",
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const env = {
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILLS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  };
  const enabled = await new WorkspaceRegistry(loadConfig({ ...env, DEVSPACE_SUBAGENTS: "1" }))
    .openWorkspace(project);
  const disabledConfig = loadConfig({ ...env, DEVSPACE_SUBAGENTS: "0" });
  const disabled = await new WorkspaceRegistry(disabledConfig).openWorkspace(project);
  const enabledFingerprint = await fingerprintWorkspaceContext(enabled, loadConfig({ ...env, DEVSPACE_SUBAGENTS: "1" }));
  const disabledFingerprint = await fingerprintWorkspaceContext(disabled, disabledConfig);

  assert.deepEqual(disabledFingerprint.instructions, enabledFingerprint.instructions);
  assert.deepEqual(disabledFingerprint.availableInstructions, enabledFingerprint.availableInstructions);
  assert.deepEqual(
    disabledFingerprint.skills,
    enabledFingerprint.skills.filter((skill) => skill.name !== "subagent-delegation"),
  );
  assert.equal(disabledFingerprint.skills.some((skill) => skill.name === "ordinary-skill"), true);
  assert.equal(disabledFingerprint.subagentProfiles, 0);
  assert.equal(disabledFingerprint.posture.subagentsEnabled, false);
  assert.match(disabledFingerprint.aggregateSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(disabledFingerprint).includes(root), false);
  assert.equal(JSON.stringify(disabledFingerprint).includes("global instructions"), false);
});
