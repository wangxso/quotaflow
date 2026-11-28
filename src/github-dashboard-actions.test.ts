import { expect, test } from 'bun:test';
import { openDatabase } from './db';
import { executeDashboardGitHubAction } from './github-dashboard-actions';
import { TaskStore } from './store';

const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
const baseSha = 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e';
const mergeSha = '23033142a38d87441ed5632bc4c9d9ac821ccd61';

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function pullPayload(options: {
  approved?: boolean;
  merged?: boolean;
  checkConclusion?: string;
  headRef?: string;
  headRepository?: string;
} = {}) {
  return {
    number: 141,
    state: options.merged ? 'closed' : 'open',
    draft: false,
    mergeable: true,
    merged: options.merged ?? false,
    user: { login: 'wangxso' },
    base: { ref: 'main', sha: baseSha },
    head: {
      ref: options.headRef ?? 'quotaflow/feature',
      sha: headSha,
      repo: { full_name: options.headRepository ?? 'wangxso/mcarplay' },
    },
    reviews: options.approved
      ? [{
        user: { login: 'quotaflow-review-gate[bot]', type: 'Bot' },
        state: 'APPROVED',
        commit_id: headSha,
        submitted_at: '2026-11-28T01:00:00Z',
      }]
      : [],
    checks: [{
      name: 'test',
      status: 'completed',
      conclusion: options.checkConclusion ?? 'success',
      head_sha: headSha,
      started_at: '2026-11-28T00:50:00Z',
      completed_at: '2026-11-28T01:00:00Z',
    }],
  };
}

function setup() {
  const db = openDatabase(':memory:');
  return { db, store: new TaskStore(db) };
}

test('dashboard Bot approval is exact-head, audited and not replayed externally', async () => {
  const { db, store } = setup();
  try {
    let approved = false;
    let writeRequests = 0;
    let snapshotRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/repos/wangxso/mcarplay/pulls/141') && !approved) {
        snapshotRequests += 1;
        return json(pullPayload({ approved }));
      }
      if (url.endsWith('/repos/wangxso/mcarplay/pulls/141') && approved) {
        snapshotRequests += 1;
        return json(pullPayload({ approved: true }));
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return json({
          check_runs: [{
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            head_sha: headSha,
            started_at: '2026-11-28T00:50:00Z',
            completed_at: '2026-11-28T01:00:00Z',
          }],
        });
      }
      if (url.endsWith('/pulls/141/reviews?per_page=100')) {
        return json(approved
          ? [{
            user: { login: 'quotaflow-review-gate[bot]', type: 'Bot' },
            state: 'APPROVED',
            commit_id: headSha,
            submitted_at: '2026-11-28T01:00:00Z',
          }]
          : []);
      }
      if (url.endsWith('/pulls/141/reviews') && init?.method === 'POST') {
        writeRequests += 1;
        approved = true;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ event: 'APPROVE', commit_id: headSha });
        return json({ id: 9001, state: 'APPROVED' }, 201);
      }
      throw new Error(`Unexpected GitHub request ${init?.method ?? 'GET'} ${url}`);
    };
    const input = {
      action: 'approve' as const,
      repository: 'wangxso/mcarplay',
      pullNumber: 141,
      expectedHeadSha: headSha,
      requestId: 'request-github-approve-1',
      actor: 'local-dashboard',
    };
    const dependencies = {
      store,
      token: 'installation-token',
      fetcher,
      policy: { requiredChecks: ['test'], requiredApprovals: 1, allowBotApprovals: true },
    };
    const result = await executeDashboardGitHubAction(input, dependencies);
    expect(result).toMatchObject({
      status: 'accepted',
      reviewId: 9001,
      reviewState: 'APPROVED',
      outcome: { status: 'succeeded', httpStatus: 201 },
      gate: { evaluation: { status: 'ready_for_human_merge' } },
    });
    expect(writeRequests).toBe(1);
    expect(snapshotRequests).toBe(2);

    const replay = await executeDashboardGitHubAction(input, dependencies);
    expect(replay).toMatchObject({
      status: 'replayed',
      reviewId: 9001,
      outcome: { status: 'succeeded' },
    });
    expect(writeRequests).toBe(1);
    expect(snapshotRequests).toBe(2);
  } finally {
    db.close();
  }
});

test('dashboard merge rechecks the gate and sends the exact confirmed head', async () => {
  const { db, store } = setup();
  try {
    let merged = false;
    const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/repos/wangxso/mcarplay/pulls/141')) {
        return json(pullPayload({ approved: true, merged }));
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return json({
          check_runs: [{
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            head_sha: headSha,
            started_at: '2026-11-28T00:50:00Z',
            completed_at: '2026-11-28T01:00:00Z',
          }],
        });
      }
      if (url.endsWith('/pulls/141/reviews?per_page=100')) {
        return json([{
          user: { login: 'quotaflow-review-gate[bot]', type: 'Bot' },
          state: 'APPROVED',
          commit_id: headSha,
          submitted_at: '2026-11-28T01:00:00Z',
        }]);
      }
      if (url.endsWith('/pulls/141/merge') && method === 'PUT') {
        writes.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        merged = true;
        return json({ merged: true, sha: mergeSha });
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    };
    const result = await executeDashboardGitHubAction({
      action: 'merge',
      repository: 'wangxso/mcarplay',
      pullNumber: 141,
      expectedHeadSha: headSha,
      requestId: 'request-github-merge-1',
      actor: 'local-dashboard',
    }, {
      store,
      token: 'installation-token',
      fetcher,
      policy: { requiredChecks: ['test'], requiredApprovals: 1, allowBotApprovals: true },
    });
    expect(writes).toEqual([{
      method: 'PUT',
      body: { sha: headSha, merge_method: 'merge' },
    }]);
    expect(result).toMatchObject({
      status: 'accepted',
      mergeCommitSha: mergeSha,
      outcome: { status: 'succeeded' },
    });
    expect(result.gate?.evaluation.status).toBe('blocked');
  } finally {
    db.close();
  }
});

test('dashboard merge stops on a blocked refreshed gate and keeps a failed audit', async () => {
  const { db, store } = setup();
  try {
    let writes = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/repos/wangxso/mcarplay/pulls/141')) {
        return json(pullPayload({ approved: true, checkConclusion: 'failure' }));
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return json({
          check_runs: [{
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            head_sha: headSha,
            started_at: '2026-11-28T00:50:00Z',
            completed_at: '2026-11-28T01:00:00Z',
          }],
        });
      }
      if (url.endsWith('/pulls/141/reviews?per_page=100')) {
        return json([{
          user: { login: 'quotaflow-review-gate[bot]', type: 'Bot' },
          state: 'APPROVED',
          commit_id: headSha,
          submitted_at: '2026-11-28T01:00:00Z',
        }]);
      }
      if (method === 'PUT' && url.endsWith('/pulls/141/merge')) {
        writes += 1;
        return json({ merged: true, sha: mergeSha });
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    };
    const input = {
      action: 'merge' as const,
      repository: 'wangxso/mcarplay',
      pullNumber: 141,
      expectedHeadSha: headSha,
      requestId: 'request-github-merge-blocked-1',
      actor: 'local-dashboard',
    };
    const dependencies = {
      store,
      token: 'installation-token',
      fetcher,
      policy: { requiredChecks: ['test'], requiredApprovals: 1, allowBotApprovals: true },
    };
    await expect(executeDashboardGitHubAction(input, dependencies)).rejects.toMatchObject({
      code: 'merge_gate_blocked',
    });
    expect(writes).toBe(0);
    const replay = await executeDashboardGitHubAction(input, dependencies);
    expect(replay).toMatchObject({
      status: 'replayed',
      outcome: { status: 'failed' },
    });
    expect(writes).toBe(0);
  } finally {
    db.close();
  }
});

test('dashboard writes reject an unapproved branch prefix before any external write', async () => {
  const { db, store } = setup();
  try {
    let writes = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/repos/wangxso/mcarplay/pulls/141')) {
        return json(pullPayload({ headRef: 'feature' }));
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return json({
          check_runs: [{
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            head_sha: headSha,
            started_at: '2026-11-28T00:50:00Z',
            completed_at: '2026-11-28T01:00:00Z',
          }],
        });
      }
      if (url.endsWith('/pulls/141/reviews?per_page=100')) return json([]);
      if (init?.method === 'POST') writes += 1;
      throw new Error(`Unexpected GitHub request ${init?.method ?? 'GET'} ${url}`);
    };
    await expect(executeDashboardGitHubAction({
      action: 'approve',
      repository: 'wangxso/mcarplay',
      pullNumber: 141,
      expectedHeadSha: headSha,
      requestId: 'request-github-branch-blocked-1',
      actor: 'local-dashboard',
    }, {
      store,
      token: 'installation-token',
      fetcher,
      allowedBranchPrefixes: ['quotaflow/'],
    })).rejects.toMatchObject({ code: 'branch_not_allowed' });
    expect(writes).toBe(0);
  } finally {
    db.close();
  }
});

test('dashboard writes stop when the current head no longer matches the confirmation', async () => {
  const { db, store } = setup();
  try {
    let writes = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/repos/wangxso/mcarplay/pulls/141')) {
        return json(pullPayload());
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return json({
          check_runs: [{
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            head_sha: headSha,
            started_at: '2026-11-28T00:50:00Z',
            completed_at: '2026-11-28T01:00:00Z',
          }],
        });
      }
      if (url.endsWith('/pulls/141/reviews?per_page=100')) return json([]);
      writes += 1;
      throw new Error(`Unexpected GitHub write ${init?.method ?? 'GET'} ${url}`);
    };
    await expect(executeDashboardGitHubAction({
      action: 'approve',
      repository: 'wangxso/mcarplay',
      pullNumber: 141,
      expectedHeadSha: '0'.repeat(40),
      requestId: 'request-github-stale-head-1',
      actor: 'local-dashboard',
    }, {
      store,
      token: 'installation-token',
      fetcher,
    })).rejects.toMatchObject({ code: 'head_sha_changed' });
    expect(writes).toBe(0);
  } finally {
    db.close();
  }
});
