import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { attemptDirectory, writeAttemptOwner } from './recovery';
import { reserveNext } from './scheduler';
import { TaskStore } from './store';
import { launchSupervised } from './supervisor';
import { ensureWorktree } from './worktree';

const configPath = process.argv[2];
if (!configPath) throw new Error('Expected a QuotaFlow config path');

const config = loadConfig(configPath);
const db = openDatabase(config.database);
const store = new TaskStore(db);
const reservedAt = Date.now();
const reservation = reserveNext(store, config.lanes, reservedAt, config.budgets);
if (!reservation) throw new Error('No runnable task');

const task = store.getTask(reservation.attempt.taskId);
const statusDir = attemptDirectory(config, task.id, reservation.attempt.id);
writeAttemptOwner(statusDir, process.pid, reservedAt);
const workspace = ensureWorktree(task.repoPath, task.workspacePath, task.checkpoint ?? 'HEAD');
const lane = config.lanes.find((candidate) => candidate.id === reservation.attempt.laneId);
if (!lane?.command?.length) throw new Error('The crash fixture requires a supervised lane command');

void launchSupervised(lane.command, workspace, statusDir).catch(() => {});
const deadline = Date.now() + 10_000;
while (!existsSync(join(statusDir, 'ready.json'))) {
  if (Date.now() > deadline) throw new Error('Timed out waiting for the supervisor to start');
  await Bun.sleep(30);
}

setInterval(() => {}, 1_000);
