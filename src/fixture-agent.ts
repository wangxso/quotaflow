import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode] = process.argv.slice(2);
const statusDir = process.env.QUOTAFLOW_ATTEMPT_DIR;
if (!statusDir) throw new Error('QUOTAFLOW_ATTEMPT_DIR is required');

function outcome(value: object) {
  const target = join(statusDir!, 'outcome.json');
  const pending = `${target}.${process.pid}.pending`;
  writeFileSync(pending, JSON.stringify(value));
  renameSync(pending, target);
}

async function startDetachedHolder() {
  const holder = spawn(process.execPath, [
    fileURLToPath(import.meta.url), 'detached-holder', statusDir,
  ], { detached: true, stdio: 'ignore' });
  holder.unref();
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(statusDir!, 'detached-heartbeat'))) {
    if (Date.now() > deadline) throw new Error('Detached descendant could not start');
    await Bun.sleep(20);
  }
}

if (mode === 'complete') {
  writeFileSync('app.txt', 'agent\n');
  writeFileSync('answer.txt', '42\n');
  outcome({ kind: 'success', reason: 'fixture_passed', tests: 'passed' });
} else if (mode === 'fail') {
  writeFileSync('app.txt', 'partial\n');
  outcome({ kind: 'failed', reason: 'fixture_failed', tests: 'failed' });
  process.exitCode = 4;
} else if (mode === 'quota') {
  writeFileSync('app.txt', 'partial\n');
  outcome({ kind: 'quota', reason: 'fixture_quota', tests: 'not_run' });
  setInterval(() => {}, 1_000);
} else if (mode === 'hold') {
  writeFileSync('app.txt', 'partial\n');
  setInterval(() => {}, 1_000);
} else if (mode === 'detached-holder') {
  const leaf = spawn(process.execPath, [
    fileURLToPath(import.meta.url), 'detached-leaf', statusDir,
  ], { detached: true, stdio: 'ignore' });
  leaf.unref();
  writeFileSync(join(statusDir, 'detached-pids.json'), JSON.stringify({ holder: process.pid, leaf: leaf.pid }));
  setInterval(() => {}, 1_000);
} else if (mode === 'detached-leaf') {
  setInterval(() => writeFileSync(join(statusDir, 'detached-heartbeat'), String(Date.now())), 30);
} else if (mode === 'detached-tree' || mode === 'detached-hold') {
  await startDetachedHolder();
  await Bun.sleep(150);
  if (mode === 'detached-hold') {
    setInterval(() => {}, 1_000);
  } else {
    process.exit(73);
  }
} else if (mode === 'echo') {
  process.stdin.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
} else if (mode === 'handoff-quota' || mode === 'handoff-hold') {
  const draft = process.env.QUOTAFLOW_HANDOFF_FILE;
  if (!draft) throw new Error('The handoff fixture requires an attempt draft path');
  writeFileSync('app.txt', '41\n');
  writeFileSync(draft, JSON.stringify({
    version: 1,
    completed: ['Verified app.txt contains 41'],
    failedAttempts: [],
    blockers: [],
    nextSteps: ['Write 42 to answer.txt'],
    checks: ['Read app.txt after writing it'],
  }));
  if (mode === 'handoff-quota') outcome({ kind: 'quota', reason: 'fixture_quota', tests: 'not_run' });
  setInterval(() => {}, 1_000);
} else if (mode === 'handoff-resume') {
  const promptFile = process.env.QUOTAFLOW_PROMPT_FILE;
  if (!promptFile || !readFileSync(promptFile, 'utf8').includes('Verified app.txt contains 41')) {
    throw new Error('The replacement agent did not receive the checkpointed note');
  }
  if (readFileSync('app.txt', 'utf8') !== '41\n') throw new Error('The accepted fixture content changed');
  writeFileSync('answer.txt', '42\n');
  outcome({ kind: 'success', reason: 'fixture_passed', tests: 'passed' });
} else {
  throw new Error('Unknown fixture mode');
}
