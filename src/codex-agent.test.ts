import { expect, test } from 'bun:test';
import type { AgentContext } from './agent';
import { CodexAppServerAgent, type CodexServer } from './codex-agent';
import type { Attempt, LaneConfig, Task } from './domain';

const lane: LaneConfig = {
  id: 'codex-magpie',
  agent: 'codex',
  model: 'opencode-go/deepseek-v4.1-flash',
  provider: 'magpie',
  account: 'magpie-default',
  priority: 1,
  slots: 1,
  windows: [],
  executable: 'codex-test',
};

const task: Task = {
  id: 'task',
  title: 'write result',
  prompt: 'Write the result into app.txt',
  repoPath: 'C:/repo',
  workspacePath: 'C:/work',
  status: 'running',
  priority: 0,
  critical: false,
  checkpoint: null,
  nextWakeAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const attempt: Attempt = {
  id: 1,
  taskId: 'task',
  laneId: lane.id,
  agent: 'codex',
  model: lane.model,
  provider: 'magpie',
  account: lane.account,
  stage: 'running',
  leaseToken: 'lease',
  actualModel: null,
  checkpoint: null,
  startedAt: 1,
  endedAt: null,
};

const context: AgentContext = {
  task,
  attempt,
  lane,
  workspacePath: 'C:/work',
  attemptDir: 'C:/attempt',
};

function fakeServer(calls: Array<{ method: string; params: unknown }>): CodexServer {
  return {
    stderr: '',
    async initialize() {
      return { value: {} };
    },
    async call(method: string, params?: unknown) {
      calls.push({ method, params });
      if (method === 'thread/start') return {
        value: { thread: { id: 'thread-1' }, model: 'opencode-go/deepseek-v4.1-flash', modelProvider: 'openai' },
      };
      if (method === 'turn/start') return { value: { turn: { id: 'turn-1' } } };
      return { value: {} };
    },
    async notification() {
      return { turn: { id: 'turn-1', status: 'completed' } };
    },
    async close() {},
  };
}

test('injects the task prompt, model and explicit base URL into App Server calls', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  let initArgs: string[] = [];
  const agent = new CodexAppServerAgent(
    { ...lane, baseUrl: 'http://127.0.0.1:3425/v1' },
    (_executable, args) => {
      initArgs = args;
      return fakeServer(calls);
    },
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'completed', exitCode: 0, fileWritten: true },
    }),
  );
  const result = await agent.run(context);
  expect(result).toMatchObject({
    status: 'completed',
    tests: 'not_run',
    activeProcesses: 0,
    actualModel: 'opencode-go/deepseek-v4.1-flash',
  });
  expect(initArgs).toContain('model="opencode-go/deepseek-v4.1-flash"');
  expect(initArgs).toContain('openai_base_url="http://127.0.0.1:3425/v1"');
  expect(calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    input: [{ type: 'text', text: task.prompt }],
  });
});

test('does not send a turn when the zero-inference preflight fails', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const agent = new CodexAppServerAgent(
    lane,
    () => fakeServer(calls),
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'error', exitCode: 127, fileWritten: false },
    }),
  );
  await expect(agent.run(context)).rejects.toThrow('preflight failed');
  expect(calls.some((call) => call.method === 'thread/start')).toBe(false);
  expect(calls.some((call) => call.method === 'turn/start')).toBe(false);
});
