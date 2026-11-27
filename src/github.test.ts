import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  evaluateGitHubPull,
  githubEventKey,
  hashGitHubBytes,
  hashGitHubPayload,
  normalizeGitHubWebhook,
  parseGitHubPullSnapshot,
  planGitHubActions,
  type GitHubPullSnapshot,
  verifyGitHubWebhookSignature,
} from './github';

const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';
const baseSha = 'daf67e87a72aa9033a4d62f88e9a9d05ce047d9e';

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
    baseSha,
    headSha,
    checks: [
      { name: 'Check and build debug APK', status: 'completed', conclusion: 'success',
        headSha, startedAt: '2026-11-27T13:57:30Z', completedAt: '2026-11-27T14:03:00Z' },
      { name: 'Check and build debug APK', status: 'completed', conclusion: 'success',
        headSha, startedAt: '2026-11-27T13:57:52Z', completedAt: '2026-11-27T14:03:06Z' },
      { name: 'GitGuardian Security Checks', status: 'completed', conclusion: 'success',
        headSha, startedAt: '2026-11-27T13:57:55Z', completedAt: '2026-11-27T13:57:56Z' },
    ],
    reviews: [],
  };
}

test('keeps the real pilot blocked by Draft and missing independent review', () => {
  const result = evaluateGitHubPull(snapshot(), { expectedHeadSha: headSha });
  expect(result).toMatchObject({
    status: 'blocked',
    headSha,
    humanMergeRequired: true,
    independentApprovals: 0,
  });
  expect(result.checks.every((check) => check.passed)).toBe(true);
  expect(result.reasons.map((reason) => reason.code)).toEqual([
    'draft',
    'independent_review_missing',
  ]);
  expect(planGitHubActions(result)).toMatchObject({
    status: 'remediation_required',
    humanApprovalRequired: true,
    actions: [{ kind: 'independent_review', requiresHuman: false, reasonCodes: ['independent_review_missing'] }],
  });
});

test('allows human merge only when current-head CI and independent review pass', () => {
  const value = snapshot();
  value.draft = false;
  value.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
    submittedAt: '2026-11-27T14:04:00Z' }];
  const gate = evaluateGitHubPull(value, {
    expectedHeadSha: headSha,
    requiredChecks: ['Check and build debug APK', 'GitGuardian Security Checks'],
    requiredApprovals: 1,
  });
  expect(gate).toMatchObject({
    status: 'ready_for_human_merge',
    independentApprovals: 1,
    reasons: [],
    humanMergeRequired: true,
  });
  expect(planGitHubActions(gate)).toMatchObject({
    status: 'human_merge_ready',
    actions: [{ kind: 'human_merge', requiresHuman: true, taskPrompt: null }],
  });
});

test('does not reuse checks or reviews from an older head', () => {
  const value = snapshot();
  value.draft = false;
  value.headSha = 'f'.repeat(40);
  value.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
    submittedAt: '2026-11-27T14:04:00Z' }];
  const result = evaluateGitHubPull(value, { expectedHeadSha: headSha });
  expect(result.checks.every((check) => !check.passed && check.status === 'missing')).toBe(true);
  expect(result.independentApprovals).toBe(0);
  expect(result.reasons.map((reason) => reason.code)).toContain('head_sha_changed');
  expect(result.reasons.filter((reason) => reason.code === 'ci_missing')).toHaveLength(1);
  expect(result.reasons.map((reason) => reason.code)).toContain('independent_review_missing');
});

test('uses the latest review per reviewer and excludes author self-approval', () => {
  const value = snapshot();
  value.draft = false;
  value.reviews = [
    { authorLogin: 'reviewer', state: 'CHANGES_REQUESTED', commitSha: headSha,
      submittedAt: '2026-11-27T14:00:00Z' },
    { authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
      submittedAt: '2026-11-27T14:05:00Z' },
    { authorLogin: 'wangxso', state: 'APPROVED', commitSha: headSha,
      submittedAt: '2026-11-27T14:06:00Z' },
  ];
  const result = evaluateGitHubPull(value, { expectedHeadSha: headSha, requiredApprovals: 1 });
  expect(result.status).toBe('ready_for_human_merge');
  expect(result.independentApprovals).toBe(1);
});

test('uses the latest current-head rerun for a required check', () => {
  const value = snapshot();
  value.draft = false;
  value.checks.unshift({ name: 'Check and build debug APK', status: 'completed', conclusion: 'failure',
    headSha, startedAt: '2026-11-27T13:56:00Z', completedAt: '2026-11-27T13:57:00Z' });
  value.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
    submittedAt: '2026-11-27T14:04:00Z' }];
  const result = evaluateGitHubPull(value, {
    expectedHeadSha: headSha,
    requiredChecks: ['Check and build debug APK'],
  });
  expect(result.status).toBe('ready_for_human_merge');
  expect(result.checks).toEqual([expect.objectContaining({
    name: 'Check and build debug APK',
    conclusion: 'success',
    passed: true,
  })]);
});

test('a newer pending rerun supersedes an older success', () => {
  const value = snapshot();
  value.draft = false;
  value.checks.push({ name: 'Check and build debug APK', status: 'in_progress', conclusion: null,
    headSha, startedAt: '2026-11-27T14:10:00Z', completedAt: null });
  value.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
    submittedAt: '2026-11-27T14:04:00Z' }];
  const result = evaluateGitHubPull(value, {
    expectedHeadSha: headSha,
    requiredChecks: ['Check and build debug APK'],
  });
  expect(result.status).toBe('blocked');
  expect(result.checks[0]).toMatchObject({ status: 'in_progress', conclusion: null, passed: false });
  expect(result.reasons.map((reason) => reason.code)).toContain('ci_not_success');
});

test('combines review feedback and CI failures into one fix task', () => {
  const value = snapshot();
  value.draft = false;
  value.checks = [{ ...value.checks[0]!, conclusion: 'failure', startedAt: '2026-11-27T14:10:00Z',
    completedAt: '2026-11-27T14:11:00Z' }];
  value.reviews = [{ authorLogin: 'reviewer', state: 'CHANGES_REQUESTED', commitSha: headSha,
    submittedAt: '2026-11-27T14:05:00Z' }];
  const gate = evaluateGitHubPull(value, {
    expectedHeadSha: headSha,
    requiredChecks: ['Check and build debug APK'],
  });
  const plan = planGitHubActions(gate);
  expect(plan.status).toBe('remediation_required');
  expect(plan.actions).toHaveLength(1);
  expect(plan.actions[0]).toMatchObject({
    kind: 'review_fix',
    requiresHuman: false,
    reasonCodes: ['ci_not_success', 'changes_requested'],
  });
  expect(plan.actions[0]!.taskPrompt).toContain('Check and build debug APK: completed/failure');
});

test('plans a human Ready action when Draft is the only gate', () => {
  const value = snapshot();
  value.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
    submittedAt: '2026-11-27T14:05:00Z' }];
  const plan = planGitHubActions(evaluateGitHubPull(value, {
    expectedHeadSha: headSha,
    requiredApprovals: 1,
  }));
  expect(plan.actions).toMatchObject([{ kind: 'mark_ready', requiresHuman: true, reasonCodes: ['draft'] }]);
});

test('blocks when the expected base SHA moves', () => {
  const result = evaluateGitHubPull(snapshot(), { expectedHeadSha: headSha, expectedBaseSha: 'e'.repeat(40) });
  expect(result.reasons.map((reason) => reason.code)).toContain('base_sha_changed');
});

test('parses and rejects the structured pull snapshot envelope', () => {
  const parsed = parseGitHubPullSnapshot({
    repository: 'wangxso/mcarplay',
    update: {
      number: 141,
      state: 'OPEN',
      draft: true,
      mergeable: 'MERGEABLE',
      authorLogin: 'wangxso',
      baseRef: 'main',
      headRef: 'quotaflow/issue-82-iap2-catalog',
      baseSha,
      headSha,
      checks: [],
      reviews: [],
    },
  });
  expect(parsed).toMatchObject({ number: 141, state: 'open', mergeable: 'mergeable', checks: [] });
  expect(() => parseGitHubPullSnapshot({ repository: 'wangxso/mcarplay', update: { number: 141 } }))
    .toThrow('update.checks must be an array');
});

test('deduplicates logical GitHub deliveries independently of delivery id', () => {
  const base = {
    eventType: 'pull_request',
    repository: 'wangxso/mcarplay',
    pullNumber: 141,
    headSha,
    payloadHash: hashGitHubPayload({ action: 'synchronize', headSha }),
  };
  expect(githubEventKey(base)).toBe(githubEventKey({ ...base, repository: 'WANGXSO/MCARPLAY' }));
  expect(githubEventKey(base)).not.toBe(githubEventKey({ ...base, payloadHash: hashGitHubPayload({ action: 'opened' }) }));
});

test('verifies the raw GitHub webhook HMAC and rejects tampering', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from('{"action":"opened"}');
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  expect(verifyGitHubWebhookSignature(secret, body, signature)).toBe(true);
  expect(verifyGitHubWebhookSignature(secret, Buffer.from('{"action":"closed"}'), signature)).toBe(false);
  expect(verifyGitHubWebhookSignature(secret, body, 'sha256=bad')).toBe(false);
  expect(verifyGitHubWebhookSignature('', body, signature)).toBe(false);
});

test('normalizes supported GitHub webhook events to PR and head identity', () => {
  const repository = { full_name: 'WANGXSO/mcarplay' };
  const pullRequest = {
    number: 141,
    head: { sha: headSha },
    base: { sha: baseSha },
  };
  const pullBody = Buffer.from(JSON.stringify({ action: 'synchronize', repository, pull_request: pullRequest }));
  expect(normalizeGitHubWebhook('pull_request', JSON.parse(pullBody.toString()), pullBody)).toEqual({
    eventType: 'pull_request', action: 'synchronize', repository: 'wangxso/mcarplay', pullNumber: 141,
    headSha, baseSha, payloadHash: hashGitHubBytes(pullBody),
  });
  const checkBody = Buffer.from(JSON.stringify({ action: 'completed', repository,
    check_run: { head_sha: headSha, pull_requests: [{ number: 141 }] } }));
  expect(normalizeGitHubWebhook('check_run', JSON.parse(checkBody.toString()), checkBody))
    .toMatchObject({ eventType: 'check_run', repository: 'wangxso/mcarplay', pullNumber: 141, headSha, baseSha: null });
  const reviewBody = Buffer.from(JSON.stringify({ action: 'submitted', repository,
    pull_request: pullRequest, review: { commit_id: headSha } }));
  expect(normalizeGitHubWebhook('pull_request_review', JSON.parse(reviewBody.toString()), reviewBody))
    .toMatchObject({ eventType: 'pull_request_review', action: 'submitted', pullNumber: 141, headSha, baseSha });
  expect(() => normalizeGitHubWebhook('issue_comment', {})).toThrow('Unsupported GitHub webhook event');
});
