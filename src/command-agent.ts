import type { AgentAdapter } from './agent';
import type { LaneConfig } from './domain';
import { launchSupervised, type SupervisorOutcome } from './supervisor';

function resultFrom(outcome: SupervisorOutcome | null, exitCode: number | null, cancelled: boolean) {
  if (cancelled) {
    return {
      status: 'cancelled' as const,
      reason: 'cancelled_by_operator',
      tests: 'not_run' as const,
    };
  }
  if (outcome?.kind === 'quota') {
    return {
      status: 'waiting_quota' as const,
      reason: outcome.reason ?? 'quota_exhausted',
      tests: 'not_run' as const,
      retryAfterMs: 60_000,
    };
  }
  if (outcome?.kind === 'failed' || exitCode !== 0) {
    return {
      status: 'failed' as const,
      reason: outcome?.reason ?? 'worker_exit',
      tests: outcome?.tests ?? 'failed',
    };
  }
  return {
    status: 'completed' as const,
    reason: outcome?.reason ?? 'worker_exit',
    tests: outcome?.tests ?? 'passed',
  };
}

export function supervisedCommandAgent(lane: LaneConfig): AgentAdapter {
  const command = lane.command;
  if (!command?.length) throw new Error(`Lane ${lane.id} has no command`);
  return {
    id: `command:${lane.id}`,
    async run(context) {
      const { stop, outcome } = await launchSupervised(command, context.workspacePath, context.attemptDir, {
        signal: context.signal,
      });
      const result = resultFrom(outcome, stop.exitCode, Boolean(context.signal?.aborted));
      return {
        ...result,
        activeProcesses: stop.activeProcesses,
      };
    },
  };
}
