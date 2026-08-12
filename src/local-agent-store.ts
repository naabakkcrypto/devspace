import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import type { LocalAgentWriteMode } from "./local-agent-profiles.js";
import type { WorkspaceMode } from "./workspace-store.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export const MAX_LOCAL_AGENT_RESPONSE_CHARACTERS = 64 * 1024;
export const MAX_LOCAL_AGENT_ERROR_CHARACTERS = 16 * 1024;
export const LOCAL_AGENT_HEARTBEAT_INTERVAL_MS = 10_000;
export const LOCAL_AGENT_STALE_RUN_MS = 90_000;
const TRUNCATION_MARKER = "\n[... local-agent output truncated ...]";

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

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  workspaceMode: WorkspaceMode;
  profileName: string;
  profileHash?: string;
  provider: string;
  model?: string;
  thinking?: string;
  writeMode: LocalAgentWriteMode;
  runId?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  responseTruncated: boolean;
  runtimeIdentity?: LocalAgentRuntimeIdentity;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  workspaceMode?: WorkspaceMode;
  profileName: string;
  profileHash?: string;
  provider: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  runId?: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface LocalAgentWorkspaceScope {
  workspaceId: string;
  workspaceRoot: string;
  workspaceCapability: string;
}

export interface VerifiedLocalAgentWorkspaceScope extends LocalAgentWorkspaceScope {
  workspaceRoot: string;
  workspaceMode: WorkspaceMode;
  managed: boolean;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  workspace_mode: string;
  profile_name: string;
  profile_hash: string | null;
  provider: string;
  model: string | null;
  thinking: string | null;
  write_mode: string;
  run_id: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  response_truncated: string;
  runtime_identity_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceScopeRow {
  id: string;
  root: string;
  mode: string;
  managed: string;
}

type OwnedPatch = Partial<Pick<
  LocalAgentRecord,
  | "providerSessionId"
  | "status"
  | "latestResponse"
  | "responseTruncated"
  | "runtimeIdentity"
  | "error"
>>;

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
      const canonicalRoot = canonicalWorkspaceRoot(scope.workspaceRoot);
      rows = rows.filter((row) => canonicalWorkspaceRoot(row.workspace_root) === canonicalRoot);
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
      const canonicalRoot = canonicalWorkspaceRoot(scope.workspaceRoot);
      rows = rows.filter((row) => canonicalWorkspaceRoot(row.workspace_root) === canonicalRoot);
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }
    return rows.map(rowToLocalAgentRecord);
  }

  listScoped(scope: LocalAgentWorkspaceScope): LocalAgentRecord[] {
    const verified = this.verifyWorkspaceScope(scope);
    return this.list({ workspaceId: verified.workspaceId }).filter(
      (record) => canonicalWorkspaceRoot(record.workspaceRoot) === verified.workspaceRoot,
    );
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: canonicalWorkspaceRoot(input.workspaceRoot),
      workspaceMode: input.workspaceMode ?? "checkout",
      profileName: input.profileName,
      profileHash: input.profileHash,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      writeMode: input.writeMode ?? "read_only",
      runId: input.runId,
      status: "starting",
      responseTruncated: false,
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id, workspace_id, workspace_root, workspace_mode, profile_name, profile_hash,
          provider, model, thinking, write_mode, run_id, status,
          response_truncated, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.workspaceMode,
        record.profileName,
        record.profileHash ?? null,
        record.provider,
        record.model ?? null,
        record.thinking ?? null,
        record.writeMode,
        record.runId ?? null,
        record.status,
        "false",
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  createScoped(
    scope: LocalAgentWorkspaceScope,
    input: Omit<CreateLocalAgentRecordInput, "workspaceId" | "workspaceRoot" | "workspaceMode">,
  ): LocalAgentRecord {
    const verified = this.verifyWorkspaceScope(scope);
    const writeMode = input.writeMode ?? "read_only";
    assertWriteModeAllowedForWorkspace(writeMode, verified);
    return this.create({
      ...input,
      writeMode,
      workspaceId: verified.workspaceId,
      workspaceRoot: verified.workspaceRoot,
      workspaceMode: verified.workspaceMode,
    });
  }

  /** Legacy unscoped lookup. Security-sensitive callers must use getScoped. */
  get(idOrPrefix: string): LocalAgentRecord | undefined {
    return this.findRecord(idOrPrefix);
  }

  getScoped(idOrPrefix: string, scope: LocalAgentWorkspaceScope): LocalAgentRecord | undefined {
    const verified = this.verifyWorkspaceScope(scope);
    return this.findRecord(idOrPrefix, verified);
  }

  claimRun(
    id: string,
    scope: LocalAgentWorkspaceScope,
    runId: string,
    patch: Pick<Partial<LocalAgentRecord>, "model" | "thinking"> = {},
  ): LocalAgentRecord {
    if (!runId) throw new Error("A non-empty runId is required.");
    const verified = this.verifyWorkspaceScope(scope);
    let current = this.getScoped(id, verified);
    if (!current) throw new Error(`Unknown subagent id for this workspace: ${id}`);
    if (
      current.runId &&
      (current.status === "idle" || current.status === "error" || current.status === "stopped")
    ) {
      const repair = this.database.sqlite.prepare(
        `update local_agent_sessions set run_id = null, updated_at = ?
          where id = ? and workspace_id = ? and run_id = ?
            and status in ('idle', 'error', 'stopped')
            and exists (
              select 1 from workspace_sessions w
               where w.id = ? and w.capability_token = ? and w.status = 'active'
            )`,
      ).run(
        new Date().toISOString(),
        current.id,
        verified.workspaceId,
        current.runId,
        verified.workspaceId,
        verified.workspaceCapability,
      );
      if (repair.changes === 1) current = this.getScoped(id, verified)!;
    }
    assertWriteModeAllowedForWorkspace(current.writeMode, verified);

    const claim = this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const staleBefore = new Date(Date.now() - LOCAL_AGENT_STALE_RUN_MS).toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions
            set status = 'starting', run_id = ?, model = ?, thinking = ?,
                latest_response = null, response_truncated = 'false', error = null,
                runtime_identity_json = null, updated_at = ?
          where id = ? and workspace_id = ?
            and (
              (status in ('idle', 'error', 'stopped') and run_id is null)
              or (status = 'starting' and updated_at < ?)
              or (write_mode = 'read_only' and status = 'running' and updated_at < ?)
            )
            and exists (
              select 1 from workspace_sessions w
               where w.id = ? and w.capability_token = ? and w.status = 'active'
            )`,
      ).run(
        runId,
        patch.model ?? current.model ?? null,
        patch.thinking ?? current.thinking ?? null,
        now,
        current.id,
        verified.workspaceId,
        staleBefore,
        staleBefore,
        verified.workspaceId,
        verified.workspaceCapability,
      );
      if (result.changes !== 1) {
        throw new Error(`Subagent ${current.id} is already claimed or no longer resumable.`);
      }
    });
    claim.immediate();
    return this.getScoped(current.id, verified)!;
  }

  claimWorker(id: string, scope: LocalAgentWorkspaceScope, runId: string): LocalAgentRecord {
    const verified = this.verifyWorkspaceScope(scope);
    const current = this.getScoped(id, verified);
    if (!current || current.runId !== runId) {
      throw new Error(`Subagent ${id} worker claim was rejected.`);
    }
    assertWriteModeAllowedForWorkspace(current.writeMode, verified);
    const result = this.database.sqlite.prepare(
      `update local_agent_sessions
          set status = 'running', error = null, updated_at = ?
        where id = ? and workspace_id = ?
          and run_id = ? and status = 'starting'
          and exists (
            select 1 from workspace_sessions w
             where w.id = ? and w.capability_token = ? and w.status = 'active'
          )`,
    ).run(
      new Date().toISOString(),
      id,
      verified.workspaceId,
      runId,
      verified.workspaceId,
      verified.workspaceCapability,
    );
    if (result.changes !== 1) throw new Error(`Subagent ${id} worker claim was rejected.`);
    return this.getScoped(id, verified)!;
  }

  heartbeatOwned(id: string, scope: LocalAgentWorkspaceScope, runId: string): void {
    const verified = this.verifyWorkspaceScope(scope);
    const result = this.database.sqlite.prepare(
      `update local_agent_sessions set updated_at = ?
        where id = ? and workspace_id = ? and run_id = ? and status in ('starting', 'running')
          and exists (
            select 1 from workspace_sessions w
             where w.id = ? and w.capability_token = ? and w.status = 'active'
          )`,
    ).run(
      new Date().toISOString(),
      id,
      verified.workspaceId,
      runId,
      verified.workspaceId,
      verified.workspaceCapability,
    );
    if (result.changes !== 1) throw new Error(`Subagent ${id} heartbeat was rejected.`);
  }

  adoptLegacyProfileHash(
    id: string,
    scope: LocalAgentWorkspaceScope,
    profileHash: string,
  ): LocalAgentRecord {
    if (!/^[a-f0-9]{64}$/.test(profileHash)) throw new Error("A valid profile SHA-256 is required.");
    const verified = this.verifyWorkspaceScope(scope);
    const current = this.getScoped(id, verified);
    if (!current) throw new Error(`Unknown subagent id for this workspace: ${id}`);
    if (current.profileHash) {
      if (current.profileHash !== profileHash) throw new Error(`Subagent profile changed: ${current.profileName}`);
      return current;
    }
    const staleBefore = new Date(Date.now() - LOCAL_AGENT_STALE_RUN_MS).toISOString();
    const result = this.database.sqlite.prepare(
      `update local_agent_sessions set profile_hash = ?, updated_at = ?
        where id = ? and workspace_id = ? and profile_hash is null
          and (
            (status in ('idle', 'error', 'stopped') and run_id is null)
            or (write_mode = 'read_only' and status in ('starting', 'running') and updated_at < ?)
          )
          and exists (
            select 1 from workspace_sessions w
             where w.id = ? and w.capability_token = ? and w.status = 'active'
          )`,
    ).run(
      profileHash,
      new Date().toISOString(),
      id,
      verified.workspaceId,
      staleBefore,
      verified.workspaceId,
      verified.workspaceCapability,
    );
    if (result.changes !== 1) throw new Error(`Subagent ${id} legacy profile adoption was rejected.`);
    return this.getScoped(id, verified)!;
  }

  updateOwned(id: string, scope: LocalAgentWorkspaceScope, runId: string, patch: OwnedPatch): LocalAgentRecord {
    const verified = this.verifyWorkspaceScope(scope);
    const current = this.getScoped(id, verified);
    if (!current || current.runId !== runId) {
      throw new Error(`Subagent ${id} is not owned by run ${runId}.`);
    }
    const boundedResponse = boundText(patch.latestResponse, MAX_LOCAL_AGENT_RESPONSE_CHARACTERS);
    const boundedError = boundText(patch.error, MAX_LOCAL_AGENT_ERROR_CHARACTERS);
    const terminal = patch.status === "idle" || patch.status === "error" || patch.status === "stopped";
    const responseTruncated = (patch.responseTruncated ?? current.responseTruncated) || boundedResponse.truncated;
    const updatedAt = new Date().toISOString();
    const result = this.database.sqlite.prepare(
      `update local_agent_sessions set
          provider_session_id = ?, status = ?, latest_response = ?, response_truncated = ?,
          runtime_identity_json = ?, error = ?, run_id = ?, updated_at = ?
        where id = ? and workspace_id = ? and run_id = ?
          and exists (
            select 1 from workspace_sessions w
             where w.id = ? and w.capability_token = ? and w.status = 'active'
          )`,
    ).run(
      patch.providerSessionId ?? current.providerSessionId ?? null,
      patch.status ?? current.status,
      patch.latestResponse === undefined ? current.latestResponse ?? null : boundedResponse.text ?? null,
      String(responseTruncated),
      patch.runtimeIdentity === undefined
        ? serializeRuntimeIdentity(current.runtimeIdentity)
        : serializeRuntimeIdentity(patch.runtimeIdentity),
      patch.error === undefined ? current.error ?? null : boundedError.text ?? null,
      terminal ? null : runId,
      updatedAt,
      id,
      verified.workspaceId,
      runId,
      verified.workspaceId,
      verified.workspaceCapability,
    );
    if (result.changes !== 1) throw new Error(`Subagent ${id} stale run update was rejected.`);
    return this.getScoped(id, verified)!;
  }

  /** Compatibility path for existing internal tests and migrations. */
  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);
    const hasResponse = Object.prototype.hasOwnProperty.call(patch, "latestResponse");
    const hasError = Object.prototype.hasOwnProperty.call(patch, "error");
    const response = boundText(patch.latestResponse, MAX_LOCAL_AGENT_RESPONSE_CHARACTERS);
    const error = boundText(patch.error, MAX_LOCAL_AGENT_ERROR_CHARACTERS);
    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      latestResponse: hasResponse ? response.text : current.latestResponse,
      responseTruncated: (patch.responseTruncated ?? current.responseTruncated) || response.truncated,
      error: hasError ? error.text : current.error,
      updatedAt: new Date().toISOString(),
    };
    this.writeRecord(updated);
    return updated;
  }

  verifyWorkspaceScope(scope: LocalAgentWorkspaceScope): VerifiedLocalAgentWorkspaceScope {
    if (!scope.workspaceId || !scope.workspaceCapability) {
      throw new Error("A workspace id and capability are required for subagent access.");
    }
    const workspaceRoot = canonicalWorkspaceRoot(scope.workspaceRoot);
    const row = this.database.sqlite.prepare(
      `select id, root, mode, managed from workspace_sessions
        where id = ? and capability_token = ? and status = 'active'`,
    ).get(scope.workspaceId, scope.workspaceCapability) as WorkspaceScopeRow | undefined;
    if (!row || canonicalWorkspaceRoot(row.root) !== workspaceRoot) {
      throw new Error("Subagent workspace capability is invalid or expired.");
    }
    return {
      ...scope,
      workspaceRoot,
      workspaceMode: row.mode === "worktree" ? "worktree" : "checkout",
      managed: row.managed === "true",
    };
  }

  close(): void {
    this.database.close();
  }

  private findRecord(
    idOrPrefix: string,
    scope?: Pick<VerifiedLocalAgentWorkspaceScope, "workspaceId" | "workspaceRoot">,
  ): LocalAgentRecord | undefined {
    const scopeSql = scope ? " and workspace_id = ?" : "";
    const scopeArgs = scope ? [scope.workspaceId] : [];
    const exact = this.database.sqlite.prepare(
      `select * from local_agent_sessions
        where (id = ? or provider_session_id = ?)${scopeSql}
        limit 1`,
    ).get(idOrPrefix, idOrPrefix, ...scopeArgs) as LocalAgentRow | undefined;
    if (exact && (!scope || canonicalWorkspaceRoot(exact.workspace_root) === scope.workspaceRoot)) {
      return rowToLocalAgentRecord(exact);
    }
    const matches = this.database.sqlite.prepare(
      `select * from local_agent_sessions
        where (id like ? escape '\\' or provider_session_id like ? escape '\\')${scopeSql}
        order by updated_at desc`,
    ).all(`${escapeLike(idOrPrefix)}%`, `${escapeLike(idOrPrefix)}%`, ...scopeArgs) as LocalAgentRow[];
    const scopedMatches = scope
      ? matches.filter((row) => canonicalWorkspaceRoot(row.workspace_root) === scope.workspaceRoot)
      : matches;
    return scopedMatches.length === 1 ? rowToLocalAgentRecord(scopedMatches[0]!) : undefined;
  }

  private getById(id: string): LocalAgentRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_sessions where id = ?")
      .get(id) as LocalAgentRow | undefined;
    return row ? rowToLocalAgentRecord(row) : undefined;
  }

  private writeRecord(record: LocalAgentRecord): void {
    this.database.sqlite.prepare(
      `update local_agent_sessions set
        workspace_id = ?, workspace_root = ?, workspace_mode = ?, profile_name = ?, profile_hash = ?,
        provider = ?, model = ?, thinking = ?, write_mode = ?, run_id = ?, provider_session_id = ?,
        status = ?, latest_response = ?, response_truncated = ?, runtime_identity_json = ?, error = ?, updated_at = ?
       where id = ?`,
    ).run(
      record.workspaceId ?? null,
      canonicalWorkspaceRoot(record.workspaceRoot),
      record.workspaceMode,
      record.profileName,
      record.profileHash ?? null,
      record.provider,
      record.model ?? null,
      record.thinking ?? null,
      record.writeMode,
      record.runId ?? null,
      record.providerSessionId ?? null,
      record.status,
      record.latestResponse ?? null,
      String(record.responseTruncated),
      serializeRuntimeIdentity(record.runtimeIdentity),
      record.error ?? null,
      record.updatedAt,
      record.id,
    );
  }
}

export function createLocalAgentStore(config: ServerConfig): LocalAgentStore {
  return new LocalAgentStore(config.stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  const response = boundText(row.latest_response ?? undefined, MAX_LOCAL_AGENT_RESPONSE_CHARACTERS);
  const error = boundText(row.error ?? undefined, MAX_LOCAL_AGENT_ERROR_CHARACTERS);
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    workspaceMode: row.workspace_mode === "worktree" ? "worktree" : "checkout",
    profileName: row.profile_name,
    profileHash: row.profile_hash ?? undefined,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    writeMode: row.write_mode === "allowed" ? "allowed" : "read_only",
    runId: row.run_id ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: response.text,
    responseTruncated: row.response_truncated === "true" || response.truncated,
    runtimeIdentity: parseRuntimeIdentity(row.runtime_identity_json),
    error: error.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readStatus(status: string): LocalAgentStatus {
  return status === "starting" || status === "running" || status === "idle" || status === "error" || status === "stopped"
    ? status
    : "error";
}

function assertWriteModeAllowedForWorkspace(
  writeMode: LocalAgentWriteMode,
  workspace: Pick<VerifiedLocalAgentWorkspaceScope, "workspaceMode" | "managed">,
): void {
  if (writeMode === "allowed" && (workspace.workspaceMode !== "worktree" || !workspace.managed)) {
    throw new Error("Writable subagents require a managed DevSpace worktree workspace.");
  }
}

function boundText(value: string | undefined, maximum: number): { text?: string; truncated: boolean } {
  if (value === undefined || value.length <= maximum) return { text: value, truncated: false };
  const keep = safeUtf16SliceEnd(value, Math.max(0, maximum - TRUNCATION_MARKER.length));
  return { text: `${value.slice(0, keep)}${TRUNCATION_MARKER}`, truncated: true };
}

function safeUtf16SliceEnd(value: string, proposedEnd: number): number {
  if (proposedEnd <= 0 || proposedEnd >= value.length) return proposedEnd;
  const previous = value.charCodeAt(proposedEnd - 1);
  const next = value.charCodeAt(proposedEnd);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? proposedEnd - 1
    : proposedEnd;
}

function canonicalWorkspaceRoot(root: string): string {
  const resolved = resolve(root);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // New or temporarily unavailable roots still receive deterministic lexical normalization.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function serializeRuntimeIdentity(identity: LocalAgentRuntimeIdentity | undefined): string | null {
  return identity ? JSON.stringify(identity) : null;
}

function parseRuntimeIdentity(value: string | null): LocalAgentRuntimeIdentity | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as LocalAgentRuntimeIdentity;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
