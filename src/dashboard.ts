import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TASK_STATUSES, type QuotaFlowConfig, type Task } from './domain';
import type { TaskStore } from './store';
import { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-assets';

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  sessionTtlMs?: number;
  workerStarter?: DashboardWorkerStarter;
}

export interface DashboardWorkerStart {
  pid: number;
  exited?: Promise<number>;
}

export type DashboardWorkerStarter = (input: {
  taskId: string;
  requestId: string;
}) => Promise<DashboardWorkerStart> | DashboardWorkerStart;

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      ...securityHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

interface DashboardSession {
  csrfToken: string;
  expiresAt: number;
}

class DashboardSessions {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, DashboardSession>();

  constructor(ttlMs: number, now: () => number) {
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) {
      throw new Error('Dashboard session TTL must be between 1 minute and 24 hours');
    }
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  create(): { id: string; session: DashboardSession } {
    this.cleanup();
    const id = randomBytes(32).toString('hex');
    const session = {
      csrfToken: randomBytes(32).toString('hex'),
      expiresAt: this.#now() + this.#ttlMs,
    };
    this.#sessions.set(id, session);
    return { id, session };
  }

  get(id: string | null): DashboardSession | null {
    this.cleanup();
    if (!id) return null;
    const session = this.#sessions.get(id);
    if (!session || session.expiresAt <= this.#now()) {
      this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  cleanup(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

const sessionCookie = 'quotaflow_dashboard_session';

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  const value = request.headers.get('cookie');
  if (!value) return result;
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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

function repositoryForPath(config: QuotaFlowConfig, value: string): string {
  const repoPath = value.replace(/\/+$/, '');
  return (config.githubProjects ?? []).find((project) =>
    project.repoPath.replace(/\/+$/, '') === repoPath)?.repository ?? value;
}

function repositoryForTask(config: QuotaFlowConfig, task: Task): string {
  return repositoryForPath(config, task.repoPath);
}

function taskSummary(task: Task, config: QuotaFlowConfig) {
  return {
    id: task.id,
    title: task.title,
    repository: repositoryForTask(config, task),
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

function eventSummary(store: TaskStore, tasks: Task[], config: QuotaFlowConfig) {
  return tasks
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 30)
    .flatMap((task) => store.events(task.id).slice(-4).map((event) => ({
      id: event.id,
      taskId: task.id,
      taskTitle: task.title,
      repository: repositoryForTask(config, task),
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

function overview(store: TaskStore, config: QuotaFlowConfig, repository?: string) {
  const safeConfig = sanitizedConfig(config);
  const tasks = store.listTasks()
    .filter((task) => !repository || repositoryForTask(config, task) === repository);
  const gates = store.listRecentGitHubGates(200)
    .filter((gate) => !repository || gate.repository === repository);
  const reruns = store.listRecentGitHubCiReruns(200)
    .filter((rerun) => !repository || rerun.repository === repository);
  const events = eventSummary(store, tasks, config);
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
      .map((task) => taskSummary(task, config)),
    recentEvents: events,
    latestEventId: store.latestEventId(),
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

function githubData(store: TaskStore, url: URL, repository?: string) {
  const limit = integer(url.searchParams.get('limit'), 'limit', 100, 1, 500);
  return {
    generatedAt: Date.now(),
    gates: store.listRecentGitHubGates(limit)
      .filter((gate) => !repository || gate.repository === repository)
      .map((gate) => ({
        repository: gate.repository,
        pullNumber: gate.pullNumber,
        headSha: gate.headSha,
        policyHash: gate.policyHash,
        status: gate.evaluation.status,
        evaluation: gate.evaluation,
        createdAt: gate.createdAt,
        updatedAt: gate.updatedAt,
      })),
    reruns: store.listRecentGitHubCiReruns(limit)
      .filter((rerun) => !repository || rerun.repository === repository),
  };
}

function repositoryFilter(url: URL): string | undefined {
  const value = url.searchParams.get('repository')?.trim();
  if (!value) return undefined;
  if (value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('repository filter is invalid');
  }
  return value;
}

function eventStream(
  store: TaskStore,
  config: QuotaFlowConfig,
  request: Request,
  url: URL,
): Response {
  const repository = repositoryFilter(url);
  const cursorValue = url.searchParams.get('cursor') ?? request.headers.get('last-event-id');
  let cursor = cursorValue === null
    ? store.latestEventId()
    : Number(cursorValue);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return json({ error: 'invalid_cursor' }, 400);
  }
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        const lines = [
          'retry: 3000',
          ...(id === undefined ? [] : [`id: ${id}`]),
          `event: ${event}`,
          `data: ${JSON.stringify(data)}`,
          '',
          '',
        ];
        controller.enqueue(encoder.encode(lines.join('\n')));
      };
      const stop = (close = false) => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);
        if (close) {
          try {
            controller.close();
          } catch {
            // The client may close the stream between the abort signal and cleanup.
          }
        }
      };
      const flush = () => {
        if (closed) return;
        try {
          const scanned = store.eventsAfter(cursor, 250);
          if (scanned.length === 0) return;
          cursor = scanned.at(-1)!.id;
          const rows = scanned
            .filter((event) => !repository || repositoryForPath(config, event.taskRepoPath) === repository);
          if (rows.length === 0) return;
          const totalIds = rows.map((event) => event.id);
          const tasks = new Map<string, ReturnType<typeof taskSummary>>();
          send('events', rows.map((event) => ({
            id: event.id,
            taskId: event.taskId,
            taskTitle: event.taskTitle,
            taskStatus: event.taskStatus,
            repository: repositoryForPath(config, event.taskRepoPath),
            repoPath: event.taskRepoPath,
            task: (() => {
              let task = tasks.get(event.taskId);
              if (!task) {
                task = taskSummary(store.getTask(event.taskId), config);
                tasks.set(event.taskId, task);
              }
              return task;
            })(),
            kind: event.kind,
            detail: event.detail,
            createdAt: event.createdAt,
          })), Math.max(...totalIds));
        } catch {
          send('stream_error', { message: 'Event stream unavailable' });
          stop(true);
        }
      };

      send('ready', { cursor, repository: repository ?? null });
      if (cursorValue !== null) flush();
      timer = setInterval(flush, 1000);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          stop();
        }
      }, 15_000);
      request.signal.addEventListener('abort', () => stop(true), { once: true });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      ...securityHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function sessionResponse(
  request: Request,
  sessions: DashboardSessions,
  actions: string[],
): Response {
  const currentId = cookies(request).get(sessionCookie) ?? null;
  let id = currentId;
  let session = sessions.get(id);
  let setCookie: Record<string, string> = {};
  if (!session) {
    const created = sessions.create();
    id = created.id;
    session = created.session;
    setCookie = {
      'Set-Cookie': [
        `${sessionCookie}=${id}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(sessions.ttlMs / 1000)}`,
      ].join('; '),
    };
  }
  return json({
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    actor: 'local-dashboard',
    actions,
  }, 200, setCookie);
}

async function dashboardTaskAction(
  store: TaskStore,
  config: QuotaFlowConfig,
  request: Request,
  url: URL,
  sessions: DashboardSessions,
  workerStarter: DashboardWorkerStarter | undefined,
): Promise<Response> {
  if (request.headers.get('origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
  const session = sessions.get(cookies(request).get(sessionCookie) ?? null);
  if (!session) return json({ error: 'session_required' }, 401);
  const csrf = request.headers.get('x-quotaflow-csrf');
  if (!csrf || !sameSecret(session.csrfToken, csrf)) return json({ error: 'csrf_rejected' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: 'content_type_required' }, 415);
  }
  const bodyText = await request.text();
  if (bodyText.length > 4096) return json({ error: 'payload_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const match = /^\/api\/tasks\/([^/]+)\/actions$/.exec(url.pathname);
  if (!match) return json({ error: 'not_found' }, 404);
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]!);
  } catch {
    return json({ error: 'invalid_task_id' }, 400);
  }
  const action = body.action;
  if (action !== 'cancel' && action !== 'retry' && action !== 'start') {
    return json({ error: 'invalid_action' }, 400);
  }
  if (body.confirmTaskId !== taskId) return json({ error: 'confirmation_rejected' }, 403);
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(body.requestId)) {
    return json({ error: 'invalid_request_id' }, 400);
  }
  if (!store.findTask(taskId)) return json({ error: 'task_not_found' }, 404);
  if (action === 'start' && !workerStarter) return json({ error: 'worker_unavailable' }, 503);
  try {
    const result = store.performDashboardTaskAction({
      taskId,
      action,
      actor: 'local-dashboard',
      requestId: body.requestId,
    });
    let workerPid: number | null = null;
    if (action === 'start' && !result.replayed) {
      try {
        const worker = await workerStarter!({
          taskId,
          requestId: body.requestId,
        });
        workerPid = worker.pid;
        store.recordDashboardWorkerEvent({
          taskId,
          requestId: body.requestId,
          outcome: 'started',
          pid: worker.pid,
        });
        if (worker.exited) {
          void worker.exited
            .then((exitCode) => store.recordDashboardWorkerEvent({
              taskId,
              requestId: body.requestId,
              outcome: 'exited',
              pid: worker.pid,
              exitCode,
            }))
            .catch((error) => store.recordDashboardWorkerEvent({
              taskId,
              requestId: body.requestId,
              outcome: 'exited',
              pid: worker.pid,
              error: error instanceof Error ? error.message : 'Worker exit status unavailable',
            }));
        }
      } catch (error) {
        store.recordDashboardWorkerEvent({
          taskId,
          requestId: body.requestId,
          outcome: 'spawn_failed',
          error: error instanceof Error ? error.message : 'Worker spawn failed',
        });
        return json({ error: 'worker_start_failed' }, 502);
      }
    }
    return json({
      status: result.replayed ? 'replayed' : 'accepted',
      action,
      task: taskSummary(result.task, config),
      requestId: body.requestId,
      ...(action === 'start' ? { workerPid } : {}),
    }, result.replayed ? 200 : 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Dashboard action failed';
    if (
      message.includes('cannot be retried')
      || message.includes('cannot be cancelled')
      || message.includes('active attempt')
      || message.includes('attempt limit')
      || message.includes('cannot be started')
      || message.includes('is not due')
      || message.includes('reused with different content')
    ) {
      return json({ error: 'action_conflict', message }, 409);
    }
    return json({ error: 'action_failed' }, 500);
  }
}

function dashboardHandler(
  store: TaskStore,
  config: QuotaFlowConfig,
  sessions: DashboardSessions,
  workerStarter: DashboardWorkerStarter | undefined,
) {
  const writeActions = ['cancel', 'retry', ...(workerStarter ? ['start'] : [])];
  const route = async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.startsWith('/api/tasks/')) {
      return dashboardTaskAction(store, config, request, url, sessions, workerStarter);
    }
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.pathname === '/') return asset(dashboardHtml, 'text/html; charset=utf-8');
    if (url.pathname === '/assets/app.css') return asset(dashboardCss, 'text/css; charset=utf-8');
    if (url.pathname === '/assets/app.js') return asset(dashboardJs, 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/health') {
      return json({
        status: 'ok',
        generatedAt: Date.now(),
        readOnly: false,
        writeActions,
      });
    }
    if (url.pathname === '/api/session') return sessionResponse(request, sessions, writeActions);
    if (url.pathname === '/api/overview') {
      return json(overview(store, config, repositoryFilter(url)));
    }
    if (url.pathname === '/api/events/stream') {
      return eventStream(store, config, request, url);
    }
    if (url.pathname === '/api/config') return json(sanitizedConfig(config));
    if (url.pathname === '/api/tasks') {
      const status = url.searchParams.get('status');
      if (status && !TASK_STATUSES.includes(status as typeof TASK_STATUSES[number])) {
        return json({ error: 'invalid_status' }, 400);
      }
      const repository = repositoryFilter(url);
      const items = store.listTasks(status as typeof TASK_STATUSES[number] | undefined)
        .filter((task) => !repository || repositoryForTask(config, task) === repository)
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((task) => taskSummary(task, config));
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
    if (url.pathname === '/api/github') return json(githubData(store, url, repositoryFilter(url)));
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
  const sessions = new DashboardSessions(options.sessionTtlMs ?? 28_800_000, Date.now);
  return Bun.serve({
    hostname: host,
    port,
    fetch: dashboardHandler(store, config, sessions, options.workerStarter),
  });
}
