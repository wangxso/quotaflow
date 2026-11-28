import type { QuotaFlowConfig } from './domain';
import {
  ciTriageRequiresHuman,
  enrichGitHubPlanWithCi,
  type GitHubCiTriage,
} from './github-ci';
import {
  materializeGitHubActions,
  type GitHubPlanMaterialization,
} from './github-materialize';
import type { GitHubWebhookActionContext } from './github-webhook-server';
import type { TaskStore } from './store';
import { fetchGitHubCommits } from './worktree';

export interface GitHubWebhookActionOutcome {
  status: 'materialized' | 'human_only' | 'ignored' | 'not_configured';
  repository: string;
  pullNumber: number;
  headSha: string;
  reason?: string;
  materialization?: GitHubPlanMaterialization;
  ciTriage?: GitHubCiTriage;
}

export async function materializeGitHubWebhookActions(
  store: TaskStore,
  config: QuotaFlowConfig,
  context: GitHubWebhookActionContext,
  ciTriageSource?: GitHubCiTriage | (() => Promise<GitHubCiTriage> | GitHubCiTriage),
): Promise<GitHubWebhookActionOutcome> {
  const repository = context.snapshot.repository.toLowerCase();
  const project = config.githubProjects?.find((candidate) => candidate.repository === repository);
  if (!project) {
    return {
      status: 'not_configured',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: 'repository_not_mapped',
    };
  }
  if (!project.allowForks && context.snapshot.headRepository?.toLowerCase() !== repository) {
    return {
      status: 'ignored',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: context.snapshot.headRepository ? 'fork_pull_request' : 'head_repository_missing',
    };
  }
  if (!project.branchPrefixes.some((prefix) => context.snapshot.headRef.startsWith(prefix))) {
    return {
      status: 'ignored',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: 'branch_not_allowed',
    };
  }

  const agentActions = context.plan.actions.filter((action) => !action.requiresHuman);
  const needsCiTriage = agentActions.some((action) =>
    action.kind === 'ci_fix' || action.kind === 'review_fix');
  const ciTriage = needsCiTriage && ciTriageSource
    ? typeof ciTriageSource === 'function'
      ? await ciTriageSource()
      : ciTriageSource
    : undefined;
  if (
    agentActions.length > 0
    && agentActions.every((action) => action.kind === 'ci_fix')
    && ciTriageRequiresHuman(ciTriage)
  ) {
    return {
      status: 'human_only',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: 'ci_triage_requires_human',
      ...(ciTriage ? { ciTriage } : {}),
    };
  }

  const plan = enrichGitHubPlanWithCi(context.plan, ciTriage);
  if (agentActions.length > 0) {
    fetchGitHubCommits(project.repoPath, project.remote ?? 'origin', [
      context.snapshot.headSha,
      context.snapshot.baseSha,
    ]);
  }
  const materialization = materializeGitHubActions(store, plan, {
    repository,
    repoPath: project.repoPath,
    worktreeRoot: config.worktreeRoot,
    baseSha: context.snapshot.baseSha,
    budgets: config.budgets,
  });
  return {
    status: materialization.status === 'human_only' ? 'human_only' : 'materialized',
    repository,
    pullNumber: context.snapshot.number,
    headSha: context.snapshot.headSha,
    materialization,
    ...(ciTriage ? { ciTriage } : {}),
  };
}
