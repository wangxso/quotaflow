import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  AgentKind,
  BudgetPolicy,
  GitHubApprovalConfig,
  GitHubProjectConfig,
  GitHubWebhookConfig,
  LaneConfig,
  Provider,
  QuotaFlowConfig,
  QuotaWindow,
} from './domain';

const providers: Provider[] = ['native', 'local', 'magpie'];
const agents: AgentKind[] = ['codex', 'opencode'];

function fail(message: string): never {
  throw new Error(`Invalid QuotaFlow config: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  return value;
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function parseWindow(value: unknown, field: string): QuotaWindow {
  const raw = object(value, field);
  const remaining = raw.remaining === null ? null : number(raw.remaining, `${field}.remaining`);
  if (remaining !== null && remaining < 0) fail(`${field}.remaining must be non-negative`);
  const reserve = number(raw.reserve, `${field}.reserve`);
  if (reserve < 0) fail(`${field}.reserve must be non-negative`);
  return {
    key: text(raw.key, `${field}.key`),
    remaining,
    reserve,
    observedAt: number(raw.observedAt, `${field}.observedAt`),
    resetAt: number(raw.resetAt, `${field}.resetAt`),
  };
}

function parseLane(value: unknown, index: number): LaneConfig {
  const field = `lanes[${index}]`;
  const raw = object(value, field);
  const provider = text(raw.provider, `${field}.provider`) as Provider;
  const agent = text(raw.agent, `${field}.agent`) as AgentKind;
  if (!providers.includes(provider)) fail(`${field}.provider is unsupported`);
  if (!agents.includes(agent)) fail(`${field}.agent is unsupported`);
  const priority = number(raw.priority, `${field}.priority`);
  const slots = number(raw.slots, `${field}.slots`);
  if (!Number.isInteger(slots) || slots < 1) fail(`${field}.slots must be a positive integer`);
  if (!Array.isArray(raw.windows)) fail(`${field}.windows must be an array`);
  const windows = raw.windows.map((window, position) => parseWindow(window, `${field}.windows[${position}]`));
  const keys = new Set<string>();
  for (const window of windows) {
    if (keys.has(window.key)) fail(`${field}.windows contains duplicate key ${window.key}`);
    keys.add(window.key);
  }
  let command: string[] | undefined;
  if (raw.command !== undefined) {
    if (!Array.isArray(raw.command) || raw.command.length === 0) fail(`${field}.command must be a non-empty string array`);
    command = raw.command.map((part, position) => text(part, `${field}.command[${position}]`));
  }
  const executable = raw.executable === undefined ? undefined : text(raw.executable, `${field}.executable`);
  const baseUrl = raw.baseUrl === undefined ? undefined : text(raw.baseUrl, `${field}.baseUrl`);
  const timeoutMs = raw.timeoutMs === undefined ? undefined : number(raw.timeoutMs, `${field}.timeoutMs`);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
    fail(`${field}.timeoutMs must be an integer of at least 1000`);
  }
  if (agent === 'opencode' && provider === 'magpie' && !baseUrl) {
    fail(`${field}.baseUrl is required for Magpie-routed OpenCode lanes`);
  }
  return {
    id: text(raw.id, `${field}.id`),
    agent,
    model: text(raw.model, `${field}.model`),
    provider,
    account: text(raw.account, `${field}.account`),
    priority,
    slots,
    windows,
    ...(command ? { command } : {}),
    ...(executable ? { executable } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function parseBudget(value: unknown, index: number): BudgetPolicy {
  const field = `budgets[${index}]`;
  const raw = object(value, field);
  const limit = number(raw.limit, `${field}.limit`);
  const reserve = number(raw.reserve, `${field}.reserve`);
  const windowMs = number(raw.windowMs, `${field}.windowMs`);
  const holdPerAttempt = number(raw.holdPerAttempt, `${field}.holdPerAttempt`);
  if (limit < 0) fail(`${field}.limit must be non-negative`);
  if (reserve < 0) fail(`${field}.reserve must be non-negative`);
  if (!Number.isInteger(windowMs) || windowMs < 1000) {
    fail(`${field}.windowMs must be an integer of at least 1000`);
  }
  if (holdPerAttempt < 0) fail(`${field}.holdPerAttempt must be non-negative`);
  if (reserve + holdPerAttempt > limit) {
    fail(`${field}.reserve + holdPerAttempt must not exceed limit`);
  }
  return {
    account: text(raw.account, `${field}.account`),
    unit: text(raw.unit, `${field}.unit`),
    limit,
    reserve,
    windowMs,
    holdPerAttempt,
  };
}

function parseGitHubWebhook(value: unknown): GitHubWebhookConfig {
  const raw = object(value, 'githubWebhook');
  const port = number(raw.port, 'githubWebhook.port');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('githubWebhook.port must be an integer between 1 and 65535');
  }
  const path = text(raw.path, 'githubWebhook.path');
  if (!path.startsWith('/') || path === '/healthz' || path.includes('?') || path.includes('#') || path.length > 256) {
    fail('githubWebhook.path must be an absolute URL path without query or fragment');
  }
  const secretEnv = text(raw.secretEnv, 'githubWebhook.secretEnv');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) {
    fail('githubWebhook.secretEnv must name an environment variable');
  }
  if (raw.fetchGate !== undefined && typeof raw.fetchGate !== 'boolean') {
    fail('githubWebhook.fetchGate must be boolean');
  }
  const tokenEnv = raw.tokenEnv === undefined ? undefined : text(raw.tokenEnv, 'githubWebhook.tokenEnv');
  if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    fail('githubWebhook.tokenEnv must name an environment variable');
  }
  const apiUrl = raw.apiUrl === undefined ? undefined : text(raw.apiUrl, 'githubWebhook.apiUrl');
  if (apiUrl) {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      fail('githubWebhook.apiUrl must be a valid URL');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail('githubWebhook.apiUrl must not contain credentials, query parameters or fragments');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) {
      fail('githubWebhook.apiUrl must use HTTPS or loopback HTTP');
    }
  }
  return {
    host: text(raw.host, 'githubWebhook.host'),
    port,
    path,
    secretEnv,
    ...(raw.fetchGate === undefined ? {} : { fetchGate: raw.fetchGate }),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(apiUrl ? { apiUrl } : {}),
  };
}

function parseGitHubApproval(value: unknown): GitHubApprovalConfig {
  const raw = object(value, 'githubApproval');
  if (typeof raw.allowBotApprovals !== 'boolean') {
    fail('githubApproval.allowBotApprovals must be boolean');
  }
  return { allowBotApprovals: raw.allowBotApprovals };
}

function parseGitHubProject(value: unknown, index: number, root: string): GitHubProjectConfig {
  const field = `githubProjects[${index}]`;
  const raw = object(value, field);
  const repository = text(raw.repository, `${field}.repository`).toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail(`${field}.repository must use the owner/name form`);
  }
  const [owner, name] = repository.split('/');
  if (/^\.+$/.test(owner!) || /^\.+$/.test(name!)) {
    fail(`${field}.repository must use the owner/name form`);
  }
  if (!Array.isArray(raw.branchPrefixes) || raw.branchPrefixes.length === 0) {
    fail(`${field}.branchPrefixes must be a non-empty array`);
  }
  const branchPrefixes = raw.branchPrefixes.map((prefix, position) => {
    const parsed = text(prefix, `${field}.branchPrefixes[${position}]`);
    if (parsed.startsWith('-') || parsed.includes('..') || /[\x00-\x1f\x7f]/.test(parsed)) {
      fail(`${field}.branchPrefixes[${position}] is unsafe`);
    }
    return parsed;
  });
  if (new Set(branchPrefixes).size !== branchPrefixes.length) {
    fail(`${field}.branchPrefixes contains duplicates`);
  }
  const remote = raw.remote === undefined ? undefined : text(raw.remote, `${field}.remote`);
  if (remote && (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith('-'))) {
    fail(`${field}.remote must be a Git remote name`);
  }
  if (raw.allowForks !== undefined && typeof raw.allowForks !== 'boolean') {
    fail(`${field}.allowForks must be boolean`);
  }
  return {
    repository,
    repoPath: resolvePath(root, text(raw.repoPath, `${field}.repoPath`)),
    branchPrefixes,
    ...(remote ? { remote } : {}),
    ...(raw.allowForks === undefined ? {} : { allowForks: raw.allowForks }),
  };
}

export function normalizeConfig(value: unknown, file: string): QuotaFlowConfig {
  const raw = object(value, 'config');
  if (raw.version !== 1) fail('version must be 1');
  const root = dirname(file);
  const routing = object(raw.routing, 'routing');
  if (!Array.isArray(routing.allowedProviders)) fail('routing.allowedProviders must be an array');
  const allowedProviders = routing.allowedProviders.map((provider, index) => {
    const parsed = text(provider, `routing.allowedProviders[${index}]`) as Provider;
    if (!providers.includes(parsed)) fail(`routing.allowedProviders[${index}] is unsupported`);
    return parsed;
  });
  if (new Set(allowedProviders).size !== allowedProviders.length) {
    fail('routing.allowedProviders contains duplicates');
  }

  if (!Array.isArray(raw.lanes)) fail('lanes must be an array');
  const lanes = raw.lanes.map(parseLane);
  const laneIds = new Set<string>();
  for (const lane of lanes) {
    if (laneIds.has(lane.id)) fail(`duplicate lane id ${lane.id}`);
    laneIds.add(lane.id);
    if (!allowedProviders.includes(lane.provider)) {
      fail(`lane ${lane.id} uses disallowed provider ${lane.provider}`);
    }
  }

  let routedModelApproval: QuotaFlowConfig['routing']['routedModelApproval'];
  if (routing.routedModelApproval !== undefined) {
    const approval = object(routing.routedModelApproval, 'routing.routedModelApproval');
    if (typeof approval.allowed !== 'boolean') fail('routing.routedModelApproval.allowed must be boolean');
    routedModelApproval = {
      allowed: approval.allowed,
      approvedBy: text(approval.approvedBy, 'routing.routedModelApproval.approvedBy'),
      approvedAt: text(approval.approvedAt, 'routing.routedModelApproval.approvedAt'),
      ...(approval.note === undefined ? {} : { note: text(approval.note, 'routing.routedModelApproval.note') }),
    };
  }
  if (lanes.some((lane) => lane.provider === 'magpie') && !routedModelApproval?.allowed) {
    fail('Magpie-routed lanes require routing.routedModelApproval.allowed=true');
  }

  let budgets: BudgetPolicy[] = [];
  if (raw.budgets !== undefined) {
    if (!Array.isArray(raw.budgets)) fail('budgets must be an array');
    budgets = raw.budgets.map(parseBudget);
    const accounts = new Set<string>();
    for (const budget of budgets) {
      if (accounts.has(budget.account)) fail(`duplicate budget account ${budget.account}`);
      accounts.add(budget.account);
    }
  }
  const githubWebhook = raw.githubWebhook === undefined ? undefined : parseGitHubWebhook(raw.githubWebhook);
  const githubApproval = raw.githubApproval === undefined ? undefined : parseGitHubApproval(raw.githubApproval);
  let githubProjects: GitHubProjectConfig[] = [];
  if (raw.githubProjects !== undefined) {
    if (!Array.isArray(raw.githubProjects)) fail('githubProjects must be an array');
    githubProjects = raw.githubProjects.map((project, index) => parseGitHubProject(project, index, root));
    const repositories = new Set<string>();
    for (const project of githubProjects) {
      if (repositories.has(project.repository)) fail(`duplicate GitHub project ${project.repository}`);
      repositories.add(project.repository);
    }
  }

  return {
    version: 1,
    database: resolvePath(root, text(raw.database, 'database')),
    worktreeRoot: resolvePath(root, text(raw.worktreeRoot, 'worktreeRoot')),
    ...(raw.defaultRepo === undefined ? {} : { defaultRepo: resolvePath(root, text(raw.defaultRepo, 'defaultRepo')) }),
    routing: { allowedProviders, ...(routedModelApproval ? { routedModelApproval } : {}) },
    ...(githubWebhook ? { githubWebhook } : {}),
    ...(githubApproval ? { githubApproval } : {}),
    budgets,
    githubProjects,
    lanes,
  };
}

export function loadConfig(file = process.env.QUOTAFLOW_CONFIG ?? 'quotaflow.config.json'): QuotaFlowConfig {
  const path = resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown read error';
    throw new Error(`Could not read QuotaFlow config ${path}: ${detail}`);
  }
  return normalizeConfig(parsed, path);
}
