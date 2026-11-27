import { createHash } from 'node:crypto';

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl?: string | null;
}

export interface GitHubReview {
  authorLogin: string;
  state: string;
  commitSha: string;
  submittedAt: string;
}

export interface GitHubPullSnapshot {
  repository: string;
  number: number;
  state: string;
  draft: boolean;
  mergeable: string;
  authorLogin: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  checks: GitHubCheckRun[];
  reviews: GitHubReview[];
}

export interface GitHubGatePolicy {
  expectedHeadSha?: string;
  expectedBaseSha?: string;
  requiredChecks?: string[];
  requiredApprovals?: number;
  allowAuthorSelfApproval?: boolean;
}

export interface GitHubGateReason {
  code: string;
  message: string;
}

export interface GitHubCheckResult {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  required: boolean;
  passed: boolean;
  detailsUrl: string | null;
}

export interface GitHubGateResult {
  status: 'ready_for_human_merge' | 'blocked';
  repository: string;
  pullNumber: number;
  headSha: string;
  policyHash: string;
  humanMergeRequired: true;
  checks: GitHubCheckResult[];
  independentApprovals: number;
  reasons: GitHubGateReason[];
}

export interface GitHubDeliveryInput {
  deliveryId: string;
  eventType: string;
  repository: string;
  pullNumber: number;
  headSha: string;
  payloadHash: string;
  eventKey: string;
  now?: number;
}

export interface GitHubDeliveryRecord extends GitHubDeliveryInput {
  now: number;
  duplicateDelivery: boolean;
  duplicateEvent: boolean;
  outcome?: string | null;
}

export interface GitHubGateIngestInput {
  snapshot: GitHubPullSnapshot;
  policy?: GitHubGatePolicy;
  deliveryId: string;
  eventType: string;
  now?: number;
}

export interface GitHubGateRecord {
  repository: string;
  pullNumber: number;
  headSha: string;
  policyHash: string;
  snapshotHash: string;
  deliveryId: string;
  evaluation: GitHubGateResult;
  createdAt: number;
  updatedAt: number;
}

export interface GitHubGateIngestResult {
  delivery: GitHubDeliveryRecord;
  gate: GitHubGateRecord;
  duplicate: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, label);
}

function shaValue(value: unknown, label: string): string {
  const sha = stringValue(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a 40-character Git SHA`);
  return sha;
}

export function parseGitHubPullSnapshot(value: unknown): GitHubPullSnapshot {
  const root = record(value, 'GitHub pull snapshot');
  const update = record(root.update, 'GitHub pull snapshot.update');
  const checks = Array.isArray(update.checks)
    ? update.checks.map((entry, index) => {
      const check = record(entry, `update.checks[${index}]`);
      return {
        name: stringValue(check.name, `update.checks[${index}].name`),
        status: stringValue(check.status, `update.checks[${index}].status`),
        conclusion: optionalString(check.conclusion, `update.checks[${index}].conclusion`),
        headSha: shaValue(check.headSha, `update.checks[${index}].headSha`),
        startedAt: optionalString(check.startedAt, `update.checks[${index}].startedAt`),
        completedAt: optionalString(check.completedAt, `update.checks[${index}].completedAt`),
        detailsUrl: optionalString(check.detailsUrl, `update.checks[${index}].detailsUrl`),
      };
    })
    : (() => { throw new Error('update.checks must be an array'); })();
  const reviews = Array.isArray(update.reviews)
    ? update.reviews.map((entry, index) => {
      const review = record(entry, `update.reviews[${index}]`);
      return {
        authorLogin: stringValue(review.authorLogin, `update.reviews[${index}].authorLogin`),
        state: stringValue(review.state, `update.reviews[${index}].state`),
        commitSha: shaValue(review.commitSha, `update.reviews[${index}].commitSha`),
        submittedAt: stringValue(review.submittedAt, `update.reviews[${index}].submittedAt`),
      };
    })
    : (() => { throw new Error('update.reviews must be an array'); })();
  const number = update.number;
  if (!Number.isInteger(number) || (number as number) <= 0) throw new Error('update.number must be a positive integer');
  if (typeof update.draft !== 'boolean') throw new Error('update.draft must be boolean');
  return {
    repository: stringValue(root.repository, 'repository').toLowerCase(),
    number: number as number,
    state: stringValue(update.state, 'update.state').toLowerCase(),
    draft: update.draft,
    mergeable: stringValue(update.mergeable, 'update.mergeable').toLowerCase(),
    authorLogin: stringValue(update.authorLogin, 'update.authorLogin'),
    baseRef: stringValue(update.baseRef, 'update.baseRef'),
    headRef: stringValue(update.headRef, 'update.headRef'),
    baseSha: shaValue(update.baseSha, 'update.baseSha'),
    headSha: shaValue(update.headSha, 'update.headSha'),
    checks,
    reviews,
  };
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestChecks(snapshot: GitHubPullSnapshot): GitHubCheckRun[] {
  const latest = new Map<string, GitHubCheckRun>();
  for (const check of snapshot.checks) {
    if (check.headSha !== snapshot.headSha) continue;
    const prior = latest.get(check.name);
    const completed = timestamp(check.completedAt);
    const priorCompleted = prior ? timestamp(prior.completedAt) : -1;
    const started = timestamp(check.startedAt);
    const priorStarted = prior ? timestamp(prior.startedAt) : -1;
    if (!prior || started > priorStarted || (started === priorStarted && completed >= priorCompleted)) {
      latest.set(check.name, check);
    }
  }
  return [...latest.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function latestReviews(snapshot: GitHubPullSnapshot): GitHubReview[] {
  const latest = new Map<string, GitHubReview>();
  for (const review of snapshot.reviews) {
    if (review.commitSha !== snapshot.headSha) continue;
    const reviewer = review.authorLogin.toLowerCase();
    const prior = latest.get(reviewer);
    if (!prior || timestamp(review.submittedAt) >= timestamp(prior.submittedAt)) latest.set(reviewer, review);
  }
  return [...latest.values()];
}

export function evaluateGitHubPull(
  snapshot: GitHubPullSnapshot,
  policy: GitHubGatePolicy = {},
): GitHubGateResult {
  const reasons: GitHubGateReason[] = [];
  const expectedHead = policy.expectedHeadSha ? shaValue(policy.expectedHeadSha, 'expectedHeadSha') : snapshot.headSha;
  const expectedBase = policy.expectedBaseSha ? shaValue(policy.expectedBaseSha, 'expectedBaseSha') : null;
  if (expectedHead !== snapshot.headSha) {
    reasons.push({ code: 'head_sha_changed', message: `Expected ${expectedHead}, received ${snapshot.headSha}` });
  }
  if (expectedBase && expectedBase !== snapshot.baseSha) {
    reasons.push({ code: 'base_sha_changed', message: `Expected base ${expectedBase}, received ${snapshot.baseSha}` });
  }
  if (snapshot.state !== 'open') reasons.push({ code: 'pull_not_open', message: `Pull request state is ${snapshot.state}` });
  if (snapshot.draft) reasons.push({ code: 'draft', message: 'Pull request is still Draft' });
  if (snapshot.mergeable !== 'mergeable') {
    reasons.push({ code: 'not_mergeable', message: `GitHub reports mergeable=${snapshot.mergeable}` });
  }

  const currentChecks = latestChecks(snapshot);
  const requiredNames = [...new Set(policy.requiredChecks ?? currentChecks.map((check) => check.name))].sort();
  if (requiredNames.length === 0) reasons.push({ code: 'ci_missing', message: 'No check runs exist for the current head SHA' });
  const checkResults: GitHubCheckResult[] = [];
  for (const name of requiredNames) {
    const check = currentChecks.find((candidate) => candidate.name === name);
    if (!check) {
      reasons.push({ code: 'ci_missing', message: `Required check ${name} has no result on ${snapshot.headSha}` });
      checkResults.push({ name, status: 'missing', conclusion: null, headSha: snapshot.headSha,
        required: true, passed: false, detailsUrl: null });
      continue;
    }
    const passed = check.status.toLowerCase() === 'completed' && check.conclusion?.toLowerCase() === 'success';
    if (!passed) reasons.push({
      code: 'ci_not_success',
      message: `${name} is ${check.status}/${check.conclusion ?? 'unknown'} on ${snapshot.headSha}`,
    });
    checkResults.push({
      name,
      status: check.status,
      conclusion: check.conclusion,
      headSha: check.headSha,
      required: true,
      passed,
      detailsUrl: check.detailsUrl ?? null,
    });
  }

  const reviews = latestReviews(snapshot);
  for (const review of reviews) {
    if (review.state.toUpperCase() === 'CHANGES_REQUESTED') {
      reasons.push({ code: 'changes_requested', message: `${review.authorLogin} requested changes on ${snapshot.headSha}` });
    }
  }
  const approvals = reviews.filter((review) =>
    review.state.toUpperCase() === 'APPROVED'
    && (policy.allowAuthorSelfApproval || review.authorLogin.toLowerCase() !== snapshot.authorLogin.toLowerCase()));
  const requiredApprovals = policy.requiredApprovals ?? 1;
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 0) {
    throw new Error('requiredApprovals must be a non-negative integer');
  }
  if (approvals.length < requiredApprovals) {
    reasons.push({
      code: 'independent_review_missing',
      message: `${approvals.length}/${requiredApprovals} independent approvals exist on ${snapshot.headSha}`,
    });
  }

  const policyHash = createHash('sha256').update(JSON.stringify({
    expectedHeadSha: expectedHead,
    expectedBaseSha: expectedBase,
    requiredChecks: requiredNames,
    requiredApprovals,
    allowAuthorSelfApproval: Boolean(policy.allowAuthorSelfApproval),
    headSha: snapshot.headSha,
  })).digest('hex');
  return {
    status: reasons.length === 0 ? 'ready_for_human_merge' : 'blocked',
    repository: snapshot.repository,
    pullNumber: snapshot.number,
    headSha: snapshot.headSha,
    policyHash,
    humanMergeRequired: true,
    checks: checkResults,
    independentApprovals: approvals.length,
    reasons,
  };
}

export function hashGitHubPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function githubEventKey(input: Omit<GitHubDeliveryInput, 'deliveryId' | 'eventKey' | 'now'>): string {
  return hashGitHubPayload([
    input.eventType,
    input.repository.toLowerCase(),
    input.pullNumber,
    input.headSha,
    input.payloadHash,
  ]);
}
