import { existsSync } from 'node:fs';
import {
  ProcessStopUnverifiedError,
  type AgentAdapter,
  type AgentFactory,
  type AgentResult,
} from './agent';
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
  assertSeparateAttemptDirectory,
  handoffProtection,
  HandoffSetupError,
  prepareHandoff,
  readHandoffDraft,
  type HandoffContext,
} from './handoff';
import {
  attemptDirectory,
  recoverInterruptedAttempts,
  writeAttemptOwner,
} from './recovery';
import { hasSupervisorEvidence, verifySupervisedStop } from './supervisor';
import { checkpoint, ensureWorktree, ProtectedPathsChangedError, verifyProtectedPaths } from './worktree';

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
    const protection = handoffProtection(task);
    let handoff: HandoffContext | undefined;
    let result: AgentResult | undefined;
    let started = false;
    let verifiedStop = false;
    let failure: { error: unknown } | undefined;

    try {
      ensureWorktree(task.repoPath, task.workspacePath, task.checkpoint ?? 'HEAD');
      if (task.handoff) {
        assertSeparateAttemptDirectory(task.workspacePath, statusDir);
        if (protection) verifyProtectedPaths(task.workspacePath, config.worktreeRoot, protection);
        const source = store.handoffForCheckpoint(task.id, task.checkpoint);
        handoff = prepareHandoff(task, statusDir, source, agent.maxPromptLength);
        if (task.checkpoint) store.recordHandoffInput(attempt, task.checkpoint, handoff?.source ?? null, clock());
      }
      started = true;
      result = await agent.run({
        task,
        attempt,
        lane,
        workspacePath: task.workspacePath,
        attemptDir: statusDir,
        ...(handoff ? { handoff } : {}),
        signal: cancellation.signal,
      });
      if ((result.activeProcesses ?? 0) !== 0) {
        throw new ProcessStopUnverifiedError('Agent left active processes after returning');
      }
      verifiedStop = result.activeProcesses === 0;
    } catch (error) {
      failure = { error };
      if (task.handoff && started && !(error instanceof ProcessStopUnverifiedError) && hasSupervisorEvidence(statusDir)) {
        try {
          verifySupervisedStop(statusDir);
          verifiedStop = true;
        } catch (stopError) {
          failure = { error: new ProcessStopUnverifiedError(errorMessage(stopError)) };
        }
      }
    }

    if (failure?.error instanceof ProcessStopUnverifiedError) {
      const blocked = store.block(task.id, 'process_stop_unverified', finishedAt(), { attemptId: attempt.id });
      return {
        task: blocked,
        attempt: store.getAttempt(attempt.id),
        agent: agent.id,
        agentStatus: 'failed',
        actualModel: null,
        usageStatus: null,
        usage: [],
        checkpoint: blocked.checkpoint,
        error: errorMessage(failure.error),
      };
    }

    let checkpointSha = task.checkpoint ?? '';
    let published = false;
    const maySnapshot = !failure || (existsSync(task.workspacePath) && (!task.handoff || started));
    if (maySnapshot) {
      try {
        checkpointSha = checkpoint(task.workspacePath, config.worktreeRoot, task.id, attempt.id, protection);
        published = true;
      } catch (error) {
        if (!failure || error instanceof ProtectedPathsChangedError) failure = { error };
      }
    }

    const settledAt = finishedAt();
    const cancelled = cancellation.signal.aborted || store.cancelRequested(task.id, attempt.id);
    const error = failure?.error;
    const protectedPaths = error instanceof ProtectedPathsChangedError ? error.paths : null;
    const rejection = protectedPaths ? 'handoff_protected_paths_changed'
      : error instanceof HandoffSetupError ? 'handoff_setup_failed' : null;
    if (task.handoff && !started && failure) store.releaseBudgetLease(attempt.id, rejection ?? 'worker_error', settledAt);
    const reason = cancelled ? 'cancelled_by_operator' : rejection ?? (failure ? 'worker_error' : result?.reason ?? 'worker_error');
    const agentStatus: AgentResult['status'] = cancelled ? 'cancelled' : failure ? 'failed' : result?.status ?? 'failed';
    const status: TaskStatus = rejection && !cancelled ? 'blocked' : agentStatus;
    if (!rejection) {
      store.beginCheckpoint(attempt.id, reason, 0, settledAt);
    }
    const usage = !failure || rejection ? result?.usage : undefined;
    const savedHandoff = handoff && verifiedStop && published ? readHandoffDraft(statusDir) : undefined;
    const settled = store.settle(
      attempt.id,
      checkpointSha,
      status,
      reason,
      failure ? 1000 : result?.retryAfterMs ?? 1000,
      settledAt,
      !failure || rejection ? result?.actualModel : undefined,
      usage,
      {
        preserveCheckpoint: Boolean(rejection),
        handoff: savedHandoff,
        ...(rejection ? { detail: { checkpointRejected: rejection, ...(protectedPaths ? { protectedPaths } : {}) } } : {}),
      },
    );
    const settledAttempt = store.getAttempt(attempt.id);
    return {
      task: settled,
      attempt: settledAttempt,
      agent: agent.id,
      agentStatus,
      actualModel: settledAttempt.actualModel,
      usageStatus: usage?.status ?? null,
      usage: store.usage(attempt.id),
      checkpoint: settled.checkpoint,
      ...(failure ? { error: errorMessage(failure.error) } : {}),
    };
  } finally {
    clearInterval(cancellationWatcher);
  }
}
