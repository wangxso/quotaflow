import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchSupervised, type SupervisorStop } from '../src/supervisor';
import { checkpoint, git, verifyCheckpoint } from './git.ts';
import { State, type Attempt, type Lane } from './state.ts';

type Outcome = { kind: 'quota' | 'success'; completed: string[]; pending: string[]; tests: string };
export type FirstMode = 'quota' | 'worker-exit' | 'hold';
const source = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const guardArgs = ['-NoProfile', '-NonInteractive', '-File', source('guard-win.ps1')];

function read<T>(file: string): T | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : null;
}

async function waitFor<T>(readValue: () => T | null, deadline = 14_000) {
  const end = Date.now() + deadline;
  do {
    const value = readValue();
    if (value !== null) return value;
    await Bun.sleep(25);
  } while (Date.now() < end);
  throw new Error('Timed out waiting for verified process stop');
}

function checkGuard(dir: string) {
  if (existsSync(join(dir, 'guard-error.txt'))) throw new Error(readFileSync(join(dir, 'guard-error.txt'), 'utf8'));
  return read<SupervisorStop>(join(dir, 'stopped.json'));
}

async function recoverStop(dir: string) {
  const published = checkGuard(dir);
  if (published) return published;
  if (process.platform === 'win32' && existsSync(join(dir, 'ready.json'))) {
    // The controller and supervisor can disappear together. Check the previously assigned OS job in this session.
    const verification = spawnSync('powershell.exe', guardArgs, {
      windowsHide: true, timeout: 8000, stdio: 'ignore',
      env: { ...process.env, QUOTAFLOW_GUARD_VERIFY: '1', QUOTAFLOW_GUARD_STATUS: dir },
    });
    if (verification.error || verification.status !== 0) throw new Error('Could not verify the old Windows Job Object');
  }
  return waitFor(() => checkGuard(dir));
}

async function launch(dir: string, workspace: string, mode: string, handoff?: string) {
  const command = [process.execPath, source('fixture-worker.ts'), mode, dir, ...(handoff ? [handoff] : [])];
  const { stop } = await launchSupervised(command, workspace, dir, { timeoutMs: 35_000 });
  return stop;
}

function finish(root: string, store: State, attempt: Attempt, stop: SupervisorStop, fault?: string) {
  const task = store.get(attempt.task);
  const dir = join(root, `attempt-${attempt.id}`);
  const expected = read<Outcome>(join(dir, 'outcome.json'));
  const success = expected?.kind === 'success' && expected.tests === 'passed' && stop.exitCode === 0;
  const reason = expected?.kind === 'quota' ? 'injected_quota' : success ? 'fixture_passed' : stop.reason;
  store.beginCheckpoint(attempt, reason, stop.activeProcesses);
  if (fault === 'before-ref') process.exit(91);
  store.db.transaction(() => {
    if (store.active(task.id)?.id !== attempt.id) return;
    const sha = checkpoint(task.workspace, root, attempt.id);
    if (fault === 'after-ref') process.exit(92);
    const artifact = join(root, `handoff-${sha}.json`);
    if (!existsSync(artifact)) {
      const content = JSON.stringify({
        task: task.id,
        attempt: attempt.id,
        agent: attempt.lane,
        actualModel: 'UNKNOWN',
        base: git(task.workspace, ['rev-parse', `${sha}^1`]),
        checkpoint: sha,
        changed: git(task.workspace, ['diff', '--name-status', `${sha}^1`, sha]).split('\n').filter(Boolean),
        completed: expected?.completed ?? [],
        pending: success ? [] : ['write answer.txt from the preserved result'],
        tests: expected?.tests ?? 'not_run',
        stop: { reason, activeProcesses: stop.activeProcesses, exitCode: stop.exitCode },
      });
      const pending = artifact + `.${process.pid}.pending`;
      writeFileSync(pending, content);
      renameSync(pending, artifact);
    }
    store.settle(attempt, sha, success ? 'completed' : 'pending', reason);
  }).immediate();
}

export function fixtureLanes(now = Date.now()): Lane[] {
  return ['fixture-codex', 'fixture-opencode'].map((id, position) => ({
    id, account: id, slots: 1, priority: 2 - position,
    windows: [{ remaining: 3, reserve: 1, observed: now - 60_000, reset: now + 360_000 }],
  }));
}

export async function drive(root: string, id: string, first: FirstMode, fault?: string) {
  if (!isAbsolute(root)) throw new Error('A dedicated absolute lab directory is required');
  const store = new State(join(root, 'phase0.sqlite'));
  try {
    const before = store.get(id);
    if (before.state === 'blocked' || before.state === 'completed') return before;
    const existing = store.active(id);
    if (existing) {
      const dir = join(root, `attempt-${existing.id}`);
      // Recovery waits for positive proof from the old supervisor. An expired lease never transfers write access.
      const stop = await recoverStop(dir);
      finish(root, store, existing, stop);
    }
    const next = store.reserve(id, fixtureLanes());
    if (!next) return store.get(id);
    const task = store.get(id);
    if (task.checkpoint) verifyCheckpoint(task.workspace, root, task.checkpoint);
    const dir = join(root, `attempt-${next.id}`);
    mkdirSync(dir);
    const handoff = task.checkpoint ? join(root, `handoff-${task.checkpoint}.json`) : undefined;
    const stop = await launch(dir, task.workspace, handoff ? 'complete' : first, handoff);
    finish(root, store, next, stop, fault);
    return store.get(id);
  } catch (error) {
    store.block(id, error instanceof Error ? error.message : 'unknown_error');
    throw error;
  } finally {
    store.db.close();
  }
}

if (import.meta.main) {
  const [root, id, mode, fault] = process.argv.slice(2);
  if (!root || !id || !mode || !['quota', 'worker-exit', 'hold'].includes(mode)) throw new Error('Expected lab path, task ID and fixture mode');
  console.log(JSON.stringify(await drive(root, id, mode as FirstMode, fault)));
}
