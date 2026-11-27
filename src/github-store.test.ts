import { expect, test } from 'bun:test';
import { openDatabase } from './db';
import type { GitHubPullSnapshot } from './github';
import { TaskStore } from './store';

const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';

function snapshot(): GitHubPullSnapshot {
  return {
    repository: 'wangxso/mcarplay',
    number: 141,
    state: 'open',
    draft: true,
    mergeable: 'mergeable',
    authorLogin: 'wangxso',
    baseRef: 'main',
    headRef: 'quotaflow/issue-82-iap2-catalog',
    baseSha: 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e',
    headSha,
    checks: [
      { name: 'Check and build debug APK', status: 'completed', conclusion: 'success',
        headSha, startedAt: '2026-11-27T13:57:30Z', completedAt: '2026-11-27T14:03:00Z' },
      { name: 'GitGuardian Security Checks', status: 'completed', conclusion: 'success',
        headSha, startedAt: '2026-11-27T13:57:55Z', completedAt: '2026-11-27T13:57:56Z' },
    ],
    reviews: [],
  };
}

test('GitHub gate ingestion persists one result and deduplicates delivery/event retries', () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const input = {
      snapshot: snapshot(),
      policy: { expectedHeadSha: headSha, requiredChecks: ['Check and build debug APK', 'GitGuardian Security Checks'] },
      deliveryId: 'delivery-1',
      eventType: 'pull_request',
      now: 100,
    };
    const first = store.ingestGitHubGate(input);
    expect(first).toMatchObject({
      duplicate: false,
      delivery: { deliveryId: 'delivery-1', duplicateDelivery: false, duplicateEvent: false },
      gate: { headSha, evaluation: { status: 'blocked' } },
    });
    expect(first.gate.evaluation.reasons.map((reason) => reason.code)).toEqual(['draft', 'independent_review_missing']);

    const retry = store.ingestGitHubGate({ ...input, now: 101 });
    expect(retry).toMatchObject({ duplicate: true, delivery: { duplicateDelivery: true, duplicateEvent: true },
      gate: { updatedAt: 100 } });
    const alternateDelivery = store.ingestGitHubGate({ ...input, deliveryId: 'delivery-2', now: 102 });
    expect(alternateDelivery).toMatchObject({ duplicate: true, delivery: { duplicateDelivery: false, duplicateEvent: true },
      gate: { updatedAt: 100 } });

    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_deliveries').get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_gate_results').get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

test('GitHub gate ingestion rejects one delivery id with changed content and records a new head', () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    const first = snapshot();
    const delivered = store.ingestGitHubGate({
      snapshot: first,
      policy: { expectedHeadSha: headSha },
      deliveryId: 'same-delivery',
      eventType: 'pull_request',
      now: 200,
    });
    const changed = snapshot();
    changed.draft = false;
    expect(() => store.ingestGitHubGate({
      snapshot: changed,
      policy: { expectedHeadSha: headSha },
      deliveryId: 'same-delivery',
      eventType: 'pull_request',
      now: 201,
    })).toThrow('reused with different content');

    const next = snapshot();
    next.draft = false;
    next.headSha = 'f'.repeat(40);
    next.checks = next.checks.map((check) => ({ ...check, headSha: next.headSha }));
    next.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: next.headSha,
      submittedAt: '2026-11-27T14:10:00Z' }];
    const result = store.ingestGitHubGate({
      snapshot: next,
      policy: { expectedHeadSha: next.headSha, requiredApprovals: 1 },
      deliveryId: 'delivery-next',
      eventType: 'pull_request',
      now: 202,
    });
    expect(result.gate.evaluation.status).toBe('ready_for_human_merge');
    expect(store.getGitHubGate(result.gate.repository, result.gate.pullNumber, result.gate.headSha,
      result.gate.policyHash)).toMatchObject({ evaluation: { status: 'ready_for_human_merge' } });
    expect(delivered.gate.evaluation.status).toBe('blocked');
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM github_gate_results').get()?.n).toBe(2);
  } finally {
    db.close();
  }
});
