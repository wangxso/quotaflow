import {
  evaluateGitHubPull,
  type GitHubGatePolicy,
  type GitHubGateRecord,
  type GitHubPullSnapshot,
} from './github';
import { fetchGitHubPullSnapshot } from './github-api';
import { dashboardRequestIdPattern } from './dashboard-worker-logs';
import { redactSensitiveText } from './github-ci';
import type {
  DashboardGitHubActionKind,
  DashboardGitHubActionOutcome,
  TaskStore,
} from './store';

const apiVersion = '2022-11-28';

export class DashboardGitHubWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export interface DashboardGitHubActionInput {
  action: DashboardGitHubActionKind;
  repository: string;
  pullNumber: number;
  expectedHeadSha: string;
  requestId: string;
  actor: string;
}

export interface DashboardGitHubActionDependencies {
  store: TaskStore;
  token: string;
  apiUrl?: string;
  policy?: GitHubGatePolicy;
  allowedBranchPrefixes?: string[];
  allowForks?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface DashboardGitHubActionResult {
  status: 'accepted' | 'replayed';
  action: DashboardGitHubActionKind;
  repository: string;
  pullNumber: number;
  requestId: string;
  headSha: string;
  outcome: DashboardGitHubActionOutcome;
  gate: GitHubGateRecord | null;
  reviewId?: number;
  reviewState?: string;
  mergeCommitSha?: string | null;
}

function validatedApiUrl(value: string | undefined): string {
  const url = new URL(value ?? 'https://api.github.com');
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new DashboardGitHubWriteError(
      'github_api_unavailable',
      'GitHub API URL must use HTTPS or loopback HTTP without credentials, query or fragments',
      503,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(value).slice(0, 500);
}

function responseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DashboardGitHubWriteError('github_response_invalid', `${label} must be an object`, 502);
  }
  return value as Record<string, unknown>;
}

function outcome(
  input: DashboardGitHubActionInput,
  status: DashboardGitHubActionOutcome['status'],
  now: number,
  fields: Partial<DashboardGitHubActionOutcome> = {},
): DashboardGitHubActionOutcome {
  return {
    status,
    action: input.action,
    actor: input.actor,
    requestId: input.requestId,
    headSha: input.expectedHeadSha,
    httpStatus: null,
    completedAt: status === 'running' ? null : now,
    result: null,
    error: null,
    ...fields,
  };
}

function validateInput(input: DashboardGitHubActionInput): void {
  if (!['approve', 'merge'].includes(input.action)) {
    throw new DashboardGitHubWriteError('invalid_github_action', 'Unsupported GitHub action', 400);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new DashboardGitHubWriteError('invalid_repository', 'GitHub repository must use owner/name', 400);
  }
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new DashboardGitHubWriteError('invalid_pull_number', 'Pull number must be a positive integer', 400);
  }
  if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha)) {
    throw new DashboardGitHubWriteError('invalid_head_sha', 'Expected head SHA is invalid', 400);
  }
  if (!dashboardRequestIdPattern.test(input.requestId)) {
    throw new DashboardGitHubWriteError('invalid_request_id', 'Dashboard request ID is invalid', 400);
  }
  if (!input.actor.trim() || input.actor.length > 200) {
    throw new DashboardGitHubWriteError('invalid_actor', 'Dashboard actor is invalid', 400);
  }
}

function assertCurrentHead(
  snapshot: GitHubPullSnapshot,
  expectedHeadSha: string,
): void {
  if (snapshot.headSha !== expectedHeadSha) {
    throw new DashboardGitHubWriteError(
      'head_sha_changed',
      `Pull request head changed from ${expectedHeadSha} to ${snapshot.headSha}`,
    );
  }
}

async function digestSnapshot(
  store: TaskStore,
  snapshot: GitHubPullSnapshot,
  input: DashboardGitHubActionInput,
  policy: GitHubGatePolicy,
  now: number,
): Promise<GitHubGateRecord> {
  return store.ingestGitHubGate({
    snapshot,
    policy,
    deliveryId: `dashboard-refresh:${input.requestId}`,
    eventType: 'dashboard_refresh',
    now,
  }).gate;
}

export async function executeDashboardGitHubAction(
  input: DashboardGitHubActionInput,
  dependencies: DashboardGitHubActionDependencies,
): Promise<DashboardGitHubActionResult> {
  validateInput(input);
  const {
    store,
    token,
    apiUrl,
    policy = {},
    allowedBranchPrefixes = [],
    allowForks = false,
    fetcher = fetch,
    now = Date.now,
  } = dependencies;
  if (!token) throw new DashboardGitHubWriteError('github_app_unavailable', 'GitHub App token is unavailable', 503);
  const claimedAt = now();
  const claim = store.claimDashboardGitHubAction({
    action: input.action,
    actor: input.actor,
    repository: input.repository,
    pullNumber: input.pullNumber,
    headSha: input.expectedHeadSha,
    requestId: input.requestId,
    now: claimedAt,
  });
  if (claim.replayed) {
    if (!claim.outcome || claim.outcome.status === 'running') {
      throw new DashboardGitHubWriteError(
        'github_action_in_doubt',
        'The prior GitHub action has no final result. Reconcile it before using a new request ID.',
        409,
      );
    }
    return {
      status: 'replayed',
      action: input.action,
      repository: input.repository.toLowerCase(),
      pullNumber: input.pullNumber,
      requestId: input.requestId,
      headSha: input.expectedHeadSha,
      outcome: claim.outcome,
      gate: null,
      ...(typeof claim.outcome.result?.reviewId === 'number'
        ? { reviewId: claim.outcome.result.reviewId }
        : {}),
      ...(typeof claim.outcome.result?.reviewState === 'string'
        ? { reviewState: claim.outcome.result.reviewState }
        : {}),
      ...(typeof claim.outcome.result?.mergeCommitSha === 'string'
        || claim.outcome.result?.mergeCommitSha === null
        ? { mergeCommitSha: claim.outcome.result.mergeCommitSha as string | null }
        : {}),
    };
  }

  const repository = input.repository.toLowerCase();
  let httpStatus: number | null = null;
  try {
    const base = validatedApiUrl(apiUrl);
    const snapshot = await fetchGitHubPullSnapshot(repository, input.pullNumber, {
      token,
      apiUrl: base,
      fetcher,
    });
    assertCurrentHead(snapshot, input.expectedHeadSha);
    const headRepository = snapshot.headRepository?.toLowerCase();
    if (!headRepository) {
      throw new DashboardGitHubWriteError(
        'head_repository_missing',
        'GitHub did not report the pull request head repository',
      );
    }
    if (headRepository !== repository && !allowForks) {
      throw new DashboardGitHubWriteError(
        'fork_not_allowed',
        `Pull request head repository ${headRepository} is not allowed`,
      );
    }
    if (
      allowedBranchPrefixes.length > 0
      && !allowedBranchPrefixes.some((prefix) => snapshot.headRef.startsWith(prefix))
    ) {
      throw new DashboardGitHubWriteError(
        'branch_not_allowed',
        `Pull request branch ${snapshot.headRef} is not in an allowed prefix`,
      );
    }
    if (snapshot.state !== 'open') {
      throw new DashboardGitHubWriteError('pull_not_open', `Pull request state is ${snapshot.state}`);
    }

    let result: Record<string, unknown>;
    let resultGate: GitHubGateRecord | null = null;
    let reviewId: number | undefined;
    let reviewState: string | undefined;
    let mergeCommitSha: string | null | undefined;

    if (input.action === 'approve') {
      const evaluation = evaluateGitHubPull(snapshot, {
        ...policy,
        expectedHeadSha: input.expectedHeadSha,
      });
      if (evaluation.reasons.some((reason) => reason.code === 'changes_requested')) {
        throw new DashboardGitHubWriteError(
          'changes_requested',
          'A current-head review requested changes',
        );
      }
      const response = await githubWrite(
        base,
        `/repos/${repository}/pulls/${input.pullNumber}/reviews`,
        'POST',
        {
          commit_id: input.expectedHeadSha,
          event: 'APPROVE',
          body: `QuotaFlow Dashboard approval for ${input.expectedHeadSha}.`,
        },
        token,
        fetcher,
      );
      httpStatus = response.status;
      const review = responseObject(response.body, 'GitHub review response');
      reviewId = Number(review.id);
      reviewState = typeof review.state === 'string' ? review.state : 'APPROVED';
      if (!Number.isInteger(reviewId) || reviewId <= 0) {
        throw new DashboardGitHubWriteError(
          'github_response_invalid',
          'GitHub review response ID is invalid',
          502,
          httpStatus,
        );
      }
      result = { reviewId, reviewState };
    } else {
      const evaluation = evaluateGitHubPull(snapshot, {
        ...policy,
        expectedHeadSha: input.expectedHeadSha,
      });
      if (evaluation.status !== 'ready_for_human_merge') {
        throw new DashboardGitHubWriteError(
          'merge_gate_blocked',
          `Merge blocked: ${evaluation.reasons.map((reason) => reason.code).join(', ') || 'unknown'}`,
        );
      }
      const response = await githubWrite(
        base,
        `/repos/${repository}/pulls/${input.pullNumber}/merge`,
        'PUT',
        {
          sha: input.expectedHeadSha,
          merge_method: 'merge',
        },
        token,
        fetcher,
      );
      httpStatus = response.status;
      const merged = responseObject(response.body, 'GitHub merge response');
      if (merged.merged !== true) {
        throw new DashboardGitHubWriteError(
          'merge_not_completed',
          typeof merged.message === 'string' ? merged.message : 'GitHub did not merge the pull request',
          409,
          httpStatus,
        );
      }
      mergeCommitSha = typeof merged.sha === 'string' ? merged.sha : null;
      result = { merged: true, mergeCommitSha };
    }

    let refreshError: string | null = null;
    try {
      const refreshed = await fetchGitHubPullSnapshot(repository, input.pullNumber, {
        token,
        apiUrl: base,
        fetcher,
      });
      resultGate = await digestSnapshot(store, refreshed, input, policy, now());
    } catch (error) {
      refreshError = message(error);
    }
    if (refreshError) result.refreshError = refreshError;

    const completed = outcome(input, 'succeeded', now(), {
      httpStatus,
      result,
    });
    store.completeDashboardGitHubAction({ requestId: input.requestId, outcome: completed });
    return {
      status: 'accepted',
      action: input.action,
      repository,
      pullNumber: input.pullNumber,
      requestId: input.requestId,
      headSha: input.expectedHeadSha,
      outcome: completed,
      gate: resultGate,
      ...(reviewId === undefined ? {} : { reviewId }),
      ...(reviewState === undefined ? {} : { reviewState }),
      ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
    };
  } catch (error) {
    const safeMessage = message(error);
    const failed = outcome(input, 'failed', now(), {
      httpStatus: error instanceof DashboardGitHubWriteError ? error.httpStatus : httpStatus,
      error: safeMessage,
    });
    store.completeDashboardGitHubAction({ requestId: input.requestId, outcome: failed });
    if (error instanceof DashboardGitHubWriteError) throw error;
    throw new DashboardGitHubWriteError('github_action_failed', safeMessage, 502, httpStatus);
  }
}

async function githubWrite(
  apiBase: string,
  path: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
  token: string,
  fetcher: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const response = await fetcher(`${apiBase}${path}`, {
    method,
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'quotaflow',
      'X-GitHub-Api-Version': apiVersion,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let payload: unknown = {};
  try {
    payload = await response.json();
  } catch {
    // Preserve the status when GitHub returns an empty or non-JSON response.
  }
  if (!response.ok) {
    const object = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const detail = typeof object.message === 'string' ? `: ${object.message}` : '';
    throw new DashboardGitHubWriteError(
      response.status === 401 || response.status === 403
        ? 'github_permission_denied'
        : response.status === 409
          ? 'github_action_conflict'
          : 'github_write_failed',
      `GitHub ${method} ${path} failed (${response.status})${detail}`,
      response.status,
      response.status,
    );
  }
  return { status: response.status, body: payload };
}
