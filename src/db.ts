import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const usageSchema = `
  CREATE TABLE IF NOT EXISTS attempt_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_request_id TEXT,
    observed_at INTEGER NOT NULL,
    provider TEXT,
    provider_name TEXT,
    agent TEXT,
    session_id TEXT,
    request_model TEXT,
    served_model TEXT,
    http_status INTEGER,
    stop_reason TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost_estimate REAL,
    priced INTEGER,
    provider_invoice TEXT NOT NULL DEFAULT 'UNKNOWN'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS attempt_usage_request
    ON attempt_usage(attempt_id, source, source_request_id)
    WHERE source_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS attempt_usage_attempt ON attempt_usage(attempt_id, id);
`;

const budgetSchema = `
  CREATE TABLE IF NOT EXISTS budget_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
    account TEXT NOT NULL,
    unit TEXT NOT NULL,
    amount REAL NOT NULL,
    state TEXT NOT NULL,
    priced INTEGER,
    window_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    expired_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS budget_leases_account
    ON budget_leases(account, state, expires_at);
`;

const githubSchema = `
  CREATE TABLE IF NOT EXISTS github_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    outcome TEXT
  );
  CREATE INDEX IF NOT EXISTS github_deliveries_pull
    ON github_deliveries(repository, pull_number, received_at);

  CREATE TABLE IF NOT EXISTS github_gate_results (
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    delivery_id TEXT NOT NULL REFERENCES github_deliveries(delivery_id),
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(repository, pull_number, head_sha, policy_hash)
  );
`;

const schema = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    repo_path TEXT NOT NULL,
    workspace_path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    critical INTEGER NOT NULL,
    handoff_config TEXT,
    checkpoint TEXT,
    next_wake_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, next_wake_at, priority DESC, created_at);

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    lane_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    stage TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    actual_model TEXT,
    checkpoint TEXT,
    handoff_note TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_active_per_task
    ON attempts(task_id) WHERE stage <> 'done';
  CREATE INDEX IF NOT EXISTS attempts_account ON attempts(account, stage, ended_at);

  CREATE TABLE IF NOT EXISTS cooldowns (
    account TEXT PRIMARY KEY,
    until_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id INTEGER REFERENCES attempts(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);

  ${usageSchema}
  ${budgetSchema}
  ${githubSchema}
`;

function migrate(db: Database, action: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    action();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the migration error if SQLite already rolled back.
    }
    throw error;
  }
}

export function openDatabase(file: string): Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
  `);
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  try {
    if (version > 8) throw new Error(`Unsupported QuotaFlow database version ${version}`);
    if (version < 8) {
      migrate(db, () => {
        const current = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
        if (current > 8) throw new Error(`Unsupported QuotaFlow database version ${current}`);
        if (current === 8) return;
        if (current < 1) {
          db.exec(schema);
        } else {
          if (current < 2) db.run("ALTER TABLE tasks ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
          if (current < 3) db.run('ALTER TABLE attempts ADD COLUMN actual_model TEXT');
          if (current < 4) db.exec(usageSchema);
          if (current < 5) db.exec(budgetSchema);
          if (current < 6) {
            db.run('ALTER TABLE tasks ADD COLUMN handoff_config TEXT');
            db.run('ALTER TABLE attempts ADD COLUMN handoff_note TEXT');
          }
          if (current >= 5 && current < 7) db.run('ALTER TABLE budget_leases ADD COLUMN expired_at INTEGER');
          if (current < 8) db.exec(githubSchema);
        }
        db.run('PRAGMA user_version = 8');
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
