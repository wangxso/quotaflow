import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { openDatabase } from './db';
import type { GitHubPullSnapshot } from './github';
import { createGitHubWebhookHandler, maxGitHubWebhookBytes, startGitHubWebhookServer } from './github-webhook-server';
import { TaskStore } from './store';

const secret = 'quotaflow-http-webhook-test-secret';
const path = '/github/webhook';
const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
const baseSha = 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e';

function payload(action = 'synchronize') {
  return Buffer.from(JSON.stringify({
    action,
    repository: { full_name: 'wangxso/mcarplay' },
    pull_request: {
      number: 141,
      head: { sha: headSha },
      base: { sha: 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e' },
    },
  }));
}

function signature(body: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function request(body: Uint8Array, overrides: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': signature(body),
      ...overrides,
    },
    body,
  });
}

function snapshot(head = headSha): GitHubPullSnapshot {
  return {
    repository: 'wangxso/mcarplay',
    number: 141,
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    authorLogin: 'wangxso',
    baseRef: 'main',
    headRef: 'feature',
    headRepository: 'wangxso/mcarplay',
    baseSha,
    headSha: head,
    checks: [{
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      headSha: head,
      startedAt: '2026-11-27T13:57:30Z',
      completedAt: '2026-11-27T14:03:00Z',
    }],
    reviews: [],
  };
}

test('HTTP webhook handler accepts, deduplicates and rejects signed events', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const handle = createGitHubWebhookHandler({ store, secret, path });
  try {
    const health = await handle(new Request('http://localhost/healthz'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const body = payload();
    const first = await handle(request(body));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: 'accepted', event: { pullNumber: 141, headSha },
      delivery: { duplicateDelivery: false, duplicateEvent: false } });
    const duplicate = await handle(request(body));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: 'duplicate',
      delivery: { duplicateDelivery: true, duplicateEvent: true } });

    const invalid = await handle(request(body, { 'x-hub-signature-256': 'sha256=bad' }));
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: 'invalid_signature' });
    const unsupported = await handle(request(body, { 'x-github-event': 'issue_comment' }));
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({ error: 'unsupported_event' });
    const ping = await handle(request(Buffer.from('{"zen":"QuotaFlow"}'), { 'x-github-event': 'ping',
      'x-github-delivery': 'ping-delivery' }));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ status: 'pong', deliveryId: 'ping-delivery' });
    const installation = await handle(request(Buffer.from('{"action":"new_permissions_accepted"}'), {
      'x-github-event': 'installation',
      'x-github-delivery': 'installation-delivery',
    }));
    expect(installation.status).toBe(200);
    expect(await installation.json()).toEqual({
      status: 'ignored',
      eventType: 'installation',
      deliveryId: 'installation-delivery',
    });
    const branchCheck = await handle(request(Buffer.from(JSON.stringify({
      action: 'completed',
      repository: { full_name: 'wangxso/mcarplay' },
      check_run: {
        head_sha: headSha,
        pull_requests: [],
      },
    })), {
      'x-github-event': 'check_run',
      'x-github-delivery': 'branch-check-delivery',
    }));
    expect(branchCheck.status).toBe(200);
    expect(await branchCheck.json()).toEqual({
      status: 'ignored',
      eventType: 'check_run',
      deliveryId: 'branch-check-delivery',
      reason: 'check_run_without_pull_request',
    });
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_deliveries').get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

test('HTTP webhook handler rejects conflicting deliveries and oversized bodies', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const handle = createGitHubWebhookHandler({ store, secret, path });
  try {
    expect((await handle(request(payload('opened')))).status).toBe(202);
    const conflict = await handle(request(payload('closed')));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'delivery_conflict' });

    const large = new Uint8Array(maxGitHubWebhookBytes + 1);
    const tooLarge = await handle(request(large));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: 'payload_too_large' });
  } finally {
    db.close();
  }
});

test('HTTP webhook handler fetches the current snapshot and stores a gate', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  let current = snapshot();
  let fetchFailure = false;
  const actionContexts: string[] = [];
  const handle = createGitHubWebhookHandler({
    store,
    secret,
    path,
    snapshotFetcher: async () => {
      if (fetchFailure) throw new Error('GitHub unavailable');
      return current;
    },
    gatePolicy: {
      requiredChecks: ['test'],
      requiredApprovals: 1,
    },
    actionHandler: async (context) => {
      actionContexts.push(`${context.gate.pullNumber}:${context.plan.actions[0]?.kind ?? 'none'}`);
      return { status: 'materialized', taskId: 'task-1' };
    },
  });
  try {
    const body = payload();
    const first = await handle(request(body));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      status: 'gated',
      delivery: { duplicateDelivery: false, duplicateEvent: false },
      gate: { status: 'blocked', reasons: [{ code: 'independent_review_missing' }] },
      plan: { actions: [{ kind: 'independent_review' }] },
      taskMaterialization: { status: 'materialized', taskId: 'task-1' },
    });
    const duplicate = await handle(request(body));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      status: 'duplicate',
      delivery: { duplicateDelivery: true, duplicateEvent: true },
    });
    expect(actionContexts).toEqual(['141:independent_review', '141:independent_review']);

    current = snapshot('f'.repeat(40));
    const stale = await handle(request(body, { 'x-github-delivery': 'delivery-stale' }));
    expect(stale.status).toBe(202);
    expect(await stale.json()).toMatchObject({ status: 'stale' });

    fetchFailure = true;
    const unavailable = await handle(request(body, { 'x-github-delivery': 'delivery-unavailable' }));
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: 'snapshot_fetch_failed' });
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_deliveries').get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_gate_results').get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

test('HTTP webhook handler asks GitHub to retry when action materialization fails', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const handle = createGitHubWebhookHandler({
    store,
    secret,
    path,
    snapshotFetcher: async () => snapshot(),
    actionHandler: () => {
      throw new Error('repository fetch failed');
    },
  });
  try {
    const response = await handle(request(payload()));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'task_materialization_failed',
      message: 'repository fetch failed',
      gate: { status: 'blocked' },
    });
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_deliveries').get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_gate_results').get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

test('Bun HTTP server exposes health and accepts a signed webhook', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const server = startGitHubWebhookServer({ host: '127.0.0.1', port: 0, path, secret, store });
  try {
    const health = await fetch(new URL('/healthz', server.url));
    expect(health.status).toBe(200);
    const body = payload();
    const response = await fetch(new URL(path, server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'network-delivery',
        'x-hub-signature-256': signature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'accepted',
      delivery: { deliveryId: 'network-delivery' } });
  } finally {
    server.stop(true);
    db.close();
  }
});
