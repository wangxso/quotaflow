import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptDirectory, writeAttemptOwner } from './recovery';
import { worktreeGit } from './worktree';

const supervisedTest = test.skipIf(process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux');
const cliEntry = fileURLToPath(new URL('./cli.ts', import.meta.url));

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

async function cliResult(root: string, args: string[], entrypoint = cliEntry, extraEnv: NodeJS.ProcessEnv = {}) {
  const process = Bun.spawn([
    globalThis.process.execPath,
    entrypoint,
    ...args,
    '--config',
    join(root, 'quotaflow.config.json'),
  ], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
    env: { ...globalThis.process.env, ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function cli(root: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = await cliResult(root, args, cliEntry, extraEnv);
  const { stdout, stderr, exitCode } = result;
  if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr || stdout}`);
  return result;
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
    const review = JSON.parse((await cli(root, [
      'task', 'add', 'CLI read-only review', '--repo', root, '--read-only',
    ])).stdout);
    expect(review).toMatchObject({ status: 'queued', accessMode: 'read_only' });
    const incompatible = await cliResult(root, [
      'task', 'add', 'Invalid review', '--repo', root, '--read-only', '--handoff',
    ]);
    expect(incompatible.exitCode).toBe(1);
    expect(incompatible.stderr).toContain('Read-only tasks cannot use handoff drafts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bundled CLI starts without running the live probe', async () => {
  const { root, config } = setup();
  try {
    const bundle = await Bun.build({ entrypoints: [cliEntry], outdir: root, target: 'bun' });
    expect(bundle.success).toBe(true);
    const result = await cliResult(root, ['config', 'validate'], bundle.outputs[0].path);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ config });
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
    const audit = await cli(root, ['budget', 'audit', '--limit', '5']);
    expect(JSON.parse(audit.stdout)).toEqual({
      policies: [{ account: 'fixture', unit: 'gateway-estimate', limit: 5, reserve: 0.5,
        windowMs: 60_000, holdPerAttempt: 0.25, used: 0, available: 5, activeLeases: 0, nextExpiryAt: null }],
      expired: [],
    });
    const invalid = await cliResult(root, ['budget', 'audit', '--limit', '0']);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('--limit must be a positive integer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetches a GitHub pull snapshot through the CLI API entry point', async () => {
  const { root } = setup();
  const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
  const baseSha = 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e';
  const testToken = ['cli', 'test', 'token'].join('-');
  let authorized = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      authorized ||= request.headers.get('authorization') === `Bearer ${testToken}`;
      const url = new URL(request.url);
      if (url.pathname === '/repos/wangxso/mcarplay/pulls/141') {
        return Response.json({
          number: 141,
          state: 'open',
          draft: true,
          mergeable: 'mergeable',
          user: { login: 'wangxso' },
          base: { ref: 'main', sha: baseSha },
          head: { ref: 'feature', sha: headSha, repo: { full_name: 'wangxso/mcarplay' } },
        });
      }
      if (url.pathname === `/repos/wangxso/mcarplay/commits/${headSha}/check-runs`) {
        return Response.json({
          check_runs: [{
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            head_sha: headSha,
            started_at: '2026-11-27T13:57:30Z',
            completed_at: '2026-11-27T14:03:00Z',
          }],
        });
      }
      if (url.pathname === '/repos/wangxso/mcarplay/pulls/141/reviews') {
        return Response.json([]);
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  try {
    const result = await cli(root, [
      'github', 'snapshot',
      '--repo', 'wangxso/mcarplay',
      '--pull-number', '141',
      '--token-env', 'QUOTAFLOW_TEST_GITHUB_TOKEN',
      '--api-url', `http://127.0.0.1:${server.port}`,
    ], { QUOTAFLOW_TEST_GITHUB_TOKEN: testToken });
    expect(JSON.parse(result.stdout)).toMatchObject({
      repository: 'wangxso/mcarplay',
      update: {
        number: 141,
        draft: true,
        mergeable: 'mergeable',
        headRepository: 'wangxso/mcarplay',
        headSha,
        checks: [{ name: 'test', conclusion: 'success' }],
        reviews: [],
      },
    });
    expect(result.stdout).not.toContain(testToken);
    expect(authorized).toBe(true);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('evaluates and idempotently stores a GitHub pull gate snapshot', async () => {
  const { root } = setup();
  const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
  try {
    const snapshotFile = join(root, 'pr-141.json');
    writeFileSync(snapshotFile, JSON.stringify({
      repository: 'wangxso/mcarplay',
      update: {
        number: 141,
        state: 'OPEN',
        draft: true,
        mergeable: 'MERGEABLE',
        authorLogin: 'wangxso',
        baseRef: 'main',
        headRef: 'quotaflow/issue-82-iap2-catalog',
        baseSha: 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e',
        headSha,
        checks: [
          { name: 'Check and build debug APK', status: 'completed', conclusion: 'success', headSha,
            startedAt: '2026-11-27T13:57:30Z', completedAt: '2026-11-27T14:03:00Z' },
          { name: 'GitGuardian Security Checks', status: 'completed', conclusion: 'success', headSha,
            startedAt: '2026-11-27T13:57:55Z', completedAt: '2026-11-27T13:57:56Z' },
        ],
        reviews: [],
      },
    }));
    const args = ['github', 'gate', snapshotFile, '--delivery-id', 'delivery-141',
      '--expected-head', headSha, '--require-check', 'Check and build debug APK',
      '--require-check', 'GitGuardian Security Checks'];
    const first = JSON.parse((await cli(root, args)).stdout);
    expect(first).toMatchObject({
      duplicate: false,
      delivery: { deliveryId: 'delivery-141', duplicateDelivery: false, duplicateEvent: false },
      gate: { headSha, evaluation: { status: 'blocked', reasons: [{ code: 'draft' },
        { code: 'independent_review_missing' }] } },
      plan: { status: 'remediation_required', actions: [{ kind: 'independent_review', requiresHuman: false }] },
    });
    const repeated = JSON.parse((await cli(root, args)).stdout);
    expect(repeated).toMatchObject({ duplicate: true, delivery: { duplicateDelivery: true, duplicateEvent: true } });
    const redelivered = JSON.parse((await cli(root, [...args.slice(0, 4), 'delivery-redelivery', ...args.slice(5)])).stdout);
    expect(redelivered).toMatchObject({ duplicate: true, delivery: { duplicateDelivery: false, duplicateEvent: true } });

    const botApproved = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    botApproved.update.draft = false;
    botApproved.update.reviews = [{
      authorLogin: 'quotaflow-review-gate[bot]',
      authorType: 'bot',
      state: 'APPROVED',
      commitSha: headSha,
      submittedAt: '2026-11-27T14:05:00Z',
    }];
    writeFileSync(snapshotFile, JSON.stringify(botApproved));
    const blockedBotArgs = [...args];
    blockedBotArgs[4] = 'delivery-bot-blocked';
    expect(JSON.parse((await cli(root, blockedBotArgs)).stdout)).toMatchObject({
      gate: { evaluation: { status: 'blocked', independentApprovals: 0 } },
    });
    const allowedBotArgs = [...args, '--allow-bot-approvals'];
    allowedBotArgs[4] = 'delivery-bot-allowed';
    expect(JSON.parse((await cli(root, allowedBotArgs)).stdout)).toMatchObject({
      gate: { evaluation: { status: 'ready_for_human_merge', independentApprovals: 1 } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializes a GitHub review action once at the exact pull head', async () => {
  const { root } = setup();
  const repo = join(root, 'repo');
  try {
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    worktreeGit(repo, ['add', '.']);
    worktreeGit(repo, ['commit', '-m', 'base']);
    const headSha = worktreeGit(repo, ['rev-parse', 'HEAD']);
    const snapshotFile = join(root, 'materialize-pr.json');
    writeFileSync(snapshotFile, JSON.stringify({
      repository: 'wangxso/quotaflow',
      update: {
        number: 141,
        state: 'OPEN',
        draft: true,
        mergeable: 'MERGEABLE',
        authorLogin: 'wangxso',
        baseRef: 'main',
        headRef: 'feature',
        baseSha: headSha,
        headSha,
        checks: [{
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          headSha,
          startedAt: '2026-11-27T13:57:30Z',
          completedAt: '2026-11-27T14:03:00Z',
        }],
        reviews: [],
      },
    }));
    const args = ['github', 'gate', snapshotFile, '--delivery-id', 'materialize-141',
      '--require-check', 'test', '--materialize', repo];

    const first = JSON.parse((await cli(root, args)).stdout);
    expect(first).toMatchObject({
      plan: { actions: [{ kind: 'independent_review' }] },
      materialization: {
        status: 'task_created',
        headSha,
        actions: [{
          kind: 'independent_review',
          outcome: 'task_created',
          task: { status: 'queued', checkpoint: headSha, accessMode: 'read_only' },
          attempts: { used: 0, limit: 3 },
        }],
      },
    });
    expect(first.materialization.actions[0].task.handoff).toBeUndefined();
    const taskId = first.materialization.actions[0].taskId as string;
    const repeated = JSON.parse((await cli(root, args)).stdout);
    expect(repeated).toMatchObject({
      duplicate: true,
      materialization: {
        status: 'task_exists',
        actions: [{ outcome: 'task_exists', taskId }],
      },
    });
    const listed = (await cli(root, ['task', 'list'])).stdout.trim().split('\n');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain(taskId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifies signed GitHub webhooks before idempotent storage', async () => {
  const { root } = setup();
  const secret = 'quotaflow-webhook-test';
  try {
    const webhookEnv = { QUOTAFLOW_TEST_WEBHOOK_SECRET: secret };
    const payloadFile = join(root, 'webhook.json');
    const payload = Buffer.from(JSON.stringify({
      action: 'synchronize',
      repository: { full_name: 'wangxso/mcarplay' },
      pull_request: {
        number: 141,
        head: { sha: 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48' },
        base: { sha: 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e' },
      },
    }));
    writeFileSync(payloadFile, payload);
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const args = ['github', 'webhook', payloadFile, '--event', 'pull_request',
      '--delivery-id', 'webhook-delivery-1', '--signature', signature,
      '--secret-env', 'QUOTAFLOW_TEST_WEBHOOK_SECRET'];
    const first = JSON.parse((await cli(root, args, webhookEnv)).stdout);
    expect(first).toMatchObject({
      event: { eventType: 'pull_request', action: 'synchronize', pullNumber: 141 },
      delivery: { deliveryId: 'webhook-delivery-1', duplicateDelivery: false, duplicateEvent: false },
    });
    const retry = JSON.parse((await cli(root, args, webhookEnv)).stdout);
    expect(retry).toMatchObject({ delivery: { duplicateDelivery: true, duplicateEvent: true } });
    const alternateArgs = [...args];
    alternateArgs[alternateArgs.indexOf('webhook-delivery-1')] = 'webhook-delivery-2';
    const redelivered = JSON.parse((await cli(root, alternateArgs, webhookEnv)).stdout);
    expect(redelivered).toMatchObject({ delivery: { duplicateDelivery: false, duplicateEvent: true } });

    writeFileSync(payloadFile, Buffer.concat([payload, Buffer.from(' ')]));
    const tampered = await cliResult(root, args, cliEntry, webhookEnv);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.stderr).toContain('Invalid GitHub webhook signature');
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

supervisedTest('retries a failed task through the CLI', async () => {
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
    const added = JSON.parse((await cli(root, ['task', 'add', 'retry task', '--repo', repo])).stdout);
    const failed = JSON.parse((await cli(root, ['worker', 'once'])).stdout);
    expect(failed.task).toMatchObject({ id: added.id, status: 'failed' });
    const retried = JSON.parse((await cli(root, ['task', 'retry', added.id])).stdout);
    expect(retried).toMatchObject({ id: added.id, status: 'queued' });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

supervisedTest('cancels an active supervised task from a second CLI process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-cli-cancel-'));
  let worker: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const repo = join(root, 'repo');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    worktreeGit(repo, ['add', '.']);
    worktreeGit(repo, ['commit', '-m', 'base']);
    const config = join(root, 'quotaflow.config.json');
    writeFileSync(config, JSON.stringify({
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
          'hold',
        ],
      }],
    }));
    const added = JSON.parse((await cli(root, ['task', 'add', 'cancel task', '--repo', repo])).stdout);
    worker = Bun.spawn([
      globalThis.process.execPath,
      fileURLToPath(new URL('./cli.ts', import.meta.url)),
      'worker',
      'once',
      '--config',
      config,
    ], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      windowsHide: true,
    });
    const app = join(root, '.quotaflow', 'worktrees', added.id, 'app.txt');
    const ready = () => existsSync(app) && readFileSync(app, 'utf8') === 'partial\n';
    const deadline = Date.now() + 15_000;
    while (!ready() && Date.now() < deadline && worker.exitCode === null) {
      await Bun.sleep(30);
    }
    expect(ready()).toBe(true);

    const requested = JSON.parse((await cli(root, ['task', 'cancel', added.id])).stdout);
    expect(requested.status).toBe('cancelling');
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
      worker.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Worker exited ${exitCode}: ${stderr || stdout}`);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      agentStatus: 'cancelled',
      task: { status: 'cancelled' },
    });
    const shown = JSON.parse((await cli(root, ['task', 'show', added.id])).stdout);
    const events = JSON.parse((await cli(root, ['task', 'events', added.id])).stdout);
    expect(shown.task).toMatchObject({ status: 'cancelled' });
    expect(events.find((event: { kind: string }) => event.kind === 'cancel_requested')).toBeTruthy();
    expect(readFileSync(app, 'utf8')).toBe('partial\n');
  } finally {
    if (worker?.exitCode === null) worker.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 30_000);

supervisedTest('force-cancels an unresponsive supervised worker after verified process stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-cli-force-cancel-'));
  let worker: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const repo = join(root, 'repo');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    worktreeGit(repo, ['add', '.']);
    worktreeGit(repo, ['commit', '-m', 'base']);
    const config = join(root, 'quotaflow.config.json');
    writeFileSync(config, JSON.stringify({
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
          'hold',
        ],
      }],
    }));
    const added = JSON.parse((await cli(root, ['task', 'add', 'force cancel task', '--repo', repo])).stdout);
    worker = Bun.spawn([
      process.execPath,
      fileURLToPath(new URL('./recovery-crash-helper.ts', import.meta.url)),
      config,
    ], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      windowsHide: true,
    });
    const statusDir = join(root, '.quotaflow', 'worktrees', '.attempts', added.id, '1');
    const app = join(root, '.quotaflow', 'worktrees', added.id, 'app.txt');
    const ready = () => existsSync(join(statusDir, 'ready.json'))
      && existsSync(app) && readFileSync(app, 'utf8') === 'partial\n';
    const readyDeadline = Date.now() + 15_000;
    while (!ready() && Date.now() < readyDeadline) {
      if (worker.exitCode !== null) throw new Error(`Unresponsive worker exited before readiness (${worker.exitCode})`);
      await Bun.sleep(30);
    }
    expect(ready()).toBe(true);

    const result = JSON.parse((
      await cli(root, ['task', 'cancel', added.id, '--force', '--wait', '5000'])
    ).stdout);
    expect(result).toMatchObject({
      attemptId: 1,
      task: { status: 'cancelled' },
      cancellation: {
        outcome: 'cancelled',
        forced: true,
        supervisorStop: {
          activeProcesses: 0,
          reason: 'cancelled',
        },
      },
    });
    expect(result.task.checkpoint).toBeTruthy();
    expect(JSON.parse(readFileSync(join(statusDir, 'stopped.json'), 'utf8'))).toMatchObject({
      activeProcesses: 0,
      reason: 'cancelled',
    });
    expect(readFileSync(app, 'utf8')).toBe('partial\n');
    const events = JSON.parse((await cli(root, ['task', 'events', added.id])).stdout);
    expect(events.find((event: { kind: string }) => event.kind === 'cancel_forced')).toBeTruthy();
    expect(events.find((event: { kind: string }) => event.kind === 'attempt_recovered')?.detail)
      .toMatchObject({ reason: 'cancellation_forced', status: 'cancelled' });

    const repeated = JSON.parse((
      await cli(root, ['task', 'cancel', added.id, '--force', '--wait', '100'])
    ).stdout);
    expect(repeated).toMatchObject({
      task: { status: 'cancelled' },
      cancellation: { outcome: 'cancelled', forced: true },
    });
  } finally {
    if (worker?.exitCode === null) worker.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 30_000);

test('reports cancellation timeout and refuses unverified Codex write transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-cli-cancel-timeout-'));
  try {
    writeFileSync(join(root, 'quotaflow.config.json'), JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      defaultRepo: root,
      routing: { allowedProviders: ['local'] },
      lanes: [{
        id: 'codex',
        agent: 'codex',
        model: 'fixture-model',
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
      }],
    }));
    const added = JSON.parse((await cli(root, ['task', 'add', 'timeout task', '--repo', root])).stdout);
    const reserved = JSON.parse((await cli(root, ['queue', 'next'])).stdout);
    const worktreeRoot = join(root, '.quotaflow', 'worktrees');
    writeAttemptOwner(
      attemptDirectory({ worktreeRoot }, added.id, reserved.attempt.id),
      999_999,
      Date.now(),
    );

    const timedOut = await cliResult(root, ['task', 'cancel', added.id, '--wait', '100']);
    expect(timedOut.exitCode).toBe(2);
    expect(JSON.parse(timedOut.stdout)).toMatchObject({
      attemptId: reserved.attempt.id,
      task: { status: 'cancelling' },
      cancellation: { outcome: 'timeout', forced: false },
    });

    const forced = await cliResult(root, ['task', 'cancel', added.id, '--force', '--wait', '100']);
    expect(forced.exitCode).toBe(2);
    const result = JSON.parse(forced.stdout);
    expect(result).toMatchObject({
      attemptId: reserved.attempt.id,
      task: { status: 'blocked', checkpoint: null },
      cancellation: {
        outcome: 'unverified',
        forced: true,
        recovery: {
          blocked: 1,
          items: [{
            reason: 'writer_unverified',
            outcome: 'blocked',
          }],
        },
      },
    });
    const shown = JSON.parse((await cli(root, ['task', 'show', added.id])).stdout);
    expect(shown.attempts).toMatchObject([{
      id: reserved.attempt.id,
      stage: 'done',
      checkpoint: null,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 20_000);

supervisedTest('runs one supervised fixture through the CLI worker', async () => {
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

supervisedTest('hands off an opted-in task from a quota-held Codex lane to an OpenCode lane', async () => {
  const { root, config } = setup();
  try {
    const repo = join(root, 'repo');
    worktreeGit(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    worktreeGit(repo, ['add', '.']);
    worktreeGit(repo, ['commit', '-m', 'base']);
    const fixture = fileURLToPath(new URL('./fixture-agent.ts', import.meta.url));
    const windows = [{ key: 'day', remaining: 10, reserve: 0, observedAt: Date.now(), resetAt: Date.now() + 60_000 }];
    writeFileSync(config, JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      defaultRepo: repo,
      routing: { allowedProviders: ['local'] },
      lanes: [
        { id: 'donor', agent: 'codex', model: 'fixture', provider: 'local', account: 'first', priority: 2, slots: 1,
          windows, command: [process.execPath, fixture, 'handoff-quota'] },
        { id: 'recipient', agent: 'opencode', model: 'fixture', provider: 'local', account: 'second', priority: 1, slots: 1,
          windows, command: [process.execPath, fixture, 'handoff-resume'] },
      ],
    }));
    const invoke = async (...args: string[]) => JSON.parse((await cli(root, args)).stdout);
    const task = await invoke('task', 'add', 'Finish fixture', '--handoff', '--handoff-protect', 'app.txt');
    expect(task.handoff).toEqual({ protectedPaths: ['app.txt'] });
    const first = await invoke('worker', 'once');
    expect(first).toMatchObject({ task: { status: 'waiting_quota' }, attempt: { agent: 'codex' } });
    expect(first.checkpoint).toBeString();
    const shown = await invoke('task', 'show', task.id);
    expect(shown.handoffNote).toMatchObject({ taskId: task.id, attemptId: first.attempt.id, checkpoint: first.checkpoint,
      note: { completed: ['Verified app.txt contains 41'] } });
    expect(worktreeGit(repo, ['ls-tree', '--name-only', first.checkpoint])).toBe('app.txt');

    await invoke('task', 'retry', task.id);
    const second = await invoke('worker', 'once');
    expect(second).toMatchObject({ task: { status: 'completed' }, attempt: { agent: 'opencode' } });
    expect(worktreeGit(repo, ['show', `${second.checkpoint}:app.txt`])).toBe('41');
    expect(worktreeGit(repo, ['show', `${second.checkpoint}:answer.txt`])).toBe('42');
    expect(await invoke('task', 'events', task.id)).toContainEqual(expect.objectContaining({
      attemptId: second.attempt.id, kind: 'handoff_input', detail: { checkpoint: first.checkpoint, sourceAttemptId: first.attempt.id },
    }));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  }
}, 30_000);
