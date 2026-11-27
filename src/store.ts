import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type {
  Attempt,
  AttemptUsageRecord,
  BudgetAudit,
  BudgetLease,
  BudgetPolicy,
  BudgetStatus,
  EventRecord,
  HandoffOptions,
  LaneConfig,
  LaneFilter,
  Reservation,
  Task,
  TaskStatus,
  UsageReport,
} from './domain';
import { parseHandoffNote, parseHandoffOptions, type HandoffDraft, type SavedHandoff } from './handoff';
import {
  evaluateGitHubPull,
  githubEventKey,
  hashGitHubPayload,
  type GitHubDeliveryInput,
  type GitHubDeliveryRecord,
  type GitHubGateIngestInput,
  type GitHubGateIngestResult,
  type GitHubGateRecord,
  type GitHubGateResult,
} from './github';
import { usageActualModel } from './magpie-usage';

export const MAX_ATTEMPTS_PER_TASK = 3;

export interface CreateTaskInput {
  id?: string;
  title: string;
  prompt?: string;
  repoPath: string;
  workspacePath: string;
  priority?: number;
  critical?: boolean;
  handoff?: HandoffOptions;
  initialCheckpoint?: string | null;
  eventDetail?: Record<string, unknown>;
  now?: number;
}

export interface CreateTaskOnceResult {
  task: Task;
  created: boolean;
}

interface PreparedTaskInput {
  id: string;
  title: string;
  prompt: string;
  repoPath: string;
  workspacePath: string;
  priority: number;
  critical: number;
  handoff: HandoffOptions | null;
  initialCheckpoint: string | null;
  eventDetail?: Record<string, unknown>;
  now: number;
}

type TaskRow = {
  id: string;
  title: string;
  prompt: string;
  repo_path: string;
  workspace_path: string;
  status: TaskStatus;
  priority: number;
  critical: number;
  handoff_config: string | null;
  checkpoint: string | null;
  next_wake_at: number | null;
  created_at: number;
  updated_at: number;
};

type AttemptRow = {
  id: number;
  task_id: string;
  lane_id: string;
  agent: Attempt['agent'];
  model: string;
  provider: Attempt['provider'];
  account: string;
  stage: Attempt['stage'];
  lease_token: string;
  actual_model: string | null;
  checkpoint: string | null;
  started_at: number;
  ended_at: number | null;
};

type EventRow = {
  id: number;
  task_id: string;
  attempt_id: number | null;
  kind: string;
  detail: string;
  created_at: number;
};

type UsageRow = {
  id: number;
  attempt_id: number;
  source: string;
  source_request_id: string | null;
  observed_at: number;
  provider: string | null;
  provider_name: string | null;
  agent: string | null;
  session_id: string | null;
  request_model: string | null;
  served_model: string | null;
  http_status: number | null;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_estimate: number | null;
  priced: number | null;
  provider_invoice: 'UNKNOWN';
};

type BudgetRow = {
  id: number;
  attempt_id: number;
  task_id?: string;
  account: string;
  unit: string;
  amount: number;
  state: BudgetLease['state'];
  priced: number | null;
  window_ms: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  expired_at: number | null;
};

type GitHubDeliveryRow = {
  delivery_id: string;
  event_key: string;
  event_type: string;
  repository: string;
  pull_number: number;
  head_sha: string;
  payload_hash: string;
  received_at: number;
  outcome: string | null;
};

type GitHubGateRow = {
  repository: string;
  pull_number: number;
  head_sha: string;
  policy_hash: string;
  status: string;
  snapshot_hash: string;
  delivery_id: string;
  detail: string;
  created_at: number;
  updated_at: number;
};

function taskFrom(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    repoPath: row.repo_path,
    workspacePath: row.workspace_path,
    status: row.status,
    priority: row.priority,
    critical: row.critical === 1,
    ...(row.handoff_config ? { handoff: parseHandoffOptions(JSON.parse(row.handoff_config)) } : {}),
    checkpoint: row.checkpoint,
    nextWakeAt: row.next_wake_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attemptFrom(row: AttemptRow): Attempt {
  return {
    id: row.id,
    taskId: row.task_id,
    laneId: row.lane_id,
    agent: row.agent,
    model: row.model,
    provider: row.provider,
    account: row.account,
    stage: row.stage,
    leaseToken: row.lease_token,
    actualModel: row.actual_model,
    checkpoint: row.checkpoint,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function eventFrom(row: EventRow): EventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    detail: JSON.parse(row.detail) as unknown,
    createdAt: row.created_at,
  };
}

function usageFrom(row: UsageRow): AttemptUsageRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    source: row.source,
    sourceRequestId: row.source_request_id,
    observedAt: row.observed_at,
    provider: row.provider,
    providerName: row.provider_name,
    agent: row.agent,
    sessionId: row.session_id,
    requestModel: row.request_model,
    servedModel: row.served_model,
    httpStatus: row.http_status,
    stopReason: row.stop_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    costEstimate: row.cost_estimate,
    priced: row.priced === null ? null : row.priced === 1,
    providerInvoice: row.provider_invoice,
  };
}

function budgetFrom(row: BudgetRow): BudgetLease {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id ?? null,
    account: row.account,
    unit: row.unit,
    amount: row.amount,
    state: row.state,
    priced: row.priced === null ? null : row.priced === 1,
    windowMs: row.window_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    expiredAt: row.expired_at,
  };
}

function githubDeliveryFrom(row: GitHubDeliveryRow, duplicateDelivery: boolean, duplicateEvent: boolean): GitHubDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    eventKey: row.event_key,
    eventType: row.event_type,
    repository: row.repository,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    payloadHash: row.payload_hash,
    now: row.received_at,
    duplicateDelivery,
    duplicateEvent,
    outcome: row.outcome,
  };
}

function githubGateFrom(row: GitHubGateRow): GitHubGateRecord {
  return {
    repository: row.repository,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    policyHash: row.policy_hash,
    snapshotHash: row.snapshot_hash,
    deliveryId: row.delivery_id,
    evaluation: JSON.parse(row.detail) as GitHubGateResult,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function usageSummary(usage: UsageReport, actualModel?: string) {
  return {
    source: usage.source,
    status: usage.status,
    sessionId: usage.sessionId,
    rows: usage.rows.length,
    actualModel: actualModel ?? null,
    costEstimate: usage.costEstimate ?? null,
    priced: usage.priced,
    providerInvoice: usage.providerInvoice,
    ...(usage.totalRows === undefined ? {} : { totalRows: usage.totalRows }),
    ...(usage.truncated === undefined ? {} : { truncated: usage.truncated }),
    ...(usage.error === undefined ? {} : { error: usage.error }),
  };
}

interface SettlementOptions {
  handoff?: HandoffDraft;
  preserveCheckpoint?: boolean;
  detail?: Record<string, unknown>;
}

function noteForCheckpoint(checkpoint: string | null, handoff?: HandoffDraft): string | null {
  return checkpoint && handoff && 'note' in handoff ? JSON.stringify(handoff.note) : null;
}

export class TaskStore {
  constructor(readonly db: Database) {}

  createTask(input: CreateTaskInput): Task {
    return this.createTaskOnce(input).task;
  }

  createTaskOnce(input: CreateTaskInput): CreateTaskOnceResult {
    const now = input.now ?? Date.now();
    const id = input.id ?? `qf-${randomUUID().slice(0, 8)}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw new Error('Task ID must use 1-64 letters, digits, dots, underscores or hyphens');
    }
    if (!input.title.trim()) throw new Error('Task title must not be empty');
    const prompt = input.prompt ?? input.title;
    const priority = input.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error('Task priority must be finite');
    const handoff = input.handoff ? parseHandoffOptions(input.handoff) : null;
    const prepared: PreparedTaskInput = {
      id,
      title: input.title,
      prompt,
      repoPath: input.repoPath,
      workspacePath: input.workspacePath,
      priority,
      critical: Number(input.critical ?? false),
      handoff,
      initialCheckpoint: input.initialCheckpoint?.trim() || null,
      ...(input.eventDetail ? { eventDetail: input.eventDetail } : {}),
      now,
    };
    return this.db.transaction(() => {
      const existing = this.findTask(id);
      if (existing) {
        if (existing.repoPath !== input.repoPath || existing.workspacePath !== input.workspacePath) {
          throw new Error(`Task ${id} already exists with a different repository or workspace`);
        }
        return { task: existing, created: false };
      }
      this.db.run(
        `INSERT INTO tasks
          (id, title, prompt, repo_path, workspace_path, status, priority, critical, handoff_config,
            checkpoint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        [prepared.id, prepared.title, prepared.prompt, prepared.repoPath, prepared.workspacePath,
          prepared.priority, prepared.critical, prepared.handoff ? JSON.stringify(prepared.handoff) : null,
          prepared.initialCheckpoint, prepared.now, prepared.now],
      );
      this.#event(prepared.id, null, 'task_created', {
        ...prepared.eventDetail,
        priority,
        critical: Boolean(prepared.critical),
        ...(prepared.handoff ? { handoff: prepared.handoff } : {}),
        ...(prepared.initialCheckpoint ? { initialCheckpoint: prepared.initialCheckpoint } : {}),
        now,
      });
      return { task: this.getTask(prepared.id), created: true };
    }).immediate();
  }

  findTask(id: string): Task | null {
    const row = this.db.query<TaskRow, [string]>('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? taskFrom(row) : null;
  }

  getTask(id: string): Task {
    const task = this.findTask(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    return task;
  }

  getAttempt(id: number): Attempt {
    const row = this.db.query<AttemptRow, [number]>('SELECT * FROM attempts WHERE id = ?').get(id);
    if (!row) throw new Error(`Unknown attempt ${id}`);
    return attemptFrom(row);
  }

  listTasks(status?: TaskStatus): Task[] {
    const rows = status
      ? this.db.query<TaskRow, [TaskStatus]>('SELECT * FROM tasks WHERE status = ? ORDER BY created_at, id').all(status)
      : this.db.query<TaskRow, []>('SELECT * FROM tasks ORDER BY created_at, id').all();
    return rows.map(taskFrom);
  }

  listRunnable(now = Date.now()): Task[] {
    const rows = this.db.query<TaskRow, [number, number]>(`
      SELECT * FROM tasks
      WHERE (status = 'queued' AND (next_wake_at IS NULL OR next_wake_at <= ?))
         OR (status = 'waiting_quota' AND (next_wake_at IS NULL OR next_wake_at <= ?))
      ORDER BY critical DESC, priority DESC, created_at, id
    `).all(now, now);
    return rows.map(taskFrom);
  }

  activeAttempt(taskId: string): Attempt | null {
    const row = this.db.query<AttemptRow, [string]>(
      "SELECT * FROM attempts WHERE task_id = ? AND stage <> 'done'",
    ).get(taskId);
    return row ? attemptFrom(row) : null;
  }

  activeAttempts(): Attempt[] {
    return this.db
      .query<AttemptRow, []>("SELECT * FROM attempts WHERE stage <> 'done' ORDER BY id")
      .all()
      .map(attemptFrom);
  }

  attempts(taskId: string): Attempt[] {
    return this.db.query<AttemptRow, [string]>('SELECT * FROM attempts WHERE task_id = ? ORDER BY id').all(taskId).map(attemptFrom);
  }

  handoffForCheckpoint(taskId: string, checkpoint: string | null): SavedHandoff | null {
    if (!checkpoint) return null;
    const row = this.db.query<{ id: number; handoff_note: string }, [string, string]>(`
      SELECT id, handoff_note FROM attempts
      WHERE task_id = ? AND checkpoint = ? AND stage = 'done' AND handoff_note IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(taskId, checkpoint);
    if (!row) return null;
    const note = parseHandoffNote(row.handoff_note);
    return note ? { taskId, attemptId: row.id, checkpoint, note } : null;
  }

  recordHandoffInput(attempt: Attempt, checkpoint: string, source: SavedHandoff | null, now = Date.now()): void {
    this.#event(attempt.taskId, attempt.id, 'handoff_input', {
      checkpoint,
      sourceAttemptId: source?.attemptId ?? null,
    }, now);
  }

  events(taskId: string): EventRecord[] {
    return this.db.query<EventRow, [string]>('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId).map(eventFrom);
  }

  usage(attemptId: number): AttemptUsageRecord[] {
    return this.db
      .query<UsageRow, [number]>('SELECT * FROM attempt_usage WHERE attempt_id = ? ORDER BY observed_at, id')
      .all(attemptId)
      .map(usageFrom);
  }

  usageForTask(taskId: string): AttemptUsageRecord[] {
    return this.db
      .query<UsageRow, [string]>(`
        SELECT attempt_usage.*
        FROM attempt_usage
        JOIN attempts ON attempts.id = attempt_usage.attempt_id
        WHERE attempts.task_id = ?
        ORDER BY attempt_usage.attempt_id, attempt_usage.observed_at, attempt_usage.id
      `)
      .all(taskId)
      .map(usageFrom);
  }

  recordGitHubDelivery(input: GitHubDeliveryInput): GitHubDeliveryRecord {
    return this.db.transaction(() => this.#recordGitHubDelivery(input)).immediate();
  }

  ingestGitHubGate(input: GitHubGateIngestInput): GitHubGateIngestResult {
    return this.db.transaction(() => {
      const now = input.now ?? Date.now();
      const payloadHash = hashGitHubPayload(input.snapshot);
      const baseDelivery = {
        eventType: input.eventType,
        repository: input.snapshot.repository,
        pullNumber: input.snapshot.number,
        headSha: input.snapshot.headSha,
        payloadHash,
      };
      const delivery = this.#recordGitHubDelivery({
        ...baseDelivery,
        deliveryId: input.deliveryId,
        eventKey: githubEventKey(baseDelivery),
        now,
      });
      const evaluation = evaluateGitHubPull(input.snapshot, input.policy);
      const snapshotHash = payloadHash;
      const existing = this.getGitHubGate(
        evaluation.repository,
        evaluation.pullNumber,
        evaluation.headSha,
        evaluation.policyHash,
      );
      const duplicate = delivery.duplicateDelivery || delivery.duplicateEvent;
      if (duplicate && existing) return { delivery, gate: existing, duplicate: true };

      this.db.run(
        `INSERT INTO github_gate_results
          (repository, pull_number, head_sha, policy_hash, status, snapshot_hash, delivery_id, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository, pull_number, head_sha, policy_hash) DO UPDATE SET
          status = excluded.status,
          snapshot_hash = excluded.snapshot_hash,
          delivery_id = excluded.delivery_id,
          detail = excluded.detail,
          updated_at = excluded.updated_at`,
        [evaluation.repository, evaluation.pullNumber, evaluation.headSha, evaluation.policyHash,
          evaluation.status, snapshotHash, delivery.deliveryId, JSON.stringify(evaluation), existing?.createdAt ?? now, now],
      );
      this.db.run(
        'UPDATE github_deliveries SET outcome = ? WHERE delivery_id = ?',
        [JSON.stringify({ status: evaluation.status, reasons: evaluation.reasons.map((reason) => reason.code) }), delivery.deliveryId],
      );
      const gate = this.getGitHubGate(
        evaluation.repository,
        evaluation.pullNumber,
        evaluation.headSha,
        evaluation.policyHash,
      )!;
      return { delivery: { ...delivery, outcome: JSON.stringify({ status: evaluation.status,
        reasons: evaluation.reasons.map((reason) => reason.code) }) }, gate, duplicate: false };
    }).immediate();
  }

  getGitHubGate(repository: string, pullNumber: number, headSha: string, policyHash: string): GitHubGateRecord | null {
    const row = this.db.query<GitHubGateRow, [string, number, string, string]>(`
      SELECT * FROM github_gate_results
      WHERE repository = ? AND pull_number = ? AND head_sha = ? AND policy_hash = ?
    `).get(repository, pullNumber, headSha, policyHash);
    return row ? githubGateFrom(row) : null;
  }

  #recordGitHubDelivery(input: GitHubDeliveryInput): GitHubDeliveryRecord {
    const now = input.now ?? Date.now();
    const byDelivery = this.db.query<GitHubDeliveryRow, [string]>(
      'SELECT * FROM github_deliveries WHERE delivery_id = ?',
    ).get(input.deliveryId);
    if (byDelivery) {
      if (byDelivery.event_key !== input.eventKey || byDelivery.payload_hash !== input.payloadHash
        || byDelivery.event_type !== input.eventType || byDelivery.repository !== input.repository
        || byDelivery.pull_number !== input.pullNumber || byDelivery.head_sha !== input.headSha) {
        throw new Error(`GitHub delivery ${input.deliveryId} was reused with different content`);
      }
      return githubDeliveryFrom(byDelivery, true, true);
    }
    const byEvent = this.db.query<GitHubDeliveryRow, [string]>(
      'SELECT * FROM github_deliveries WHERE event_key = ?',
    ).get(input.eventKey);
    if (byEvent) return githubDeliveryFrom(byEvent, false, true);
    this.db.run(
      `INSERT INTO github_deliveries
        (delivery_id, event_key, event_type, repository, pull_number, head_sha, payload_hash, received_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [input.deliveryId, input.eventKey, input.eventType, input.repository, input.pullNumber,
        input.headSha, input.payloadHash, now],
    );
    return { ...input, now, duplicateDelivery: false, duplicateEvent: false, outcome: null };
  }

  budgetStatus(policies: BudgetPolicy[], now = Date.now()): BudgetStatus[] {
    return this.db.transaction(() => {
      this.#expireBudgetLeases(now);
      return policies.map((policy) => this.#budgetStatus(policy, now));
    }).immediate();
  }

  expireBudgetLeases(now = Date.now()): BudgetLease[] {
    return this.db.transaction(() => this.#expireBudgetLeases(now)).immediate();
  }

  budgetAudit(policies: BudgetPolicy[], now = Date.now(), limit = 100): BudgetAudit {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('Budget audit limit must be a positive integer');
    return this.db.transaction(() => {
      this.#expireBudgetLeases(now);
      return {
        policies: policies.map((policy) => this.#budgetStatus(policy, now)),
        expired: this.db.query<BudgetRow, [number]>(`
          SELECT budget_leases.*, attempts.task_id
          FROM budget_leases
          JOIN attempts ON attempts.id = budget_leases.attempt_id
          WHERE budget_leases.state = 'expired'
          ORDER BY budget_leases.updated_at DESC, budget_leases.id DESC
          LIMIT ?
        `).all(limit).map(budgetFrom),
      };
    }).immediate();
  }

  budgetLease(attemptId: number): BudgetLease | null {
    const row = this.db.query<BudgetRow, [number]>(`
      SELECT budget_leases.*, attempts.task_id
      FROM budget_leases
      JOIN attempts ON attempts.id = budget_leases.attempt_id
      WHERE budget_leases.attempt_id = ?
    `).get(attemptId);
    return row ? budgetFrom(row) : null;
  }

  budgetLeasesForTask(taskId: string): BudgetLease[] {
    return this.db
      .query<BudgetRow, [string]>(`
        SELECT budget_leases.*, attempts.task_id
        FROM budget_leases
        JOIN attempts ON attempts.id = budget_leases.attempt_id
        WHERE attempts.task_id = ?
        ORDER BY budget_leases.id
      `)
      .all(taskId)
      .map(budgetFrom);
  }

  releaseBudgetLease(attemptId: number, reason: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const attempt = this.db.query<AttemptRow, [number]>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
      const updated = this.db.run(
        "UPDATE budget_leases SET amount = 0, state = 'released', priced = NULL, updated_at = ?, expires_at = ? WHERE attempt_id = ? AND state NOT IN ('released', 'expired')",
        [now, now, attemptId],
      );
      if (updated.changes) {
        this.#event(attempt.task_id, attemptId, 'budget_lease_released', { reason, now });
      }
      return updated.changes === 1;
    }).immediate();
  }

  reserve(
    taskId: string,
    lanes: LaneConfig[],
    now = Date.now(),
    budgets: BudgetPolicy[] = [],
  ): Reservation | null {
    return this.db.transaction(() => {
      this.#expireBudgetLeases(now);
      const task = this.getTask(taskId);
      const due = (task.status === 'queued' && (task.nextWakeAt === null || task.nextWakeAt <= now))
        || (task.status === 'waiting_quota' && (task.nextWakeAt === null || task.nextWakeAt <= now));
      if (!due) return null;

      const attemptCount = this.db.query<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM attempts WHERE task_id = ?',
      ).get(taskId)!.n;
      if (attemptCount >= MAX_ATTEMPTS_PER_TASK) {
        this.#updateStatus(taskId, 'blocked', null, now);
        this.#event(taskId, null, 'blocked', { reason: 'attempt_limit', now });
        return null;
      }

      const filters: LaneFilter[] = [];
      const budgetByAccount = new Map(budgets.map((budget) => [budget.account, budget]));
      const retryTimes: number[] = [];
      const sorted = [...lanes].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
      for (const lane of sorted) {
        let reason = '';
        let budget: BudgetPolicy | undefined;
        let budgetStatus: BudgetStatus | undefined;
        const cooldown = this.db.query<{ until_ms: number }, [string]>(
          'SELECT until_ms FROM cooldowns WHERE account = ?',
        ).get(lane.account);
        if (cooldown && cooldown.until_ms > now) {
          reason = 'cooldown';
          retryTimes.push(cooldown.until_ms);
        }

        const active = this.db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM attempts WHERE account = ? AND stage <> 'done'",
        ).get(lane.account)!.n;
        if (!reason && active >= lane.slots) reason = 'slots';

        budget = budgetByAccount.get(lane.account);
        if (!reason && budget) {
          budgetStatus = this.#budgetStatus(budget, now);
          if (budgetStatus.used + budget.holdPerAttempt > budget.limit - budget.reserve) {
            reason = 'budget';
            if (budgetStatus.nextExpiryAt !== null) retryTimes.push(budgetStatus.nextExpiryAt);
          }
        }

        if (!reason && lane.windows.length === 0) reason = 'UNKNOWN';
        if (!reason) {
          for (const window of lane.windows) {
            if (window.remaining === null || window.observedAt > now || !Number.isFinite(window.resetAt)) {
              reason = 'UNKNOWN';
              break;
            }
            if (window.resetAt <= now || window.resetAt <= window.observedAt) {
              reason = 'stale';
              break;
            }
            const consumed = this.db.query<{ n: number }, [string, number, number]>(
              "SELECT count(*) AS n FROM attempts WHERE account = ? AND stage = 'done' AND ended_at >= ? AND ended_at < ?",
            ).get(lane.account, window.observedAt, window.resetAt)!.n;
            const available = window.remaining - consumed - active;
            if (available - (task.critical ? 0 : window.reserve) < 1) {
              reason = 'quota';
              break;
            }
          }
        }

        filters.push({ laneId: lane.id, reason: reason || 'eligible' });
        if (reason) continue;

        const leaseToken = randomUUID();
        const inserted = this.db.run(
          `INSERT INTO attempts
            (task_id, lane_id, agent, model, provider, account, stage, lease_token, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
          [taskId, lane.id, lane.agent, lane.model, lane.provider, lane.account, leaseToken, now],
        );
        const attemptId = Number(inserted.lastInsertRowid);
        if (budget) {
          const heldAt = now;
          const expiresAt = now + budget.windowMs;
          this.db.run(
            `INSERT INTO budget_leases
              (attempt_id, account, unit, amount, state, priced, window_ms, created_at, updated_at, expires_at)
             VALUES (?, ?, ?, ?, 'held', NULL, ?, ?, ?, ?)`,
            [attemptId, budget.account, budget.unit, budget.holdPerAttempt, budget.windowMs, heldAt, heldAt, expiresAt],
          );
        }
        this.db.run("UPDATE tasks SET status = 'running', next_wake_at = NULL, updated_at = ? WHERE id = ?", [now, taskId]);
        this.#event(taskId, attemptId, 'attempt_reserved', {
          laneId: lane.id,
          model: lane.model,
          provider: lane.provider,
          account: lane.account,
          filters,
          policy: 'phase1-quota-priority-v1',
          ...(budget && budgetStatus ? {
            budget: {
              account: budget.account,
              unit: budget.unit,
              limit: budget.limit,
              reserve: budget.reserve,
              usedBefore: budgetStatus.used,
              hold: budget.holdPerAttempt,
              expiresAt: now + budget.windowMs,
            },
          } : {}),
          now,
        });
        return { attempt: this.activeAttempt(taskId)!, filters };
      }

      const allWaitingForCooldown = filters.length > 0 && filters.every((filter) =>
        filter.reason === 'budget' || filter.reason === 'cooldown');
      const retryAt = allWaitingForCooldown && retryTimes.length > 0
        ? Math.max(now + 1000, Math.min(...retryTimes))
        : now + 1000;
      this.#updateStatus(taskId, 'waiting_quota', retryAt, now);
      this.#event(taskId, null, 'waiting_quota', { filters, retryAt, now });
      return null;
    }).immediate();
  }

  beginCheckpoint(attemptId: number, reason: string, activeProcesses: number, now = Date.now()): boolean {
    if (activeProcesses !== 0) throw new Error('Cannot checkpoint while worker processes are active');
    return this.db.transaction(() => {
      const attempt = this.db.query<AttemptRow, [number]>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
      const updated = this.db.run(
        "UPDATE attempts SET stage = 'checkpoint' WHERE id = ? AND stage = 'running'",
        [attemptId],
      );
      if (updated.changes) {
        this.#event(attempt.task_id, attemptId, 'checkpoint_intent', { reason, activeProcesses, now });
      }
      return updated.changes === 1;
    }).immediate();
  }

  settle(
    attemptId: number,
    checkpoint: string,
    status: TaskStatus,
    reason: string,
    retryAfterMs = 1000,
    now = Date.now(),
    actualModel?: string,
    usage?: UsageReport,
    options: SettlementOptions = {},
  ): Task {
    return this.db.transaction(() => {
      const attempt = this.db.query<AttemptRow, [number]>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
      const usageModel = usageActualModel(usage);
      const settledActualModel = usageModel
        ?? (usage?.status === 'recorded' ? undefined : actualModel);
      const published = options.preserveCheckpoint ? null : checkpoint || null;
      const updated = this.db.run(
        `UPDATE attempts SET stage = 'done', checkpoint = ?, ended_at = ?, actual_model = coalesce(?, actual_model),
          handoff_note = ? WHERE id = ? AND stage <> 'done'`,
        [published, now, settledActualModel ?? null, noteForCheckpoint(published, options.handoff), attemptId],
      );
      if (!updated.changes) return this.getTask(attempt.task_id);

      if (usage) this.#recordUsage(attemptId, usage);
      const budgetLease = this.#settleBudgetLease(attemptId, usage, now);
      const nextWakeAt = status === 'waiting_quota' || status === 'queued' ? now + retryAfterMs : null;
      this.#updateStatus(attempt.task_id, status, nextWakeAt, now);
      if (!options.preserveCheckpoint) {
        this.db.run('UPDATE tasks SET checkpoint = ? WHERE id = ?', [published, attempt.task_id]);
      }
      if (nextWakeAt !== null) {
        this.db.run(
          `INSERT INTO cooldowns (account, until_ms) VALUES (?, ?)
           ON CONFLICT(account) DO UPDATE SET until_ms = max(until_ms, excluded.until_ms)`,
          [attempt.account, nextWakeAt],
        );
      }
      if (usage) {
        this.#event(attempt.task_id, attemptId, 'usage_reconciled', usageSummary(usage, settledActualModel));
      }
      if (budgetLease) {
        this.#event(attempt.task_id, attemptId, 'budget_lease_updated', {
          account: budgetLease.account,
          unit: budgetLease.unit,
          amount: budgetLease.amount,
          state: budgetLease.state,
          priced: budgetLease.priced,
          expiresAt: budgetLease.expiresAt,
        });
      }
      this.#recordHandoff(attempt.task_id, attemptId, published, options.handoff, now);
      this.#event(attempt.task_id, attemptId, 'attempt_finished', {
        ...options.detail,
        checkpoint: published,
        status,
        reason,
        actualModel: settledActualModel ?? attempt.actual_model,
        ...(usage ? { usage: usageSummary(usage, settledActualModel) } : {}),
        ...(budgetLease ? {
          budget: {
            account: budgetLease.account,
            unit: budgetLease.unit,
            amount: budgetLease.amount,
            state: budgetLease.state,
            priced: budgetLease.priced,
          },
        } : {}),
        retryAfterMs: nextWakeAt === null ? null : retryAfterMs,
        now,
      });
      return this.getTask(attempt.task_id);
    }).immediate();
  }

  recoverAttempt(
    attemptId: number,
    input: {
      status: 'queued' | 'blocked' | 'cancelled';
      checkpoint?: string | null;
      handoff?: HandoffDraft;
      reason: string;
      detail?: Record<string, unknown>;
      now?: number;
    },
  ): Task {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const attempt = this.db.query<AttemptRow, [number]>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
      const checkpoint = input.checkpoint || null;
      const updated = this.db.run(
        `UPDATE attempts SET stage = 'done', checkpoint = coalesce(?, checkpoint), ended_at = ?,
          handoff_note = ? WHERE id = ? AND stage <> 'done'`,
        [checkpoint, now, noteForCheckpoint(checkpoint, input.handoff), attemptId],
      );
      if (!updated.changes) return this.getTask(attempt.task_id);

      const budgetLease = this.#settleBudgetLease(attemptId, undefined, now);
      const recoveryCooldownUntil = budgetLease?.state === 'pending' && budgetLease.expiresAt > now
        ? budgetLease.expiresAt
        : null;
      const nextWakeAt = input.status === 'queued' ? recoveryCooldownUntil : null;
      this.#updateStatus(attempt.task_id, input.status, nextWakeAt, now);
      if (checkpoint) {
        this.db.run('UPDATE tasks SET checkpoint = ? WHERE id = ?', [checkpoint, attempt.task_id]);
      }
      if (budgetLease) {
        this.#event(attempt.task_id, attemptId, 'budget_lease_updated', {
          account: budgetLease.account,
          unit: budgetLease.unit,
          amount: budgetLease.amount,
          state: budgetLease.state,
          priced: budgetLease.priced,
          expiresAt: budgetLease.expiresAt,
        });
      }
      if (recoveryCooldownUntil !== null) {
        this.db.run(
          `INSERT INTO cooldowns (account, until_ms) VALUES (?, ?)
           ON CONFLICT(account) DO UPDATE SET until_ms = max(until_ms, excluded.until_ms)`,
          [attempt.account, recoveryCooldownUntil],
        );
        this.#event(attempt.task_id, attemptId, 'recovery_cooldown', {
          account: attempt.account,
          until: recoveryCooldownUntil,
          reason: 'pending_budget_lease',
          now,
        }, now);
      }
      const detail = {
        status: input.status,
        reason: input.reason,
        checkpoint: checkpoint ?? attempt.checkpoint,
        recovered: true,
        ...(recoveryCooldownUntil === null ? {} : { recoveryCooldownUntil }),
        ...input.detail,
        now,
      };
      this.#recordHandoff(attempt.task_id, attemptId, checkpoint, input.handoff, now);
      this.#event(attempt.task_id, attemptId, 'attempt_recovered', detail);
      this.#event(attempt.task_id, attemptId, 'attempt_finished', detail);
      return this.getTask(attempt.task_id);
    }).immediate();
  }

  #recordHandoff(taskId: string, attemptId: number, checkpoint: string | null, handoff: HandoffDraft | undefined, now: number) {
    if (!handoff || !checkpoint) return;
    if ('note' in handoff) this.#event(taskId, attemptId, 'handoff_saved', { checkpoint }, now);
    else this.#event(taskId, attemptId, 'handoff_unavailable', { checkpoint, reason: handoff.reason }, now);
  }

  cancelRequested(taskId: string, attemptId: number): boolean {
    return Boolean(this.db.query<{ present: number }, [string, number]>(`
      SELECT 1 AS present
      FROM events
      WHERE task_id = ? AND attempt_id = ? AND kind = 'cancel_requested'
      LIMIT 1
    `).get(taskId, attemptId));
  }

  requestForcedCancellation(taskId: string, waitMs: number, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return false;
      const active = this.activeAttempt(taskId);
      if (!active) return false;
      const present = this.db.query<{ present: number }, [string, number]>(`
        SELECT 1 AS present
        FROM events
        WHERE task_id = ? AND attempt_id = ? AND kind = 'cancel_forced'
        LIMIT 1
      `).get(taskId, active.id);
      if (present) return false;
      this.#event(taskId, active.id, 'cancel_forced', {
        reason: 'worker_unresponsive',
        waitMs,
        now,
      });
      return true;
    }).immediate();
  }

  block(
    taskId: string,
    reason: string,
    now = Date.now(),
    expected?: { attemptId: number; detail?: Record<string, unknown> },
  ): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (task.status === 'completed' || task.status === 'cancelled') return task;
      const active = this.activeAttempt(taskId);
      if (expected && (expected.attemptId !== active?.id || task.status === 'blocked')) return task;
      this.#updateStatus(taskId, 'blocked', null, now);
      this.#event(taskId, active?.id ?? null, 'blocked', { reason, ...expected?.detail, now });
      return this.getTask(taskId);
    }).immediate();
  }

  retry(taskId: string, now = Date.now()): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      const active = this.activeAttempt(taskId);
      if (active) throw new Error(`Task ${taskId} has an active attempt ${active.id}; stop it before retrying`);
      if (!['failed', 'blocked', 'waiting_quota', 'waiting_dependency', 'waiting_human'].includes(task.status)) {
        throw new Error(`Task ${taskId} cannot be retried from status ${task.status}`);
      }
      const attemptCount = this.db.query<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM attempts WHERE task_id = ?',
      ).get(taskId)!.n;
      if (attemptCount >= MAX_ATTEMPTS_PER_TASK) {
        throw new Error(`Task ${taskId} reached the attempt limit of ${MAX_ATTEMPTS_PER_TASK}`);
      }
      this.#updateStatus(taskId, 'queued', null, now);
      this.#event(taskId, null, 'retry_requested', {
        previousStatus: task.status,
        attemptCount,
        now,
      });
      return this.getTask(taskId);
    }).immediate();
  }

  cancel(taskId: string, now = Date.now()): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (task.status === 'completed' || task.status === 'cancelled') return task;
      const active = this.activeAttempt(taskId);
      if (active) {
        if (task.status === 'cancelling' && this.cancelRequested(taskId, active.id)) return task;
        this.#updateStatus(taskId, 'cancelling', null, now);
        this.#event(taskId, active.id, 'cancel_requested', { reason: 'operator', now });
        return this.getTask(taskId);
      }
      this.#updateStatus(taskId, 'cancelled', null, now);
      this.#event(taskId, null, 'cancelled', { now });
      return this.getTask(taskId);
    }).immediate();
  }

  #updateStatus(taskId: string, status: TaskStatus, nextWakeAt: number | null, now: number) {
    this.db.run(
      'UPDATE tasks SET status = ?, next_wake_at = ?, updated_at = ? WHERE id = ?',
      [status, nextWakeAt, now, taskId],
    );
  }

  #budgetStatus(policy: BudgetPolicy, now: number): BudgetStatus {
    const row = this.db.query<{
      used: number | null;
      active: number;
      next_expiry: number | null;
    }, [string, number]>(`
      SELECT
        coalesce(sum(amount), 0) AS used,
        count(*) AS active,
        min(expires_at) AS next_expiry
      FROM budget_leases
      JOIN attempts ON attempts.id = budget_leases.attempt_id
      WHERE budget_leases.account = ?
        AND budget_leases.state <> 'released'
        AND (budget_leases.expires_at > ? OR attempts.stage <> 'done')
    `).get(policy.account, now)!;
    return {
      ...policy,
      used: row.used ?? 0,
      available: policy.limit - (row.used ?? 0),
      activeLeases: row.active,
      nextExpiryAt: row.next_expiry,
    };
  }

  #expireBudgetLeases(now: number): BudgetLease[] {
    const rows = this.db.query<BudgetRow, [number]>(`
      SELECT budget_leases.*, attempts.task_id
      FROM budget_leases
      JOIN attempts ON attempts.id = budget_leases.attempt_id
      WHERE budget_leases.state NOT IN ('released', 'expired')
        AND budget_leases.expires_at <= ?
        AND attempts.stage = 'done'
      ORDER BY budget_leases.expires_at, budget_leases.id
    `).all(now);
    const expired: BudgetLease[] = [];
    for (const row of rows) {
      const previousState = row.state;
      this.db.run(
        "UPDATE budget_leases SET state = 'expired', priced = coalesce(priced, ?), updated_at = ?, expired_at = ? WHERE attempt_id = ? AND state <> 'expired'",
        [Number(previousState === 'settled'), now, now, row.attempt_id],
      );
      const lease = budgetFrom({
        ...row,
        state: 'expired',
        priced: row.priced ?? Number(previousState === 'settled'),
        updated_at: now,
        expired_at: now,
      });
      expired.push(lease);
      this.#event(row.task_id!, row.attempt_id, 'budget_lease_expired', {
        account: lease.account,
        unit: lease.unit,
        amount: lease.amount,
        previousState,
        priced: lease.priced,
        expiresAt: lease.expiresAt,
        expiredAt: lease.expiredAt,
      }, now);
    }
    return expired;
  }

  #settleBudgetLease(attemptId: number, usage: UsageReport | undefined, now: number): BudgetLease | null {
    const row = this.db
      .query<BudgetRow, [number]>(`
        SELECT budget_leases.*, attempts.task_id
        FROM budget_leases
        JOIN attempts ON attempts.id = budget_leases.attempt_id
        WHERE budget_leases.attempt_id = ?
      `)
      .get(attemptId);
    if (!row || row.state === 'released' || row.state === 'expired') return null;
    const priced = usage?.status === 'recorded'
      && usage.priced === true
      && usage.rows.length > 0
      && usage.rows.every((entry) => entry.priced === true && entry.costEstimate !== null);
    const estimatedCost = Math.max(0, usage?.costEstimate ?? 0);
    const amount = priced ? estimatedCost : Math.max(row.amount, estimatedCost);
    const state: BudgetLease['state'] = priced ? 'settled' : 'pending';
    const expiresAt = now + row.window_ms;
    this.db.run(
      'UPDATE budget_leases SET amount = ?, state = ?, priced = ?, updated_at = ?, expires_at = ? WHERE attempt_id = ?',
      [amount, state, Number(priced), now, expiresAt, attemptId],
    );
    return budgetFrom({
      ...row,
      amount,
      state,
      priced: Number(priced),
      updated_at: now,
      expires_at: expiresAt,
    });
  }

  #recordUsage(attemptId: number, usage: UsageReport) {
    for (const row of usage.rows) {
      this.db.run(
        `INSERT OR IGNORE INTO attempt_usage (
          attempt_id, source, source_request_id, observed_at, provider, provider_name, agent,
          session_id, request_model, served_model, http_status, stop_reason,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          cost_estimate, priced, provider_invoice
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attemptId,
          row.source,
          row.sourceRequestId,
          row.observedAt,
          row.provider,
          row.providerName,
          row.agent,
          row.sessionId,
          row.requestModel,
          row.servedModel,
          row.httpStatus,
          row.stopReason,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens,
          row.reasoningTokens,
          row.costEstimate,
          row.priced === null ? null : Number(row.priced),
          row.providerInvoice,
        ],
      );
    }
  }

  #event(taskId: string, attemptId: number | null, kind: string, detail: unknown, now = Date.now()) {
    this.db.run(
      'INSERT INTO events (task_id, attempt_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      [taskId, attemptId, kind, JSON.stringify(detail), now],
    );
  }
}
