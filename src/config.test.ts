import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, normalizeConfig } from './config';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'quotaflow-config-'));
}

test('resolves paths and accepts explicitly approved Magpie routing', () => {
  const root = workspace();
  try {
    const file = join(root, 'quotaflow.config.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      database: '.quotaflow/state.sqlite',
      worktreeRoot: '.quotaflow/worktrees',
      defaultRepo: '.',
      routing: {
        allowedProviders: ['magpie', 'native'],
        routedModelApproval: {
          allowed: true,
          approvedBy: 'project-owner',
          approvedAt: '2026-11-27',
        },
      },
      lanes: [{
        id: 'codex-magpie',
        agent: 'codex',
        model: 'opencode-go/deepseek-v4.1-flash',
        provider: 'magpie',
        account: 'magpie-default',
        priority: 10,
        slots: 1,
        windows: [],
      }],
    }));
    const config = loadConfig(file);
    expect(config.database).toBe(join(root, '.quotaflow', 'state.sqlite'));
    expect(config.worktreeRoot).toBe(join(root, '.quotaflow', 'worktrees'));
    expect(config.defaultRepo).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects Magpie routing without an explicit approval', () => {
  expect(() => normalizeConfig({
    version: 1,
    database: 'state.sqlite',
    worktreeRoot: 'worktrees',
    routing: { allowedProviders: ['magpie'] },
    lanes: [{
      id: 'codex-magpie',
      agent: 'codex',
      model: 'routed-model',
      provider: 'magpie',
      account: 'magpie-default',
      priority: 1,
      slots: 1,
      windows: [],
    }],
  }, join(tmpdir(), 'quotaflow.config.json'))).toThrow('routedModelApproval');
});

test('requires an explicit endpoint for Magpie-routed OpenCode lanes', () => {
  expect(() => normalizeConfig({
    version: 1,
    database: 'state.sqlite',
    worktreeRoot: 'worktrees',
    routing: {
      allowedProviders: ['magpie'],
      routedModelApproval: {
        allowed: true,
        approvedBy: 'project-owner',
        approvedAt: '2026-11-27',
      },
    },
    lanes: [{
      id: 'opencode-magpie',
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      provider: 'magpie',
      account: 'magpie-default',
      priority: 1,
      slots: 1,
      windows: [],
    }],
  }, join(tmpdir(), 'quotaflow.config.json'))).toThrow('baseUrl');
});

test('parses gateway-estimate budgets and rejects ambiguous policies', () => {
  const base = {
    version: 1,
    database: 'state.sqlite',
    worktreeRoot: 'worktrees',
    routing: { allowedProviders: ['magpie'] as const },
    budgets: [{
      account: 'magpie-default',
      unit: 'magpie-cost-estimate',
      limit: 10,
      reserve: 0.5,
      windowMs: 86_400_000,
      holdPerAttempt: 0.25,
    }],
    lanes: [],
  };
  const config = normalizeConfig(base, join(tmpdir(), 'quotaflow.config.json'));
  expect(config.budgets).toEqual(base.budgets);
  expect(() => normalizeConfig({
    ...base,
    budgets: [base.budgets[0], base.budgets[0]],
  }, join(tmpdir(), 'quotaflow.config.json'))).toThrow('duplicate budget account');
  expect(() => normalizeConfig({
    ...base,
    budgets: [{ ...base.budgets[0], reserve: 10 }],
  }, join(tmpdir(), 'quotaflow.config.json'))).toThrow('reserve + holdPerAttempt');
});

test('rejects disallowed providers and duplicate lanes', () => {
  const base = {
    version: 1,
    database: 'state.sqlite',
    worktreeRoot: 'worktrees',
    routing: { allowedProviders: ['native'] },
    lanes: [{
      id: 'local-a',
      agent: 'opencode',
      model: 'local',
      provider: 'native',
      account: 'native-default',
      priority: 1,
      slots: 1,
      windows: [],
    }],
  };
  expect(() => normalizeConfig({ ...base, routing: { allowedProviders: ['native'] }, lanes: [{
    ...base.lanes[0],
    provider: 'local',
  }] }, join(tmpdir(), 'quotaflow.config.json'))).toThrow('disallowed provider');
  expect(() => normalizeConfig({ ...base, lanes: [base.lanes[0], base.lanes[0]] }, join(tmpdir(), 'quotaflow.config.json')))
    .toThrow('duplicate lane');
});

test('parses and validates GitHub webhook configuration', () => {
  const base = {
    version: 1,
    database: 'state.sqlite',
    worktreeRoot: 'worktrees',
    routing: { allowedProviders: ['native'] },
    githubWebhook: {
      host: '127.0.0.1',
      port: 8787,
      path: '/github/webhook',
      secretEnv: 'GITHUB_WEBHOOK_SECRET',
    },
    githubApproval: {
      allowBotApprovals: true,
    },
    lanes: [],
  };
  const parsed = normalizeConfig(base, join(tmpdir(), 'quotaflow.config.json'));
  expect(parsed.githubWebhook).toEqual(base.githubWebhook);
  expect(parsed.githubApproval).toEqual(base.githubApproval);
  expect(() => normalizeConfig({ ...base, githubWebhook: { ...base.githubWebhook, port: 0 } },
    join(tmpdir(), 'quotaflow.config.json'))).toThrow('githubWebhook.port');
  expect(() => normalizeConfig({ ...base, githubWebhook: { ...base.githubWebhook, path: '/hooks?secret=1' } },
    join(tmpdir(), 'quotaflow.config.json'))).toThrow('githubWebhook.path');
  expect(() => normalizeConfig({ ...base, githubWebhook: { ...base.githubWebhook, secretEnv: 'bad-name' } },
    join(tmpdir(), 'quotaflow.config.json'))).toThrow('githubWebhook.secretEnv');
  expect(() => normalizeConfig({ ...base, githubApproval: { allowBotApprovals: 'yes' } },
    join(tmpdir(), 'quotaflow.config.json'))).toThrow('githubApproval.allowBotApprovals');
});
