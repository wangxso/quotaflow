import { expect, test } from 'bun:test';
import { openDatabase } from './db';
import type { GitHubCiFailure, GitHubCiTriage } from './github-ci';
import { runGitHubCiReruns } from './github-ci-rerun';
import type { GitHubPullSnapshot } from './github';
import { TaskStore } from './store';

const repository = 'wangxso/mcarplay';
const pullNumber = 141;
const baseSha = 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e';
const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
const installationToken = ['test', 'installation', 'token'].join('-');

function snapshot(head = headSha): GitHubPullSnapshot {
  return {
    repository,
    number: pullNumber,
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    authorLogin: 'wangxso',
    baseRef: 'main',
    headRef: 'quotaflow/rerun',
    headRepository: repository,
    baseSha,
    headSha: head,
    checks: [],
    reviews: [],
  };
}

function failure(overrides: Partial<GitHubCiFailure> = {}): GitHubCiFailure {
  return {
    name: 'runner health',
    jobId: 10,
    runId: 100,
    category: 'infrastructure',
    logBytes: 24,
    truncated: false,
    excerpt: 'runner lost communication',
    ...overrides,
  };
}

function triage(failures = [failure()], complete = true): GitHubCiTriage {
  return { headSha, failures, complete };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test('requests one same-head workflow rerun and persists the attempt', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const calls: string[] = [];
  try {
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      refreshSnapshot: async () => snapshot(),
      token: installationToken,
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname.endsWith('/actions/runs/100')) return json({ head_sha: headSha });
        if (url.pathname.endsWith('/actions/runs/100/rerun')) return new Response(null, { status: 201 });
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    expect(summary).toMatchObject({
      status: 'requested',
      candidates: [100],
      staleHead: false,
      outcomes: [{ runId: 100, outcomes: 'requested', httpStatus: 201 }],
      remainingTriage: { failures: [] },
    });
    expect(calls).toEqual([
      'GET /repos/wangxso/mcarplay/actions/runs/100',
      'POST /repos/wangxso/mcarplay/actions/runs/100/rerun',
    ]);
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toMatchObject([{
      runId: 100,
      state: 'requested',
      requestCount: 1,
      httpStatus: 201,
    }]);
  } finally {
    db.close();
  }
});

test('rejects a rerun when the pull request head moved', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let requests = 0;
  try {
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      refreshSnapshot: async () => snapshot('f'.repeat(40)),
      token: installationToken,
      fetcher: async () => {
        requests += 1;
        throw new Error('fetch should not run');
      },
    });
    expect(summary).toMatchObject({
      status: 'human_only',
      staleHead: true,
      outcomes: [{ runId: 100, outcomes: 'stale_head' }],
    });
    expect(requests).toBe(0);
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toEqual([]);
  } finally {
    db.close();
  }
});

test('rejects a workflow run whose refreshed head does not match triage', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let reruns = 0;
  try {
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      refreshSnapshot: async () => snapshot(),
      token: installationToken,
      fetcher: async (input) => {
        if (String(input).endsWith('/rerun')) reruns += 1;
        return json({ head_sha: 'e'.repeat(40) });
      },
    });
    expect(summary).toMatchObject({
      status: 'human_only',
      staleHead: true,
      outcomes: [{ outcomes: 'stale_head' }],
    });
    expect(reruns).toBe(0);
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toEqual([]);
  } finally {
    db.close();
  }
});

test('enforces the per-head rerun limit before another external request', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let reruns = 0;
  try {
    expect(store.claimGitHubCiRerun({
      repository,
      pullNumber,
      headSha,
      runId: 99,
      maxPerHead: 1,
    }).claimed).toBe(true);
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage([failure({ runId: 100, jobId: 11 })]),
      refreshSnapshot: async () => snapshot(),
      token: installationToken,
      maxPerHead: 1,
      fetcher: async (input) => {
        if (String(input).endsWith('/rerun')) reruns += 1;
        return json({ head_sha: headSha });
      },
    });
    expect(summary).toMatchObject({
      status: 'human_only',
      outcomes: [{ runId: 100, outcomes: 'limit_reached' }],
    });
    expect(reruns).toBe(0);
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('concurrent duplicate deliveries produce one rerun claim and one POST', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let gets = 0;
  let posts = 0;
  try {
    const invoke = () => runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      refreshSnapshot: async () => snapshot(),
      token: installationToken,
      fetcher: async (input, init) => {
        if (String(input).endsWith('/rerun')) {
          posts += 1;
          expect(init?.method).toBe('POST');
          return new Response(null, { status: 202 });
        }
        gets += 1;
        return json({ head_sha: headSha });
      },
    });
    const [first, second] = await Promise.all([invoke(), invoke()]);
    expect([first.outcomes[0]?.outcomes, second.outcomes[0]?.outcomes].sort())
      .toEqual(['duplicate', 'requested']);
    expect(gets).toBe(2);
    expect(posts).toBe(1);
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('never reruns a workflow run that includes a code or test failure', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let refreshed = 0;
  try {
    const value = triage([
      failure(),
      failure({ jobId: 11, name: 'unit tests', category: 'code_or_test', excerpt: 'AssertionError' }),
    ]);
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: value,
      refreshSnapshot: async () => {
        refreshed += 1;
        return snapshot();
      },
      token: installationToken,
    });
    expect(summary).toMatchObject({
      status: 'not_needed',
      candidates: [],
      remainingTriage: {
        failures: [{ category: 'infrastructure' }, { category: 'code_or_test' }],
      },
    });
    expect(refreshed).toBe(0);
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toEqual([]);
  } finally {
    db.close();
  }
});

test('does not rerun when not every failed check was triaged', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let refreshed = 0;
  try {
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage([failure()], false),
      refreshSnapshot: async () => {
        refreshed += 1;
        return snapshot();
      },
      token: installationToken,
    });
    expect(summary).toMatchObject({
      status: 'not_needed',
      incomplete: true,
      candidates: [],
    });
    expect(refreshed).toBe(0);
  } finally {
    db.close();
  }
});

test('allows an explicit zero limit without refreshing or calling GitHub', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let refreshed = 0;
  let requested = 0;
  try {
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      maxPerHead: 0,
      refreshSnapshot: async () => {
        refreshed += 1;
        return snapshot();
      },
      token: installationToken,
      fetcher: async () => {
        requested += 1;
        return json({ head_sha: headSha });
      },
    });
    expect(summary).toMatchObject({
      status: 'human_only',
      outcomes: [{ runId: 100, outcomes: 'limit_reached' }],
    });
    expect(refreshed).toBe(0);
    expect(requested).toBe(0);
  } finally {
    db.close();
  }
});

test('records a failed rerun API response without unlocking another request', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const summary = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      refreshSnapshot: async () => snapshot(),
      token: installationToken,
      fetcher: async (input) => {
        if (String(input).endsWith('/rerun')) {
          return json({ message: 'Actions write permission is required' }, 403);
        }
        return json({ head_sha: headSha });
      },
    });
    expect(summary).toMatchObject({
      status: 'human_only',
      outcomes: [{
        outcomes: 'rerun_failed',
        httpStatus: 403,
        message: 'Workflow rerun failed (403): Actions write permission is required',
      }],
    });
    expect(store.listGitHubCiReruns(repository, pullNumber, headSha)).toMatchObject([{
      state: 'failed',
      requestCount: 1,
      httpStatus: 403,
      error: 'Actions write permission is required',
    }]);

    const duplicate = await runGitHubCiReruns({
      store,
      repository,
      pullNumber,
      triage: triage(),
      refreshSnapshot: async () => snapshot(),
      token: installationToken,
      fetcher: async (input) => {
        if (String(input).endsWith('/rerun')) throw new Error('rerun POST must not repeat');
        return json({ head_sha: headSha });
      },
    });
    expect(duplicate.outcomes[0]).toMatchObject({ outcomes: 'duplicate' });
  } finally {
    db.close();
  }
});
