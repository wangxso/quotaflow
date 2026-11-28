#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config';
import { agentForLane } from './agent-factory';
import { openDatabase } from './db';
import { TASK_STATUSES, type TaskStatus } from './domain';
import { reserveNext } from './scheduler';
import { TaskStore } from './store';
import { runOnce } from './worker';
import { recoverInterruptedAttempts } from './recovery';
import { waitForCancellation } from './cancellation';
import { ensureWorktree } from './worktree';
import {
  githubEventKey,
  hashGitHubPayload,
  normalizeGitHubWebhook,
  parseGitHubPullSnapshot,
  planGitHubActions,
  verifyGitHubWebhookSignature,
} from './github';
import { fetchGitHubPullSnapshot } from './github-api';
import { GitHubAppTokenProvider } from './github-app-auth';
import { triageGitHubChecks } from './github-ci';
import { startGitHubWebhookServer } from './github-webhook-server';
import { materializeGitHubWebhookActions } from './github-webhook-actions';
import { materializeGitHubActions } from './github-materialize';

const usage = `
quotaflow config validate [--config <file>]
quotaflow task add <title> [--prompt <text>] [--repo <path>] [--workspace <path>] [--priority <n>] [--critical] [--read-only] [--handoff] [--handoff-protect <path>]... [--config <file>]
quotaflow task list [--status <status>] [--config <file>]
quotaflow task show <id> [--config <file>]
quotaflow task events <id> [--config <file>]
quotaflow task cancel <id> [--wait <ms>] [--force] [--config <file>]
quotaflow task retry <id> [--config <file>]
quotaflow task prepare <id> [--config <file>]
quotaflow queue next [--config <file>]
quotaflow worker once [--config <file>]
quotaflow worker recover [--config <file>]
quotaflow budget status [--config <file>]
quotaflow budget audit [--limit <n>] [--config <file>]
quotaflow github snapshot --repo <owner/repo> --pull-number <n> [--token-env <name>] [--api-url <url>] [--config <file>]
quotaflow github gate <snapshot.json> [--delivery-id <id>] [--event-type <type>] [--expected-head <sha>] [--expected-base <sha>] [--require-check <name>]... [--required-approvals <n>] [--allow-author-self-approval] [--allow-bot-approvals] [--materialize <repo>] [--config <file>]
quotaflow github webhook <payload.json> --event <type> --delivery-id <id> --signature <sha256=...> [--secret-env GITHUB_WEBHOOK_SECRET] [--config <file>]
quotaflow github serve-webhook [--host <host>] [--port <n>] [--path <path>] [--secret-env <name>] [--config <file>]
`.trim();

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function requireTaskId(args: string[]): string {
  const id = args[0];
  if (!id || id.startsWith('--')) throw new Error('Expected a task ID');
  return id;
}

function taskStatus(value?: string): TaskStatus | undefined {
  if (!value) return undefined;
  if (!TASK_STATUSES.includes(value as TaskStatus)) throw new Error(`Unknown task status ${value}`);
  return value as TaskStatus;
}

function printTasks(store: TaskStore, status?: TaskStatus) {
  const tasks = store.listTasks(status);
  if (tasks.length === 0) {
    console.log('no tasks');
    return;
  }
  for (const task of tasks) {
    console.log([task.id, task.status, task.priority, task.critical ? 'critical' : '-', task.title].join('\t'));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = option(args, '--config') ?? process.env.QUOTAFLOW_CONFIG ?? 'quotaflow.config.json';
  const [scope, action, ...rest] = args;
  if (!scope || scope === 'help' || scope === '--help') {
    console.log(usage);
    return;
  }

  const config = loadConfig(configPath);
  const githubAppTokens = config.githubApp ? new GitHubAppTokenProvider(config.githubApp) : undefined;
  if (scope === 'config' && action === 'validate') {
    console.log(JSON.stringify({
      config: configPath,
      database: config.database,
      worktreeRoot: config.worktreeRoot,
      allowedProviders: config.routing.allowedProviders,
      routedModelApproval: config.routing.routedModelApproval ?? null,
      githubWebhook: config.githubWebhook ?? null,
      githubApproval: config.githubApproval ?? { allowBotApprovals: false },
      githubApp: config.githubApp ?? null,
      githubProjects: config.githubProjects ?? [],
      budgets: config.budgets ?? [],
      lanes: config.lanes.map((lane) => ({
        id: lane.id,
        agent: lane.agent,
        model: lane.model,
        provider: lane.provider,
        ...(lane.baseUrl ? { baseUrl: lane.baseUrl } : {}),
      })),
    }, null, 2));
    return;
  }

  const db = openDatabase(config.database);
  const store = new TaskStore(db);
  try {
    if (scope === 'task' && action === 'add') {
      const repoPath = option(rest, '--repo') ?? config.defaultRepo;
      if (!repoPath) throw new Error('Expected --repo or defaultRepo in config');
      const id = option(rest, '--id') ?? `qf-${randomUUID().slice(0, 8)}`;
      const workspacePath = option(rest, '--workspace') ?? join(config.worktreeRoot, id);
      const promptOption = option(rest, '--prompt');
      const priorityText = option(rest, '--priority') ?? '0';
      const priority = Number(priorityText);
      if (!Number.isFinite(priority)) throw new Error('--priority must be a finite number');
      const critical = flag(rest, '--critical');
      const accessMode = flag(rest, '--read-only') ? 'read_only' : 'write';
      const protectedPaths: string[] = [];
      for (let path = option(rest, '--handoff-protect'); path !== undefined; path = option(rest, '--handoff-protect')) {
        protectedPaths.push(path);
      }
      const handoff = flag(rest, '--handoff') || protectedPaths.length > 0 ? { protectedPaths } : undefined;
      const title = option(rest, '--title') ?? rest.join(' ').trim();
      if (!title) throw new Error('Expected a task title');
      const prompt = promptOption ?? title;
      const task = store.createTask({
        id,
        title,
        prompt,
        repoPath,
        workspacePath,
        priority,
        critical,
        accessMode,
        handoff,
      });
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    if (scope === 'task' && action === 'list') {
      printTasks(store, taskStatus(option(rest, '--status')));
      return;
    }

    if (scope === 'task' && action === 'show') {
      const task = store.getTask(requireTaskId(rest));
      console.log(JSON.stringify({
        task,
        attempts: store.attempts(task.id),
        usage: store.usageForTask(task.id),
        budgetLeases: store.budgetLeasesForTask(task.id),
        ...(task.handoff ? { handoffNote: store.handoffForCheckpoint(task.id, task.checkpoint) } : {}),
      }, null, 2));
      return;
    }

    if (scope === 'task' && action === 'events') {
      console.log(JSON.stringify(store.events(requireTaskId(rest)), null, 2));
      return;
    }

    if (scope === 'task' && action === 'cancel') {
      const id = requireTaskId(rest);
      const waitText = option(rest, '--wait');
      const force = flag(rest, '--force');
      if (waitText === undefined && !force) {
        console.log(JSON.stringify(store.cancel(id), null, 2));
        return;
      }
      const waitMs = waitText === undefined ? 10_000 : Number(waitText);
      if (!Number.isInteger(waitMs) || waitMs < 0) throw new Error('--wait must be a non-negative integer');
      const result = await waitForCancellation(store, config, id, { waitMs, force });
      console.log(JSON.stringify(result, null, 2));
      if (result.cancellation.outcome !== 'cancelled') process.exitCode = 2;
      return;
    }

    if (scope === 'task' && action === 'retry') {
      console.log(JSON.stringify(store.retry(requireTaskId(rest)), null, 2));
      return;
    }

    if (scope === 'task' && action === 'prepare') {
      const task = store.getTask(requireTaskId(rest));
      const workspacePath = ensureWorktree(task.repoPath, task.workspacePath, task.checkpoint ?? 'HEAD');
      console.log(JSON.stringify({ ...task, workspacePath }, null, 2));
      return;
    }

    if (scope === 'queue' && action === 'next') {
      const reservation = reserveNext(store, config.lanes, Date.now(), config.budgets);
      console.log(JSON.stringify(reservation ?? { status: 'idle' }, null, 2));
      return;
    }

    if (scope === 'budget' && action === 'status') {
      console.log(JSON.stringify(store.budgetStatus(config.budgets ?? []), null, 2));
      return;
    }

    if (scope === 'budget' && action === 'audit') {
      const limitText = option(rest, '--limit') ?? '100';
      const limit = Number(limitText);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
      console.log(JSON.stringify(store.budgetAudit(config.budgets ?? [], Date.now(), limit), null, 2));
      return;
    }

    if (scope === 'github' && action === 'gate') {
      const snapshotFile = rest.shift();
      if (!snapshotFile || snapshotFile.startsWith('--')) throw new Error('Expected a GitHub pull snapshot JSON file');
      if (statSync(snapshotFile).size > 1_000_000) throw new Error('GitHub pull snapshot exceeds 1 MiB');
      const snapshotText = readFileSync(snapshotFile, 'utf8');
      const snapshot = parseGitHubPullSnapshot(JSON.parse(snapshotText) as unknown);
      const expectedHeadSha = option(rest, '--expected-head');
      const expectedBaseSha = option(rest, '--expected-base');
      const eventType = option(rest, '--event-type') ?? 'pull_request';
      if (!eventType.trim()) throw new Error('--event-type must not be empty');
      const requiredChecks: string[] = [];
      for (let check = option(rest, '--require-check'); check !== undefined; check = option(rest, '--require-check')) {
        if (!check.trim()) throw new Error('--require-check must not be empty');
        requiredChecks.push(check.trim());
      }
      const approvalsText = option(rest, '--required-approvals');
      const requiredApprovals = approvalsText === undefined ? undefined : Number(approvalsText);
      if (requiredApprovals !== undefined && (!Number.isInteger(requiredApprovals) || requiredApprovals < 0)) {
        throw new Error('--required-approvals must be a non-negative integer');
      }
      const allowAuthorSelfApproval = flag(rest, '--allow-author-self-approval');
      const allowBotApprovals = flag(rest, '--allow-bot-approvals')
        || Boolean(config.githubApproval?.allowBotApprovals);
      const materializeRepo = option(rest, '--materialize');
      const deliveryId = option(rest, '--delivery-id') ?? `local:${hashGitHubPayload(snapshot).slice(0, 24)}`;
      if (rest.length > 0) throw new Error(`Unexpected github gate arguments: ${rest.join(' ')}`);
      if (!deliveryId.trim()) throw new Error('--delivery-id must not be empty');
      const result = store.ingestGitHubGate({
        snapshot,
        policy: {
          ...(expectedHeadSha ? { expectedHeadSha } : {}),
          ...(expectedBaseSha ? { expectedBaseSha } : {}),
          ...(requiredChecks.length ? { requiredChecks } : {}),
          ...(requiredApprovals === undefined ? {} : { requiredApprovals }),
          allowAuthorSelfApproval,
          allowBotApprovals,
        },
        deliveryId,
        eventType,
      });
      const plan = planGitHubActions(result.gate.evaluation);
      const materialization = materializeRepo
        ? materializeGitHubActions(store, plan, {
          repository: result.gate.repository,
          repoPath: materializeRepo,
          worktreeRoot: config.worktreeRoot,
          baseSha: snapshot.baseSha,
          budgets: config.budgets,
        })
        : undefined;
      console.log(JSON.stringify({
        ...result,
        plan,
        ...(materialization ? { materialization } : {}),
      }, null, 2));
      return;
    }

    if (scope === 'github' && action === 'snapshot') {
      const repository = option(rest, '--repo');
      const pullText = option(rest, '--pull-number');
      const tokenName = option(rest, '--token-env') ?? 'GITHUB_TOKEN';
      const apiUrl = option(rest, '--api-url') ?? process.env.GITHUB_API_URL;
      if (!repository || !pullText) throw new Error('github snapshot requires --repo and --pull-number');
      if (rest.length > 0) throw new Error(`Unexpected github snapshot arguments: ${rest.join(' ')}`);
      const pullNumber = Number(pullText);
      if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
        throw new Error('--pull-number must be a positive integer');
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenName)) throw new Error('--token-env must name an environment variable');
      const token = process.env[tokenName] ?? await githubAppTokens?.getToken();
      const snapshot = await fetchGitHubPullSnapshot(repository, pullNumber, {
        ...(token ? { token } : {}),
        ...(apiUrl ? { apiUrl } : {}),
      });
      const { repository: normalizedRepository, ...update } = snapshot;
      console.log(JSON.stringify({ repository: normalizedRepository, update }, null, 2));
      return;
    }

    if (scope === 'github' && action === 'webhook') {
      const payloadFile = rest.shift();
      if (!payloadFile || payloadFile.startsWith('--')) throw new Error('Expected a GitHub webhook payload JSON file');
      const eventType = option(rest, '--event');
      const deliveryId = option(rest, '--delivery-id');
      const signature = option(rest, '--signature');
      const secretName = option(rest, '--secret-env') ?? 'GITHUB_WEBHOOK_SECRET';
      if (!eventType || !deliveryId || !signature) {
        throw new Error('GitHub webhook requires --event, --delivery-id and --signature');
      }
      if (rest.length > 0) throw new Error(`Unexpected github webhook arguments: ${rest.join(' ')}`);
      if (!deliveryId.trim()) throw new Error('--delivery-id must not be empty');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName)) throw new Error('--secret-env must name an environment variable');
      const secret = process.env[secretName];
      if (!secret) throw new Error(`GitHub webhook secret is missing from ${secretName}`);
      if (statSync(payloadFile).size > 2_000_000) throw new Error('GitHub webhook payload exceeds 2 MB');
      const rawPayload = readFileSync(payloadFile);
      if (!verifyGitHubWebhookSignature(secret, rawPayload, signature)) {
        throw new Error('Invalid GitHub webhook signature');
      }
      const payload = JSON.parse(rawPayload.toString('utf8')) as unknown;
      const normalized = normalizeGitHubWebhook(eventType, payload, rawPayload);
      const baseDelivery = {
        eventType: normalized.eventType,
        repository: normalized.repository,
        pullNumber: normalized.pullNumber,
        headSha: normalized.headSha,
        payloadHash: normalized.payloadHash,
      };
      const delivery = store.recordGitHubDelivery({
        ...baseDelivery,
        deliveryId,
        eventKey: githubEventKey(baseDelivery),
      });
      console.log(JSON.stringify({ event: normalized, delivery }, null, 2));
      return;
    }

    if (scope === 'github' && action === 'serve-webhook') {
      const defaults = config.githubWebhook ?? {
        host: '127.0.0.1',
        port: 8787,
        path: '/github/webhook',
        secretEnv: 'GITHUB_WEBHOOK_SECRET',
      };
      const host = option(rest, '--host') ?? defaults.host;
      const portText = option(rest, '--port') ?? String(defaults.port);
      const port = Number(portText);
      const path = option(rest, '--path') ?? defaults.path;
      const secretName = option(rest, '--secret-env') ?? defaults.secretEnv;
      const fetchGate = defaults.fetchGate ?? true;
      const tokenName = defaults.tokenEnv;
      const apiUrl = defaults.apiUrl;
      if (rest.length > 0) throw new Error(`Unexpected github serve-webhook arguments: ${rest.join(' ')}`);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port must be an integer between 1 and 65535');
      }
      if (!path.startsWith('/') || path === '/healthz' || path.includes('?') || path.includes('#') || path.length > 256) {
        throw new Error('--path must be an absolute URL path other than /healthz, without query or fragment');
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName)) throw new Error('--secret-env must name an environment variable');
      const secret = process.env[secretName];
      if (!secret) throw new Error(`GitHub webhook secret is missing from ${secretName}`);
      const accessToken = async () =>
        (tokenName ? process.env[tokenName] : undefined) ?? await githubAppTokens?.getToken();
      const server = startGitHubWebhookServer({
        host,
        port,
        path,
        secret,
        store,
        ...(fetchGate ? {
          snapshotFetcher: async (repository: string, pullNumber: number) => {
            const token = await accessToken();
            return fetchGitHubPullSnapshot(repository, pullNumber, {
              ...(token ? { token } : {}),
              ...(apiUrl ? { apiUrl } : {}),
            });
          },
        } : {}),
        gatePolicy: {
          allowBotApprovals: Boolean(config.githubApproval?.allowBotApprovals),
        },
        actionHandler: (context) => materializeGitHubWebhookActions(store, config, context, async () => {
          const token = await accessToken();
          return triageGitHubChecks(context.gate.repository, context.gate, {
            ...(token ? { token } : {}),
            ...(apiUrl ?? config.githubApp?.apiUrl ? { apiUrl: apiUrl ?? config.githubApp?.apiUrl } : {}),
          });
        }),
      });
      console.log(JSON.stringify({ listening: server.url.toString(), path, health: '/healthz' }, null, 2));
      const stopped = new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await stopped;
      server.stop(true);
      return;
    }

    if (scope === 'worker' && action === 'once') {
      const result = await runOnce(store, config, agentForLane);
      console.log(JSON.stringify(result ?? { status: 'idle' }, null, 2));
      return;
    }

    if (scope === 'worker' && action === 'recover') {
      console.log(JSON.stringify(recoverInterruptedAttempts(store, config), null, 2));
      return;
    }

    throw new Error(`Unknown command\n${usage}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
