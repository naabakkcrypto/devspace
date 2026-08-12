import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-safety",
    up: migrateLocalAgentSafety,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentSafety(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "workspace_sessions", "capability_token", "text");
  sqlite.exec(`
    update workspace_sessions
       set capability_token = lower(hex(randomblob(32)))
     where capability_token is null or capability_token = '';
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "write_mode", "text not null default 'read_only'");
  addColumnIfMissing(sqlite, "local_agent_sessions", "workspace_mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "local_agent_sessions", "profile_hash", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "run_id", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "runtime_identity_json", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "response_truncated", "text not null default 'false'");
  sqlite.exec(`
    update local_agent_sessions
       set latest_response = substr(latest_response, 1, 65496) || char(10) || '[... local-agent output truncated ...]',
           response_truncated = 'true'
     where latest_response is not null and length(latest_response) > 65536;

    update local_agent_sessions
       set error = substr(error, 1, 16384)
     where error is not null and length(error) > 16384;
  `);

  const writerRootExpression = process.platform === "win32"
    ? "lower(workspace_root)"
    : "workspace_root";
  const duplicateWriterRoots = sqlite.prepare(
    `select ${writerRootExpression} as root_key
       from local_agent_sessions
      where write_mode = 'allowed' and status in ('starting', 'running')
      group by ${writerRootExpression}
     having count(*) > 1`,
  ).all() as Array<{ root_key: string }>;
  const stopDuplicateWriters = sqlite.prepare(
    `update local_agent_sessions
        set status = 'error', run_id = null,
            error = 'Migration stopped conflicting active writable sessions; verify the worktree before retrying.',
            updated_at = ?
      where ${writerRootExpression} = ?
        and write_mode = 'allowed' and status in ('starting', 'running')`,
  );
  const reconciliationTime = new Date().toISOString();
  for (const duplicate of duplicateWriterRoots) {
    stopDuplicateWriters.run(reconciliationTime, duplicate.root_key);
  }

  sqlite.exec(`
    create index if not exists local_agent_sessions_run_id_idx
      on local_agent_sessions(run_id);

    create unique index if not exists local_agent_sessions_active_writer_root_uidx
      on local_agent_sessions(${writerRootExpression})
      where write_mode = 'allowed' and status in ('starting', 'running');
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
