import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db';
import type { QuotaFlowConfig } from './domain';
import {
  hashGitHubPayload,
  type GitHubActionPlan,
  type GitHubGateResult,
  type GitHubPullSnapshot,
} from './github';
import { materializeGitHubWebhookActions } from './github-webhook-actions';
import {
  createGitHubWebhookHandler,
  type GitHubWebhookActionContext,
} from './github-webhook-server';
import { TaskStore } from './store';
import { worktreeGit } from './worktree';

function setupRepository() {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-webhook-actions-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  worktreeGit(root, ['init', '--bare', remote]);
  worktreeGit(root, ['init', '--initial-branch=main', source]);
  writeFileSync(join(source, 'app.txt'), 'base\n');
  worktreeGit(source, ['add', '.']);
  worktreeGit(source, ['commit', '-m', 'base']);
  const baseSha = worktreeGit(source, ['rev-parse', 'HEAD']);
  worktreeGit(source, ['remote', 'add', 'origin', remote]);
  worktreeGit(source, ['push', 'origin', 'main']);
  worktreeGit(source, ['checkout', '-b', 'quotaflow/feature']);
  writeFileSync(join(source, 'answer.txt'), '42\n');
  worktreeGit(source, ['add', '.']);
  worktreeGit(source, ['commit', '-m', 'feature']);
  const headSha = worktreeGit(source, ['rev-parse', 'HEAD']);
  worktreeGit(source, ['push', 'origin', 'HEAD:refs/pull/42/head']);
  worktreeGit(root, ['clone', remote, repo]);
  return { root, repo, baseSha, headSha };
}

function snapshot(baseSha: string, headSha: string): GitHubPullSnapshot {
  return {
    repository: 'wangxso/mcarplay',
    number: 42,
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    authorLogin: 'wangxso',
    baseRef: 'main',
    headRef: 'quotaflow/feature',
    headRepository: 'wangxso/mcarplay',
    baseSha,
    headSha,
    checks: [],
    reviews: [],
  };
}

function context(value: GitHubPullSnapshot): GitHubWebhookActionContext {
  const plannedActionKey = hashGitHubPayload([value.repository, value.number, value.headSha, 'independent_review']);
  const plan: GitHubActionPlan = {
    status: 'remediation_required',
    pullNumber: value.number,
    headSha: value.headSha,
    humanApprovalRequired: true,
    actions: [{
      actionKey: plannedActionKey,
      kind: 'independent_review',
      title: 'Perform an independent current-head review',
      priority: 90,
      requiresHuman: false,
      reasonCodes: ['independent_review_missing'],
      taskPrompt: 'Perform a read-only review.',
    }],
  };
  const gate: GitHubGateResult = {
    status: 'blocked',
    repository: value.repository,
    pullNumber: value.number,
    headSha: value.headSha,
    policyHash: 'policy',
    humanMergeRequired: true,
    checks: [],
    independentApprovals: 0,
    reasons: [{ code: 'independent_review_missing', message: 'missing' }],
  };
  return {
    deliveryId: 'delivery-42',
    event: {
      eventType: 'pull_request',
      action: 'synchronize',
      repository: value.repository,
      pullNumber: value.number,
      headSha: value.headSha,
      baseSha: value.baseSha,
      payloadHash: 'payload',
    },
    snapshot: value,
    gate,
    plan,
  };
}

function config(repoPath: string, worktreeRoot: string): QuotaFlowConfig {
  return {
    version: 1,
    database: ':memory:',
    worktreeRoot,
    routing: { allowedProviders: [] },
    githubProjects: [{
      repository: 'wangxso/mcarplay',
      repoPath,
      branchPrefixes: ['quotaflow/'],
    }],
    lanes: [],
  };
}

test('webhook action materialization fetches the exact head and is idempotent', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const actionContext = context(value);
    const first = await materializeGitHubWebhookActions(
      store,
      config(repo, join(root, 'worktrees')),
      actionContext,
    );
    expect(first).toMatchObject({
      status: 'materialized',
      repository: 'wangxso/mcarplay',
      headSha,
      materialization: {
        status: 'task_created',
        actions: [{
          kind: 'independent_review',
          outcome: 'task_created',
          task: { accessMode: 'read_only', checkpoint: headSha },
        }],
      },
    });
    const repeated = await materializeGitHubWebhookActions(
      store,
      config(repo, join(root, 'worktrees')),
      actionContext,
    );
    expect(repeated).toMatchObject({
      status: 'materialized',
      materialization: { status: 'task_exists' },
    });
    expect(store.listTasks()).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lost HTTP response followed by the same delivery creates one task', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const webhookSecret = ['lost', 'response', 'secret'].join('-');
  try {
    const value = snapshot(baseSha, headSha);
    value.checks = [{
      name: 'Check and build debug APK',
      status: 'completed',
      conclusion: 'failure',
      headSha,
      startedAt: '2026-11-28T01:00:00Z',
      completedAt: '2026-11-28T01:01:00Z',
    }];
    const rawBody = Buffer.from(JSON.stringify({
      action: 'synchronize',
      repository: { full_name: value.repository },
      pull_request: {
        number: value.number,
        head: { sha: value.headSha },
        base: { sha: value.baseSha },
      },
    }));
    const webhookSignature = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
    const handle = createGitHubWebhookHandler({
      store,
      secret: webhookSecret,
      path: '/github/webhook',
      snapshotFetcher: async () => value,
      gatePolicy: { requiredApprovals: 0 },
      actionHandler: (actionContext) => materializeGitHubWebhookActions(
        store,
        config(repo, join(root, 'worktrees')),
        actionContext,
      ),
    });
    const request = () => new Request('http://localhost/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'lost-response-delivery',
        'x-hub-signature-256': webhookSignature,
      },
      body: rawBody,
    });

    const first = await handle(request());
    expect(first.status).toBe(202);
    const retry = await handle(request());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      status: 'duplicate',
      delivery: { duplicateDelivery: true, duplicateEvent: true },
      taskMaterialization: { materialization: { status: 'task_exists' } },
    });
    expect(store.listTasks()).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('webhook action materialization ignores unmapped forks and unapproved branches', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const fork = await materializeGitHubWebhookActions(store, config(repo, join(root, 'worktrees')), context({
      ...value,
      headRepository: 'fork/mcarplay',
    }));
    expect(fork).toMatchObject({ status: 'ignored', reason: 'fork_pull_request' });

    const branch = await materializeGitHubWebhookActions(store, config(repo, join(root, 'worktrees')), context({
      ...value,
      headRef: 'release/not-allowed',
    }));
    expect(branch).toMatchObject({ status: 'ignored', reason: 'branch_not_allowed' });

    const unmapped = await materializeGitHubWebhookActions(store, {
      ...config(repo, join(root, 'worktrees')),
      githubProjects: [],
    }, context(value));
    expect(unmapped).toMatchObject({ status: 'not_configured', reason: 'repository_not_mapped' });
    expect(store.listTasks()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('webhook action materialization leaves infrastructure-only CI failures for humans', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const actionContext = context(value);
    actionContext.plan.actions[0] = {
      ...actionContext.plan.actions[0]!,
      kind: 'ci_fix',
      reasonCodes: ['ci_not_success'],
      taskPrompt: 'Fix CI.',
    };
    const result = await materializeGitHubWebhookActions(
      store,
      config(repo, join(root, 'worktrees')),
      actionContext,
      {
        triage: {
          headSha,
          complete: true,
          failures: [{
            name: 'runner health',
            jobId: 10,
            runId: 1,
            category: 'infrastructure',
            logBytes: 20,
            truncated: false,
            excerpt: 'runner lost communication',
          }],
        },
      },
    );
    expect(result).toMatchObject({
      status: 'human_only',
      reason: 'ci_triage_requires_human',
      ciTriage: {
        failures: [{ category: 'infrastructure' }],
      },
    });
    expect(store.listTasks()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('webhook action materialization waits for an exact-head CI rerun without creating a task', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const actionContext = context(value);
    actionContext.plan.actions[0] = {
      ...actionContext.plan.actions[0]!,
      kind: 'ci_fix',
      reasonCodes: ['ci_not_success'],
      taskPrompt: 'Fix CI.',
    };
    const ciTriage = {
      headSha,
      complete: true,
      failures: [{
        name: 'runner health',
        jobId: 10,
        runId: 100,
        category: 'infrastructure' as const,
        logBytes: 20,
        truncated: false,
        excerpt: 'runner lost communication',
      }],
    };
    const result = await materializeGitHubWebhookActions(
      store,
      config(repo, join(root, 'worktrees')),
      actionContext,
      {
        triage: ciTriage,
        rerun: {
          status: 'requested',
          incomplete: false,
          candidates: [100],
          outcomes: [{
            runId: 100,
            outcomes: 'requested',
            failedChecks: ['runner health'],
            categories: ['infrastructure'],
            httpStatus: 201,
            message: 'requested',
          }],
          remainingTriage: { ...ciTriage, failures: [] },
          staleHead: false,
        },
      },
    );
    expect(result).toMatchObject({
      status: 'human_only',
      reason: 'ci_rerun_requested',
      ciRerun: { candidates: [100], outcomes: [{ runId: 100 }] },
    });
    expect(store.listTasks()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('webhook action materialization reruns infrastructure and still repairs code failures', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const actionContext = context(value);
    actionContext.plan.actions[0] = {
      ...actionContext.plan.actions[0]!,
      kind: 'ci_fix',
      reasonCodes: ['ci_not_success'],
      taskPrompt: 'Fix CI.',
    };
    const codeFailure = {
      name: 'unit tests',
      jobId: 11,
      runId: 101,
      category: 'code_or_test' as const,
      logBytes: 30,
      truncated: false,
      excerpt: 'AssertionError: expected 42',
    };
    const infrastructureFailure = {
      name: 'runner health',
      jobId: 10,
      runId: 100,
      category: 'infrastructure' as const,
      logBytes: 20,
      truncated: false,
      excerpt: 'runner lost communication',
    };
    const result = await materializeGitHubWebhookActions(
      store,
      config(repo, join(root, 'worktrees')),
      actionContext,
      {
        triage: {
          headSha,
          complete: true,
          failures: [infrastructureFailure, codeFailure],
        },
        rerun: {
          status: 'requested',
          incomplete: false,
          candidates: [100],
          outcomes: [{
            runId: 100,
            outcomes: 'requested',
            failedChecks: ['runner health'],
            categories: ['infrastructure'],
            httpStatus: 201,
            message: 'requested',
          }],
          remainingTriage: {
            headSha,
            complete: true,
            failures: [codeFailure],
          },
          staleHead: false,
        },
      },
    );
    expect(result).toMatchObject({
      status: 'materialized',
      materialization: {
        actions: [{
          kind: 'ci_fix',
          outcome: 'task_created',
          task: { accessMode: 'write' },
        }],
      },
    });
    const prompt = result.materialization!.actions[0]!.task!.prompt;
    expect(prompt).toContain('Category: code_or_test');
    expect(prompt).toContain('AssertionError: expected 42');
    expect(prompt).not.toContain('runner lost communication');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('webhook action materialization blocks review fixes when rerun detects a stale head', async () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const actionContext = context(value);
    actionContext.plan.actions[0] = {
      ...actionContext.plan.actions[0]!,
      kind: 'review_fix',
      reasonCodes: ['ci_not_success', 'changes_requested'],
      taskPrompt: 'Address review feedback and CI.',
    };
    const ciTriage = {
      headSha,
      complete: true,
      failures: [{
        name: 'runner health',
        jobId: 10,
        runId: 100,
        category: 'infrastructure' as const,
        logBytes: 20,
        truncated: false,
        excerpt: 'runner lost communication',
      }],
    };
    const result = await materializeGitHubWebhookActions(
      store,
      config(repo, join(root, 'worktrees')),
      actionContext,
      {
        triage: ciTriage,
        rerun: {
          status: 'human_only',
          incomplete: false,
          candidates: [100],
          outcomes: [{
            runId: 100,
            outcomes: 'stale_head',
            failedChecks: ['runner health'],
            categories: ['infrastructure'],
            message: 'stale',
          }],
          remainingTriage: ciTriage,
          staleHead: true,
        },
      },
    );
    expect(result).toMatchObject({
      status: 'human_only',
      reason: 'ci_rerun_stale_head',
    });
    expect(store.listTasks()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
