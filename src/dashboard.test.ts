import { expect, test } from 'bun:test';
import { openDatabase } from './db';
import type { QuotaFlowConfig } from './domain';
import { startDashboardServer } from './dashboard';
import { TaskStore } from './store';

function config(): QuotaFlowConfig {
  return {
    version: 1,
    database: ':memory:',
    worktreeRoot: '/tmp/quotaflow-dashboard-worktrees',
    defaultRepo: '/tmp/quotaflow-dashboard-repo',
    routing: { allowedProviders: ['local'] },
    githubWebhook: {
      host: '127.0.0.1',
      port: 8787,
      path: '/github/webhook',
      secretEnv: 'GITHUB_WEBHOOK_SECRET',
      requiredChecks: ['test'],
    },
    githubApp: {
      appId: 123,
      installationId: 456,
      privateKeyPath: '/tmp/not-exposed.pem',
    },
    githubProjects: [
      {
        repository: 'owner/repo',
        repoPath: '/tmp/quotaflow-dashboard-repo',
        branchPrefixes: ['quotaflow/'],
        maxCiRerunsPerHead: 1,
      },
      {
        repository: 'owner/other',
        repoPath: '/tmp/quotaflow-other-repo',
        branchPrefixes: ['quotaflow/'],
      },
    ],
    budgets: [],
    lanes: [{
      id: 'local',
      agent: 'codex',
      model: 'test-model',
      provider: 'local',
      account: 'default',
      priority: 1,
      slots: 1,
      windows: [],
    }],
  };
}

test('dashboard serves a guarded local API, SSE and project filters', async () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const server = startDashboardServer(store, config(), { host: '127.0.0.1', port: 0 });
  try {
    const task = store.createTask({
      id: 'dashboard-task',
      title: 'Inspect dashboard',
      prompt: 'Read-only dashboard fixture',
      repoPath: '/tmp/quotaflow-dashboard-repo',
      workspacePath: '/tmp/quotaflow-dashboard-worktrees/dashboard-task',
      priority: 12,
      now: 100,
    });

    const page = await fetch(new URL('/', server.url));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const pageHtml = await page.text();
    expect(pageHtml).toContain('QuotaFlow Control Plane');
    expect(pageHtml).toContain('最近任务');

    const stylesheet = await fetch(new URL('/assets/app.css', server.url));
    expect(stylesheet.headers.get('content-type')).toContain('text/css');
    expect(await stylesheet.text()).toContain('.sidebar-recent');

    const script = await fetch(new URL('/assets/app.js', server.url));
    expect(script.headers.get('content-type')).toContain('text/javascript');
    const scriptText = await script.text();
    expect(scriptText).toContain("$('#sidebar-recents')");
    expect(scriptText).not.toContain('innerHTML');

    const health = await fetch(new URL('/api/health', server.url));
    expect(await health.json()).toEqual(expect.objectContaining({
      status: 'ok',
      readOnly: false,
      writeActions: ['cancel', 'retry'],
    }));

    const overview = await fetch(new URL('/api/overview', server.url));
    const overviewBody = await overview.json();
    expect(overviewBody).toMatchObject({
      tasks: { total: 1, activeAttempts: 0 },
      latestEventId: 1,
      recentTasks: [{ id: task.id, title: task.title, status: 'queued' }],
    });
    expect(overviewBody.tasks.byStatus.queued).toBe(1);
    expect(overviewBody.repositories.map((repository: { repository: string }) => repository.repository))
      .toEqual(['owner/repo', 'owner/other']);

    const tasks = await fetch(new URL('/api/tasks?status=queued', server.url));
    expect(await tasks.json()).toMatchObject({
      items: [{ id: task.id, priority: 12, accessMode: 'write' }],
    });

    const detail = await fetch(new URL(`/api/tasks/${task.id}`, server.url));
    expect(await detail.json()).toMatchObject({
      task: { id: task.id, prompt: 'Read-only dashboard fixture' },
      attempts: [],
      events: [{ kind: 'task_created' }],
      usage: [],
    });

    const other = store.createTask({
      id: 'other-task',
      title: 'Inspect another repository',
      prompt: 'Other repository fixture',
      repoPath: '/tmp/quotaflow-other-repo',
      workspacePath: '/tmp/quotaflow-dashboard-worktrees/other-task',
      now: 200,
    });

    const filteredTasks = await fetch(new URL('/api/tasks?repository=owner%2Frepo', server.url));
    const filteredTaskBody = await filteredTasks.json();
    expect(filteredTaskBody.items.map((item: { id: string }) => item.id)).toEqual([task.id]);
    expect(filteredTaskBody.items[0].repository).toBe('owner/repo');

    const filteredOverview = await fetch(new URL('/api/overview?repository=owner%2Fother', server.url));
    expect(await filteredOverview.json()).toMatchObject({
      tasks: { total: 1, byStatus: { queued: 1 } },
      recentTasks: [{ id: other.id, repository: 'owner/other' }],
    });

    const eventController = new AbortController();
    const eventResponse = await fetch(
      new URL('/api/events/stream?cursor=0&repository=owner%2Frepo', server.url),
      { signal: eventController.signal },
    );
    expect(eventResponse.headers.get('content-type')).toContain('text/event-stream');
    const reader = eventResponse.body!.getReader();
    const decoder = new TextDecoder();
    let eventText = '';
    while (!eventText.includes('event: events')) {
      const timeout = Bun.sleep(2_000).then(() => {
        throw new Error('Timed out waiting for SSE events');
      });
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      eventText += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    eventController.abort();
    expect(eventText).toContain('"repository":"owner/repo"');
    expect(eventText).not.toContain('"repository":"owner/other"');

    const configResponse = await fetch(new URL('/api/config', server.url));
    const configText = await configResponse.text();
    expect(configText).toContain('"appId":123');
    expect(configText).not.toContain('privateKeyPath');
    expect(configText).not.toContain('not-exposed.pem');

    const missing = await fetch(new URL('/api/tasks/missing', server.url));
    expect(missing.status).toBe(404);
    const invalidStatus = await fetch(new URL('/api/tasks?status=unknown', server.url));
    expect(invalidStatus.status).toBe(400);
    const invalidLimit = await fetch(new URL('/api/github?limit=bad', server.url));
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toEqual({ error: 'invalid_query' });
    const method = await fetch(new URL('/api/tasks', server.url), { method: 'POST' });
    expect(method.status).toBe(405);

    const sessionResponse = await fetch(new URL('/api/session', server.url));
    expect(sessionResponse.status).toBe(200);
    const sessionCookie = sessionResponse.headers.get('set-cookie');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    const session = await sessionResponse.json() as { csrfToken: string };
    expect(session.csrfToken).toHaveLength(64);
    const cookie = sessionCookie!.split(';')[0]!;
    const action = async (
      taskId: string,
      requestId: string,
      overrides: {
        action?: string;
        confirmTaskId?: string;
        origin?: string;
        csrf?: string;
        cookie?: string;
      } = {},
    ) => fetch(new URL(`/api/tasks/${taskId}/actions`, server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: overrides.origin ?? server.url.origin,
        cookie: overrides.cookie ?? cookie,
        'x-quotaflow-csrf': overrides.csrf ?? session.csrfToken,
      },
      body: JSON.stringify({
        action: overrides.action ?? 'cancel',
        confirmTaskId: overrides.confirmTaskId ?? taskId,
        requestId,
      }),
    });

    const unauthorized = await fetch(new URL(`/api/tasks/${task.id}/actions`, server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.url.origin,
      },
      body: JSON.stringify({ action: 'cancel', confirmTaskId: task.id, requestId: 'request-no-session' }),
    });
    expect(unauthorized.status).toBe(401);
    const badCsrf = await action(task.id, 'request-bad-csrf', { csrf: 'b'.repeat(64) });
    expect(badCsrf.status).toBe(403);
    expect(await badCsrf.json()).toEqual({ error: 'csrf_rejected' });
    const badOrigin = await action(task.id, 'request-bad-origin', { origin: 'https://example.test' });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toEqual({ error: 'origin_rejected' });
    const badConfirmation = await action(task.id, 'request-bad-confirm', { confirmTaskId: 'other-task' });
    expect(badConfirmation.status).toBe(403);
    expect(await badConfirmation.json()).toEqual({ error: 'confirmation_rejected' });

    const cancelled = await action(task.id, 'request-cancel-1');
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({
      status: 'accepted',
      action: 'cancel',
      task: { id: task.id, status: 'cancelled' },
    });
    const replayed = await action(task.id, 'request-cancel-1');
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({
      status: 'replayed',
      task: { id: task.id, status: 'cancelled' },
    });
    expect(store.events(task.id).filter((event) => event.kind === 'dashboard_action')).toHaveLength(1);

    store.block(other.id, 'fixture_blocked', 300);
    const retried = await action(other.id, 'request-retry-1', {
      action: 'retry',
      confirmTaskId: other.id,
    });
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({
      status: 'accepted',
      action: 'retry',
      task: { id: other.id, status: 'queued' },
    });
  } finally {
    server.stop(true);
    db.close();
  }
});

test('dashboard refuses non-loopback binding', () => {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  try {
    expect(() => startDashboardServer(store, config(), { host: '0.0.0.0', port: 0 }))
      .toThrow('loopback');
  } finally {
    db.close();
  }
});
