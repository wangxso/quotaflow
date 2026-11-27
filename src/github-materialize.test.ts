import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db';
import type { BudgetPolicy } from './domain';
import { hashGitHubPayload, type GitHubActionPlan, type GitHubPlannedAction } from './github';
import { materializeGitHubActions } from './github-materialize';
import { TaskStore } from './store';
import { ensureWorktree, worktreeGit } from './worktree';

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-github-materialize-'));
  const repo = join(root, 'repo');
  worktreeGit(root, ['init', '--initial-branch=main', repo]);
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  worktreeGit(repo, ['add', '.']);
  worktreeGit(repo, ['commit', '-m', 'base']);
  const headSha = worktreeGit(repo, ['rev-parse', 'HEAD']);
  return { root, repo, headSha };
}

function plannedAction(
  kind: GitHubPlannedAction['kind'],
  requiresHuman: boolean,
  taskPrompt: string | null,
  reasonCodes: string[],
): GitHubPlannedAction {
  const reasonKey = [...reasonCodes].sort();
  return {
    actionKey: hashGitHubPayload(['wangxso/quotaflow', 141, 'a'.repeat(40), kind, reasonKey]),
    kind,
    title: `Test ${kind}`,
    priority: kind === 'review_fix' ? 120 : 90,
    requiresHuman,
    reasonCodes,
    taskPrompt,
  };
}

function plan(headSha: string, actions: GitHubPlannedAction[]): GitHubActionPlan {
  return {
    status: 'remediation_required',
    pullNumber: 141,
    headSha,
    humanApprovalRequired: true,
    actions,
  };
}

const budget: BudgetPolicy = {
  account: 'fixture',
  unit: 'gateway-estimate',
  limit: 2,
  reserve: 0,
  windowMs: 60_000,
  holdPerAttempt: 0.25,
};

test('materializes one head-bound agent task and leaves human actions untouched', () => {
  const { root, repo, headSha } = setupRepo();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const agent = plannedAction(
      'review_fix',
      false,
      'Address the review findings without pushing, commenting, or merging.',
      ['ci_not_success', 'changes_requested'],
    );
    const human = plannedAction('resolve_conflict', true, null, ['not_mergeable']);
    const actionPlan = plan(headSha, [agent, human]);
    const input = {
      repository: 'wangxso/quotaflow',
      repoPath: repo,
      worktreeRoot: join(root, 'worktrees'),
      baseSha: headSha,
      budgets: [budget],
    };

    const first = materializeGitHubActions(store, actionPlan, input);
    expect(first).toMatchObject({
      status: 'task_created',
      headSha,
      limits: {
        attemptsPerTask: 3,
        budgetEnforcement: 'configured',
        budgets: [budget],
      },
    });
    expect(first.actions[0]).toMatchObject({
      kind: 'review_fix',
      outcome: 'task_created',
      requiresHuman: false,
      attempts: { used: 0, limit: 3 },
      task: {
        status: 'queued',
        checkpoint: headSha,
        priority: 120,
        accessMode: 'write',
        handoff: { protectedPaths: [] },
      },
    });
    expect(first.actions[0]!.task?.prompt).toContain(`Exact head SHA: ${headSha}`);
    expect(first.actions[0]!.task?.prompt).toContain('without pushing, commenting, or merging');
    expect(first.actions[1]).toMatchObject({
      kind: 'resolve_conflict',
      outcome: 'human_required',
      taskId: null,
      task: null,
    });
    expect(store.events(first.actions[0]!.taskId!)).toContainEqual(expect.objectContaining({
      kind: 'task_created',
      detail: expect.objectContaining({
        source: 'github_action_plan',
        actionKey: agent.actionKey,
        headSha,
      }),
    }));

    ensureWorktree(repo, first.actions[0]!.task!.workspacePath, headSha);
    const repeated = materializeGitHubActions(store, actionPlan, input);
    expect(repeated.status).toBe('task_exists');
    expect(repeated.actions[0]).toMatchObject({
      outcome: 'task_exists',
      taskId: first.actions[0]!.taskId,
    });
    expect(store.listTasks()).toHaveLength(1);

    worktreeGit(first.actions[0]!.task!.workspacePath, ['commit', '--allow-empty', '-m', 'drift']);
    expect(() => materializeGitHubActions(store, actionPlan, input))
      .toThrow(`Workspace ${first.actions[0]!.task!.workspacePath} is not checked out at ${headSha}`);
    expect(store.listTasks()).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing head evidence before creating a task', () => {
  const { root, repo } = setupRepo();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const missingHead = 'f'.repeat(40);
    const actionPlan = plan(missingHead, [
      plannedAction('independent_review', false, 'Review the exact pull request head.', ['independent_review_missing']),
    ]);
    expect(() => materializeGitHubActions(store, actionPlan, {
      repository: 'wangxso/quotaflow',
      repoPath: repo,
      worktreeRoot: join(root, 'worktrees'),
      baseSha: missingHead,
    })).toThrow(`Commit ${missingHead} is not available`);
    expect(store.listTasks()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses parallel agent tasks and keeps human-only plans task-free', () => {
  const { root, repo, headSha } = setupRepo();
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const input = {
      repository: 'wangxso/quotaflow',
      repoPath: repo,
      worktreeRoot: join(root, 'worktrees'),
      baseSha: headSha,
    };
    expect(() => materializeGitHubActions(store, plan(headSha, [
      plannedAction('independent_review', false, 'Review.', ['independent_review_missing']),
      plannedAction('ci_fix', false, 'Fix CI.', ['ci_not_success']),
    ]), input)).toThrow('more than one agent task');

    const humanOnly = materializeGitHubActions(store, plan(headSha, [
      plannedAction('human_merge', true, null, []),
    ]), input);
    expect(humanOnly).toMatchObject({
      status: 'human_only',
      limits: { attemptsPerTask: 3, budgetEnforcement: 'quota_only' },
      actions: [{ outcome: 'human_required', taskId: null }],
    });
    expect(store.listTasks()).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
