import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab, git, restoreNewWorktree, verifyCheckpoint, worktree } from './git.ts';
import { drive, fixtureLanes } from './run.ts';
import { State, type Lane } from './state.ts';

function setup() {
  const lab = createLab();
  const state = new State(join(lab.root, 'phase0.sqlite'));
  state.add('task', lab.workspace);
  state.db.close();
  return lab;
}

function controller(root: string, mode: string, fault?: string) {
  return Bun.spawn([process.execPath, fileURLToPath(new URL('./run.ts', import.meta.url)), root, 'task', mode, ...(fault ? [fault] : [])], {
    stdout: 'pipe', stderr: 'inherit', stdin: 'ignore',
  });
}

async function waitForFile(file: string, process?: { exitCode: number | null }) {
  const deadline = Date.now() + 17_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline || (process && process.exitCode !== null)) throw new Error(`Missing expected fixture: ${file}`);
    await Bun.sleep(30);
  }
}

function checkCompleted(root: string, workspace: string) {
  const state = new State(join(root, 'phase0.sqlite'));
  try {
    expect(state.get('task').state).toBe('completed');
    expect(state.active('task')).toBeNull();
    const events = state.events('task');
    expect(events.filter((event) => event.kind === 'reserved').map((event) => JSON.parse(event.detail).lane))
      .toEqual(['fixture-codex', 'fixture-opencode']);
    expect(events.filter((event) => event.kind === 'checkpoint_committed')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'checkpoint_intent').map((event) => JSON.parse(event.detail).activeProcesses))
      .toEqual([0, 0]);
    expect(readFileSync(join(workspace, 'answer.txt'), 'utf8')).toBe('42\n');
  } finally {
    state.db.close();
  }
}

test('quota signal stops descendants and hands staged, unstaged, deleted and untracked files to a new agent', async () => {
  const lab = setup();
  const first = await drive(lab.root, 'task', 'quota');
  expect(first.state).toBe('pending');
  const restored = restoreNewWorktree(lab.repo, join(lab.root, 'restored'), first.checkpoint!);
  verifyCheckpoint(restored, lab.root, first.checkpoint!);
  expect(git(lab.repo, ['status', '--short'])).toBe('');
  const heartbeat = join(lab.root, 'attempt-1', 'heartbeat');
  const lastWrite = statSync(heartbeat).size;
  await drive(lab.root, 'task', 'quota');
  expect(statSync(heartbeat).size).toBe(lastWrite);
  checkCompleted(lab.root, lab.workspace);
}, 60_000);

test('a worker exiting with an active descendant is contained and another agent finishes', async () => {
  const lab = setup();
  await drive(lab.root, 'task', 'worker-exit');
  const stop = JSON.parse(readFileSync(join(lab.root, 'attempt-1', 'stopped.json'), 'utf8'));
  expect(stop).toMatchObject({ activeProcesses: 0, exitCode: 73, reason: 'worker_exit' });
  await drive(lab.root, 'task', 'worker-exit');
  checkCompleted(lab.root, lab.workspace);
}, 60_000);

test('forcing the controller to exit closes the old job and recovery restarts the task', async () => {
  const lab = setup();
  const run = controller(lab.root, 'hold');
  try {
    await waitForFile(join(lab.root, 'attempt-1', 'ready.json'), run);
    await waitForFile(join(lab.root, 'attempt-1', 'heartbeat'), run);
    const killed = spawnSync('taskkill.exe', ['/PID', String(run.pid), '/F'], { windowsHide: true });
    expect(killed.status).toBe(0);
    expect(await run.exited).not.toBe(0);
  } finally {
    if (run.exitCode === null) run.kill('SIGKILL');
  }
  await drive(lab.root, 'task', 'hold');
  const stop = JSON.parse(readFileSync(join(lab.root, 'attempt-1', 'stopped.json'), 'utf8'));
  expect(stop.activeProcesses).toBe(0);
  expect(['controller_closed', 'job_reaped']).toContain(stop.reason);
  const heartbeat = join(lab.root, 'attempt-1', 'heartbeat');
  const writes = statSync(heartbeat).size;
  await Bun.sleep(100);
  expect(statSync(heartbeat).size).toBe(writes);
  checkCompleted(lab.root, lab.workspace);
}, 60_000);

for (const [fault, exit] of [['before-ref', 91], ['after-ref', 92]] as const) {
  test(`checkpoint survives a controller exit ${fault} without a duplicate Git reference`, async () => {
    const lab = setup();
    const run = controller(lab.root, 'quota', fault);
    expect(await run.exited).toBe(exit);
    const references = () => git(lab.repo, ['for-each-ref', '--format=%(objectname)', 'refs/quotaflow/phase0/attempt-1']);
    const published = references();
    expect(Boolean(published)).toBe(fault === 'after-ref');
    await drive(lab.root, 'task', 'quota');
    if (published) expect(references()).toBe(published);
    checkCompleted(lab.root, lab.workspace);
  }, 60_000);
}

test('concurrent processes cannot reserve one account slot twice', async () => {
  const lab = setup();
  const file = join(lab.root, 'phase0.sqlite');
  const store = new State(file);
  store.add('other', worktree(lab.repo, join(lab.root, 'other')));
  store.db.close();
  const start = (id: string) => Bun.spawn([process.execPath, '-e', `
    import { State } from ${JSON.stringify(new URL('./state.ts', import.meta.url).href)};
    import { fixtureLanes } from ${JSON.stringify(new URL('./run.ts', import.meta.url).href)};
    const state = new State(process.argv[1]);
    const attempt = state.reserve(process.argv[2], fixtureLanes().slice(0, 1));
    console.log(attempt ? 'reserved' : 'waiting');
    state.db.close();
  `, file, id], { stdout: 'pipe', stderr: 'inherit' });
  const jobs = [start('task'), start('other')];
  const output = await Promise.all(jobs.map((job) => new Response(job.stdout).text()));
  expect(await Promise.all(jobs.map((job) => job.exited))).toEqual([0, 0]);
  expect(output.map((line) => line.trim()).sort()).toEqual(['reserved', 'waiting']);
}, 30_000);

test('quota waits persist while other work uses a reserved pool only for a critical task', () => {
  const lab = setup();
  const now = Date.now();
  const file = join(lab.root, 'phase0.sqlite');
  const base = new State(file);
  base.add('critical', worktree(lab.repo, join(lab.root, 'critical')), true);
  const known: Lane = { id: 'large', account: 'a', priority: 2, slots: 2,
    windows: [{ remaining: 6, reserve: 1, observed: now, reset: now + 10_000 },
      { remaining: 1, reserve: 1, observed: now, reset: now + 100_000 }] };
  const unknown: Lane = { ...known, id: 'unknown', account: 'b', windows: [] };
  expect(base.reserve('task', [known, unknown], now)).toBeNull();
  expect(base.reserve('critical', [known], now)?.lane).toBe('large');
  base.db.close();
  const restarted = new State(file);
  try {
    expect(restarted.get('task').state).toBe('waiting_quota');
    expect(restarted.events('task')[0].detail).toContain('UNKNOWN');
    expect(restarted.reserve('task', [known], now + 999)).toBeNull();
    const fallback: Lane = { ...known, id: 'approved-backup', account: 'c', windows: [known.windows[0]] };
    expect(restarted.reserve('task', [known, fallback], now + 1000)?.lane).toBe('approved-backup');
  } finally {
    restarted.db.close();
  }
});

test('a missing stop receipt blocks recovery and retains the old writer claim', async () => {
  const lab = setup();
  const file = join(lab.root, 'phase0.sqlite');
  const store = new State(file);
  const attempt = store.reserve('task', fixtureLanes())!;
  store.db.close();
  const dir = join(lab.root, `attempt-${attempt.id}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'guard-error.txt'), 'simulated supervisor failure');
  await expect(drive(lab.root, 'task', 'quota')).rejects.toThrow('simulated supervisor failure');
  const restarted = new State(file);
  try {
    expect(restarted.get('task').state).toBe('blocked');
    expect(restarted.active('task')?.id).toBe(attempt.id);
    expect(restarted.reserve('task', fixtureLanes())).toBeNull();
  } finally {
    restarted.db.close();
  }
});
