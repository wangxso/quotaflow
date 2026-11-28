import {
  parseGitHubPullSnapshot,
  type GitHubCheckRun,
  type GitHubPullSnapshot,
  type GitHubReview,
} from './github';

const defaultApiUrl = 'https://api.github.com';
const apiVersion = '2022-11-28';

type GitHubFetcher = typeof fetch;

export interface GitHubApiOptions {
  token?: string;
  apiUrl?: string;
  fetcher?: GitHubFetcher;
  timeoutMs?: number;
  mergeableAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function mergeability(value: unknown): string {
  if (value === true) return 'mergeable';
  if (value === false) return 'not_mergeable';
  return typeof value === 'string' && value.trim() ? value.toLowerCase() : 'unknown';
}

function reviewAuthorType(value: unknown): 'user' | 'bot' | 'organization' {
  const type = typeof value === 'string' ? value.toLowerCase() : '';
  if (type === 'bot') return 'bot';
  if (type === 'organization') return 'organization';
  return 'user';
}

function apiUrl(value: string | undefined): URL {
  const parsed = new URL(value ?? defaultApiUrl);
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('GitHub API URL must not contain credentials, query parameters or fragments');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) {
    throw new Error('GitHub API URL must use HTTPS or loopback HTTP');
  }
  return parsed;
}

async function responseJson(response: Response, url: URL): Promise<unknown> {
  if (!response.ok) {
    let detail = '';
    try {
      const body = object(await response.json(), 'GitHub API error');
      detail = typeof body.message === 'string' ? `: ${body.message}` : '';
    } catch {
      // Keep the status-only error when GitHub does not return a JSON message.
    }
    throw new Error(`GitHub API GET ${url.pathname} failed (${response.status})${detail}`);
  }
  return response.json();
}

export async function fetchGitHubPullSnapshot(
  repository: string,
  pullNumber: number,
  options: GitHubApiOptions = {},
): Promise<GitHubPullSnapshot> {
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

  const api = apiUrl(options.apiUrl);
  const root = api.toString().replace(/\/+$/, '');
  const fetcher = options.fetcher ?? fetch;
  const mergeableAttempts = options.mergeableAttempts ?? 3;
  if (!Number.isInteger(mergeableAttempts) || mergeableAttempts < 1 || mergeableAttempts > 5) {
    throw new Error('GitHub mergeable attempts must be an integer between 1 and 5');
  }
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'quotaflow',
    'X-GitHub-Api-Version': apiVersion,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const get = async (path: string): Promise<unknown> => {
    const url = new URL(`${root}${path}`);
    const response = await fetcher(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    return responseJson(response, url);
  };

  let pull: JsonObject | undefined;
  for (let attempt = 1; attempt <= mergeableAttempts; attempt += 1) {
    pull = object(await get(`/repos/${repository}/pulls/${pullNumber}`), 'GitHub pull response');
    if (typeof pull.mergeable === 'boolean' || typeof pull.mergeable === 'string') break;
    if (attempt < mergeableAttempts) await sleep(attempt * 500);
  }
  if (!pull) throw new Error('GitHub pull response is missing');
  const head = object(pull.head, 'GitHub pull response.head');
  const base = object(pull.base, 'GitHub pull response.base');
  const author = object(pull.user, 'GitHub pull response.user');
  const headRepository = head.repo === null || head.repo === undefined
    ? null
    : object(head.repo, 'GitHub pull response.head.repo');
  const headSha = text(head.sha, 'GitHub pull response.head.sha');

  const [checksResponse, reviewsResponse] = await Promise.all([
    get(`/repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`),
    get(`/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`),
  ]);
  const checkRuns = object(checksResponse, 'GitHub check-runs response').check_runs;
  if (!Array.isArray(checkRuns)) throw new Error('GitHub check-runs response.check_runs must be an array');
  const checks: GitHubCheckRun[] = checkRuns.map((entry, index) => {
    const run = object(entry, `GitHub check-runs response.check_runs[${index}]`);
    return {
      name: text(run.name, `GitHub check-runs response.check_runs[${index}].name`),
      status: text(run.status, `GitHub check-runs response.check_runs[${index}].status`),
      conclusion: optionalText(run.conclusion),
      headSha: text(run.head_sha, `GitHub check-runs response.check_runs[${index}].head_sha`),
      startedAt: optionalText(run.started_at),
      completedAt: optionalText(run.completed_at),
      detailsUrl: optionalText(run.details_url),
    };
  });

  if (!Array.isArray(reviewsResponse)) throw new Error('GitHub reviews response must be an array');
  const reviews: GitHubReview[] = [];
  reviewsResponse.forEach((entry, index) => {
    const review = object(entry, `GitHub reviews response[${index}]`);
    const reviewer = review.user;
    const commitSha = optionalText(review.commit_id);
    const submittedAt = optionalText(review.submitted_at);
    if (!reviewer || !commitSha || !submittedAt) return;
    const reviewerObject = object(reviewer, `GitHub reviews response[${index}].user`);
    reviews.push({
      authorLogin: text(reviewerObject.login, `GitHub reviews response[${index}].user.login`),
      authorType: reviewAuthorType(reviewerObject.type),
      state: text(review.state, `GitHub reviews response[${index}].state`),
      commitSha,
      submittedAt,
    });
  });

  return parseGitHubPullSnapshot({
    repository,
    update: {
      number: pull.number,
      state: pull.state,
      draft: pull.draft,
      mergeable: mergeability(pull.mergeable),
      authorLogin: author.login,
      baseRef: base.ref,
      headRef: head.ref,
      ...(headRepository
        ? { headRepository: text(headRepository.full_name, 'GitHub pull response.head.repo.full_name') }
        : {}),
      baseSha: base.sha,
      headSha,
      checks,
      reviews,
    },
  });
}
