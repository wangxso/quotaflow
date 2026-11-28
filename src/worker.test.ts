import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessStopUnverifiedError, type AgentAdapter } from './agent';
import { supervisedCommandAgent } from './command-agent';
import type { QuotaFlowConfig, UsageReport } from './domain';
import { openDatabase } from './db';
import { attemptDirectory } from './recovery';
import { TaskStore } from './store';
import { runOnce } from './worker';
import { checkpoint, ensureWorktree, restoreCheckpoint, worktreeGit } from './worktree';

const supervisedTest = test.skipIf(process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux');
const draft = {
  version: 1,
  completed: ['Verified app.txt'],
  failedAttempts: [],
  blockers: [],
  nextSteps: ['Write answer.txt'],
  checks: ['Read back the accepted result'],
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-worker-'));
  const repo = join(root, 'repo');
  worktreeGit(root, ['init', '--initial-branch=main', repo]);
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  worktreeGit(repo, ['add', '.']);
  worktreeGit(repo, ['commit', '-m', 'base']);
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const config: QuotaFlowConfig = {
    version: 1,
    database: ':memory:',
    worktreeRoot: join(root, 'worktrees'),
    routing: { allowedProviders: ['local'] },
    lanes: [{
      id: 'fixture',
      agent: 'codex',
      model: 'fixture-model',
      provider: 'local',
      account: 'fixture-account',
      priority: 10,
      slots: 1,
      windows: [{
        key: 'day',
        remaining: 10,
        reserve: 1,
        observedAt: Date.now() - 1000,
        resetAt: Date.now() + 60_000,
      }],
    }],
  };
  return { root, repo, db, store, config };
}

function fixtureAgent(write: (workspace: string) => void): AgentAdapter {
  return {
    id: 'fixture',
    async run(context) {
      write(context.workspacePath);
      return { status: 'completed', reason: 'fixture_passed', tests: 'passed', actualModel: 'fixture-model' };
    },
  };
}

function usageReport(): UsageReport {
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
      requestModel: 'requested-model',
      servedModel: 'served-model',
      httpStatus: 200,
      stopReason: 'stop',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costEstimate: 0,
      priced: true,
      providerInvoice: 'UNKNOWN',
    }],
    actualModel: 'served-model',
    costEstimate: 0,
    priced: true,
    providerInvoice: 'UNKNOWN',
  };
}

async function removeEventually(path: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['EBUSY', 'EPERM'].includes(String(error.code))) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
  rmSync(path, { recursive: true, force: true });
}

test('worker reserves, executes, checkpoints and completes a task', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    store.createTask({
      id: 'task',
      title: 'worker task',
      repoPath: repo,
      workspacePath: join(root, 'task'),
    });
    const startedAt = Date.now();
    const endedAt = startedAt + 5_000;
    let tick = 0;
    const result = await runOnce(store, config, () => fixtureAgent((workspace) => {
      writeFileSync(join(workspace, 'app.txt'), 'started\n');
      writeFileSync(join(workspace, 'answer.txt'), '42\n');
    }), () => tick++ === 0 ? startedAt : endedAt);
    expect(result?.task.status).toBe('completed');
    expect(result?.checkpoint).toBeTruthy();
    expect(result?.actualModel).toBe('fixture-model');
    expect(result?.attempt.stage).toBe('done');
    expect(result?.attempt.startedAt).toBe(startedAt);
    expect(result?.attempt.endedAt).toBe(endedAt);
    expect(store.attempts('task')[0].actualModel).toBe('fixture-model');
    expect(store.activeAttempt('task')).toBeNull();
    expect(store.events('task').map((event) => event.kind)).toContain('attempt_finished');
    const restored = join(root, 'restored');
    restoreCheckpoint(repo, restored, result!.checkpoint!);
    expect(readFileSync(join(restored, 'app.txt'), 'utf8')).toBe('started\n');
    expect(readFileSync(join(restored, 'answer.txt'), 'utf8')).toBe('42\n');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('targeted worker start ignores higher-priority queue entries', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    store.createTask({
      id: 'target',
      title: 'target',
      repoPath: repo,
      workspacePath: join(root, 'target'),
      priority: 1,
    });
    store.createTask({
      id: 'higher-priority',
      title: 'higher priority',
      repoPath: repo,
      workspacePath: join(root, 'higher-priority'),
      priority: 100,
    });
    const result = await runOnce(
      store,
      config,
      () => fixtureAgent((workspace) => writeFileSync(join(workspace, 'target.txt'), 'done\n')),
      Date.now,
      { taskId: 'target' },
    );
    expect(result).toMatchObject({
      task: { id: 'target', status: 'completed' },
      agentStatus: 'completed',
    });
    expect(store.getTask('higher-priority').status).toBe('queued');
  } finally {
    db.close();
    await removeEventually(root);
  }
});

test('a rejected change keeps the handoff checkpoint and blocks a retry while the protected file is dirty', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    const workspacePath = join(root, 'protected');
    const task = store.createTask({ id: 'protected', title: 'finish work', repoPath: repo, workspacePath,
      handoff: { protectedPaths: ['app.txt'] } });
    const now = Date.now();
    const first = await runOnce(store, config, () => ({
      id: 'donor',
      async run({ handoff }) {
        writeFileSync(join(workspacePath, 'app.txt'), 'accepted\n');
        writeFileSync(handoff!.file, JSON.stringify(draft));
        return { status: 'waiting_quota', reason: 'fixture_quota', tests: 'not_run', activeProcesses: 0, retryAfterMs: 5 };
      },
    }), () => now);
    expect(first?.task.status).toBe('waiting_quota');
    expect(store.handoffForCheckpoint(task.id, first!.checkpoint)).toMatchObject({ attemptId: first!.attempt.id, note: draft });
    expect(store.handoffForCheckpoint(task.id, worktreeGit(repo, ['rev-parse', 'HEAD']))).toBeNull();
    expect(store.handoffForCheckpoint('another-task', first!.checkpoint)).toBeNull();

    const rejected = await runOnce(store, config, () => ({
      id: 'recipient',
      async run({ handoff }) {
        expect(handoff?.source?.attemptId).toBe(first!.attempt.id);
        writeFileSync(join(workspacePath, 'answer.txt'), '42\n');
        writeFileSync(join(workspacePath, 'app.txt'), 'accepted\n\n');
        writeFileSync(handoff!.file, JSON.stringify(draft));
        return { status: 'completed', reason: 'fixture_passed', tests: 'passed', activeProcesses: 0, usage: usageReport() };
      },
    }), () => now + 10);
    expect(rejected?.task).toMatchObject({ status: 'blocked', checkpoint: first!.checkpoint });
    expect(rejected?.attempt).toMatchObject({ stage: 'done', checkpoint: null });
    expect(store.usage(rejected!.attempt.id)).toHaveLength(1);
    expect(store.events(task.id).at(-1)?.detail).toMatchObject({ reason: 'handoff_protected_paths_changed', protectedPaths: ['app.txt'] });
    expect(store.events(task.id).filter((entry) => entry.kind === 'handoff_saved')).toHaveLength(1);
    expect(worktreeGit(repo, ['for-each-ref', `refs/quotaflow/attempts/${task.id}/${rejected!.attempt.id}`])).toBe('');
    expect(readFileSync(join(workspacePath, 'app.txt'), 'utf8')).toBe('accepted\n\n');

    store.retry(task.id, now + 20);
    let started = false;
    const retry = await runOnce(store, config, () => fixtureAgent(() => { started = true; }), () => now + 20);
    expect(started).toBe(false);
    expect(retry?.task).toMatchObject({ status: 'blocked', checkpoint: first!.checkpoint });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['missing', 'invalid', 'unverified'])('worker resumes from the original prompt when the prior note is %s', async (kind) => {
  const { root, repo, db, store, config } = setup();
  try {
    const task = store.createTask({ id: 'handoff', title: 'Retain the original task', repoPath: repo,
      workspacePath: join(root, 'resume'), handoff: { protectedPaths: [] } });
    const now = Date.now();
    const first = await runOnce(store, config, () => ({
      id: 'donor',
      async run({ handoff }) {
        if (kind === 'invalid') writeFileSync(handoff!.file, JSON.stringify({ version: 1, nextSteps: ['Incomplete draft'] }));
        if (kind === 'unverified') writeFileSync(handoff!.file, JSON.stringify(draft));
        return { status: 'waiting_quota', reason: 'fixture_quota', tests: 'not_run', retryAfterMs: 5,
          ...(kind === 'unverified' ? {} : { activeProcesses: 0 }) };
      },
    }), () => now);
    expect(first?.task.status).toBe('waiting_quota');
    expect(store.handoffForCheckpoint(task.id, first!.checkpoint)).toBeNull();
    const resumed = await runOnce(store, config, () => ({
      id: 'recipient',
      async run(context) {
        expect(context.task.prompt).toBe(task.prompt);
        expect(context.handoff?.prompt.startsWith(task.prompt)).toBe(true);
        expect(context.handoff?.source).toBeNull();
        expect(context.handoff?.prompt).not.toContain('Previous attempt note');
        return { status: 'completed', reason: 'fixture_passed', tests: 'passed', activeProcesses: 0 };
      },
    }), () => now + 10);
    expect(resumed?.task.status).toBe('completed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker records a failed fixture and still stores a checkpoint', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    store.createTask({
      id: 'failed',
      title: 'failed task',
      repoPath: repo,
      workspacePath: join(root, 'failed'),
    });
    const result = await runOnce(store, config, () => ({
      id: 'fixture',
      async run(context) {
        writeFileSync(join(context.workspacePath, 'app.txt'), 'partial\n');
        return { status: 'failed', reason: 'fixture_failed', tests: 'failed' };
      },
    }));
    expect(result?.task.status).toBe('failed');
    expect(result?.checkpoint).toBeTruthy();
    const workspace = result!.task.workspacePath;
    expect(readFileSync(join(workspace, 'app.txt'), 'utf8')).toBe('partial\n');
    expect(worktreeGit(workspace, ['rev-parse', `${result!.checkpoint}^1`])).toBe(worktreeGit(repo, ['rev-parse', 'HEAD']));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker persists request-level usage and the served model', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    store.createTask({
      id: 'usage',
      title: 'usage task',
      repoPath: repo,
      workspacePath: join(root, 'usage'),
    });
    const report = usageReport();
    const result = await runOnce(store, config, () => ({
      id: 'fixture',
      async run(context) {
        writeFileSync(join(context.workspacePath, 'app.txt'), 'usage\n');
        return {
          status: 'completed',
          reason: 'fixture_passed',
          tests: 'not_run',
          usage: report,
        };
      },
    }));
    expect(result).toMatchObject({
      actualModel: 'served-model',
      usageStatus: 'recorded',
      usage: [{ sourceRequestId: 'request-1', servedModel: 'served-model' }],
    });
    expect(store.getAttempt(result!.attempt.id).actualModel).toBe('served-model');
    expect(store.usage(result!.attempt.id)).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker cooperatively cancels an active adapter and saves a checkpoint', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const agent: AgentAdapter = {
      id: 'cancel-fixture',
      async run(context) {
        writeFileSync(join(context.workspacePath, 'app.txt'), 'partial\n');
        started();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) {
            resolve();
            return;
          }
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'cancelled',
          reason: 'agent_cancelled',
          tests: 'not_run',
          activeProcesses: 0,
        };
      },
    };
    store.createTask({
      id: 'cancel-active',
      title: 'cancel active',
      repoPath: repo,
      workspacePath: join(root, 'cancel-active'),
    });
    const running = runOnce(store, config, () => agent);
    await startedPromise;
    expect(store.cancel('cancel-active')).toMatchObject({ status: 'cancelling' });
    const result = await running;
    expect(result).toMatchObject({
      agentStatus: 'cancelled',
      task: { status: 'cancelled' },
    });
    expect(result?.checkpoint).toBeTruthy();
    expect(store.getAttempt(result!.attempt.id).stage).toBe('done');
    expect(store.events('cancel-active').find((event) => event.kind === 'cancel_requested')).toBeTruthy();
    expect(store.events('cancel-active').at(-1)?.detail).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled_by_operator',
    });
    expect(readFileSync(join(root, 'cancel-active', 'app.txt'), 'utf8')).toBe('partial\n');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['missing receipt', 'active processes'])('worker blocks without a checkpoint for %s', async (stop) => {
  const { root, repo, db, store, config } = setup();
  try {
    store.createTask({
      id: 'unverified-stop',
      title: 'unverified stop',
      repoPath: repo,
      workspacePath: join(root, 'unverified-stop'),
    });
    const result = await runOnce(store, config, () => ({
      id: 'unverified-stop',
      async run(context) {
        writeFileSync(join(context.workspacePath, 'app.txt'), 'partial\n');
        if (stop === 'missing receipt') throw new ProcessStopUnverifiedError('missing supervisor receipt');
        return { status: 'completed', reason: 'fixture_returned', tests: 'passed', activeProcesses: 1 };
      },
    }));

    expect(result).toMatchObject({
      task: { status: 'blocked', checkpoint: null },
      attempt: { stage: 'running' },
      checkpoint: null,
    });
    expect(store.activeAttempt('unverified-stop')?.stage).toBe('running');
    expect(store.events('unverified-stop').some((event) => event.kind === 'checkpoint_intent')).toBe(false);
    expect(store.events('unverified-stop').at(-1)?.detail).toMatchObject({
      reason: 'process_stop_unverified',
    });
    expect(readFileSync(join(root, 'unverified-stop', 'app.txt'), 'utf8')).toBe('partial\n');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

supervisedTest('worker checkpoints and parks a quota-held supervised task', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    config.lanes[0].command = [
      process.execPath,
      fileURLToPath(new URL('./fixture-agent.ts', import.meta.url)),
      'quota',
    ];
    config.budgets = [{
      account: 'fixture-account',
      unit: 'gateway-estimate',
      limit: 1,
      reserve: 0,
      windowMs: 60_000,
      holdPerAttempt: 0.25,
    }];
    store.createTask({
      id: 'quota',
      title: 'quota task',
      repoPath: repo,
      workspacePath: join(root, 'quota'),
    });
    const result = await runOnce(store, config, (lane) => supervisedCommandAgent(lane));
    expect(result).toMatchObject({
      agentStatus: 'waiting_quota',
      task: { status: 'waiting_quota' },
    });
    expect(result?.checkpoint).toBeTruthy();
    expect(typeof result?.task.nextWakeAt).toBe('number');
    expect(store.getAttempt(result!.attempt.id).stage).toBe('done');
    expect(store.budgetLease(result!.attempt.id)).toMatchObject({
      amount: 0.25,
      state: 'pending',
      priced: false,
    });
    expect(store.events('quota').at(-1)?.detail).toMatchObject({
      status: 'waiting_quota',
      reason: 'fixture_quota',
    });
    expect(readFileSync(join(root, 'quota', 'app.txt'), 'utf8')).toBe('partial\n');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

supervisedTest('worker recovers a crashed controller from verified supervisor evidence', async () => {
  const { root, repo, db, config } = setup();
  let fileDb: ReturnType<typeof openDatabase> | null = null;
  let crashed: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const fixture = fileURLToPath(new URL('./fixture-agent.ts', import.meta.url));
    const helper = fileURLToPath(new URL('./recovery-crash-helper.ts', import.meta.url));
    const file = join(root, 'crash.sqlite');
    const helperConfig: QuotaFlowConfig = {
      ...config,
      database: file,
      worktreeRoot: join(root, 'crash-worktrees'),
      defaultRepo: repo,
      lanes: [{
        ...config.lanes[0],
        command: [process.execPath, fixture, 'hold'],
      }],
    };
    const configFile = join(root, 'crash.config.json');
    writeFileSync(configFile, JSON.stringify(helperConfig, null, 2));
    fileDb = openDatabase(file);
    const fileStore = new TaskStore(fileDb);
    fileStore.createTask({
      id: 'crash',
      title: 'crash recovery',
      repoPath: repo,
      workspacePath: join(root, 'crash-task'),
    });

    crashed = Bun.spawn([
      process.execPath,
      helper,
      configFile,
    ], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'inherit',
      stdin: 'ignore',
      windowsHide: true,
    });
    let first: { taskId: string; attemptId: number } | null = null;
    const activeDeadline = Date.now() + 10_000;
    while (!first && Date.now() < activeDeadline) {
      const active = fileStore.activeAttempt('crash');
      if (active) first = { taskId: active.taskId, attemptId: active.id };
      else await Bun.sleep(30);
    }
    if (!first) throw new Error('Crash helper did not reserve an attempt');
    const statusDir = attemptDirectory(helperConfig, first.taskId, first.attemptId);
    const app = join(root, 'crash-task', 'app.txt');
    const ready = () => existsSync(join(statusDir, 'ready.json'))
      && existsSync(app) && readFileSync(app, 'utf8') === 'partial\n';
    const readyDeadline = Date.now() + 10_000;
    while (!ready() && Date.now() < readyDeadline && crashed.exitCode === null) {
      await Bun.sleep(30);
    }
    expect(ready()).toBe(true);
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill.exe', ['/PID', String(crashed.pid), '/F'], { windowsHide: true });
      expect(killed.status).toBe(0);
    } else {
      crashed.kill('SIGKILL');
    }
    expect(await crashed.exited).not.toBe(0);
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(statusDir, 'stopped.json')) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(existsSync(join(statusDir, 'stopped.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(statusDir, 'stopped.json'), 'utf8'))).toMatchObject({
      activeProcesses: 0,
      reason: 'controller_closed',
    });

    helperConfig.lanes[0].command = [process.execPath, fixture, 'complete'];
    const result = await runOnce(fileStore, helperConfig, (lane) => supervisedCommandAgent(lane));
    expect(result?.task.status).toBe('completed');
    expect(result?.attempt.id).toBeGreaterThan(first.attemptId);
    const attempts = fileStore.attempts(first.taskId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ id: first.attemptId, stage: 'done' });
    expect(attempts[0].checkpoint).toBeTruthy();
    expect(worktreeGit(join(root, 'crash-task'), [
      'show',
      `${attempts[0].checkpoint}:app.txt`,
    ])).toBe('partial');
    expect(fileStore.events(first.taskId).find((event) => event.kind === 'attempt_recovered')?.detail)
      .toMatchObject({ reason: 'worker_restart_verified', recovered: true });
    expect(readFileSync(join(root, 'crash-task', 'app.txt'), 'utf8')).toBe('agent\n');
  } finally {
    if (crashed?.exitCode === null) crashed.kill();
    fileDb?.close();
    db.close();
    try {
      await removeEventually(root);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['EBUSY', 'EPERM'].includes(String(error.code))) {
        throw error;
      }
    }
  }
}, 30_000);

test('worker blocks a task and releases its budget lease when no adapter is registered', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    const policy = {
      account: 'fixture-account',
      unit: 'gateway-estimate',
      limit: 1,
      reserve: 0,
      windowMs: 60_000,
      holdPerAttempt: 0.25,
    };
    config.budgets = [policy];
    store.createTask({
      id: 'blocked',
      title: 'blocked task',
      repoPath: repo,
      workspacePath: join(root, 'blocked'),
    });
    const result = await runOnce(store, config, () => undefined);
    expect(result?.task.status).toBe('blocked');
    expect(store.activeAttempt('blocked')).toBeNull();
    expect(result?.error).toContain('No agent adapter');
    expect(store.budgetLease(result!.attempt.id)).toMatchObject({
      amount: 0,
      state: 'released',
    });
    expect(store.budgetStatus([policy])[0]).toMatchObject({
      used: 0,
      available: 1,
      activeLeases: 0,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker blocks read-only tasks when the adapter cannot enforce read-only access', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    store.createTask({
      id: 'read-only-unsupported',
      title: 'review task',
      repoPath: repo,
      workspacePath: join(root, 'read-only-unsupported'),
      accessMode: 'read_only',
    });
    let invoked = false;
    const result = await runOnce(store, config, () => ({
      id: 'write-only-fixture',
      async run() {
        invoked = true;
        return { status: 'completed', reason: 'fixture', tests: 'not_run' };
      },
    }));
    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      task: { status: 'blocked' },
      agentStatus: 'failed',
      error: 'Agent adapter write-only-fixture does not support read-only tasks',
    });
    expect(store.events('read-only-unsupported')).toContainEqual(expect.objectContaining({
      kind: 'attempt_finished',
      detail: expect.objectContaining({ reason: 'read_only_adapter_unsupported' }),
    }));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker refuses and does not checkpoint modifications from a read-only task', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    const initialCheckpoint = worktreeGit(repo, ['rev-parse', 'HEAD']);
    store.createTask({
      id: 'read-only-violation',
      title: 'review task',
      repoPath: repo,
      workspacePath: join(root, 'read-only-violation'),
      accessMode: 'read_only',
      initialCheckpoint,
    });
    const result = await runOnce(store, config, () => ({
      id: 'read-only-fixture',
      supportsReadOnly: true,
      async run({ workspacePath }) {
        writeFileSync(join(workspacePath, 'app.txt'), 'unexpected write\n');
        return {
          status: 'completed',
          reason: 'fixture',
          tests: 'not_run',
          output: 'No blocking findings',
        };
      },
    }));
    expect(result).toMatchObject({
      task: { status: 'blocked', checkpoint: initialCheckpoint },
      agentStatus: 'failed',
      checkpoint: initialCheckpoint,
      output: 'No blocking findings',
    });
    expect(result?.error).toContain('Read-only workspace was modified');
    expect(store.events('read-only-violation')).toContainEqual(expect.objectContaining({
      kind: 'attempt_finished',
      detail: expect.objectContaining({
        agentOutput: 'No blocking findings',
        checkpointRejected: 'read_only_workspace_modified',
      }),
    }));
    expect(readFileSync(join(root, 'read-only-violation', 'app.txt'), 'utf8')).toBe('unexpected write\n');

    store.retry('read-only-violation');
    let reinvoked = false;
    const retried = await runOnce(store, config, () => ({
      id: 'read-only-fixture',
      supportsReadOnly: true,
      async run() {
        reinvoked = true;
        return { status: 'completed', reason: 'should_not_run', tests: 'not_run' };
      },
    }));
    expect(reinvoked).toBe(false);
    expect(retried).toMatchObject({
      task: { status: 'blocked', checkpoint: initialCheckpoint },
      agentStatus: 'failed',
    });
    expect(retried?.error).toContain('Read-only workspace was modified');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker completes a clean read-only task and persists its report without a new checkpoint', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    const initialCheckpoint = worktreeGit(repo, ['rev-parse', 'HEAD']);
    store.createTask({
      id: 'read-only-review',
      title: 'review task',
      repoPath: repo,
      workspacePath: join(root, 'read-only-review'),
      accessMode: 'read_only',
      initialCheckpoint,
    });
    const result = await runOnce(store, config, () => ({
      id: 'read-only-fixture',
      supportsReadOnly: true,
      async run() {
        return {
          status: 'completed',
          reason: 'review_completed',
          tests: 'not_run',
          output: 'No blocking findings',
        };
      },
    }));
    expect(result).toMatchObject({
      task: { status: 'completed', checkpoint: initialCheckpoint },
      agentStatus: 'completed',
      checkpoint: initialCheckpoint,
      output: 'No blocking findings',
    });
    expect(store.events('read-only-review')).toContainEqual(expect.objectContaining({
      kind: 'attempt_finished',
      detail: expect.objectContaining({ agentOutput: 'No blocking findings' }),
    }));
    expect(worktreeGit(repo, ['status', '--short'])).toBe('');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker prepares a new worktree when a checkpoint exists', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    const existing = ensureWorktree(repo, join(root, 'existing'));
    writeFileSync(join(existing, 'app.txt'), 'state\n');
    const sha = checkpoint(existing, root, 'resume', 99);
    store.createTask({
      id: 'resume',
      title: 'resume task',
      repoPath: repo,
      workspacePath: join(root, 'resume'),
    });
    store.db.run("UPDATE tasks SET checkpoint = ? WHERE id = 'resume'", [sha]);
    const result = await runOnce(store, config, () => fixtureAgent((workspace) => {
      expect(readFileSync(join(workspace, 'app.txt'), 'utf8')).toBe('state\n');
      writeFileSync(join(workspace, 'answer.txt'), 'resumed\n');
    }));
    expect(result?.task.status).toBe('completed');
    expect(readFileSync(join(root, 'resume', 'answer.txt'), 'utf8')).toBe('resumed\n');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

supervisedTest('worker runs a supervised command adapter end to end', async () => {
  const { root, repo, db, store, config } = setup();
  try {
    config.lanes[0].command = [
      process.execPath,
      fileURLToPath(new URL('./fixture-agent.ts', import.meta.url)),
      'complete',
    ];
    store.createTask({
      id: 'supervised',
      title: 'supervised task',
      repoPath: repo,
      workspacePath: join(root, 'supervised'),
    });
    const result = await runOnce(store, config, (lane) => supervisedCommandAgent(lane));
    expect(result?.task.status).toBe('completed');
    expect(result?.checkpoint).toBeTruthy();
    expect(readFileSync(join(root, 'supervised', 'answer.txt'), 'utf8')).toBe('42\n');
    expect(store.activeAttempt('supervised')).toBeNull();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
