import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BudgetPolicy, Task } from './domain';
import type { GitHubActionPlan, GitHubPlannedAction } from './github';
import { MAX_ATTEMPTS_PER_TASK, type TaskStore } from './store';
import { commitExists, currentCommit } from './worktree';

const agentActionKinds = new Set<GitHubPlannedAction['kind']>([
  'independent_review',
  'review_fix',
  'ci_fix',
]);

export interface GitHubMaterializationInput {
  repository: string;
  repoPath: string;
  worktreeRoot: string;
  baseSha: string;
  budgets?: BudgetPolicy[];
}

export interface GitHubActionMaterialization {
  actionKey: string;
  kind: GitHubPlannedAction['kind'];
  title: string;
  requiresHuman: boolean;
  reasonCodes: string[];
  outcome: 'task_created' | 'task_exists' | 'human_required';
  taskId: string | null;
  task: Task | null;
  attempts: {
    used: number;
    limit: number;
  };
}

export interface GitHubPlanMaterialization {
  status: 'task_created' | 'task_exists' | 'human_only';
  repository: string;
  pullNumber: number;
  headSha: string;
  actions: GitHubActionMaterialization[];
  limits: {
    attemptsPerTask: number;
    budgetEnforcement: 'configured' | 'quota_only';
    budgets: BudgetPolicy[];
  };
}

function taskIdFor(actionKey: string): string {
  return `gh-${actionKey.slice(0, 32)}`;
}

function taskPrompt(
  repository: string,
  pullNumber: number,
  headSha: string,
  baseSha: string,
  action: GitHubPlannedAction,
): string {
  if (!action.taskPrompt?.trim()) {
    throw new Error(`GitHub action ${action.kind} has no task prompt`);
  }
  return [
    `Repository: ${repository}`,
    `Pull request: #${pullNumber}`,
    `Exact head SHA: ${headSha}`,
    `Base SHA: ${baseSha}`,
    `Action key: ${action.actionKey}`,
    '',
    'The task worktree is created from the exact head SHA. Do not switch branches or check out another commit.',
    '',
    action.taskPrompt,
  ].join('\n');
}

export function materializeGitHubActions(
  store: TaskStore,
  plan: GitHubActionPlan,
  input: GitHubMaterializationInput,
): GitHubPlanMaterialization {
  const repoPath = resolve(input.repoPath);
  const worktreeRoot = resolve(input.worktreeRoot);
  const budgets = input.budgets ?? [];
  const agentActions = plan.actions.filter((action) => !action.requiresHuman);
  if (agentActions.length > 1) {
    throw new Error('GitHub action plan contains more than one agent task');
  }
  const unsupported = agentActions.find((action) => !agentActionKinds.has(action.kind));
  if (unsupported) throw new Error(`GitHub action ${unsupported.kind} cannot be materialized as an agent task`);

  if (agentActions.length > 0) {
    if (!/^[0-9a-f]{40}$/i.test(plan.headSha) || !/^[0-9a-f]{40}$/i.test(input.baseSha)) {
      throw new Error('GitHub action materialization requires exact base and head commit SHAs');
    }
    for (const revision of new Set([plan.headSha, input.baseSha])) {
      if (!commitExists(repoPath, revision)) {
        throw new Error(`Commit ${revision} is not available in ${repoPath}; fetch the pull request before materializing`);
      }
    }
  }

  const actions: GitHubActionMaterialization[] = [];
  for (const action of plan.actions) {
    if (action.requiresHuman) {
      actions.push({
        actionKey: action.actionKey,
        kind: action.kind,
        title: action.title,
        requiresHuman: true,
        reasonCodes: action.reasonCodes,
        outcome: 'human_required',
        taskId: null,
        task: null,
        attempts: { used: 0, limit: MAX_ATTEMPTS_PER_TASK },
      });
      continue;
    }

    const taskId = taskIdFor(action.actionKey);
    const workspacePath = join(worktreeRoot, taskId);
    const existing = store.findTask(taskId);
    if (!existing && existsSync(workspacePath)) {
      throw new Error(`Workspace ${workspacePath} exists without task ${taskId}`);
    }
    if (existing && existsSync(workspacePath) && currentCommit(workspacePath) !== plan.headSha) {
      throw new Error(`Workspace ${workspacePath} is not checked out at ${plan.headSha}`);
    }
    const created = store.createTaskOnce({
      id: taskId,
      title: `GitHub PR #${plan.pullNumber}: ${action.title}`,
      prompt: taskPrompt(input.repository, plan.pullNumber, plan.headSha, input.baseSha, action),
      repoPath,
      workspacePath,
      priority: action.priority,
      handoff: { protectedPaths: [] },
      initialCheckpoint: plan.headSha,
      eventDetail: {
        source: 'github_action_plan',
        repository: input.repository,
        pullNumber: plan.pullNumber,
        headSha: plan.headSha,
        baseSha: input.baseSha,
        actionKey: action.actionKey,
        kind: action.kind,
        reasonCodes: action.reasonCodes,
      },
    });
    const attemptsUsed = store.attempts(created.task.id).length;
    actions.push({
      actionKey: action.actionKey,
      kind: action.kind,
      title: action.title,
      requiresHuman: false,
      reasonCodes: action.reasonCodes,
      outcome: created.created ? 'task_created' : 'task_exists',
      taskId: created.task.id,
      task: created.task,
      attempts: { used: attemptsUsed, limit: MAX_ATTEMPTS_PER_TASK },
    });
  }

  const status = actions.some((action) => action.outcome === 'task_created')
    ? 'task_created'
    : actions.some((action) => action.outcome === 'task_exists')
      ? 'task_exists'
      : 'human_only';
  return {
    status,
    repository: input.repository,
    pullNumber: plan.pullNumber,
    headSha: plan.headSha,
    actions,
    limits: {
      attemptsPerTask: MAX_ATTEMPTS_PER_TASK,
      budgetEnforcement: budgets.length > 0 ? 'configured' : 'quota_only',
      budgets,
    },
  };
}
