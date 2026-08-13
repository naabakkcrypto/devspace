import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import {
  LOCAL_AGENT_STALE_RUN_MS,
  LocalAgentStore,
  MAX_LOCAL_AGENT_RESPONSE_CHARACTERS,
} from "./local-agent-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const store = new LocalAgentStore(root);
  stores.push(store);
  const workspaceStore = new SqliteWorkspaceStore(root);
  workspaceStore.createSession({
    id: "ws_1",
    root: join(root, "project"),
    capabilityToken: "cap-1",
  });
  workspaceStore.createSession({
    id: "ws_other",
    root: join(root, "other"),
    capabilityToken: "cap-other",
  });
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
    thinking: "high",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(store.get(created.id)?.thinking, "high");
  assert.equal(store.get(created.id)?.profileName, "reviewer");
  assert.equal(store.get(created.id.slice(0, 7))?.id, created.id);

  const updated = store.update(created.id, {
    status: "idle",
    latestResponse: "done",
    providerSessionId: "thread_123",
    thinking: "medium",
  });

  assert.equal(updated.status, "idle");
  assert.equal(updated.thinking, "medium");
  assert.equal(store.get("thread_123")?.id, created.id);
  assert.equal(store.get(created.id)?.thinking, "medium");
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
  assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
  assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
  assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);
  const secureScope = {
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    workspaceCapability: "cap-1",
  };
  assert.equal(store.getScoped(created.id, secureScope)?.id, created.id);
  const adoptedLegacy = store.adoptLegacyProfileHash(created.id, secureScope, "a".repeat(64));
  assert.equal(adoptedLegacy.profileHash, "a".repeat(64));
  assert.equal(store.adoptLegacyProfileHash(created.id, secureScope, "a".repeat(64)).profileHash, "a".repeat(64));
  assert.throws(
    () => store.adoptLegacyProfileHash(created.id, secureScope, "b".repeat(64)),
    /profile changed/,
  );
  if (process.platform === "win32") {
    assert.equal(
      store.getScoped(created.id, {
        ...secureScope,
        workspaceRoot: secureScope.workspaceRoot.toUpperCase(),
      })?.id,
      created.id,
    );
  }
  assert.throws(
    () => store.getScoped(created.id, { ...secureScope, workspaceCapability: "cap-other" }),
    /capability is invalid/,
  );
  assert.equal(
    store.getScoped(created.id, {
      workspaceId: "ws_other",
      workspaceRoot: join(root, "other"),
      workspaceCapability: "cap-other",
    }),
    undefined,
  );

  const otherStore = new LocalAgentStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, createdFromOtherStore.id].sort(),
  );

  const claimedId = "run-one";
  const firstClaim = store.claimRun(created.id, secureScope, claimedId);
  assert.equal(firstClaim.runId, claimedId);
  assert.equal(firstClaim.status, "starting");
  assert.throws(
    () => otherStore.claimRun(created.id, secureScope, "run-two"),
    /already claimed|no longer resumable/,
  );
  store.claimWorker(created.id, secureScope, claimedId, 10_001);
  assert.equal(store.getScoped(created.id, secureScope)?.workerPid, 10_001);
  const huge = "x".repeat(MAX_LOCAL_AGENT_RESPONSE_CHARACTERS * 2);
  const completed = store.updateOwned(created.id, secureScope, claimedId, {
    status: "idle",
    latestResponse: huge,
  });
  assert.equal(completed.runId, undefined);
  assert.equal(completed.responseTruncated, true);
  assert.ok((completed.latestResponse?.length ?? 0) <= MAX_LOCAL_AGENT_RESPONSE_CHARACTERS);
  assert.match(completed.latestResponse ?? "", /truncated/);
  assert.throws(
    () => store.updateOwned(created.id, secureScope, claimedId, { status: "error" }),
    /not owned/,
  );

  const rollbackCompatible = store.update(
    store.create({
      workspaceId: "ws_1",
      workspaceRoot: join(root, "project"),
      profileName: "rollback-compatible",
      provider: "codex",
      runId: "v5-active-run",
    }).id,
    {
      status: "idle",
      latestResponse: "legacy-old-binary-response",
    },
  );
  const rollbackSqlite = new Database(databasePath(root));
  rollbackSqlite.prepare(
    "update local_agent_sessions set run_id = ?, latest_response = ?, error = ? where id = ?",
  ).run(
    "v5-active-run",
    "r".repeat(MAX_LOCAL_AGENT_RESPONSE_CHARACTERS * 2),
    "e".repeat(32 * 1024),
    rollbackCompatible.id,
  );
  rollbackSqlite.close();
  const rollbackRead = store.getScoped(rollbackCompatible.id, secureScope)!;
  assert.equal(rollbackRead.responseTruncated, true);
  assert.ok((rollbackRead.latestResponse?.length ?? 0) <= MAX_LOCAL_AGENT_RESPONSE_CHARACTERS);
  assert.ok((rollbackRead.error?.length ?? 0) <= 16 * 1024);
  const rollbackReclaimed = store.claimRun(
    rollbackCompatible.id,
    secureScope,
    "post-rollback-run",
  );
  assert.equal(rollbackReclaimed.runId, "post-rollback-run");
  store.claimWorker(rollbackCompatible.id, secureScope, "post-rollback-run", 10_002);
  store.updateOwned(rollbackCompatible.id, secureScope, "post-rollback-run", { status: "idle" });

  const staleReader = store.createScoped(secureScope, {
    profileName: "stale-reader",
    provider: "codex",
    writeMode: "read_only",
    runId: "stale-reader-one",
  });
  store.claimWorker(staleReader.id, secureScope, "stale-reader-one", 10_003);
  assert.equal(store.heartbeatOwned(staleReader.id, secureScope, "stale-reader-one"), false);
  assert.throws(
    () => otherStore.claimRun(staleReader.id, secureScope, "stale-reader-fresh"),
    /already claimed|no longer resumable/,
  );
  const staleSqlite = new Database(databasePath(root));
  staleSqlite.prepare("update local_agent_sessions set updated_at = ? where id = ?").run(
    new Date(Date.now() - LOCAL_AGENT_STALE_RUN_MS - 1_000).toISOString(),
    staleReader.id,
  );
  staleSqlite.close();
  const reclaimedReader = otherStore.claimRun(staleReader.id, secureScope, "stale-reader-two");
  assert.equal(reclaimedReader.runId, "stale-reader-two");
  otherStore.claimWorker(staleReader.id, secureScope, "stale-reader-two", 10_004);
  otherStore.updateOwned(staleReader.id, secureScope, "stale-reader-two", { status: "idle" });

  const legacyUnsafeWriter = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    workspaceMode: "checkout",
    profileName: "legacy-unsafe-writer",
    provider: "codex",
    writeMode: "allowed",
    runId: "legacy-unsafe-writer",
  });
  assert.throws(
    () => store.claimWorker(legacyUnsafeWriter.id, secureScope, "legacy-unsafe-writer", 10_006),
    /managed DevSpace worktree/,
  );
  store.update(legacyUnsafeWriter.id, { status: "error", runId: undefined });

  const worktreeRoot = join(root, "managed-worktree");
  workspaceStore.createSession({
    id: "ws_worktree",
    root: worktreeRoot,
    mode: "worktree",
    managed: true,
    capabilityToken: "cap-worktree",
  });
  const worktreeScope = {
    workspaceId: "ws_worktree",
    workspaceRoot: worktreeRoot,
    workspaceCapability: "cap-worktree",
  };
  const writerOne = store.createScoped(worktreeScope, {
    profileName: "writer",
    provider: "codex",
    writeMode: "allowed",
    runId: "writer-one",
  });
  assert.throws(
    () => store.claimRun(writerOne.id, worktreeScope, "writer-too-soon"),
    /already claimed|no longer resumable/,
  );
  const writerSqlite = new Database(databasePath(root));
  writerSqlite.prepare("update local_agent_sessions set updated_at = ? where id = ?").run(
    new Date(Date.now() - LOCAL_AGENT_STALE_RUN_MS - 1_000).toISOString(),
    writerOne.id,
  );
  writerSqlite.close();
  const reclaimedWriter = store.claimRun(writerOne.id, worktreeScope, "writer-reclaimed-before-start");
  assert.equal(reclaimedWriter.runId, "writer-reclaimed-before-start");
  assert.throws(
    () => otherStore.createScoped(worktreeScope, {
      profileName: "writer-two",
      provider: "codex",
      writeMode: "allowed",
      runId: "writer-two",
    }),
    /UNIQUE constraint failed/,
  );
  store.claimWorker(writerOne.id, worktreeScope, "writer-reclaimed-before-start", 10_005);
  assert.equal(store.getScoped(writerOne.id, worktreeScope)?.workerPid, 10_005);
  store.markProviderStarted(writerOne.id, worktreeScope, "writer-reclaimed-before-start");
  assert.equal(store.getScoped(writerOne.id, worktreeScope)?.providerStarted, true);
  const stopRequested = store.requestStop(writerOne.id, worktreeScope);
  assert.equal(stopRequested.stopRequested, true);
  assert.equal(
    store.heartbeatOwned(writerOne.id, worktreeScope, "writer-reclaimed-before-start"),
    true,
  );
  const runningWriterSqlite = new Database(databasePath(root));
  runningWriterSqlite.prepare("update local_agent_sessions set updated_at = ? where id = ?").run(
    new Date(Date.now() - LOCAL_AGENT_STALE_RUN_MS - 1_000).toISOString(),
    writerOne.id,
  );
  runningWriterSqlite.close();
  assert.throws(
    () => store.recoverInterruptedWriter(writerOne.id, worktreeScope, () => true),
    /still alive/,
  );
  assert.throws(
    () => store.claimRun(writerOne.id, worktreeScope, "unsafe-writer-reclaim"),
    /already claimed|no longer resumable/,
  );
  const quarantinedWriter = store.recoverInterruptedWriter(
    writerOne.id,
    worktreeScope,
    () => false,
  );
  assert.equal(quarantinedWriter.status, "quarantined");
  assert.equal(quarantinedWriter.runId, undefined);
  assert.equal(quarantinedWriter.providerStarted, true);
  assert.throws(
    () => otherStore.createScoped(worktreeScope, {
      profileName: "quarantine-conflict",
      provider: "codex",
      writeMode: "allowed",
      runId: "quarantine-conflict",
    }),
    /UNIQUE constraint failed/,
  );
  store.update(writerOne.id, {
    status: "error",
    runId: undefined,
    workerPid: undefined,
    stopRequested: false,
    providerStarted: false,
  });

  const preProviderWriter = store.createScoped(worktreeScope, {
    profileName: "pre-provider-writer",
    provider: "codex",
    writeMode: "allowed",
    runId: "pre-provider-writer",
  });
  store.claimWorker(preProviderWriter.id, worktreeScope, "pre-provider-writer", 10_007);
  const preProviderSqlite = new Database(databasePath(root));
  preProviderSqlite.prepare("update local_agent_sessions set updated_at = ? where id = ?").run(
    new Date(Date.now() - LOCAL_AGENT_STALE_RUN_MS - 1_000).toISOString(),
    preProviderWriter.id,
  );
  preProviderSqlite.close();
  const recoveredWriter = store.recoverInterruptedWriter(
    preProviderWriter.id,
    worktreeScope,
    () => false,
  );
  assert.equal(recoveredWriter.status, "stopped");
  assert.equal(recoveredWriter.runId, undefined);
  assert.equal(recoveredWriter.workerPid, undefined);
  assert.equal(recoveredWriter.stopRequested, false);
  assert.match(recoveredWriter.error ?? "", /worktree preserved/);
  const writerTwo = otherStore.createScoped(worktreeScope, {
    profileName: "writer-two",
    provider: "codex",
    writeMode: "allowed",
    runId: "writer-two",
  });
  assert.equal(writerTwo.status, "starting");
  assert.throws(
    () => store.createScoped(secureScope, {
      profileName: "checkout-writer",
      provider: "codex",
      writeMode: "allowed",
      runId: "checkout-writer",
    }),
    /managed DevSpace worktree/,
  );
  workspaceStore.close();

  testLegacyMigrationDefaults(join(root, "legacy"));
  testDuplicateWriterMigration(join(root, "duplicate-writers"));
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}

function testLegacyMigrationDefaults(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const sqlite = new Database(databasePath(stateDir));
  sqlite.exec(`
    create table devspace_schema_migrations (version integer primary key, name text not null, applied_at text not null);
    insert into devspace_schema_migrations values (1, 'workspace-state', 'now');
    insert into devspace_schema_migrations values (2, 'oauth-state', 'now');
    insert into devspace_schema_migrations values (3, 'local-agent-sessions', 'now');
    insert into devspace_schema_migrations values (4, 'workspace-conversation-bindings', 'now');
    create table workspace_sessions (
      id text primary key, root text not null, status text not null default 'active',
      mode text not null default 'checkout', source_root text, base_ref text, base_sha text,
      managed text not null default 'false', created_at text not null, last_used_at text not null
    );
    insert into workspace_sessions values ('legacy-ws', 'C:/legacy', 'active', 'checkout', null, null, null, 'false', 'now', 'now');
    create table local_agent_sessions (
      id text primary key, workspace_id text, workspace_root text not null, profile_name text not null,
      provider text not null, model text, thinking text, provider_session_id text, status text not null,
      latest_response text, error text, created_at text not null, updated_at text not null
    );
    insert into local_agent_sessions values ('agt_legacy', 'legacy-ws', 'C:/legacy', 'reviewer', 'codex', null, null, null, 'idle', null, null, 'now', 'now');
  `);
  sqlite.close();
  const migrated = new LocalAgentStore(stateDir);
  try {
    const record = migrated.get("agt_legacy");
    assert.equal(record?.writeMode, "read_only");
    assert.equal(record?.workspaceMode, "checkout");
    assert.equal(record?.responseTruncated, false);
    assert.equal(record?.profileHash, undefined);
    assert.equal(record?.workerPid, undefined);
    assert.equal(record?.stopRequested, false);
    assert.equal(record?.providerStarted, false);
  } finally {
    migrated.close();
  }
}

function testDuplicateWriterMigration(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const sqlite = new Database(databasePath(stateDir));
  sqlite.exec(`
    create table devspace_schema_migrations (version integer primary key, name text not null, applied_at text not null);
    insert into devspace_schema_migrations values (1, 'workspace-state', 'now');
    insert into devspace_schema_migrations values (2, 'oauth-state', 'now');
    insert into devspace_schema_migrations values (3, 'local-agent-sessions', 'now');
    insert into devspace_schema_migrations values (4, 'workspace-conversation-bindings', 'now');
    create table workspace_sessions (
      id text primary key, root text not null, status text not null default 'active',
      mode text not null default 'worktree', source_root text, base_ref text, base_sha text,
      managed text not null default 'true', created_at text not null, last_used_at text not null
    );
    insert into workspace_sessions values ('legacy-ws', 'C:/legacy-worktree', 'active', 'worktree', null, null, null, 'true', 'now', 'now');
    create table local_agent_sessions (
      id text primary key, workspace_id text, workspace_root text not null, profile_name text not null,
      provider text not null, model text, thinking text, provider_session_id text, status text not null,
      latest_response text, error text, created_at text not null, updated_at text not null,
      write_mode text not null default 'read_only'
    );
    insert into local_agent_sessions values
      ('agt_writer_one', 'legacy-ws', 'C:/legacy-worktree', 'writer', 'codex', null, null, null, 'running', null, null, 'now', '2026-01-01T00:00:00.000Z', 'allowed'),
      ('agt_writer_two', 'legacy-ws', 'C:/legacy-worktree', 'writer', 'codex', null, null, null, 'starting', null, null, 'now', '2026-01-02T00:00:00.000Z', 'allowed');
  `);
  sqlite.close();
  const migrated = new LocalAgentStore(stateDir);
  try {
    const records = migrated.list({ workspaceRoot: "C:/legacy-worktree" });
    const activeWriters = records.filter(
      (record) => record.writeMode === "allowed" && ["starting", "running"].includes(record.status),
    );
    assert.equal(activeWriters.length, 0);
    assert.ok(records.every((record) => record.status === "error"));
  } finally {
    migrated.close();
  }
}
