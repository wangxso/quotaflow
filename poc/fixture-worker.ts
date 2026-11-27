import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git.ts';

const [mode, dir, receipt] = process.argv.slice(2);
const workspace = process.cwd();

process.on('uncaughtException', (error) => {
  const status = process.env.QUOTAFLOW_GUARD_STATUS;
  if (status) writeFileSync(join(status, 'worker-error.txt'), error.stack ?? error.message);
  process.exit(1);
});

function outcome(value: object) {
  writeFileSync(join(dir, 'outcome.pending'), JSON.stringify(value));
  renameSync(join(dir, 'outcome.pending'), join(dir, 'outcome.json'));
}

if (mode === 'descendant') {
  setInterval(() => appendFileSync(join(dir, 'heartbeat'), 'x'), 30);
} else if (mode === 'complete') {
  const handoff = JSON.parse(readFileSync(receipt!, 'utf8'));
  assert.equal(handoff.pending.length, 1);
  assert.equal(handoff.pending[0], 'write answer.txt from the preserved result');
  assert.equal(readFileSync('app.txt', 'utf8'), 'started\n');
  assert.equal(git(workspace, ['show', ':app.txt']), 'staged');
  assert.equal(readFileSync('handoff.txt', 'utf8'), '41\n');
  assert.equal(existsSync('obsolete.txt'), false);
  writeFileSync('answer.txt', `${Number(readFileSync('handoff.txt', 'utf8')) + 1}\n`);
  assert.equal(readFileSync('answer.txt', 'utf8'), '42\n');
  outcome({ kind: 'success', completed: ['answer.txt'], pending: [], tests: 'passed' });
} else if (['quota', 'worker-exit', 'hold'].includes(mode ?? '')) {
  writeFileSync('app.txt', 'staged\n');
  git(workspace, ['add', 'app.txt']);
  writeFileSync('app.txt', 'started\n');
  rmSync('obsolete.txt');
  writeFileSync('handoff.txt', '41\n');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', dir!], {
    stdio: 'ignore', windowsHide: true,
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(dir!, 'heartbeat'))) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error('Fixture descendant could not start');
    await Bun.sleep(25);
  }
  if (mode === 'quota') outcome({
    kind: 'quota', completed: ['app.txt', 'handoff.txt'],
    pending: ['write answer.txt from the preserved result'], tests: 'pending',
  });
  if (mode === 'worker-exit') process.exit(73);
  setInterval(() => {}, 1000);
} else {
  throw new Error('Invalid fixture mode');
}
