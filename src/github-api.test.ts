import { expect, test } from 'bun:test';
import { fetchGitHubPullSnapshot } from './github-api';

const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
const baseSha = 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetches and normalizes a pull request with current checks and reviews', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    if (url.endsWith('/repos/wangxso/mcarplay/pulls/141')) {
      return json({
        number: 141,
        state: 'open',
        draft: true,
        mergeable: true,
        user: { login: 'wangxso' },
        base: { ref: 'main', sha: baseSha },
        head: { ref: 'feature', sha: headSha, repo: { full_name: 'wangxso/mcarplay' } },
      });
    }
    if (url.includes(`/commits/${headSha}/check-runs`)) {
      return json({
        check_runs: [{
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          head_sha: headSha,
          started_at: '2026-11-27T13:57:30Z',
          completed_at: '2026-11-27T14:03:00Z',
          details_url: 'https://example.test/check',
        }],
      });
    }
    if (url.endsWith('/repos/wangxso/mcarplay/pulls/141/reviews?per_page=100')) {
      return json([{
        user: { login: 'reviewer' },
        state: 'APPROVED',
        commit_id: headSha,
        submitted_at: '2026-11-27T14:04:00Z',
      }, {
        user: { login: 'pending-reviewer' },
        state: 'PENDING',
        commit_id: null,
        submitted_at: null,
      }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const snapshot = await fetchGitHubPullSnapshot('wangxso/mcarplay', 141, {
    token: 'test-token',
    fetcher,
  });
  expect(snapshot).toMatchObject({
    repository: 'wangxso/mcarplay',
    number: 141,
    draft: true,
    mergeable: 'mergeable',
    headSha,
    headRepository: 'wangxso/mcarplay',
    checks: [{ name: 'test', conclusion: 'success' }],
    reviews: [{ authorLogin: 'reviewer', authorType: 'user', state: 'APPROVED', commitSha: headSha }],
  });
  expect(snapshot.checks[0]).not.toHaveProperty('passed');
  expect(requests).toHaveLength(3);
  expect(requests.every((request) => request.authorization === 'Bearer test-token')).toBe(true);
  expect(requests.some((request) => request.url.includes('/check-runs?filter=latest&per_page=100'))).toBe(true);
});

test('retries while GitHub is still computing mergeability', async () => {
  let pullRequests = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/pulls/141')) {
      pullRequests += 1;
      return json({
        number: 141,
        state: 'open',
        draft: false,
        mergeable: pullRequests === 1 ? null : true,
        user: { login: 'wangxso' },
        base: { ref: 'main', sha: baseSha },
        head: { ref: 'feature', sha: headSha, repo: { full_name: 'wangxso/mcarplay' } },
      });
    }
    if (url.includes(`/commits/${headSha}/check-runs`)) return json({ check_runs: [] });
    if (url.includes('/reviews?')) return json([]);
    throw new Error(`Unexpected URL ${url}`);
  };
  const delays: number[] = [];
  const snapshot = await fetchGitHubPullSnapshot('wangxso/mcarplay', 141, {
    fetcher,
    mergeableAttempts: 3,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  expect(snapshot.mergeable).toBe('mergeable');
  expect(pullRequests).toBe(2);
  expect(delays).toEqual([500]);
});

test('supports loopback test APIs and reports safe GitHub errors', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    urls.push(String(input));
    return json({ message: 'Not Found' }, 404);
  };
  await expect(fetchGitHubPullSnapshot('wangxso/missing', 7, {
    apiUrl: 'http://127.0.0.1:8123/api/v3/',
    token: 'must-not-appear',
    fetcher,
  })).rejects.toThrow('GitHub API GET /api/v3/repos/wangxso/missing/pulls/7 failed (404): Not Found');
  expect(urls).toHaveLength(1);
  expect(urls[0]).not.toContain('must-not-appear');
});

test('rejects invalid repositories, pull numbers and unsafe API URLs before fetching', async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error('fetch should not run');
  };
  await expect(fetchGitHubPullSnapshot('../secret', 1, { fetcher }))
    .rejects.toThrow('owner/name');
  await expect(fetchGitHubPullSnapshot('owner/repo', 0, { fetcher }))
    .rejects.toThrow('positive integer');
  await expect(fetchGitHubPullSnapshot('owner/repo', 1, {
    apiUrl: 'http://example.test/api',
    fetcher,
  })).rejects.toThrow('HTTPS or loopback HTTP');
});
