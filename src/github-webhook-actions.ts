import type { QuotaFlowConfig } from './domain';
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
}

export function materializeGitHubWebhookActions(
  store: TaskStore,
  config: QuotaFlowConfig,
  context: GitHubWebhookActionContext,
): GitHubWebhookActionOutcome {
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

  if (context.plan.actions.some((action) => !action.requiresHuman)) {
    fetchGitHubCommits(project.repoPath, project.remote ?? 'origin', [
      context.snapshot.headSha,
      context.snapshot.baseSha,
    ]);
  }
  const materialization = materializeGitHubActions(store, context.plan, {
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
  };
}
