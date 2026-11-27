import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

export interface GitHubPlannedAction {
  actionKey: string;
  kind: 'human_merge' | 'independent_review' | 'review_fix' | 'ci_fix' | 'mark_ready' | 'resolve_conflict' | 'refresh_evidence';
  title: string;
  priority: number;
  requiresHuman: boolean;
  reasonCodes: string[];
  taskPrompt: string | null;
}

export interface GitHubActionPlan {
  status: 'human_merge_ready' | 'remediation_required';
  pullNumber: number;
  headSha: string;
  humanApprovalRequired: true;
  actions: GitHubPlannedAction[];
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

export interface GitHubWebhookEvent {
  eventType: string;
  action: string;
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string | null;
  payloadHash: string;
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

function plannedAction(
  gate: GitHubGateResult,
  kind: GitHubPlannedAction['kind'],
  title: string,
  priority: number,
  requiresHuman: boolean,
  reasonCodes: string[],
  taskPrompt: string | null,
): GitHubPlannedAction {
  return {
    actionKey: hashGitHubPayload([gate.repository, gate.pullNumber, gate.headSha, kind, [...reasonCodes].sort()]),
    kind,
    title,
    priority,
    requiresHuman,
    reasonCodes,
    taskPrompt,
  };
}

export function planGitHubActions(gate: GitHubGateResult): GitHubActionPlan {
  if (gate.status === 'ready_for_human_merge') {
    return {
      status: 'human_merge_ready',
      pullNumber: gate.pullNumber,
      headSha: gate.headSha,
      humanApprovalRequired: true,
      actions: [plannedAction(gate, 'human_merge', 'Review and merge the approved pull request', 1000, true, [], null)],
    };
  }

  const codes = new Set(gate.reasons.map((reason) => reason.code));
  const failedChecks = gate.checks.filter((check) => !check.passed);
  const actions: GitHubPlannedAction[] = [];
  if (codes.has('head_sha_changed') || codes.has('base_sha_changed')) {
    const reasonCodes = [...codes].filter((code) => code === 'head_sha_changed' || code === 'base_sha_changed');
    return {
      status: 'remediation_required',
      pullNumber: gate.pullNumber,
      headSha: gate.headSha,
      humanApprovalRequired: true,
      actions: [plannedAction(gate, 'refresh_evidence', 'Refresh evidence for the current base and head',
        100, true, reasonCodes, null)],
    };
  }
  const hasCiFailure = codes.has('ci_not_success') || codes.has('ci_missing');
  const hasChangesRequested = codes.has('changes_requested');
  if (hasCiFailure || hasChangesRequested) {
    const checkSummary = hasCiFailure
      ? failedChecks.length
        ? failedChecks.map((check) => `${check.name}: ${check.status}/${check.conclusion ?? 'unknown'}`).join('; ')
        : 'required current-head CI evidence is missing'
      : 'current-head CI is passing';
    const reasonCodes = [...codes].filter((code) =>
      code === 'ci_not_success' || code === 'ci_missing' || code === 'changes_requested');
    actions.push(plannedAction(
      gate,
      hasChangesRequested ? 'review_fix' : 'ci_fix',
      hasChangesRequested ? 'Address review feedback and current-head CI' : 'Triage and fix current-head CI',
      120,
      false,
      reasonCodes,
      hasChangesRequested
        ? `Address the current-head review feedback and CI state for pull request #${gate.pullNumber} at ${gate.headSha}. CI status: ${checkSummary}. Keep the fix scoped to the review findings, failing checks, and original issue. Run affected tests and do not push, comment, merge, or resolve reviews yourself. Write the changes and observed checks into the handoff note.`
        : `Inspect pull request #${gate.pullNumber} at ${gate.headSha}. Diagnose the failing or missing CI evidence: ${checkSummary}. Make only the minimal source or test changes needed, run the affected checks locally, and do not push, comment, merge, or change repository settings. Write the observed commands and results into the handoff note.`,
    ));
  }
  const immediateFix = actions.length > 0;
  if (!immediateFix && codes.has('independent_review_missing')) {
    actions.push(plannedAction(
      gate,
      'independent_review',
      'Perform an independent current-head review',
      90,
      false,
      ['independent_review_missing'],
      `Perform an independent code review of pull request #${gate.pullNumber} at ${gate.headSha}. Treat the workspace as read-only. Do not modify files, push, comment, approve, or merge. Inspect the full diff, issue intent, tests, and relevant callers. Finish with a concise review report that lists concrete findings with severity and file/line evidence, or states explicitly that no blocking findings remain. The review must be independent from the implementing agent.`,
    ));
  }
  if (codes.has('not_mergeable')) {
    actions.push(plannedAction(
      gate,
      'resolve_conflict',
      'Resolve mergeability with human approval',
      105,
      true,
      ['not_mergeable'],
      null,
    ));
  }
  if (codes.has('draft') && !codes.has('independent_review_missing') && !immediateFix) {
    actions.push(plannedAction(
      gate,
      'mark_ready',
      'Mark the pull request Ready after other gates pass',
      50,
      true,
      ['draft'],
      null,
    ));
  }
  if (actions.length === 0) {
    actions.push(plannedAction(
      gate,
      'refresh_evidence',
      'Inspect the blocking gate reasons',
      100,
      true,
      gate.reasons.map((reason) => reason.code),
      null,
    ));
  }
  actions.sort((left, right) => right.priority - left.priority || left.kind.localeCompare(right.kind));
  return {
    status: 'remediation_required',
    pullNumber: gate.pullNumber,
    headSha: gate.headSha,
    humanApprovalRequired: true,
    actions,
  };
}

export function hashGitHubPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hashGitHubBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function verifyGitHubWebhookSignature(
  secret: string,
  payload: string | Uint8Array,
  signatureHeader: string,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!secret || !match) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(match[1], 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

export function normalizeGitHubWebhook(
  eventType: string,
  payload: unknown,
  rawPayload?: Uint8Array,
): GitHubWebhookEvent {
  const event = eventType.trim().toLowerCase();
  if (!['pull_request', 'check_run', 'pull_request_review'].includes(event)) {
    throw new Error(`Unsupported GitHub webhook event ${eventType}`);
  }
  const root = record(payload, 'GitHub webhook payload');
  const repository = stringValue(record(root.repository, 'repository').full_name, 'repository.full_name').toLowerCase();
  const action = stringValue(root.action, 'action').toLowerCase();
  if (event === 'pull_request') {
    const pull = record(root.pull_request, 'pull_request');
    return {
      eventType: event,
      action,
      repository,
      pullNumber: positiveInteger(pull.number, 'pull_request.number'),
      headSha: shaValue(record(pull.head, 'pull_request.head').sha, 'pull_request.head.sha'),
      baseSha: shaValue(record(pull.base, 'pull_request.base').sha, 'pull_request.base.sha'),
      payloadHash: rawPayload ? hashGitHubBytes(rawPayload) : hashGitHubPayload(payload),
    };
  }
  if (event === 'check_run') {
    const check = record(root.check_run, 'check_run');
    const pulls = check.pull_requests;
    if (!Array.isArray(pulls) || pulls.length === 0) throw new Error('check_run.pull_requests must contain a PR');
    const pull = record(pulls[0], 'check_run.pull_requests[0]');
    return {
      eventType: event,
      action,
      repository,
      pullNumber: positiveInteger(pull.number, 'check_run.pull_requests[0].number'),
      headSha: shaValue(check.head_sha, 'check_run.head_sha'),
      baseSha: null,
      payloadHash: rawPayload ? hashGitHubBytes(rawPayload) : hashGitHubPayload(payload),
    };
  }
  if (event === 'pull_request_review') {
    const pull = record(root.pull_request, 'pull_request');
    const review = record(root.review, 'review');
    return {
      eventType: event,
      action,
      repository,
      pullNumber: positiveInteger(pull.number, 'pull_request.number'),
      headSha: shaValue(review.commit_id ?? record(pull.head, 'pull_request.head').sha, 'review.commit_id'),
      baseSha: shaValue(record(pull.base, 'pull_request.base').sha, 'pull_request.base.sha'),
      payloadHash: rawPayload ? hashGitHubBytes(rawPayload) : hashGitHubPayload(payload),
    };
  }
  throw new Error(`GitHub webhook event ${eventType} reached an invalid branch`);
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
