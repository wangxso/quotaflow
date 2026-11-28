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
    githubProjects: [{
      repository: 'owner/repo',
      repoPath: '/tmp/quotaflow-dashboard-repo',
      branchPrefixes: ['quotaflow/'],
      maxCiRerunsPerHead: 1,
    }],
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

test('dashboard serves a read-only local API and security headers', async () => {
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
    expect(await health.json()).toEqual(expect.objectContaining({ status: 'ok', readOnly: true }));

    const overview = await fetch(new URL('/api/overview', server.url));
    expect(await overview.json()).toMatchObject({
      tasks: {
        total: 1,
        byStatus: { queued: 1 },
        activeAttempts: 0,
      },
      repositories: [{ repository: 'owner/repo', branchPrefixes: ['quotaflow/'] }],
      recentTasks: [{ id: task.id, title: task.title, status: 'queued' }],
    });

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
