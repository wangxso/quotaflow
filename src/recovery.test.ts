import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuotaFlowConfig } from './domain';
import { openDatabase } from './db';
import {
  attemptDirectory,
  recoverInterruptedAttempts,
  writeAttemptOwner,
} from './recovery';
import { TaskStore } from './store';
import { supervisorLaunchFile } from './supervisor';
import { ensureWorktree, worktreeGit } from './worktree';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-recovery-'));
  const repo = join(root, 'repo');
  worktreeGit(root, ['init', '--initial-branch=main', repo]);
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  worktreeGit(repo, ['add', '.']);
  worktreeGit(repo, ['commit', '-m', 'base']);
  const now = Date.now();
  const config: QuotaFlowConfig = {
    version: 1,
    database: ':memory:',
    worktreeRoot: join(root, 'worktrees'),
    routing: { allowedProviders: ['local'] },
    lanes: [{
      id: 'fixture',
      agent: 'codex',
      model: 'fixture-model',
      provider: 'local',
      account: 'fixture-account',
      priority: 1,
      slots: 1,
      windows: [{ key: 'day', remaining: 10, reserve: 0, observedAt: now - 1000, resetAt: now + 60_000 }],
    }],
  };
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  return { root, repo, now, config, db, store };
}

test('verified supervisor stop checkpoints the interrupted workspace and requeues the task', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    store.createTask({
      id: 'recover',
      title: 'recover',
      repoPath: repo,
      workspacePath: join(root, 'recover'),
      now,
    });
    const reservation = store.reserve('recover', config.lanes, now)!;
    const workspace = ensureWorktree(repo, join(root, 'recover'));
    writeFileSync(join(workspace, 'app.txt'), 'partial\n');
    const statusDir = attemptDirectory(config, 'recover', reservation.attempt.id);
    writeAttemptOwner(statusDir, 999_999, now);
    writeFileSync(join(statusDir, 'ready.json'), '{}');

    const report = recoverInterruptedAttempts(store, config, {
      now: now + 10,
      isProcessAlive: () => false,
      verifyStop: () => ({
        supervisorPid: 1,
        workerPid: 2,
        exitCode: null,
        activeProcesses: 0,
        reason: 'controller_closed',
      }),
    });

    expect(report).toMatchObject({ recovered: 1, blocked: 0, skipped: 0, errors: 0 });
    expect(store.getTask('recover')).toMatchObject({ status: 'queued' });
    expect(store.activeAttempt('recover')).toBeNull();
    const recovered = store.getAttempt(reservation.attempt.id);
    expect(recovered.stage).toBe('done');
    expect(recovered.checkpoint).toBeTruthy();
    expect(worktreeGit(workspace, ['show', `${recovered.checkpoint}:app.txt`])).toBe('partial');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unverified Codex writer blocks recovery instead of transferring write access', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    store.createTask({
      id: 'unverified',
      title: 'unverified',
      repoPath: repo,
      workspacePath: join(root, 'unverified'),
      now,
    });
    const reservation = store.reserve('unverified', config.lanes, now)!;
    writeAttemptOwner(
      attemptDirectory(config, 'unverified', reservation.attempt.id),
      999_999,
      now,
    );

    const report = recoverInterruptedAttempts(store, config, {
      now: now + 10,
      isProcessAlive: () => false,
    });

    expect(report).toMatchObject({ recovered: 0, blocked: 1, skipped: 0, errors: 0 });
    expect(store.getTask('unverified')).toMatchObject({
      status: 'blocked',
      checkpoint: null,
    });
    expect(store.activeAttempt('unverified')).toBeNull();
    expect(store.events('unverified').at(-1)?.detail).toMatchObject({
      reason: 'writer_unverified',
      recovered: true,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a launch intent retains the writer claim until the stop receipt arrives', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    config.lanes[0].command = ['fixture'];
    const workspace = ensureWorktree(repo, join(root, 'in-flight'));
    store.createTask({
      id: 'in-flight',
      title: 'interrupted during launch',
      repoPath: repo,
      workspacePath: workspace,
      now,
    });
    const { attempt } = store.reserve('in-flight', config.lanes, now)!;
    const status = attemptDirectory(config, 'in-flight', attempt.id);
    writeAttemptOwner(status, 999_999, now);
    writeFileSync(join(status, supervisorLaunchFile), '{}');
    writeFileSync(join(workspace, 'app.txt'), 'partial\n');
    const recover = () => recoverInterruptedAttempts(store, config, { isProcessAlive: () => false });

    expect(recover().items[0]).toMatchObject({ outcome: 'blocked', reason: 'writer_stop_unverified' });
    expect(store.getTask('in-flight')).toMatchObject({ status: 'blocked', checkpoint: null });
    expect(store.activeAttempt('in-flight')?.id).toBe(attempt.id);
    expect(() => store.retry('in-flight')).toThrow('active attempt');

    writeFileSync(join(status, 'stopped.json'), JSON.stringify({
      supervisorPid: 100,
      workerPid: 101,
      exitCode: null,
      activeProcesses: 0,
      reason: 'controller_closed',
    }));
    expect(recover().items[0]).toMatchObject({ outcome: 'recovered', reason: 'worker_restart_verified' });
    const task = store.getTask('in-flight');
    expect(task.status).toBe('queued');
    expect(store.activeAttempt('in-flight')).toBeNull();
    expect(worktreeGit(workspace, ['show', `${task.checkpoint}:app.txt`])).toBe('partial');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pending cancellation is honored after a verified worker restart', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    store.createTask({
      id: 'cancel-recover',
      title: 'cancel after restart',
      repoPath: repo,
      workspacePath: join(root, 'cancel-recover'),
      now,
    });
    const reservation = store.reserve('cancel-recover', config.lanes, now)!;
    const workspace = ensureWorktree(repo, join(root, 'cancel-recover'));
    writeFileSync(join(workspace, 'app.txt'), 'partial\n');
    const statusDir = attemptDirectory(config, 'cancel-recover', reservation.attempt.id);
    writeAttemptOwner(statusDir, 999_999, now);
    writeFileSync(join(statusDir, 'ready.json'), '{}');
    store.cancel('cancel-recover', now + 1);

    const report = recoverInterruptedAttempts(store, config, {
      now: now + 10,
      isProcessAlive: () => false,
      verifyStop: () => ({
        supervisorPid: 1,
        workerPid: 2,
        exitCode: null,
        activeProcesses: 0,
        reason: 'controller_closed',
      }),
    });

    expect(report).toMatchObject({ recovered: 1, blocked: 0, skipped: 0, errors: 0 });
    const cancelledTask = store.getTask('cancel-recover');
    expect(cancelledTask.status).toBe('cancelled');
    expect(typeof cancelledTask.checkpoint).toBe('string');
    expect(store.events('cancel-recover').find((event) => event.kind === 'attempt_recovered')?.detail)
      .toMatchObject({ reason: 'cancellation_completed', status: 'cancelled' });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live worker owner is not preempted', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    store.createTask({
      id: 'live',
      title: 'live',
      repoPath: repo,
      workspacePath: join(root, 'live'),
      now,
    });
    const reservation = store.reserve('live', config.lanes, now)!;
    writeAttemptOwner(
      attemptDirectory(config, 'live', reservation.attempt.id),
      process.pid,
      now,
    );

    const report = recoverInterruptedAttempts(store, config, {
      now: now + 10,
      isProcessAlive: () => true,
    });

    expect(report).toMatchObject({ recovered: 0, blocked: 0, skipped: 1, errors: 0 });
    expect(store.getTask('live').status).toBe('running');
    expect(store.activeAttempt('live')?.id).toBe(reservation.attempt.id);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('targeted recovery does not touch an unrelated active attempt', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    for (const id of ['target', 'other']) {
      store.createTask({
        id,
        title: id,
        repoPath: repo,
        workspacePath: join(root, id),
        now,
      });
    }
    const target = store.reserve('target', config.lanes, now)!;
    const other = store.reserve('other', [{
      ...config.lanes[0],
      id: 'other-lane',
      account: 'other-account',
    }], now)!;
    for (const [taskId, attemptId] of [
      ['target', target.attempt.id],
      ['other', other.attempt.id],
    ] as const) {
      const statusDir = attemptDirectory(config, taskId, attemptId);
      writeAttemptOwner(statusDir, 999_999, now);
      writeFileSync(join(statusDir, 'ready.json'), '{}');
    }

    const report = recoverInterruptedAttempts(store, config, {
      now: now + 10,
      taskId: 'target',
      isProcessAlive: () => false,
      verifyStop: () => ({
        supervisorPid: 1,
        workerPid: 2,
        exitCode: null,
        activeProcesses: 0,
        reason: 'controller_closed',
      }),
    });

    expect(report).toMatchObject({ recovered: 1, blocked: 0, skipped: 0, errors: 0 });
    expect(store.getTask('target').status).toBe('queued');
    expect(store.getTask('other').status).toBe('running');
    expect(store.activeAttempt('other')?.id).toBe(other.attempt.id);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a low-level reservation without owner evidence is left untouched', () => {
  const { root, repo, now, config, db, store } = setup();
  try {
    store.createTask({
      id: 'unowned',
      title: 'unowned',
      repoPath: repo,
      workspacePath: join(root, 'unowned'),
      now,
    });
    const reservation = store.reserve('unowned', config.lanes, now)!;

    const report = recoverInterruptedAttempts(store, config, {
      now: now + 10,
      isProcessAlive: () => false,
    });

    expect(report).toMatchObject({ recovered: 0, blocked: 0, skipped: 1, errors: 0 });
    expect(report.items[0]).toMatchObject({ reason: 'missing_owner_evidence' });
    expect(store.getTask('unowned').status).toBe('running');
    expect(store.activeAttempt('unowned')?.id).toBe(reservation.attempt.id);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
