import { expect, test } from 'bun:test';
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
import type { GitHubWebhookActionContext } from './github-webhook-server';
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

test('webhook action materialization fetches the exact head and is idempotent', () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const actionContext = context(value);
    const first = materializeGitHubWebhookActions(store, config(repo, join(root, 'worktrees')), actionContext);
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
    const repeated = materializeGitHubWebhookActions(store, config(repo, join(root, 'worktrees')), actionContext);
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

test('webhook action materialization ignores unmapped forks and unapproved branches', () => {
  const { root, repo, baseSha, headSha } = setupRepository();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const value = snapshot(baseSha, headSha);
    const fork = materializeGitHubWebhookActions(store, config(repo, join(root, 'worktrees')), context({
      ...value,
      headRepository: 'fork/mcarplay',
    }));
    expect(fork).toMatchObject({ status: 'ignored', reason: 'fork_pull_request' });

    const branch = materializeGitHubWebhookActions(store, config(repo, join(root, 'worktrees')), context({
      ...value,
      headRef: 'release/not-allowed',
    }));
    expect(branch).toMatchObject({ status: 'ignored', reason: 'branch_not_allowed' });

    const unmapped = materializeGitHubWebhookActions(store, {
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
