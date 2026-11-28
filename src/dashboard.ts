import { TASK_STATUSES, type QuotaFlowConfig, type Task } from './domain';
import type { TaskStore } from './store';
import { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-assets';

export interface DashboardServerOptions {
  host?: string;
  port?: number;
}

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      ...securityHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function asset(value: string, contentType: string): Response {
  return new Response(value, {
    headers: {
      ...securityHeaders,
      'Content-Type': contentType,
    },
  });
}

function integer(value: string | null, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function taskSummary(task: Task) {
  return {
    id: task.id,
    title: task.title,
    repoPath: task.repoPath,
    workspacePath: task.workspacePath,
    status: task.status,
    priority: task.priority,
    critical: task.critical,
    accessMode: task.accessMode,
    checkpoint: task.checkpoint,
    nextWakeAt: task.nextWakeAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function eventSummary(store: TaskStore, tasks: Task[]) {
  return tasks
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 30)
    .flatMap((task) => store.events(task.id).slice(-4).map((event) => ({
      id: event.id,
      taskId: task.id,
      taskTitle: task.title,
      kind: event.kind,
      detail: event.detail,
      createdAt: event.createdAt,
    })))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 40);
}

function taskCounts(tasks: Task[]) {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<string, number>;
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  return byStatus;
}

function sanitizedConfig(config: QuotaFlowConfig) {
  return {
    database: config.database,
    worktreeRoot: config.worktreeRoot,
    defaultRepo: config.defaultRepo ?? null,
    githubWebhook: config.githubWebhook
      ? {
        host: config.githubWebhook.host,
        port: config.githubWebhook.port,
        path: config.githubWebhook.path,
        fetchGate: config.githubWebhook.fetchGate ?? true,
        requiredChecks: config.githubWebhook.requiredChecks ?? null,
      }
      : null,
    githubApp: config.githubApp ? { appId: config.githubApp.appId } : null,
    repositories: (config.githubProjects ?? []).map((project) => ({
      repository: project.repository,
      branchPrefixes: project.branchPrefixes,
      allowForks: project.allowForks ?? false,
      maxCiRerunsPerHead: project.maxCiRerunsPerHead ?? 1,
    })),
    laneCount: config.lanes.length,
    budgetPolicyCount: (config.budgets ?? []).length,
  };
}

function overview(store: TaskStore, config: QuotaFlowConfig) {
  const safeConfig = sanitizedConfig(config);
  const tasks = store.listTasks();
  const gates = store.listRecentGitHubGates(200);
  const reruns = store.listRecentGitHubCiReruns(200);
  const events = eventSummary(store, tasks);
  return {
    generatedAt: Date.now(),
    tasks: {
      total: tasks.length,
      byStatus: taskCounts(tasks),
      activeAttempts: store.activeAttempts().length,
    },
    github: {
      gates: gates.length,
      blockedGates: gates.filter((gate) => gate.evaluation.status === 'blocked').length,
      readyGates: gates.filter((gate) => gate.evaluation.status === 'ready_for_human_merge').length,
      reruns: reruns.length,
      requestedReruns: reruns.filter((rerun) => rerun.state === 'requested').length,
    },
    budgets: store.budgetStatus(config.budgets ?? []),
    recentTasks: tasks
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 12)
      .map(taskSummary),
    recentEvents: events,
    repositories: safeConfig.repositories,
    lanes: config.lanes.map((lane) => ({
      id: lane.id,
      agent: lane.agent,
      model: lane.model,
      provider: lane.provider,
      account: lane.account,
      slots: lane.slots,
      priority: lane.priority,
    })),
  };
}

function githubData(store: TaskStore, url: URL) {
  const limit = integer(url.searchParams.get('limit'), 'limit', 100, 1, 500);
  return {
    generatedAt: Date.now(),
    gates: store.listRecentGitHubGates(limit).map((gate) => ({
      repository: gate.repository,
      pullNumber: gate.pullNumber,
      headSha: gate.headSha,
      policyHash: gate.policyHash,
      status: gate.evaluation.status,
      evaluation: gate.evaluation,
      createdAt: gate.createdAt,
      updatedAt: gate.updatedAt,
    })),
    reruns: store.listRecentGitHubCiReruns(limit),
  };
}

function dashboardHandler(store: TaskStore, config: QuotaFlowConfig) {
  const route = async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.pathname === '/') return asset(dashboardHtml, 'text/html; charset=utf-8');
    if (url.pathname === '/assets/app.css') return asset(dashboardCss, 'text/css; charset=utf-8');
    if (url.pathname === '/assets/app.js') return asset(dashboardJs, 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/health') {
      return json({ status: 'ok', generatedAt: Date.now(), readOnly: true });
    }
    if (url.pathname === '/api/overview') return json(overview(store, config));
    if (url.pathname === '/api/config') return json(sanitizedConfig(config));
    if (url.pathname === '/api/tasks') {
      const status = url.searchParams.get('status');
      if (status && !TASK_STATUSES.includes(status as typeof TASK_STATUSES[number])) {
        return json({ error: 'invalid_status' }, 400);
      }
      const items = store.listTasks(status as typeof TASK_STATUSES[number] | undefined)
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(taskSummary);
      return json({ generatedAt: Date.now(), items });
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(taskMatch[1]!);
      } catch {
        return json({ error: 'invalid_task_id' }, 400);
      }
      const task = store.findTask(taskId);
      if (!task) return json({ error: 'task_not_found' }, 404);
      return json({
        generatedAt: Date.now(),
        task,
        attempts: store.attempts(task.id),
        events: store.events(task.id),
        usage: store.usageForTask(task.id),
        budgetLeases: store.budgetLeasesForTask(task.id),
        handoffNote: task.handoff ? store.handoffForCheckpoint(task.id, task.checkpoint) : null,
      });
    }
    if (url.pathname === '/api/github') return json(githubData(store, url));
    if (url.pathname === '/api/budgets') {
      return json({
        generatedAt: Date.now(),
        policies: store.budgetStatus(config.budgets ?? []),
        lanes: config.lanes.map((lane) => ({
          id: lane.id,
          agent: lane.agent,
          model: lane.model,
          provider: lane.provider,
          account: lane.account,
          slots: lane.slots,
          priority: lane.priority,
          windows: lane.windows,
        })),
      });
    }
    return json({ error: 'not_found' }, 404);
  };
  return async function handle(request: Request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const invalidQuery = message.includes('must be an integer between');
      return json({ error: invalidQuery ? 'invalid_query' : 'internal_error' }, invalidQuery ? 400 : 500);
    }
  };
}

function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function startDashboardServer(
  store: TaskStore,
  config: QuotaFlowConfig,
  options: DashboardServerOptions = {},
) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8788;
  if (!loopback(host)) throw new Error('Dashboard host must be a loopback address');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Dashboard port must be an integer between 0 and 65535');
  }
  return Bun.serve({
    hostname: host,
    port,
    fetch: dashboardHandler(store, config),
  });
}
