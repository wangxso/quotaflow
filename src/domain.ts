export type Provider = 'native' | 'local' | 'magpie';
export type AgentKind = 'codex' | 'opencode';
export type TaskAccessMode = 'write' | 'read_only';

export const TASK_STATUSES = [
  'queued',
  'running',
  'cancelling',
  'waiting_quota',
  'waiting_dependency',
  'waiting_human',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export type AttemptStage = 'running' | 'checkpoint' | 'done';

export interface QuotaWindow {
  key: string;
  remaining: number | null;
  reserve: number;
  observedAt: number;
  resetAt: number;
}

export interface LaneConfig {
  id: string;
  agent: AgentKind;
  model: string;
  provider: Provider;
  account: string;
  priority: number;
  slots: number;
  windows: QuotaWindow[];
  command?: string[];
  executable?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface RoutedModelApproval {
  allowed: boolean;
  approvedBy: string;
  approvedAt: string;
  note?: string;
}

export interface RoutingConfig {
  allowedProviders: Provider[];
  routedModelApproval?: RoutedModelApproval;
}

export interface GitHubWebhookConfig {
  host: string;
  port: number;
  path: string;
  secretEnv: string;
  fetchGate?: boolean;
  tokenEnv?: string;
  apiUrl?: string;
}

export interface GitHubApprovalConfig {
  allowBotApprovals: boolean;
}

export interface BudgetPolicy {
  account: string;
  unit: string;
  limit: number;
  reserve: number;
  windowMs: number;
  holdPerAttempt: number;
}

export interface BudgetStatus extends BudgetPolicy {
  used: number;
  available: number;
  activeLeases: number;
  nextExpiryAt: number | null;
}

export interface BudgetLease {
  attemptId: number;
  taskId: string | null;
  account: string;
  unit: string;
  amount: number;
  state: 'held' | 'pending' | 'settled' | 'released' | 'expired';
  priced: boolean | null;
  windowMs: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  expiredAt: number | null;
}

export interface BudgetAudit {
  policies: BudgetStatus[];
  expired: BudgetLease[];
}

export interface QuotaFlowConfig {
  version: 1;
  database: string;
  worktreeRoot: string;
  defaultRepo?: string;
  routing: RoutingConfig;
  githubWebhook?: GitHubWebhookConfig;
  githubApproval?: GitHubApprovalConfig;
  budgets?: BudgetPolicy[];
  lanes: LaneConfig[];
}

export interface HandoffOptions {
  protectedPaths: string[];
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  repoPath: string;
  workspacePath: string;
  status: TaskStatus;
  priority: number;
  critical: boolean;
  accessMode: TaskAccessMode;
  handoff?: HandoffOptions;
  checkpoint: string | null;
  nextWakeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Attempt {
  id: number;
  taskId: string;
  laneId: string;
  agent: AgentKind;
  model: string;
  provider: Provider;
  account: string;
  stage: AttemptStage;
  leaseToken: string;
  actualModel: string | null;
  checkpoint: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type UsageStatus = 'recorded' | 'not_found' | 'unavailable';

export interface UsageObservation {
  source: string;
  sourceRequestId: string | null;
  observedAt: number;
  provider: string | null;
  providerName: string | null;
  agent: string | null;
  sessionId: string | null;
  requestModel: string | null;
  servedModel: string | null;
  httpStatus: number | null;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costEstimate: number | null;
  priced: boolean | null;
  providerInvoice: 'UNKNOWN';
}

export interface UsageReport {
  source: string;
  status: UsageStatus;
  sessionId: string | null;
  queryWindow: {
    start: number;
    end: number;
  };
  rows: UsageObservation[];
  actualModel?: string;
  costEstimate?: number;
  priced: boolean | null;
  providerInvoice: 'UNKNOWN';
  totalRows?: number;
  truncated?: boolean;
  error?: string;
}

export interface AttemptUsageRecord extends UsageObservation {
  id: number;
  attemptId: number;
}

export interface EventRecord {
  id: number;
  taskId: string;
  attemptId: number | null;
  kind: string;
  detail: unknown;
  createdAt: number;
}

export interface LaneFilter {
  laneId: string;
  reason: string;
}

export interface Reservation {
  attempt: Attempt;
  filters: LaneFilter[];
}
