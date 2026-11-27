import { CodexAppServerAgent } from './codex-agent';
import { supervisedCommandAgent } from './command-agent';
import { OpenCodeAgent } from './opencode-agent';
import type { AgentAdapter } from './agent';
import type { LaneConfig } from './domain';

export function agentForLane(lane: LaneConfig): AgentAdapter | undefined {
  if (lane.command?.length) return supervisedCommandAgent(lane);
  if (lane.agent === 'codex') return new CodexAppServerAgent(lane);
  if (lane.agent === 'opencode') return new OpenCodeAgent(lane);
  return undefined;
}
