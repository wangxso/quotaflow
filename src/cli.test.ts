import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worktreeGit } from './worktree';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-cli-'));
  const config = join(root, 'quotaflow.config.json');
  writeFileSync(config, JSON.stringify({
    version: 1,
    database: '.quotaflow/state.sqlite',
    worktreeRoot: '.quotaflow/worktrees',
    defaultRepo: '.',
    routing: { allowedProviders: [] },
    lanes: [],
  }));
  return { root, config };
}

async function cli(root: string, args: string[]) {
  const process = Bun.spawn([
    globalThis.process.execPath,
    fileURLToPath(new URL('./cli.ts', import.meta.url)),
    ...args,
    '--config',
    join(root, 'quotaflow.config.json'),
  ], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr || stdout}`);
  return { stdout, stderr, exitCode };
}

test('adds and lists a task through the CLI', async () => {
  const { root } = setup();
  try {
    const added = await cli(root, ['task', 'add', 'CLI smoke task', '--repo', root, '--priority', '7']);
    const task = JSON.parse(added.stdout);
    expect(task).toMatchObject({ title: 'CLI smoke task', status: 'queued', priority: 7 });
    const listed = await cli(root, ['task', 'list']);
    expect(listed.stdout).toContain(task.id);
    expect(listed.stdout).toContain('queued');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports an invalid task ID without a stack trace', async () => {
  const { root } = setup();
  try {
    const process = Bun.spawn([
      globalThis.process.execPath,
      fileURLToPath(new URL('./cli.ts', import.meta.url)),
      'task',
      'show',
      'missing',
      '--config',
      join(root, 'quotaflow.config.json'),
    ], { cwd: root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true });
    const stderr = await new Response(process.stderr).text();
    expect(await process.exited).toBe(1);
    expect(stderr).toContain('Unknown task missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shows configured budget status', async () => {
  const { root } = setup();
  try {
    writeFileSync(join(root, 'quotaflow.config.json'), JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      routing: { allowedProviders: [] },
      budgets: [{
        account: 'fixture',
        unit: 'gateway-estimate',
        limit: 5,
        reserve: 0.5,
        windowMs: 60_000,
        holdPerAttempt: 0.25,
      }],
      lanes: [],
    }));
    const result = await cli(root, ['budget', 'status']);
    expect(JSON.parse(result.stdout)).toMatchObject([{
      account: 'fixture',
      unit: 'gateway-estimate',
      limit: 5,
      used: 0,
      available: 5,
      activeLeases: 0,
      nextExpiryAt: null,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shows task budget leases through the CLI', async () => {
  const { root } = setup();
  const now = Date.now();
  try {
    writeFileSync(join(root, 'quotaflow.config.json'), JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      defaultRepo: root,
      routing: { allowedProviders: ['local'] },
      budgets: [{
        account: 'fixture',
        unit: 'gateway-estimate',
        limit: 1,
        reserve: 0,
        windowMs: 60_000,
        holdPerAttempt: 0.25,
      }],
      lanes: [{
        id: 'fixture',
        agent: 'codex',
        model: 'fixture',
        provider: 'local',
        account: 'fixture',
        priority: 1,
        slots: 1,
        windows: [{
          key: 'day',
          remaining: 10,
          reserve: 0,
          observedAt: now - 1000,
          resetAt: now + 60_000,
        }],
      }],
    }));
    const added = await cli(root, ['task', 'add', 'budget audit task', '--repo', root]);
    const task = JSON.parse(added.stdout);
    const reserved = JSON.parse((await cli(root, ['queue', 'next'])).stdout);
    const shown = JSON.parse((await cli(root, ['task', 'show', task.id])).stdout);
    expect(shown.budgetLeases).toMatchObject([{
      attemptId: reserved.attempt.id,
      account: 'fixture',
      unit: 'gateway-estimate',
      amount: 0.25,
      state: 'held',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs worker recovery as an idempotent CLI command', async () => {
  const { root } = setup();
  try {
    const result = await cli(root, ['worker', 'recover']);
    expect(JSON.parse(result.stdout)).toEqual({
      items: [],
      recovered: 0,
      blocked: 0,
      skipped: 0,
      errors: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retries a failed task through the CLI', async () => {
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-cli-retry-'));
  try {
    const repo = join(root, 'repo');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    worktreeGit(repo, ['add', '.']);
    worktreeGit(repo, ['commit', '-m', 'base']);
    writeFileSync(join(root, 'quotaflow.config.json'), JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      defaultRepo: repo,
      routing: { allowedProviders: ['local'] },
      lanes: [{
        id: 'fixture',
        agent: 'codex',
        model: 'fixture',
        provider: 'local',
        account: 'fixture',
        priority: 1,
        slots: 1,
        windows: [{
          key: 'day',
          remaining: 10,
          reserve: 0,
          observedAt: Date.now() - 1000,
          resetAt: Date.now() + 60_000,
        }],
        command: [
          process.execPath,
          fileURLToPath(new URL('./fixture-agent.ts', import.meta.url)),
          'fail',
        ],
      }],
    }));
    const added = JSON.parse((await cli(root, ['task', 'add', 'retry task', '--repo', root])).stdout);
    const failed = JSON.parse((await cli(root, ['worker', 'once'])).stdout);
    expect(failed.task).toMatchObject({ id: added.id, status: 'failed' });
    const retried = JSON.parse((await cli(root, ['task', 'retry', added.id])).stdout);
    expect(retried).toMatchObject({ id: added.id, status: 'queued' });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('runs one supervised fixture through the CLI worker', async () => {
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-cli-worker-'));
  try {
    const repo = join(root, 'repo');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    worktreeGit(repo, ['add', '.']);
    worktreeGit(repo, ['commit', '-m', 'base']);
    writeFileSync(join(root, 'quotaflow.config.json'), JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      defaultRepo: repo,
      routing: { allowedProviders: ['local'] },
      lanes: [{
        id: 'fixture',
        agent: 'codex',
        model: 'fixture',
        provider: 'local',
        account: 'fixture',
        priority: 1,
        slots: 1,
        windows: [{
          key: 'day',
          remaining: 10,
          reserve: 1,
          observedAt: Date.now() - 1000,
          resetAt: Date.now() + 60_000,
        }],
        command: [
          process.execPath,
          fileURLToPath(new URL('./fixture-agent.ts', import.meta.url)),
          'complete',
        ],
      }],
    }));
    const added = await cli(root, ['task', 'add', 'worker smoke', '--repo', repo]);
    const task = JSON.parse(added.stdout);
    const worked = await cli(root, ['worker', 'once']);
    const result = JSON.parse(worked.stdout);
    expect(result.task).toMatchObject({ id: task.id, status: 'completed' });
    expect(result.agentStatus).toBe('completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
