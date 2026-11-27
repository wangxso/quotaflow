import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db';

function createLegacyDatabase(version: 1 | 2 | 3 | 4): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), `quotaflow-db-v${version}-`));
  const file = join(root, 'state.sqlite');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      ${version >= 2 ? "prompt TEXT NOT NULL DEFAULT ''," : ''}
      repo_path TEXT NOT NULL,
      workspace_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      critical INTEGER NOT NULL,
      checkpoint TEXT,
      next_wake_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      stage TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      ${version >= 3 ? 'actual_model TEXT,' : ''}
      checkpoint TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    ${version === 4 ? `
      CREATE TABLE attempt_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_request_id TEXT,
        observed_at INTEGER NOT NULL
      );
    ` : ''}
    PRAGMA user_version = ${version};
  `);
  if (version === 1) {
    db.run(`
      INSERT INTO tasks
        (id, title, repo_path, workspace_path, status, priority, critical, created_at, updated_at)
      VALUES ('legacy', 'legacy', 'repo', 'workspace', 'queued', 0, 0, 1, 1)
    `);
  } else {
    db.run(`
      INSERT INTO tasks
        (id, title, prompt, repo_path, workspace_path, status, priority, critical, created_at, updated_at)
      VALUES ('legacy', 'legacy', 'kept prompt', 'repo', 'workspace', 'queued', 0, 0, 1, 1)
    `);
  }
  db.run(`
    INSERT INTO attempts
      (task_id, lane_id, agent, model, provider, account, stage, lease_token, started_at)
    VALUES ('legacy', 'lane', 'codex', 'model', 'local', 'account', 'done', 'lease', 1)
  `);
  db.close();
  return { root, file };
}

for (const version of [1, 2, 3, 4] as const) {
  test(`migrates schema v${version} to v5 without losing task data`, () => {
    const { root, file } = createLegacyDatabase(version);
    const db = openDatabase(file);
    try {
      expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(5);
      expect(db.query<{ prompt: string }, []>("SELECT prompt FROM tasks WHERE id = 'legacy'").get()?.prompt)
        .toBe(version === 1 ? '' : 'kept prompt');
      expect(db.query<{ actual_model: string | null }, []>(
        "SELECT actual_model FROM attempts WHERE task_id = 'legacy'",
      ).get()?.actual_model).toBeNull();
      expect(db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempt_usage'",
      ).get()?.name).toBe('attempt_usage');
      expect(db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'budget_leases'",
      ).get()?.name).toBe('budget_leases');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
