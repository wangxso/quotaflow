import { expect, test } from 'bun:test';
import {
  evaluateGitHubPull,
  githubEventKey,
  hashGitHubPayload,
  parseGitHubPullSnapshot,
  type GitHubPullSnapshot,
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
});

test('allows human merge only when current-head CI and independent review pass', () => {
  const value = snapshot();
  value.draft = false;
  value.reviews = [{ authorLogin: 'reviewer', state: 'APPROVED', commitSha: headSha,
    submittedAt: '2026-11-27T14:04:00Z' }];
  expect(evaluateGitHubPull(value, {
    expectedHeadSha: headSha,
    requiredChecks: ['Check and build debug APK', 'GitGuardian Security Checks'],
    requiredApprovals: 1,
  })).toMatchObject({
    status: 'ready_for_human_merge',
    independentApprovals: 1,
    reasons: [],
    humanMergeRequired: true,
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
