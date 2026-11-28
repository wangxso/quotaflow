import type { GitHubPullSnapshot } from './github';
import type { GitHubCiFailure, GitHubCiTriage } from './github-ci';
import type { TaskStore } from './store';

type GitHubCiRerunFetcher = typeof fetch;

export interface GitHubCiRerunCandidate {
  runId: number;
  failures: GitHubCiFailure[];
}

export interface GitHubCiRerunPlan {
  candidates: GitHubCiRerunCandidate[];
  incomplete: boolean;
}

export type GitHubCiRerunOutcome =
  | 'authentication_required'
  | 'duplicate'
  | 'limit_reached'
  | 'requested'
  | 'rerun_failed'
  | 'run_fetch_failed'
  | 'stale_head';

export interface GitHubCiRerunResult {
  runId: number;
  outcomes: GitHubCiRerunOutcome;
  failedChecks: string[];
  categories: GitHubCiFailure['category'][];
  httpStatus?: number;
  message: string;
}

export interface GitHubCiRerunSummary {
  status: 'human_only' | 'not_needed' | 'requested';
  incomplete: boolean;
  candidates: number[];
  outcomes: GitHubCiRerunResult[];
  remainingTriage: GitHubCiTriage;
  staleHead: boolean;
}

export interface GitHubCiRerunOptions {
  store: TaskStore;
  repository: string;
  pullNumber: number;
  triage: GitHubCiTriage;
  refreshSnapshot: (
    repository: string,
    pullNumber: number,
  ) => Promise<GitHubPullSnapshot>;
  token?: string;
  apiUrl?: string;
  fetcher?: GitHubCiRerunFetcher;
  maxPerHead?: number;
  timeoutMs?: number;
  now?: () => number;
}

function apiBase(value: string | undefined): string {
  const url = new URL(value ?? 'https://api.github.com');
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('GitHub API URL must use HTTPS or loopback HTTP without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function validateIdentity(repository: string, pullNumber: number, triage: GitHubCiTriage): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GitHub repository must use the owner/name form');
  }
  const [owner, name] = repository.split('/');
  if (/^\.+$/.test(owner!) || /^\.+$/.test(name!)) {
    throw new Error('GitHub repository must use the owner/name form');
  }
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('GitHub pull number must be a positive integer');
  }
  if (!/^[0-9a-f]{40}$/.test(triage.headSha)) {
    throw new Error('GitHub CI triage head SHA must be a 40-character Git SHA');
  }
}

function failureKey(failure: GitHubCiFailure): string {
  return [
    failure.runId ?? 'no-run',
    failure.jobId ?? 'no-job',
    failure.name,
  ].join(':');
}

function eligible(failure: GitHubCiFailure): boolean {
  return failure.runId !== null
    && (failure.category === 'infrastructure' || failure.category === 'cancelled');
}

export function planGitHubCiReruns(triage: GitHubCiTriage): GitHubCiRerunPlan {
  if (!triage.complete) {
    return {
      candidates: [],
      incomplete: true,
    };
  }
  const byRun = new Map<number, GitHubCiFailure[]>();
  for (const failure of triage.failures) {
    if (failure.runId === null) continue;
    const group = byRun.get(failure.runId) ?? [];
    group.push(failure);
    byRun.set(failure.runId, group);
  }
  const candidates: GitHubCiRerunCandidate[] = [];
  for (const [runId, failures] of byRun) {
    if (failures.every(eligible)) candidates.push({ runId, failures });
  }
  candidates.sort((left, right) => left.runId - right.runId);
  return {
    candidates,
    incomplete: false,
  };
}

function remainingTriage(triage: GitHubCiTriage, covered: Set<string>): GitHubCiTriage {
  return {
    ...triage,
    failures: triage.failures.filter((failure) => !covered.has(failureKey(failure))),
  };
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'quotaflow',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const value = await response.json() as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const message = (value as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message.slice(0, 300);
    }
  } catch {
    // Keep a status-only message when GitHub does not return JSON.
  }
  return 'GitHub Actions request failed';
}

function result(
  candidate: GitHubCiRerunCandidate,
  outcomes: GitHubCiRerunOutcome,
  message: string,
  httpStatus?: number,
): GitHubCiRerunResult {
  return {
    runId: candidate.runId,
    outcomes,
    failedChecks: candidate.failures.map((failure) => failure.name),
    categories: candidate.failures.map((failure) => failure.category),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    message,
  };
}

export async function runGitHubCiReruns(options: GitHubCiRerunOptions): Promise<GitHubCiRerunSummary> {
  validateIdentity(options.repository, options.pullNumber, options.triage);
  const maxPerHead = options.maxPerHead ?? 1;
  if (!Number.isInteger(maxPerHead) || maxPerHead < 0 || maxPerHead > 5) {
    throw new Error('GitHub CI reruns per head must be an integer between 0 and 5');
  }
  const repository = options.repository.toLowerCase();
  const plan = planGitHubCiReruns(options.triage);
  if (plan.incomplete || plan.candidates.length === 0) {
    return {
      status: 'not_needed',
      incomplete: plan.incomplete,
      candidates: plan.candidates.map((candidate) => candidate.runId),
      outcomes: [],
      remainingTriage: options.triage,
      staleHead: false,
    };
  }
  if (maxPerHead === 0) {
    return {
      status: 'human_only',
      incomplete: false,
      candidates: plan.candidates.map((candidate) => candidate.runId),
      outcomes: plan.candidates.map((candidate) =>
        result(candidate, 'limit_reached', 'Automatic CI reruns are disabled for this repository')),
      remainingTriage: options.triage,
      staleHead: false,
    };
  }

  const noRerun = (outcome: GitHubCiRerunOutcome, message: string): GitHubCiRerunSummary => ({
    status: 'human_only',
    incomplete: false,
    candidates: plan.candidates.map((candidate) => candidate.runId),
    outcomes: plan.candidates.map((candidate) => result(candidate, outcome, message)),
    remainingTriage: options.triage,
    staleHead: outcome === 'stale_head',
  });

  if (!options.token) return noRerun('authentication_required', 'GitHub installation token is unavailable');

  let current: GitHubPullSnapshot;
  try {
    current = await options.refreshSnapshot(repository, options.pullNumber);
  } catch {
    return noRerun('run_fetch_failed', 'Current pull request snapshot could not be refreshed');
  }
  if (
    current.repository !== repository
    || current.number !== options.pullNumber
    || current.headSha !== options.triage.headSha
  ) {
    return noRerun('stale_head', 'Pull request head no longer matches the CI triage');
  }

  const fetcher = options.fetcher ?? fetch;
  const api = apiBase(options.apiUrl);
  const outcomes: GitHubCiRerunResult[] = [];
  const covered = new Set<string>();
  for (const candidate of plan.candidates) {
    const commonHeaders = headers(options.token);
    let runResponse: Response;
    try {
      runResponse = await fetcher(`${api}/repos/${repository}/actions/runs/${candidate.runId}`, {
        method: 'GET',
        redirect: 'error',
        headers: commonHeaders,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch {
      outcomes.push(result(candidate, 'run_fetch_failed', 'Workflow run could not be refreshed'));
      continue;
    }
    if (!runResponse.ok) {
      const message = await responseMessage(runResponse);
      outcomes.push(result(
        candidate,
        'run_fetch_failed',
        `Workflow run refresh failed (${runResponse.status}): ${message}`,
        runResponse.status,
      ));
      continue;
    }
    let runPayload: unknown;
    try {
      runPayload = await runResponse.json();
    } catch {
      outcomes.push(result(candidate, 'run_fetch_failed', 'Workflow run response was not valid JSON'));
      continue;
    }
    const runHeadSha = runPayload && typeof runPayload === 'object' && !Array.isArray(runPayload)
      ? (runPayload as Record<string, unknown>).head_sha
      : undefined;
    if (typeof runHeadSha !== 'string' || runHeadSha !== options.triage.headSha) {
      outcomes.push(result(candidate, 'stale_head', 'Workflow run head no longer matches the CI triage'));
      continue;
    }

    const claim = options.store.claimGitHubCiRerun({
      repository,
      pullNumber: options.pullNumber,
      headSha: options.triage.headSha,
      runId: candidate.runId,
      maxPerHead,
      ...(options.now ? { now: options.now() } : {}),
    });
    if (!claim.claimed) {
      outcomes.push(result(
        candidate,
        claim.reason === 'duplicate' ? 'duplicate' : 'limit_reached',
        claim.reason === 'duplicate'
          ? 'This workflow run was already claimed for a rerun'
          : `The current-head rerun limit of ${maxPerHead} is exhausted`,
      ));
      if (claim.reason === 'duplicate') {
        for (const failure of candidate.failures) covered.add(failureKey(failure));
      }
      continue;
    }

    let rerunResponse: Response;
    try {
      rerunResponse = await fetcher(
        `${api}/repos/${repository}/actions/runs/${candidate.runId}/rerun`,
        {
          method: 'POST',
          redirect: 'error',
          headers: commonHeaders,
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        },
      );
    } catch {
      options.store.completeGitHubCiRerun({
        repository,
        pullNumber: options.pullNumber,
        headSha: options.triage.headSha,
        runId: candidate.runId,
        state: 'failed',
        error: 'Workflow rerun request failed before a response was received',
        ...(options.now ? { now: options.now() } : {}),
      });
      outcomes.push(result(candidate, 'rerun_failed', 'Workflow rerun request failed before a response'));
      continue;
    }
    if (!rerunResponse.ok) {
      const message = await responseMessage(rerunResponse);
      options.store.completeGitHubCiRerun({
        repository,
        pullNumber: options.pullNumber,
        headSha: options.triage.headSha,
        runId: candidate.runId,
        state: 'failed',
        httpStatus: rerunResponse.status,
        error: message,
        ...(options.now ? { now: options.now() } : {}),
      });
      outcomes.push(result(
        candidate,
        'rerun_failed',
        `Workflow rerun failed (${rerunResponse.status}): ${message}`,
        rerunResponse.status,
      ));
      continue;
    }
    await rerunResponse.body?.cancel();
    options.store.completeGitHubCiRerun({
      repository,
      pullNumber: options.pullNumber,
      headSha: options.triage.headSha,
      runId: candidate.runId,
      state: 'requested',
      httpStatus: rerunResponse.status,
      ...(options.now ? { now: options.now() } : {}),
    });
    for (const failure of candidate.failures) covered.add(failureKey(failure));
    outcomes.push(result(
      candidate,
      'requested',
      `Workflow rerun requested for exact head ${options.triage.headSha}`,
      rerunResponse.status,
    ));
  }

  const staleHead = outcomes.some((outcome) => outcome.outcomes === 'stale_head');
  const requested = outcomes.some((outcome) =>
    outcome.outcomes === 'requested' || outcome.outcomes === 'duplicate');
  const blocked = outcomes.some((outcome) =>
    outcome.outcomes !== 'requested' && outcome.outcomes !== 'duplicate');
  return {
    status: staleHead || blocked ? 'human_only' : requested ? 'requested' : 'not_needed',
    incomplete: false,
    candidates: plan.candidates.map((candidate) => candidate.runId),
    outcomes,
    remainingTriage: remainingTriage(options.triage, covered),
    staleHead,
  };
}
