#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
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

const usage = `
quotaflow config validate [--config <file>]
quotaflow task add <title> [--prompt <text>] [--repo <path>] [--workspace <path>] [--priority <n>] [--critical] [--config <file>]
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
  if (scope === 'config' && action === 'validate') {
    console.log(JSON.stringify({
      config: configPath,
      database: config.database,
      worktreeRoot: config.worktreeRoot,
      allowedProviders: config.routing.allowedProviders,
      routedModelApproval: config.routing.routedModelApproval ?? null,
      budgets: config.budgets ?? [],
      lanes: config.lanes.map((lane) => ({ id: lane.id, agent: lane.agent, model: lane.model, provider: lane.provider })),
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
