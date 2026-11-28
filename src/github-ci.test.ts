import { expect, test } from 'bun:test';
import {
  ciTriageRequiresHuman,
  enrichGitHubPlanWithCi,
  redactGitHubLog,
  triageGitHubChecks,
} from './github-ci';
import type { GitHubGateResult } from './github';

const headSha = 'abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48';

function gate(): GitHubGateResult {
  return {
    status: 'blocked',
    repository: 'wangxso/mcarplay',
    pullNumber: 42,
    headSha,
    policyHash: 'policy',
    humanMergeRequired: true,
    independentApprovals: 0,
    reasons: [
      { code: 'ci_not_success', message: 'CI failed' },
      { code: 'independent_review_missing', message: 'Review missing' },
    ],
    checks: [
      {
        name: 'unit tests',
        status: 'completed',
        conclusion: 'failure',
        headSha,
        required: true,
        passed: false,
        detailsUrl: 'https://github.com/wangxso/mcarplay/actions/runs/1/job/101',
      },
      {
        name: 'runner health',
        status: 'completed',
        conclusion: 'failure',
        headSha,
        required: true,
        passed: false,
        detailsUrl: 'https://github.com/wangxso/mcarplay/actions/runs/1/job/102',
      },
      {
        name: 'security',
        status: 'completed',
        conclusion: 'failure',
        headSha,
        required: true,
        passed: false,
        detailsUrl: 'https://example.test/security',
      },
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        headSha,
        required: true,
        passed: true,
        detailsUrl: 'https://github.com/wangxso/mcarplay/actions/runs/1/job/104',
      },
    ],
  };
}

test('fetches failed job logs, classifies failures and redacts secrets', async () => {
  const requested: string[] = [];
  const fakeToken = ['top', 'secret', 'value'].join('-');
  const triage = await triageGitHubChecks('wangxso/mcarplay', gate(), {
    token: 'installation-token',
    fetcher: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/jobs/101/logs')) {
        return new Response([
          '> Task :app:testDebugUnitTest',
          'AssertionError: expected 41 but was 42',
          `TOKEN=${fakeToken}`,
          'Authorization: Bearer top-secret-value',
        ].join('\n'));
      }
      if (url.endsWith('/jobs/102/logs')) {
        return new Response('The runner lost communication with the server.');
      }
      return new Response('not found', { status: 404 });
    },
  });
  expect(triage.failures).toMatchObject([
    {
      name: 'unit tests',
      runId: 1,
      jobId: 101,
      category: 'code_or_test',
    },
    {
      name: 'runner health',
      runId: 1,
      jobId: 102,
      category: 'infrastructure',
    },
    {
      name: 'security',
      jobId: null,
      category: 'unknown',
      error: 'No GitHub Actions job ID in details URL',
    },
  ]);
  expect(triage.complete).toBe(true);
  expect(triage.failures[0]!.excerpt).toContain('TOKEN=[REDACTED]');
  expect(triage.failures[0]!.excerpt).toContain('Bearer [REDACTED]');
  expect(requested).toHaveLength(2);
});

test('adds CI context to remediation prompts and detects human-only infrastructure failures', async () => {
  const triage = await triageGitHubChecks('wangxso/mcarplay', {
    ...gate(),
    checks: [gate().checks[1]!],
  }, {
    fetcher: async () => new Response('No space left on device'),
  });
  expect(ciTriageRequiresHuman(triage)).toBe(true);
  const plan = enrichGitHubPlanWithCi({
    status: 'remediation_required' as const,
    pullNumber: 42,
    headSha,
    humanApprovalRequired: true as const,
    actions: [{
      actionKey: 'action',
      kind: 'ci_fix' as const,
      title: 'Fix CI',
      priority: 120,
      requiresHuman: false,
      reasonCodes: ['ci_not_success'],
      taskPrompt: 'Fix CI.',
    }],
  }, triage);
  expect(plan.actions[0]!.taskPrompt).toContain('Category: infrastructure');
  expect(plan.actions[0]!.taskPrompt).toContain('Log excerpt:');
  expect(plan.actions[0]!.taskPrompt).toContain('No space left on device');
});

test('redacts common private-key and credential formats', () => {
  const begin = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const end = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
  const redacted = redactGitHubLog([
    'api_key=top-secret',
    'password: hunter2',
    'sensitive',
    '-----END RSA PRIVATE KEY-----',
    `${begin}\ntest-only-key-material\n${end}`,
  ].join('\n'));
  expect(redacted).toContain('api_key=[REDACTED]');
  expect(redacted).toContain('password: [REDACTED]');
  expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
  expect(redacted).not.toContain('test-only-key-material');
});
