import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadLocalAgentProfiles, summarizeLocalAgentProfile } from "./local-agent-profiles.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-test-"));

try {
  const configDir = join(root, ".devspace-home");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });

  await writeFile(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Global reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "---",
      "",
      "Global body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      'description: "Project reviewer #1."',
      "provider: claude",
      "model: sonnet",
      "thinking: high",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "disabled.md"),
    [
      "---",
      "name: disabled",
      "description: Disabled agent.",
      "provider: codex",
      "disabled: true",
      "---",
      "",
      "Disabled body.",
      "",
    ].join("\n"),
  );

  const enabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const profiles = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "reviewer");
  assert.equal(profiles[0]?.description, "Project reviewer #1.");
  assert.equal(profiles[0]?.provider, "claude");
  assert.equal(profiles[0]?.model, "sonnet");
  assert.equal(profiles[0]?.thinking, "high");
  assert.equal(profiles[0]?.writeMode, "read_only");
  assert.match(profiles[0]?.profileHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(profiles[0]?.body, "Project body.");
  const firstHash = profiles[0]?.profileHash;
  assert.deepEqual(summarizeLocalAgentProfile(profiles[0]!), {
    name: "reviewer",
    description: "Project reviewer #1.",
    provider: "claude",
    model: "sonnet",
    thinking: "high",
    writeMode: "read_only",
    profileHash: firstHash,
  });

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "writer.md"),
    [
      "---",
      "name: writer",
      "description: Explicitly writable agent.",
      "provider: codex",
      "writeMode: allowed",
      "---",
      "",
      "Writer body.",
      "",
    ].join("\n"),
  );
  const profilesWithAllowed = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profilesWithAllowed.map((profile) => profile.name), ["reviewer", "writer"]);
  assert.equal(profilesWithAllowed.find((profile) => profile.name === "writer")?.writeMode, "allowed");

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "alias.md"),
    [
      "---",
      "name: alias",
      "description: Alias writable agent.",
      "provider: codex",
      "write_mode: allowed",
      "---",
      "",
      "Alias body.",
      "",
    ].join("\n"),
  );
  const profilesWithAlias = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.equal(profilesWithAlias.find((profile) => profile.name === "alias")?.writeMode, "allowed");

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "stable.md"),
    [
      "---",
      "name: stable",
      "description: Stable hash agent.",
      "provider: codex",
      "---",
      "",
      "Stable body.",
      "",
    ].join("\n"),
  );
  const stableBefore = (await loadLocalAgentProfiles(enabledConfig, workspaceRoot)).find(
    (profile) => profile.name === "stable",
  )?.profileHash;
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "stable.md"),
    [
      "---",
      "name: stable",
      "description: Stable hash agent.",
      "provider: codex",
      "---",
      "",
      "Stable body.",
      "",
    ].join("\r\n"),
  );
  const stableAfter = (await loadLocalAgentProfiles(enabledConfig, workspaceRoot)).find(
    (profile) => profile.name === "stable",
  )?.profileHash;
  assert.equal(stableAfter, stableBefore);
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "stable.md"),
    [
      "---",
      "name: stable",
      "description: Stable hash agent.",
      "provider: codex",
      "---",
      "",
      "Changed body.",
      "",
    ].join("\n"),
  );
  const stableChanged = (await loadLocalAgentProfiles(enabledConfig, workspaceRoot)).find(
    (profile) => profile.name === "stable",
  )?.profileHash;
  assert.notEqual(stableChanged, stableAfter);

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "custom.md"),
    [
      "---",
      "name: custom",
      "description: Unsupported custom agent.",
      "provider: custom",
      "---",
      "",
      "Custom body.",
      "",
    ].join("\n"),
  );
  const profilesWithInvalid = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "invalid-number.md"),
    [
      "---",
      "name: invalid-number",
      "description: Invalid write mode.",
      "provider: codex",
      "writeMode: 1",
      "---",
      "",
      "Invalid body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "invalid-value.md"),
    [
      "---",
      "name: invalid-value",
      "description: Invalid write mode.",
      "provider: codex",
      "writeMode: full_access",
      "---",
      "",
      "Invalid body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "conflicting-mode-keys.md"),
    [
      "---",
      "name: conflicting-mode-keys",
      "description: Conflicting write modes.",
      "provider: codex",
      "writeMode: read_only",
      "write_mode: allowed",
      "---",
      "",
      "Invalid body.",
      "",
    ].join("\n"),
  );
  const profilesAfterInvalid = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(
    profilesWithInvalid.map((profile) => profile.name),
    ["alias", "reviewer", "stable", "writer"],
  );
  assert.deepEqual(
    profilesAfterInvalid.map((profile) => profile.name),
    ["alias", "reviewer", "stable", "writer"],
  );

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.deepEqual(await loadLocalAgentProfiles(disabledConfig, workspaceRoot), []);
} finally {
  await rm(root, { recursive: true, force: true });
}
