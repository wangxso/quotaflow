import type { Attempt, LaneConfig, Task, UsageReport } from './domain';

export interface AgentContext {
  task: Task;
  attempt: Attempt;
  lane: LaneConfig;
  workspacePath: string;
  attemptDir: string;
}

export interface AgentResult {
  status: 'completed' | 'failed' | 'waiting_quota' | 'cancelled';
  reason: string;
  tests: 'passed' | 'failed' | 'not_run';
  retryAfterMs?: number;
  activeProcesses?: number;
  actualModel?: string;
  usage?: UsageReport;
}

export interface AgentAdapter {
  id: string;
  run(context: AgentContext): Promise<AgentResult>;
}

export type AgentFactory = (lane: LaneConfig) => AgentAdapter | undefined;
