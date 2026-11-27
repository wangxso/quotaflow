import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode] = process.argv.slice(2);
const statusDir = process.env.QUOTAFLOW_ATTEMPT_DIR;
if (!statusDir) throw new Error('QUOTAFLOW_ATTEMPT_DIR is required');

function outcome(value: object) {
  const target = join(statusDir!, 'outcome.json');
  const pending = `${target}.${process.pid}.pending`;
  writeFileSync(pending, JSON.stringify(value));
  renameSync(pending, target);
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
} else if (mode === 'echo') {
  process.stdin.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
} else {
  throw new Error('Expected fixture mode complete, fail, hold, quota or echo');
}
