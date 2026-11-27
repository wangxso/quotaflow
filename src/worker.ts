import { existsSync } from 'node:fs';
import type { AgentAdapter, AgentFactory, AgentResult } from './agent';
import type {
  Attempt,
  AttemptUsageRecord,
  LaneConfig,
  QuotaFlowConfig,
  Task,
  TaskStatus,
  UsageStatus,
} from './domain';
import { reserveNext } from './scheduler';
import type { TaskStore } from './store';
import {
  attemptDirectory,
  recoverInterruptedAttempts,
  writeAttemptOwner,
} from './recovery';
import { checkpoint, ensureWorktree } from './worktree';

export interface WorkerResult {
  task: Task;
  attempt: Attempt;
  agent: string;
  agentStatus: AgentResult['status'];
  actualModel: string | null;
  usageStatus: UsageStatus | null;
  usage: AttemptUsageRecord[];
  checkpoint: string | null;
  error?: string;
}

function targetStatus(result: AgentResult): TaskStatus {
  if (result.status === 'completed') return 'completed';
  if (result.status === 'waiting_quota') return 'waiting_quota';
  if (result.status === 'cancelled') return 'cancelled';
  return 'failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runOnce(
  store: TaskStore,
  config: QuotaFlowConfig,
  agentFor: AgentFactory,
  clock: () => number = Date.now,
): Promise<WorkerResult | null> {
  if (store.activeAttempts().length > 0) {
    recoverInterruptedAttempts(store, config, { now: clock() });
  }
  const reservedAt = clock();
  const reservation = reserveNext(store, config.lanes, reservedAt, config.budgets);
  if (!reservation) return null;
  const attempt = reservation.attempt;
  const finishedAt = () => Math.max(attempt.startedAt, clock());
  const task = store.getTask(attempt.taskId);
  const statusDir = attemptDirectory(config, task.id, attempt.id);
  writeAttemptOwner(statusDir, process.pid, reservedAt);
  const lane = config.lanes.find((candidate) => candidate.id === attempt.laneId);
  if (!lane) {
    const settledAt = finishedAt();
    store.releaseBudgetLease(attempt.id, 'unknown_lane', settledAt);
    store.beginCheckpoint(attempt.id, 'unknown_lane', 0, settledAt);
    const settled = store.settle(attempt.id, task.checkpoint ?? '', 'blocked', 'unknown_lane', 1000, settledAt);
    return {
      task: settled,
      attempt: store.getAttempt(attempt.id),
      agent: 'none',
      agentStatus: 'failed',
      actualModel: null,
      usageStatus: null,
      usage: [],
      checkpoint: task.checkpoint,
      error: 'unknown lane',
    };
  }

  const agent = agentFor(lane);
  if (!agent) {
    const settledAt = finishedAt();
    store.releaseBudgetLease(attempt.id, 'missing_agent_adapter', settledAt);
    store.beginCheckpoint(attempt.id, 'missing_agent_adapter', 0, settledAt);
    const settled = store.settle(attempt.id, task.checkpoint ?? '', 'blocked', 'missing_agent_adapter', 1000, settledAt);
    return {
      task: settled,
      attempt: store.getAttempt(attempt.id),
      agent: 'none',
      agentStatus: 'failed',
      actualModel: null,
      usageStatus: null,
      usage: [],
      checkpoint: task.checkpoint,
      error: `No agent adapter for lane ${lane.id}`,
    };
  }

  const cancellation = new AbortController();
  const observeCancellation = () => {
    if (!cancellation.signal.aborted && store.cancelRequested(task.id, attempt.id)) {
      cancellation.abort();
    }
  };
  observeCancellation();
  const cancellationWatcher = setInterval(observeCancellation, 100);

  try {
    ensureWorktree(task.repoPath, task.workspacePath, task.checkpoint ?? 'HEAD');
    const result = await agent.run({
      task,
      attempt,
      lane,
      workspacePath: task.workspacePath,
      attemptDir: statusDir,
      signal: cancellation.signal,
    });
    if ((result.activeProcesses ?? 0) !== 0) throw new Error('Agent left active processes after returning');
    const cancelled = cancellation.signal.aborted || store.cancelRequested(task.id, attempt.id);
    const checkpointSha = checkpoint(task.workspacePath, config.worktreeRoot, task.id, attempt.id);
    const settledAt = finishedAt();
    const reason = cancelled ? 'cancelled_by_operator' : result.reason;
    const agentStatus: AgentResult['status'] = cancelled ? 'cancelled' : result.status;
    store.beginCheckpoint(attempt.id, reason, result.activeProcesses ?? 0, settledAt);
    const settled = store.settle(
      attempt.id,
      checkpointSha,
      cancelled ? 'cancelled' : targetStatus(result),
      reason,
      result.retryAfterMs ?? 1000,
      settledAt,
      result.actualModel,
      result.usage,
    );
    const settledAttempt = store.getAttempt(attempt.id);
    return {
      task: settled,
      attempt: settledAttempt,
      agent: agent.id,
      agentStatus,
      actualModel: settledAttempt.actualModel,
      usageStatus: result.usage?.status ?? null,
      usage: store.usage(attempt.id),
      checkpoint: checkpointSha,
    };
  } catch (error) {
    let checkpointSha = task.checkpoint ?? '';
    try {
      if (existsSync(task.workspacePath)) {
        checkpointSha = checkpoint(task.workspacePath, config.worktreeRoot, task.id, attempt.id);
      }
    } catch {
      checkpointSha = task.checkpoint ?? '';
    }
    const settledAt = finishedAt();
    const cancelled = cancellation.signal.aborted || store.cancelRequested(task.id, attempt.id);
    const reason = cancelled ? 'cancelled_by_operator' : 'worker_error';
    try {
      store.beginCheckpoint(attempt.id, reason, 0, settledAt);
    } catch {
      // The settlement below is still authoritative if the attempt already moved on.
    }
    const settled = store.settle(
      attempt.id,
      checkpointSha,
      cancelled ? 'cancelled' : 'failed',
      reason,
      1000,
      settledAt,
    );
    return {
      task: settled,
      attempt: store.getAttempt(attempt.id),
      agent: agent.id,
      agentStatus: cancelled ? 'cancelled' : 'failed',
      actualModel: null,
      usageStatus: null,
      usage: [],
      checkpoint: checkpointSha || null,
      error: errorMessage(error),
    };
  } finally {
    clearInterval(cancellationWatcher);
  }
}
