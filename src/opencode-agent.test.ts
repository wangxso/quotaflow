import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from './agent';
import type { Attempt, LaneConfig, Task, UsageReport } from './domain';
import { OpenCodeAgent, type OpenCodeRunner, type OpenCodeUsageLookup } from './opencode-agent';

const lane: LaneConfig = {
  id: 'opencode-magpie',
  agent: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  provider: 'magpie',
  account: 'magpie-default',
  priority: 1,
  slots: 1,
  windows: [],
  executable: 'opencode-test',
  baseUrl: 'http://127.0.0.1:3425/v1/',
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
  agent: 'opencode',
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

function context(root: string): AgentContext {
  return {
    task,
    attempt,
    lane,
    workspacePath: join(root, 'workspace'),
    attemptDir: join(root, 'attempt'),
  };
}

function runnerWith(output: string, exitCode = 0): OpenCodeRunner {
  return async (_command, _cwd, statusDir) => {
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(join(statusDir, 'worker.log'), output);
    return {
      stop: { supervisorPid: 1, workerPid: 2, exitCode, activeProcesses: 0, reason: 'worker_exit' },
      outcome: null,
    };
  };
}

function usageReport(servedModel = 'hy4-flash-free'): UsageReport {
  return {
    source: 'magpie',
    status: 'recorded',
    sessionId: 'session-1',
    queryWindow: { start: 1, end: 2 },
    rows: [{
      source: 'magpie',
      sourceRequestId: 'request-1',
      observedAt: 1,
      provider: 'opencode-go',
      providerName: 'OpenCode Go',
      agent: 'opencode',
      sessionId: 'session-1',
      requestModel: 'opencode-go/deepseek-v4.1-flash',
      servedModel,
      httpStatus: 200,
      stopReason: 'stop',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costEstimate: 0,
      priced: true,
      providerInvoice: 'UNKNOWN',
    }],
    actualModel: servedModel,
    costEstimate: 0,
    priced: true,
    providerInvoice: 'UNKNOWN',
  };
}

test('runs OpenCode with isolated Magpie config and parses JSON events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-opencode-'));
  try {
    let command: string[] = [];
    let environment: NodeJS.ProcessEnv = {};
    let timeoutMs: number | undefined;
    const output = [
      'diagnostic line',
      JSON.stringify({ type: 'step_start', sessionID: 'session-1' }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'session-1',
        part: {
          type: 'step-finish',
          reason: 'stop',
          model: 'deepseek-v4.1-flash',
          tokens: { total: 42 },
          cost: 0.001,
        },
      }),
    ].join('\n');
    let usageInput: Parameters<OpenCodeUsageLookup>[0] | undefined;
    const agent = new OpenCodeAgent(
      lane,
      async (args, _cwd, statusDir, options) => {
        command = args;
        environment = options?.env ?? {};
        timeoutMs = options?.timeoutMs;
        mkdirSync(statusDir, { recursive: true });
        writeFileSync(join(statusDir, 'worker.log'), output);
        return {
          stop: { supervisorPid: 1, workerPid: 2, exitCode: 0, activeProcesses: 0, reason: 'worker_exit' },
          outcome: null,
        };
      },
      async (input) => {
        usageInput = input;
        return usageReport();
      },
    );

    const result = await agent.run(context(root));
    expect(result).toMatchObject({
      status: 'completed',
      reason: 'opencode_run_completed',
      tests: 'not_run',
      activeProcesses: 0,
      actualModel: 'hy4-flash-free',
      usage: {
        status: 'recorded',
        sessionId: 'session-1',
        actualModel: 'hy4-flash-free',
        providerInvoice: 'UNKNOWN',
      },
    });
    expect(usageInput).toMatchObject({
      baseUrl: 'http://127.0.0.1:3425/v1/',
      sessionId: 'session-1',
    });
    expect(command).toEqual([
      'opencode-test',
      'run',
      '--pure',
      '--format',
      'json',
      '--model',
      'magpie/opencode-go/deepseek-v4.1-flash',
      '--dir',
      join(root, 'workspace'),
      task.prompt,
    ]);
    expect(timeoutMs).toBe(300_000);
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(environment.XDG_CONFIG_HOME).toContain(join('attempt', 'opencode', 'config'));
    const config = JSON.parse(readFileSync(String(environment.OPENCODE_CONFIG), 'utf8'));
    expect(config).toMatchObject({
      enabled_providers: ['magpie'],
      model: 'magpie/opencode-go/deepseek-v4.1-flash',
      share: 'disabled',
      permission: {
        edit: 'allow',
        external_directory: 'deny',
        webfetch: 'deny',
      },
      provider: {
        magpie: {
          options: {
            baseURL: 'http://127.0.0.1:3425/v1',
            apiKey: 'magpie',
          },
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps a completed task when Magpie usage reconciliation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-opencode-'));
  try {
    const output = [
      JSON.stringify({ type: 'step_start', sessionID: 'session-1' }),
      JSON.stringify({ type: 'step_finish', sessionID: 'session-1', part: { reason: 'stop' } }),
    ].join('\n');
    const agent = new OpenCodeAgent(
      lane,
      runnerWith(output),
      async () => {
        throw new Error('usage endpoint unavailable');
      },
    );
    const result = await agent.run(context(root));
    expect(result).toMatchObject({
      status: 'completed',
      reason: 'opencode_run_completed',
      usage: {
        status: 'unavailable',
        sessionId: 'session-1',
        error: 'usage endpoint unavailable',
        providerInvoice: 'UNKNOWN',
      },
    });
    expect(result.actualModel).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classifies OpenCode quota failures for retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-opencode-'));
  try {
    const agent = new OpenCodeAgent(lane, runnerWith('429 usage limit reached\n', 1));
    const result = await agent.run(context(root));
    expect(result).toMatchObject({
      status: 'waiting_quota',
      reason: 'opencode_quota',
      retryAfterMs: 60_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects OpenCode output without a completed step', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-opencode-'));
  try {
    const agent = new OpenCodeAgent(lane, runnerWith(JSON.stringify({ type: 'step_start' })));
    const result = await agent.run(context(root));
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'opencode_missing_step_finish',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
