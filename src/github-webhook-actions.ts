import type { QuotaFlowConfig } from './domain';
import {
  ciTriageRequiresHuman,
  enrichGitHubPlanWithCi,
  type GitHubCiTriage,
} from './github-ci';
import type { GitHubCiRerunSummary } from './github-ci-rerun';
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
  ciRerun?: GitHubCiRerunSummary;
}

export interface GitHubCiAssessment {
  triage: GitHubCiTriage;
  rerun?: GitHubCiRerunSummary;
}

export async function materializeGitHubWebhookActions(
  store: TaskStore,
  config: QuotaFlowConfig,
  context: GitHubWebhookActionContext,
  ciAssessmentSource?: GitHubCiAssessment | (() =>
    Promise<GitHubCiAssessment> | GitHubCiAssessment),
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
  const ciAssessment = needsCiTriage && ciAssessmentSource
    ? typeof ciAssessmentSource === 'function'
      ? await ciAssessmentSource()
      : ciAssessmentSource
    : undefined;
  const ciTriage = ciAssessment?.triage;
  const ciRerun = ciAssessment?.rerun;
  const remainingCiTriage = ciRerun?.remainingTriage ?? ciTriage;
  const allAgentActionsAreCiFixes = agentActions.length > 0
    && agentActions.every((action) => action.kind === 'ci_fix');
  const agentActionableCiFailure = Boolean(remainingCiTriage?.failures.some((failure) =>
    failure.category === 'code_or_test' || failure.category === 'unknown'));
  if (agentActions.length > 0 && ciRerun?.staleHead) {
    return {
      status: 'human_only',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: 'ci_rerun_stale_head',
      ...(ciTriage ? { ciTriage } : {}),
      ...(ciRerun ? { ciRerun } : {}),
    };
  }
  if (
    allAgentActionsAreCiFixes
    && ciRerun
    && ciRerun.candidates.length > 0
    && remainingCiTriage?.failures.length === 0
  ) {
    return {
      status: 'human_only',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: ciRerun.status === 'requested' ? 'ci_rerun_requested' : 'ci_rerun_requires_human',
      ...(ciTriage ? { ciTriage } : {}),
      ...(ciRerun ? { ciRerun } : {}),
    };
  }
  if (
    allAgentActionsAreCiFixes
    && ciRerun?.status === 'human_only'
    && !agentActionableCiFailure
  ) {
    return {
      status: 'human_only',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: 'ci_rerun_requires_human',
      ...(ciTriage ? { ciTriage } : {}),
      ...(ciRerun ? { ciRerun } : {}),
    };
  }
  if (
    agentActions.length > 0
    && agentActions.every((action) => action.kind === 'ci_fix')
    && ciTriageRequiresHuman(remainingCiTriage)
  ) {
    return {
      status: 'human_only',
      repository,
      pullNumber: context.snapshot.number,
      headSha: context.snapshot.headSha,
      reason: 'ci_triage_requires_human',
      ...(ciTriage ? { ciTriage } : {}),
      ...(ciRerun ? { ciRerun } : {}),
    };
  }

  const plan = enrichGitHubPlanWithCi(context.plan, remainingCiTriage);
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
    ...(ciRerun ? { ciRerun } : {}),
  };
}
