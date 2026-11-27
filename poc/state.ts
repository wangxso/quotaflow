import { Database } from 'bun:sqlite';

export type Window = { remaining: number | null; reserve: number; observed: number; reset: number };
export type Lane = { id: string; account: string; priority: number; slots: number; windows: Window[] };
export type Task = {
  id: string;
  workspace: string;
  critical: number;
  state: 'pending' | 'running' | 'waiting_quota' | 'blocked' | 'completed';
  wake: number | null;
  checkpoint: string | null;
};
export type Attempt = {
  id: number;
  task: string;
  lane: string;
  account: string;
  stage: 'running' | 'checkpoint' | 'done';
};

export class State {
  readonly db: Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL UNIQUE, critical INTEGER NOT NULL,
        state TEXT NOT NULL, wake INTEGER, checkpoint TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL REFERENCES tasks(id),
        lane TEXT NOT NULL, account TEXT NOT NULL, stage TEXT NOT NULL, settled INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_writer ON attempts(task) WHERE stage <> 'done';
      CREATE INDEX IF NOT EXISTS account_activity ON attempts(account, stage, settled);
      CREATE TABLE IF NOT EXISTS cooldown (account TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL, detail TEXT NOT NULL
      );
    `);
  }

  add(id: string, workspace: string, critical = false) {
    this.db.run('INSERT INTO tasks VALUES (?, ?, ?, ?, NULL, NULL)', [id, workspace, Number(critical), 'pending']);
  }

  get(id: string): Task {
    const task = this.db.query<Task, [string]>('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) throw new Error('Unknown task');
    return task;
  }

  active(id: string) {
    return this.db.query<Attempt, [string]>("SELECT * FROM attempts WHERE task = ? AND stage <> 'done'").get(id);
  }

  events(id: string) {
    return this.db.query<{ id: number; kind: string; detail: string }, [string]>(
      'SELECT id, kind, detail FROM events WHERE task = ? ORDER BY id',
    ).all(id);
  }

  #event(id: string, kind: string, detail: object) {
    this.db.run('INSERT INTO events (task, kind, detail) VALUES (?, ?, ?)', [id, kind, JSON.stringify(detail)]);
  }

  reserve(id: string, lanes: Lane[], now = Date.now()): Attempt | null {
    return this.db.transaction(() => {
      const task = this.get(id);
      if (task.state !== 'pending' && (task.state !== 'waiting_quota' || (task.wake ?? 0) > now)) return null;
      const prior = this.db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM attempts WHERE task = ?').get(id)!;
      if (prior.n >= 3) {
        this.db.run("UPDATE tasks SET state = 'blocked', wake = NULL WHERE id = ?", [id]);
        this.#event(id, 'blocked', { reason: 'attempt_limit' });
        return null;
      }

      const filters: { lane: string; reason: string }[] = [];
      const sorted = [...lanes].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : Number(a.id > b.id)));
      for (const lane of sorted) {
        const cool = this.db.query<{ until_ms: number }, [string]>('SELECT until_ms FROM cooldown WHERE account = ?').get(lane.account);
        const slots = this.db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM attempts WHERE account = ? AND stage <> 'done'",
        ).get(lane.account)!.n;
        let reason = cool && cool.until_ms > now ? 'cooldown' : '';
        if (!reason && slots >= lane.slots) reason = 'slots';
        if (!reason && (!lane.windows.length || lane.windows.some((w) => w.remaining === null || w.observed > now || w.reset <= now))) {
          reason = 'UNKNOWN';
        }
        if (!reason) {
          for (const window of lane.windows) {
            const spend = this.db.query<{ n: number }, [string, number]>(
              "SELECT count(*) AS n FROM attempts WHERE account = ? AND stage = 'done' AND settled >= ?",
            ).get(lane.account, window.observed)!.n;
            if (window.remaining! - spend - slots - (task.critical ? 0 : window.reserve) < 1) {
              reason = 'quota';
              break;
            }
          }
        }
        filters.push({ lane: lane.id, reason: reason || 'eligible' });
        if (reason) continue;

        const result = this.db.run('INSERT INTO attempts (task, lane, account, stage) VALUES (?, ?, ?, ?)',
          [id, lane.id, lane.account, 'running']);
        this.db.run("UPDATE tasks SET state = 'running', wake = NULL WHERE id = ?", [id]);
        this.#event(id, 'reserved', { attempt: Number(result.lastInsertRowid), lane: lane.id, filters, policy: 'phase0-priority-v1' });
        return this.active(id);
      }

      this.db.run("UPDATE tasks SET state = 'waiting_quota', wake = ? WHERE id = ?", [now + 1000, id]);
      this.#event(id, 'waiting_quota', { filters, retryAfterMs: 1000 });
      return null;
    }).immediate();
  }

  beginCheckpoint(attempt: Attempt, reason: string, activeProcesses: number) {
    if (activeProcesses !== 0) throw new Error('Worker stop has not been verified');
    return this.db.transaction(() => {
      const update = this.db.run("UPDATE attempts SET stage = 'checkpoint' WHERE id = ? AND stage = 'running'", [attempt.id]);
      if (update.changes) this.#event(attempt.task, 'checkpoint_intent', { attempt: attempt.id, reason, activeProcesses });
    }).immediate();
  }

  settle(attempt: Attempt, sha: string, next: 'pending' | 'completed', reason: string, now = Date.now()) {
    return this.db.transaction(() => {
      const update = this.db.run("UPDATE attempts SET stage = 'done', settled = ? WHERE id = ? AND stage = 'checkpoint'", [now, attempt.id]);
      if (!update.changes) return;
      if (next === 'pending') {
        this.db.run(`INSERT INTO cooldown VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET until_ms = max(until_ms, excluded.until_ms)`,
          [attempt.account, now + 300_000]);
      }
      this.db.run('UPDATE tasks SET state = ?, checkpoint = ? WHERE id = ?', [next, sha, attempt.task]);
      this.#event(attempt.task, 'checkpoint_committed', { attempt: attempt.id, sha, reason, next });
    }).immediate();
  }

  block(id: string, reason: string) {
    this.db.transaction(() => {
      const update = this.db.run("UPDATE tasks SET state = 'blocked', wake = NULL WHERE id = ? AND state NOT IN ('completed', 'blocked')", [id]);
      if (update.changes) this.#event(id, 'blocked', { reason });
    }).immediate();
  }
}
