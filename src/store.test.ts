import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db';
import type { BudgetPolicy, LaneConfig, UsageObservation, UsageReport } from './domain';
import { reserveNext } from './scheduler';
import { TaskStore } from './store';

function lane(now: number, overrides: Partial<LaneConfig> = {}): LaneConfig {
  return {
    id: 'test-lane',
    agent: 'codex',
    model: 'test-model',
    provider: 'local',
    account: 'test-account',
    priority: 10,
    slots: 1,
    windows: [{ key: 'day', remaining: 5, reserve: 1, observedAt: now - 1000, resetAt: now + 60_000 }],
    ...overrides,
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-store-'));
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  return { root, db, store };
}

function close(root: string, db: ReturnType<typeof openDatabase>) {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

function observation(index: number, servedModel = 'served-model'): UsageObservation {
  return {
    source: 'magpie',
    sourceRequestId: `request-${index}`,
    observedAt: index,
    provider: 'opencode-go',
    providerName: 'OpenCode Go',
    agent: 'opencode',
    sessionId: 'session-1',
    requestModel: 'requested-model',
    servedModel,
    httpStatus: 200,
    stopReason: 'stop',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costEstimate: 0,
    priced: true,
    providerInvoice: 'UNKNOWN',
  };
}

function usageReport(rows: UsageObservation[]): UsageReport {
  const models = new Set(rows.map((row) => row.servedModel).filter(Boolean));
  return {
    source: 'magpie',
    status: rows.length > 0 ? 'recorded' : 'not_found',
    sessionId: 'session-1',
    queryWindow: { start: 0, end: 100 },
    rows,
    ...(models.size === 1 ? { actualModel: [...models][0] as string } : {}),
    costEstimate: rows.reduce((total, row) => total + (row.costEstimate ?? 0), 0),
    priced: rows.length > 0 && rows.every((row) => row.priced === true),
    providerInvoice: 'UNKNOWN',
  };
}

const budget: BudgetPolicy = {
  account: 'test-account',
  unit: 'gateway-estimate',
  limit: 1,
  reserve: 0,
  windowMs: 60_000,
  holdPerAttempt: 0.6,
};

test('reserves one account slot and puts the next task in waiting_quota', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    store.createTask({ id: 'two', title: 'two', repoPath: root, workspacePath: join(root, 'two'), now });
    const lanes = [lane(now)];
    expect(store.reserve('one', lanes, now)?.attempt.laneId).toBe('test-lane');
    expect(store.reserve('two', lanes, now)).toBeNull();
    expect(store.getTask('two').status).toBe('waiting_quota');
    expect(store.events('two').some((event) => event.kind === 'waiting_quota')).toBe(true);
  } finally {
    close(root, db);
  }
});

test('settle releases the account slot and lets another task reserve', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    store.createTask({ id: 'two', title: 'two', repoPath: root, workspacePath: join(root, 'two'), now });
    const lanes = [lane(now)];
    const first = store.reserve('one', lanes, now)!;
    expect(store.beginCheckpoint(first.attempt.id, 'finished', 0, now)).toBe(true);
    const settled = store.settle(first.attempt.id, 'abc123', 'completed', 'done', 0, now);
    expect(settled.status).toBe('completed');
    expect(store.activeAttempt('one')).toBeNull();
    expect(reserveNext(store, lanes, now + 1)?.attempt.taskId).toBe('two');
  } finally {
    close(root, db);
  }
});

test('critical work may consume the reserve while normal work waits', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'normal', title: 'normal', repoPath: root, workspacePath: join(root, 'normal'), now });
    store.createTask({ id: 'critical', title: 'critical', repoPath: root, workspacePath: join(root, 'critical'), priority: 10, critical: true, now });
    const edge = lane(now, {
      windows: [{ key: 'day', remaining: 1, reserve: 1, observedAt: now, resetAt: now + 60_000 }],
    });
    expect(store.reserve('normal', [edge], now)).toBeNull();
    expect(store.getTask('normal').status).toBe('waiting_quota');
    expect(store.reserve('critical', [edge], now)?.attempt.taskId).toBe('critical');
  } finally {
    close(root, db);
  }
});

test('settle persists request-level usage and derives the served model', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    const reservation = store.reserve('one', [lane(now)], now)!;
    expect(store.beginCheckpoint(reservation.attempt.id, 'finished', 0, now)).toBe(true);
    store.settle(
      reservation.attempt.id,
      'abc123',
      'completed',
      'done',
      0,
      now,
      undefined,
      usageReport([observation(1), observation(2)]),
    );

    expect(store.getAttempt(reservation.attempt.id).actualModel).toBe('served-model');
    expect(store.usage(reservation.attempt.id)).toMatchObject([
      { sourceRequestId: 'request-1', servedModel: 'served-model', providerInvoice: 'UNKNOWN' },
      { sourceRequestId: 'request-2', servedModel: 'served-model', providerInvoice: 'UNKNOWN' },
    ]);
    expect(store.usageForTask('one')).toHaveLength(2);
    expect(store.events('one').find((event) => event.kind === 'usage_reconciled')?.detail).toMatchObject({
      status: 'recorded',
      rows: 2,
      actualModel: 'served-model',
      providerInvoice: 'UNKNOWN',
    });
  } finally {
    close(root, db);
  }
});

test('budget leases block a second attempt and cool down until expiry', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    store.createTask({ id: 'two', title: 'two', repoPath: root, workspacePath: join(root, 'two'), now });
    const budgetLane = lane(now, {
      slots: 2,
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 3_600_000 }],
    });

    const first = store.reserve('one', [budgetLane], now, [budget])!;
    expect(store.budgetLease(1)).toMatchObject({
      amount: 0.6,
      state: 'held',
      unit: 'gateway-estimate',
    });
    expect(store.budgetStatus([budget], now)[0]).toMatchObject({
      used: 0.6,
      available: 0.4,
      activeLeases: 1,
    });

    expect(store.reserve('two', [budgetLane], now, [budget])).toBeNull();
    expect(store.getTask('two').status).toBe('waiting_quota');
    expect(store.getTask('two').nextWakeAt).toBe(now + budget.windowMs);
    expect(store.events('two').at(-1)?.detail).toMatchObject({
      filters: [{ reason: 'budget' }],
    });

    store.beginCheckpoint(first.attempt.id, 'finished', 0, now);
    store.settle(first.attempt.id, 'checkpoint-one', 'completed', 'done', 0, now);
    expect(store.reserve('two', [budgetLane], now + budget.windowMs, [budget])).not.toBeNull();
  } finally {
    close(root, db);
  }
});

test('an active attempt keeps its budget hold after the nominal lease expiry', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'long-run', title: 'long run', repoPath: root, workspacePath: join(root, 'long-run'), now });
    const budgetLane = lane(now, {
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 3_600_000 }],
    });
    const reservation = store.reserve('long-run', [budgetLane], now, [{ ...budget, windowMs: 10 }])!;

    expect(store.budgetStatus([{ ...budget, windowMs: 10 }], now + 100)[0]).toMatchObject({
      used: 0.6,
      activeLeases: 1,
    });
    expect(store.budgetLease(reservation.attempt.id)).toMatchObject({
      state: 'held',
      expiresAt: now + 10,
      expiredAt: null,
    });
    expect(store.events('long-run').some((event) => event.kind === 'budget_lease_expired')).toBe(false);

    store.beginCheckpoint(reservation.attempt.id, 'finished', 0, now + 100);
    store.settle(reservation.attempt.id, 'checkpoint', 'completed', 'done', 0, now + 100, undefined, usageReport([]));
    expect(store.budgetLease(reservation.attempt.id)).toMatchObject({
      state: 'pending',
      expiresAt: now + 110,
    });
  } finally {
    close(root, db);
  }
});

test('expired budget leases are audited once and stop consuming the window', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'expire', title: 'expire', repoPath: root, workspacePath: join(root, 'expire'), now });
    const shortBudget = { ...budget, windowMs: 10 };
    const budgetLane = lane(now, {
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 3_600_000 }],
    });
    const reservation = store.reserve('expire', [budgetLane], now, [shortBudget])!;
    store.beginCheckpoint(reservation.attempt.id, 'finished', 0, now);
    store.settle(reservation.attempt.id, 'checkpoint', 'completed', 'done', 0, now, undefined, usageReport([]));

    expect(store.budgetStatus([shortBudget], now + 9)[0]).toMatchObject({ used: 0.6, activeLeases: 1 });
    expect(store.budgetStatus([shortBudget], now + 10)[0]).toMatchObject({ used: 0, activeLeases: 0, nextExpiryAt: null });
    expect(store.budgetLease(reservation.attempt.id)).toMatchObject({
      amount: 0.6,
      state: 'expired',
      priced: false,
      expiredAt: now + 10,
    });
    expect(store.events('expire').filter((event) => event.kind === 'budget_lease_expired')).toHaveLength(1);
    expect(store.budgetAudit([shortBudget], now + 11).expired).toMatchObject([{
      attemptId: reservation.attempt.id,
      taskId: 'expire',
      state: 'expired',
      expiredAt: now + 10,
    }]);
    expect(store.expireBudgetLeases(now + 12)).toEqual([]);
    expect(store.releaseBudgetLease(reservation.attempt.id, 'late_release', now + 12)).toBe(false);
    expect(store.budgetLease(reservation.attempt.id)?.state).toBe('expired');
    expect(store.events('expire').filter((event) => event.kind === 'budget_lease_expired')).toHaveLength(1);
  } finally {
    close(root, db);
  }
});

test('priced usage shrinks the budget hold and unknown usage keeps it', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'priced', title: 'priced', repoPath: root, workspacePath: join(root, 'priced'), now });
    store.createTask({ id: 'unknown', title: 'unknown', repoPath: root, workspacePath: join(root, 'unknown'), now });
    const budgetLane = lane(now, {
      slots: 2,
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 3_600_000 }],
    });

    const priced = store.reserve('priced', [budgetLane], now, [budget])!;
    store.beginCheckpoint(priced.attempt.id, 'finished', 0, now);
    const pricedRows = [observation(1)];
    pricedRows[0].costEstimate = 0.2;
    store.settle(
      priced.attempt.id,
      'checkpoint-priced',
      'completed',
      'done',
      0,
      now,
      undefined,
      usageReport(pricedRows),
    );
    expect(store.budgetLease(priced.attempt.id)).toMatchObject({
      amount: 0.2,
      state: 'settled',
      priced: true,
    });
    expect(store.budgetStatus([budget], now + 1)[0]).toMatchObject({ used: 0.2 });

    const unknown = store.reserve('unknown', [budgetLane], now + 1, [budget])!;
    store.beginCheckpoint(unknown.attempt.id, 'finished', 0, now + 1);
    store.settle(
      unknown.attempt.id,
      'checkpoint-unknown',
      'completed',
      'done',
      0,
      now + 1,
      undefined,
      usageReport([]),
    );
    expect(store.budgetLease(unknown.attempt.id)).toMatchObject({
      amount: 0.6,
      state: 'pending',
      priced: false,
    });
  } finally {
    close(root, db);
  }
});

test('releasing a budget lease zeroes its hold without later settlement resurrection', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'released', title: 'released', repoPath: root, workspacePath: join(root, 'released'), now });
    const budgetLane = lane(now, {
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 3_600_000 }],
    });
    const reservation = store.reserve('released', [budgetLane], now, [budget])!;
    expect(store.budgetStatus([budget], now)[0]).toMatchObject({ used: 0.6, activeLeases: 1 });

    expect(store.releaseBudgetLease(reservation.attempt.id, 'fixture_cleanup', now)).toBe(true);
    expect(store.budgetLease(reservation.attempt.id)).toMatchObject({
      amount: 0,
      state: 'released',
      priced: null,
      expiresAt: now,
    });
    expect(store.budgetStatus([budget], now + 1)[0]).toMatchObject({ used: 0, available: 1, activeLeases: 0 });
    expect(store.releaseBudgetLease(reservation.attempt.id, 'fixture_cleanup', now)).toBe(false);

    store.beginCheckpoint(reservation.attempt.id, 'released', 0, now);
    store.settle(reservation.attempt.id, '', 'blocked', 'fixture_cleanup', 1000, now);
    expect(store.budgetLease(reservation.attempt.id)).toMatchObject({ amount: 0, state: 'released' });
    expect(store.events('released').filter((event) => event.kind === 'budget_lease_released')).toHaveLength(1);
  } finally {
    close(root, db);
  }
});

test('recorded usage with mixed served models does not invent an actual model', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    const reservation = store.reserve('one', [lane(now)], now)!;
    store.beginCheckpoint(reservation.attempt.id, 'finished', 0, now);
    store.settle(
      reservation.attempt.id,
      'abc123',
      'completed',
      'done',
      0,
      now,
      'requested-model',
      usageReport([observation(1, 'model-a'), observation(2, 'model-b')]),
    );

    expect(store.getAttempt(reservation.attempt.id).actualModel).toBeNull();
  } finally {
    close(root, db);
  }
});

test('unknown and stale quota observations are not reserved', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    expect(store.reserve('one', [lane(now, { windows: [] })], now)).toBeNull();
    expect(store.events('one').some((event) => event.kind === 'waiting_quota')).toBe(true);
    expect(store.reserve('one', [lane(now, { windows: [{
      key: 'day', remaining: 5, reserve: 1, observedAt: now, resetAt: now - 1,
    }] })], now + 1001)).toBeNull();
    expect(store.events('one').at(-1)?.detail).toMatchObject({ filters: [{ reason: 'stale' }] });
  } finally {
    close(root, db);
  }
});

test('cancel requests active cancellation and succeeds for queued work', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'one', title: 'one', repoPath: root, workspacePath: join(root, 'one'), now });
    store.createTask({ id: 'two', title: 'two', repoPath: root, workspacePath: join(root, 'two'), now });
    const reservation = store.reserve('one', [lane(now)], now)!;
    expect(store.cancel('one', now)).toMatchObject({ status: 'cancelling' });
    expect(store.cancelRequested('one', reservation.attempt.id)).toBe(true);
    expect(store.cancel('one', now)).toMatchObject({ status: 'cancelling' });
    expect(store.events('one').filter((event) => event.kind === 'cancel_requested')).toHaveLength(1);
    expect(store.requestForcedCancellation('one', 5000, now + 1)).toBe(true);
    expect(store.requestForcedCancellation('one', 5000, now + 2)).toBe(false);
    expect(store.events('one').filter((event) => event.kind === 'cancel_forced')).toHaveLength(1);
    store.beginCheckpoint(reservation.attempt.id, 'cancelled_by_operator', 0, now);
    store.settle(reservation.attempt.id, '', 'cancelled', 'cancelled_by_operator', 1000, now);
    expect(store.getTask('one').status).toBe('cancelled');
    expect(store.cancel('two', now).status).toBe('cancelled');
  } finally {
    close(root, db);
  }
});

test('retry requeues an inactive failed task without erasing its checkpoint or history', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'retry', title: 'retry', repoPath: root, workspacePath: join(root, 'retry'), now });
    const first = store.reserve('retry', [lane(now)], now)!;
    store.beginCheckpoint(first.attempt.id, 'fixture_failed', 0, now);
    store.settle(first.attempt.id, 'checkpoint-one', 'failed', 'fixture_failed', 1000, now + 1);

    const retried = store.retry('retry', now + 2);
    expect(retried).toMatchObject({
      status: 'queued',
      checkpoint: 'checkpoint-one',
      nextWakeAt: null,
    });
    expect(store.attempts('retry')).toHaveLength(1);
    expect(store.events('retry').at(-1)).toMatchObject({
      kind: 'retry_requested',
      detail: {
        previousStatus: 'failed',
        attemptCount: 1,
      },
    });
    expect(store.reserve('retry', [lane(now + 3)], now + 3)).not.toBeNull();
  } finally {
    close(root, db);
  }
});

test('retry rejects an active writer', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'active', title: 'active', repoPath: root, workspacePath: join(root, 'active'), now });
    store.reserve('active', [lane(now)], now);
    expect(() => store.retry('active', now + 1)).toThrow('active attempt');
  } finally {
    close(root, db);
  }
});

test('recovery closes an interrupted attempt, preserves its checkpoint and requeues the task', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    store.createTask({ id: 'recover', title: 'recover', repoPath: root, workspacePath: join(root, 'recover'), now });
    const budgetLane = lane(now, {
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 3_600_000 }],
    });
    const reservation = store.reserve('recover', [budgetLane], now, [budget])!;
    const recovered = store.recoverAttempt(reservation.attempt.id, {
      status: 'queued',
      checkpoint: 'checkpoint-recovered',
      reason: 'worker_restart_verified',
      detail: { ownerPid: 999_999, supervisorStop: { activeProcesses: 0 } },
      now: now + 10,
    });

    expect(recovered).toMatchObject({
      id: 'recover',
      status: 'queued',
      checkpoint: 'checkpoint-recovered',
      nextWakeAt: now + 10 + budget.windowMs,
    });
    expect(store.activeAttempt('recover')).toBeNull();
    expect(store.getAttempt(reservation.attempt.id)).toMatchObject({
      stage: 'done',
      checkpoint: 'checkpoint-recovered',
      endedAt: now + 10,
    });
    expect(store.budgetLease(reservation.attempt.id)).toMatchObject({
      amount: 0.6,
      state: 'pending',
      priced: false,
    });
    expect(store.events('recover').filter((event) => event.kind === 'attempt_recovered')).toHaveLength(1);
    expect(store.events('recover').find((event) => event.kind === 'recovery_cooldown')?.detail).toMatchObject({
      account: budget.account,
      until: now + 10 + budget.windowMs,
      reason: 'pending_budget_lease',
    });

    store.createTask({ id: 'cooldown-peer', title: 'peer', repoPath: root,
      workspacePath: join(root, 'cooldown-peer'), now });
    expect(store.reserve('cooldown-peer', [budgetLane], now + 11, [budget])).toBeNull();
    expect(store.getTask('cooldown-peer').nextWakeAt).toBe(now + 10 + budget.windowMs);
    expect(store.events('cooldown-peer').at(-1)?.detail).toMatchObject({
      filters: [{ laneId: budgetLane.id, reason: 'cooldown' }],
      retryAt: now + 10 + budget.windowMs,
    });

    store.recoverAttempt(reservation.attempt.id, {
      status: 'blocked',
      reason: 'duplicate',
      now: now + 20,
    });
    expect(store.getTask('recover').status).toBe('queued');
    expect(store.events('recover').filter((event) => event.kind === 'attempt_recovered')).toHaveLength(1);

    const resumed = store.reserve('recover', [budgetLane], now + 10 + budget.windowMs, [budget]);
    expect(resumed?.attempt).toMatchObject({ taskId: 'recover', account: budget.account });
  } finally {
    close(root, db);
  }
});

test('task IDs are restricted to safe reference characters', () => {
  const now = Date.now();
  const { root, db, store } = setup();
  try {
    expect(() => store.createTask({
      id: '../escape',
      title: 'bad',
      repoPath: root,
      workspacePath: join(root, 'bad'),
      now,
    })).toThrow('Task ID');
  } finally {
    close(root, db);
  }
});

test('idempotent task creation rejects a changed access mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-store-'));
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const input = {
      id: 'stable',
      title: 'stable task',
      repoPath: root,
      workspacePath: join(root, 'stable'),
      accessMode: 'write' as const,
    };
    expect(store.createTaskOnce(input)).toMatchObject({ created: true, task: { accessMode: 'write' } });
    expect(() => store.createTaskOnce({ ...input, accessMode: 'read_only' }))
      .toThrow('already exists with access mode write');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
