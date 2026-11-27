import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QuotaFlowConfig, Task, TaskStatus } from './domain';
import {
  attemptDirectory,
  recoverInterruptedAttempts,
  writeCancellationFlag,
  type RecoveryDependencies,
  type RecoveryReport,
} from './recovery';
import type { TaskStore } from './store';
import type { SupervisorStop } from './supervisor';

export type CancellationOutcome = 'cancelled' | 'timeout' | 'unverified' | 'not_cancelled';

export interface CancellationReport {
  task: Task;
  attemptId: number | null;
  cancellation: {
    outcome: CancellationOutcome;
    forced: boolean;
    waitMs: number;
    supervisorStop: SupervisorStop | null;
    recovery: RecoveryReport | null;
  };
}

export interface CancellationOptions {
  waitMs: number;
  force?: boolean;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  recovery?: RecoveryDependencies;
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'cancelled'
    || status === 'blocked'
    || status === 'completed'
    || status === 'failed';
}

function reportOutcome(status: TaskStatus): CancellationOutcome {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'unverified';
  if (status === 'completed' || status === 'failed') return 'not_cancelled';
  return 'timeout';
}

export async function waitForCancellation(
  store: TaskStore,
  config: QuotaFlowConfig,
  taskId: string,
  options: CancellationOptions,
): Promise<CancellationReport> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const forced = options.force ?? false;
  const requestedAt = clock();
  const initial = store.cancel(taskId, requestedAt);
  const attemptId = initial.status === 'cancelling'
    ? store.activeAttempt(taskId)?.id ?? null
    : null;

  let recovery: RecoveryReport | null = null;
  let supervisorStop: SupervisorStop | null = null;
  const stoppedPath = attemptId === null
    ? null
    : join(attemptDirectory(config, taskId, attemptId), 'stopped.json');

  if (forced && attemptId !== null) {
    store.requestForcedCancellation(taskId, options.waitMs, requestedAt);
    writeCancellationFlag(config, taskId, attemptId, {
      requestedAt,
      terminateOwner: true,
    });
  }

  const deadline = requestedAt + options.waitMs;
  while (attemptId !== null) {
    const current = store.getTask(taskId);
    if (isTerminal(current.status)) break;

    if (forced && stoppedPath && existsSync(stoppedPath)) {
      recovery = recoverInterruptedAttempts(store, config, {
        ...options.recovery,
        taskId,
        now: clock(),
        cancellationReason: 'cancellation_forced',
      });
      const item = recovery.items.find((candidate) => candidate.attemptId === attemptId);
      supervisorStop = item?.supervisorStop ?? supervisorStop;
      if (item?.outcome === 'blocked' || item?.outcome === 'error') break;
    }

    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await sleep(Math.min(50, remaining));
  }

  if (forced && attemptId !== null && recovery === null) {
    recovery = recoverInterruptedAttempts(store, config, {
      ...options.recovery,
      taskId,
      now: clock(),
      cancellationReason: 'cancellation_forced',
    });
    const item = recovery.items.find((candidate) => candidate.attemptId === attemptId);
    supervisorStop = item?.supervisorStop ?? supervisorStop;
  }

  const task = store.getTask(taskId);
  return {
    task,
    attemptId,
    cancellation: {
      outcome: reportOutcome(task.status),
      forced,
      waitMs: options.waitMs,
      supervisorStop,
      recovery,
    },
  };
}
