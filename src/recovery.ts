import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, QuotaFlowConfig } from './domain';
import type { TaskStore } from './store';
import { verifySupervisedStop, type SupervisorStop } from './supervisor';
import { checkpoint } from './worktree';

export interface AttemptOwner {
  pid: number;
  startedAt: number;
}

export interface RecoveryItem {
  taskId: string;
  attemptId: number;
  agent: Attempt['agent'];
  outcome: 'recovered' | 'blocked' | 'skipped' | 'error';
  reason: string;
  checkpoint?: string | null;
  ownerPid?: number | null;
  supervisorStop?: SupervisorStop | null;
  error?: string;
}

export interface RecoveryReport {
  items: RecoveryItem[];
  recovered: number;
  blocked: number;
  skipped: number;
  errors: number;
}

export interface RecoveryDependencies {
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
  verifyStop?: (statusDir: string) => SupervisorStop;
  snapshot?: typeof checkpoint;
}

export function attemptDirectory(
  config: Pick<QuotaFlowConfig, 'worktreeRoot'>,
  taskId: string,
  attemptId: number,
): string {
  return join(config.worktreeRoot, '.attempts', taskId, String(attemptId));
}

export function writeAttemptOwner(
  statusDir: string,
  pid = process.pid,
  startedAt = Date.now(),
): AttemptOwner {
  const owner = { pid, startedAt };
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, 'owner.json'), JSON.stringify(owner));
  return owner;
}

function readAttemptOwner(statusDir: string): AttemptOwner | null {
  const file = join(statusDir, 'owner.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AttemptOwner>;
    if (!Number.isInteger(parsed.pid) || typeof parsed.startedAt !== 'number') return null;
    return { pid: parsed.pid!, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(items: RecoveryItem[]): RecoveryReport {
  return {
    items,
    recovered: items.filter((item) => item.outcome === 'recovered').length,
    blocked: items.filter((item) => item.outcome === 'blocked').length,
    skipped: items.filter((item) => item.outcome === 'skipped').length,
    errors: items.filter((item) => item.outcome === 'error').length,
  };
}

export function recoverInterruptedAttempts(
  store: TaskStore,
  config: QuotaFlowConfig,
  dependencies: RecoveryDependencies = {},
): RecoveryReport {
  const now = dependencies.now ?? Date.now();
  const probe = dependencies.isProcessAlive ?? isProcessAlive;
  const verifyStop = dependencies.verifyStop ?? verifySupervisedStop;
  const snapshot = dependencies.snapshot ?? checkpoint;
  const items: RecoveryItem[] = [];

  for (const attempt of store.activeAttempts()) {
    const task = store.getTask(attempt.taskId);
    const cancellationRequested = store.cancelRequested(task.id, attempt.id);
    const statusDir = attemptDirectory(config, task.id, attempt.id);
    const owner = readAttemptOwner(statusDir);
    const ownerPid = owner?.pid ?? null;
    const ownerAlive = ownerPid === null ? null : probe(ownerPid);
    const launched = existsSync(join(statusDir, 'ready.json'));
    const stopPresent = existsSync(join(statusDir, 'stopped.json'));

    if (ownerAlive === true) {
      items.push({
        taskId: task.id,
        attemptId: attempt.id,
        agent: attempt.agent,
        outcome: 'skipped',
        reason: 'owner_alive',
        ownerPid,
      });
      continue;
    }

    let supervisorStop: SupervisorStop | null = null;
    let verificationError: string | null = null;
    if (launched || stopPresent) {
      try {
        supervisorStop = verifyStop(statusDir);
      } catch (error) {
        verificationError = message(error);
      }
    }

    if (!supervisorStop && (launched || stopPresent)) {
      try {
        store.recoverAttempt(attempt.id, {
          status: 'blocked',
          reason: 'writer_stop_unverified',
          detail: { ownerPid, verificationError },
          now,
        });
        items.push({
          taskId: task.id,
          attemptId: attempt.id,
          agent: attempt.agent,
          outcome: 'blocked',
          reason: 'writer_stop_unverified',
          ownerPid,
          error: verificationError ?? undefined,
        });
      } catch (error) {
        items.push({
          taskId: task.id,
          attemptId: attempt.id,
          agent: attempt.agent,
          outcome: 'error',
          reason: 'recovery_write_failed',
          ownerPid,
          error: message(error),
        });
      }
      continue;
    }

    if (!supervisorStop && ownerAlive === null) {
      if (cancellationRequested) {
        try {
          store.recoverAttempt(attempt.id, {
            status: 'blocked',
            reason: 'cancellation_writer_unverified',
            detail: { ownerPid, verificationError },
            now,
          });
          items.push({
            taskId: task.id,
            attemptId: attempt.id,
            agent: attempt.agent,
            outcome: 'blocked',
            reason: 'cancellation_writer_unverified',
            ownerPid,
            error: verificationError ?? undefined,
          });
        } catch (error) {
          items.push({
            taskId: task.id,
            attemptId: attempt.id,
            agent: attempt.agent,
            outcome: 'error',
            reason: 'recovery_write_failed',
            ownerPid,
            error: message(error),
          });
        }
        continue;
      }
      items.push({
        taskId: task.id,
        attemptId: attempt.id,
        agent: attempt.agent,
        outcome: 'skipped',
        reason: 'missing_owner_evidence',
        ownerPid,
      });
      continue;
    }

    const lane = config.lanes.find((candidate) => candidate.id === attempt.laneId);
    const supervisorBacked = Boolean(lane?.command?.length) || attempt.agent === 'opencode';
    if (!supervisorStop && !supervisorBacked) {
      try {
        store.recoverAttempt(attempt.id, {
          status: 'blocked',
          reason: 'writer_unverified',
          detail: { ownerPid, verificationError, adapter: attempt.agent },
          now,
        });
        items.push({
          taskId: task.id,
          attemptId: attempt.id,
          agent: attempt.agent,
          outcome: 'blocked',
          reason: 'writer_unverified',
          ownerPid,
          error: verificationError ?? undefined,
        });
      } catch (error) {
        items.push({
          taskId: task.id,
          attemptId: attempt.id,
          agent: attempt.agent,
          outcome: 'error',
          reason: 'recovery_write_failed',
          ownerPid,
          error: message(error),
        });
      }
      continue;
    }

    let checkpointSha = task.checkpoint;
    try {
      if (existsSync(task.workspacePath)) {
        checkpointSha = snapshot(task.workspacePath, config.worktreeRoot, task.id, attempt.id);
      }
    } catch (error) {
      try {
        store.recoverAttempt(attempt.id, {
          status: 'blocked',
          reason: 'recovery_checkpoint_failed',
          detail: {
            ownerPid,
            supervisorStop,
            error: message(error),
          },
          now,
        });
        items.push({
          taskId: task.id,
          attemptId: attempt.id,
          agent: attempt.agent,
          outcome: 'blocked',
          reason: 'recovery_checkpoint_failed',
          ownerPid,
          supervisorStop,
          error: message(error),
        });
      } catch (writeError) {
        items.push({
          taskId: task.id,
          attemptId: attempt.id,
          agent: attempt.agent,
          outcome: 'error',
          reason: 'recovery_write_failed',
          ownerPid,
          error: message(writeError),
        });
      }
      continue;
    }

    const reason = cancellationRequested
      ? 'cancellation_completed'
      : supervisorStop ? 'worker_restart_verified' : 'worker_restart_unlaunched';
    try {
      store.recoverAttempt(attempt.id, {
        status: cancellationRequested ? 'cancelled' : 'queued',
        checkpoint: checkpointSha,
        reason,
        detail: {
          ownerPid,
          supervisorStop,
          verificationError,
        },
        now,
      });
      items.push({
        taskId: task.id,
        attemptId: attempt.id,
        agent: attempt.agent,
        outcome: 'recovered',
        reason,
        checkpoint: checkpointSha,
        ownerPid,
        supervisorStop,
      });
    } catch (error) {
      items.push({
        taskId: task.id,
        attemptId: attempt.id,
        agent: attempt.agent,
        outcome: 'error',
        reason: 'recovery_write_failed',
        ownerPid,
        error: message(error),
      });
    }
  }

  return summarize(items);
}
