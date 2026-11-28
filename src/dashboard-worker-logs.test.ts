import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dashboardWorkerRuns,
  MAX_DASHBOARD_WORKER_LOG_BYTES,
  readDashboardWorkerLog,
} from './dashboard-worker-logs';

test('worker runs group lifecycle events and sanitize exit errors', () => {
  const requestId = 'request-run-1';
  const runs = dashboardWorkerRuns([
    {
      id: 1,
      taskId: 'task',
      attemptId: null,
      kind: 'dashboard_action',
      detail: { action: 'start', requestId, now: 10 },
      createdAt: 10,
    },
    {
      id: 2,
      taskId: 'task',
      attemptId: null,
      kind: 'dashboard_worker_started',
      detail: { requestId, pid: 9001, now: 11 },
      createdAt: 11,
    },
    {
      id: 3,
      taskId: 'task',
      attemptId: null,
      kind: 'dashboard_worker_exited',
      detail: { requestId, pid: 9001, exitCode: 2, error: 'token=exit-secret', now: 12 },
      createdAt: 12,
    },
  ], undefined);
  expect(runs).toEqual([
    expect.objectContaining({
      requestId,
      state: 'failed',
      pid: 9001,
      exitCode: 2,
      requestedAt: 10,
      startedAt: 11,
      exitedAt: 12,
      logAvailable: false,
      error: 'token=[REDACTED]',
    }),
  ]);
});

test('worker logs keep only the sanitized tail', () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-worker-log-'));
  try {
    const directory = join(root, 'workers');
    mkdirSync(directory);
    const prefix = 'discarded-prefix\n'.repeat(4_096);
    const marker = `\u001b[32mtail\u001b[0m token=secret-value\n${'终'.repeat(20)}\n`;
    writeFileSync(join(directory, 'request-log-1.log'), prefix + marker, { mode: 0o600 });

    const log = readDashboardWorkerLog(directory, 'request-log-1');
    expect(log).toMatchObject({
      truncated: true,
      sourceBytes: Buffer.byteLength(prefix + marker),
    });
    expect(log!.bytes).toBeLessThanOrEqual(MAX_DASHBOARD_WORKER_LOG_BYTES);
    expect(log!.text).toContain('tail token=[REDACTED]');
    expect(log!.text).toContain('终'.repeat(20));
    expect(log!.text).not.toContain('\u001b');
    expect(log!.text).not.toContain('secret-value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('worker log reads refuse symbolic links', () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-worker-link-'));
  try {
    const directory = join(root, 'workers');
    mkdirSync(directory);
    const target = join(root, 'secret.txt');
    writeFileSync(target, 'token=must-not-be-served\n');
    symlinkSync(target, join(directory, 'request-link-1.log'));
    expect(readDashboardWorkerLog(directory, 'request-link-1')).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
