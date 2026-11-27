import { expect, test } from 'bun:test';
import { ProcessStopUnverifiedError, type AgentContext } from './agent';
import { CodexAppServerAgent, type CodexServer } from './codex-agent';
import type { Attempt, LaneConfig, Task } from './domain';
import type { SupervisorStop } from './supervisor';

const stopReceipt: SupervisorStop = {
  supervisorPid: 1,
  workerPid: 2,
  exitCode: 0,
  activeProcesses: 0,
  reason: 'worker_exit',
};

const verifyStop = () => stopReceipt;

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
  accessMode: 'write',
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
    async notification(method: string) {
      if (method === 'item/completed') {
        return { turnId: 'turn-1', item: { type: 'agentMessage', text: 'Review complete' } };
      }
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
    verifyStop,
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

test('enforces a read-only workspace and captures the final review report', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  let preflightOptions: { readOnly?: boolean } | undefined;
  const agent = new CodexAppServerAgent(
    lane,
    () => fakeServer(calls),
    async (_server, _workspace, options) => {
      preflightOptions = options;
      return {
        inferenceCalls: 0,
        commandExec: { status: 'completed', exitCode: 0, fileWritten: false, workspaceRead: true },
      };
    },
    verifyStop,
  );
  const result = await agent.run({
    ...context,
    task: { ...task, accessMode: 'read_only' },
  });
  expect(preflightOptions).toEqual({ readOnly: true });
  expect(calls.find((call) => call.method === 'thread/start')?.params)
    .toMatchObject({ sandbox: 'read-only' });
  expect(calls.find((call) => call.method === 'turn/start')?.params)
    .toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  expect(result).toMatchObject({ output: 'Review complete', status: 'completed' });
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
    verifyStop,
  );
  await expect(agent.run(context)).rejects.toThrow('preflight failed');
  expect(calls.some((call) => call.method === 'thread/start')).toBe(false);
  expect(calls.some((call) => call.method === 'turn/start')).toBe(false);
});

test('uses the handoff prompt and grants a dedicated writable directory for its draft', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const agent = new CodexAppServerAgent(
    lane,
    () => fakeServer(calls),
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'completed', exitCode: 0, fileWritten: true },
    }),
    verifyStop,
  );
  const handoff = { directory: 'C:/attempt/handoff', file: 'C:/attempt/handoff/draft.json',
    prompt: 'Task plus verified handoff notes', source: null };
  await agent.run({ ...context, handoff });
  expect(calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    input: [{ type: 'text', text: handoff.prompt }],
    sandboxPolicy: { writableRoots: [context.workspacePath, handoff.directory] },
  });
});

test('cancellation interrupts the active turn and closes the server', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = fakeServer(calls);
  server.notification = async () => new Promise(() => {});
  let closed = false;
  server.close = async () => { closed = true; };
  const agent = new CodexAppServerAgent(
    lane,
    () => server,
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'completed', exitCode: 0, fileWritten: true },
    }),
    verifyStop,
  );
  const controller = new AbortController();
  const running = agent.run({ ...context, signal: controller.signal });
  const deadline = Date.now() + 1_000;
  while (!calls.some((call) => call.method === 'turn/start') && Date.now() < deadline) {
    await Bun.sleep(1);
  }
  controller.abort();
  const result = await running;
  expect(result).toMatchObject({
    status: 'cancelled',
    reason: 'cancelled_by_operator',
    tests: 'not_run',
    activeProcesses: 0,
  });
  expect(calls.some((call) => call.method === 'turn/interrupt')).toBe(true);
  expect(closed).toBe(true);
});

test('requires an independent stop verifier for a custom Codex server', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = fakeServer(calls);
  const agent = new CodexAppServerAgent(
    lane,
    () => server,
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'completed', exitCode: 0, fileWritten: true },
    }),
    () => { throw new Error('no stop receipt'); },
  );

  await expect(agent.run(context)).rejects.toBeInstanceOf(ProcessStopUnverifiedError);
});

test('refuses a stop receipt that still reports active processes', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = fakeServer(calls);
  const agent = new CodexAppServerAgent(
    lane,
    () => server,
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'completed', exitCode: 0, fileWritten: true },
    }),
    () => ({ ...stopReceipt, exitCode: null, activeProcesses: 1, reason: 'controller_closed' }),
  );

  await expect(agent.run(context)).rejects.toBeInstanceOf(ProcessStopUnverifiedError);
});

test('rejects a malformed custom stop receipt', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const agent = new CodexAppServerAgent(
    lane,
    () => fakeServer(calls),
    async () => ({
      inferenceCalls: 0,
      commandExec: { status: 'completed', exitCode: 0, fileWritten: true },
    }),
    () => ({ ...stopReceipt, supervisorPid: 0 }),
  );

  await expect(agent.run(context)).rejects.toBeInstanceOf(ProcessStopUnverifiedError);
});
