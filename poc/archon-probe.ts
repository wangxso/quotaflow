import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLab, git } from './git.ts';

const [binary, bunExecutable] = process.argv.slice(2);
if (!binary || !bunExecutable) throw new Error('Expected Archon executable and the path to bun.exe');
const lab = createLab();
const capture = join(lab.root, 'events');
mkdirSync(capture);
const workflows = join(lab.repo, '.archon', 'workflows');
mkdirSync(workflows, { recursive: true });
const proofPath = JSON.stringify(capture);
writeFileSync(join(workflows, 'phase0-recovery.yaml'), `name: phase0-recovery
description: Exercise workflow delegation and persistence with local test data
worktree:
  enabled: true
nodes:
  - id: prepare
    runtime: bun
    script: |
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const proof = ${proofPath};
      appendFileSync(join(proof, 'prepare.txt'), 'once\\n');
      writeFileSync(join(proof, 'checkout.txt'), process.cwd());
      writeFileSync('app.txt', '41\\n');
      console.log(JSON.stringify({ operation: 'prepare', complete: true }));
  - id: delegate
    depends_on: [prepare]
    runtime: bun
    script: |
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const proof = ${proofPath};
      const receipt = join(proof, 'failed.txt');
      if (!existsSync(receipt)) {
        writeFileSync(receipt, 'injected local node failure');
        writeFileSync('handoff.txt', 'finish from 41\\n');
        process.exit(23);
      }
      if (readFileSync('handoff.txt', 'utf8').trim() !== 'finish from 41') process.exit(24);
      if (readFileSync(join(proof, 'checkout.txt'), 'utf8') !== process.cwd()) process.exit(25);
      writeFileSync('answer.txt', String(Number(readFileSync('app.txt', 'utf8')) + 1));
      console.log(JSON.stringify({ operation: 'delegate', answer: 42 }));
`);
git(lab.repo, ['add', '.archon']);
git(lab.repo, ['commit', '-m', 'Add Archon test workflow']);
if (process.platform === 'win32') git(lab.repo, ['config', '--local', 'core.longpaths', 'true']);

const env = {
  ...process.env,
  ARCHON_HOME: join(lab.root, 'archon'),
  DO_NOT_TRACK: '1',
  PATH: `${dirname(resolve(bunExecutable))}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};

function archon(label: string, ...args: string[]) {
  const result = spawnSync(resolve(binary), args, { cwd: lab.repo, env, windowsHide: true, encoding: 'utf8', timeout: 45_000 });
  if (result.error) throw result.error;
  writeFileSync(join(capture, `${label}.stdout`), result.stdout);
  writeFileSync(join(capture, `${label}.stderr`), result.stderr);
  return result;
}

const detected = archon('version', 'version');
assert.equal(detected.status, 0);
const first = archon('first', 'workflow', 'run', 'phase0-recovery', '--json');
const list = archon('runs', 'workflow', 'runs', '--json');
const data = JSON.parse(list.stdout);
const runs = Array.isArray(data) ? data : data.runs;
const run = runs?.find((entry: Record<string, unknown>) =>
  [entry.workflowName, entry.workflow_name, entry.workflow, entry.name].includes('phase0-recovery')) ?? runs?.[0];
const runId = run?.id ?? run?.runId ?? run?.run_id;
if (!runId || run.status !== 'failed') {
  throw new Error(`Archon did not persist the injected failure (start=${first.status}, status=${run?.status ?? 'missing'})`);
}
const preview = archon('resume-preview', 'workflow', 'resume', runId, '--json');
const previewResult = JSON.parse(preview.stdout);
assert.equal(previewResult.executed, false);
const resume = archon('resume', 'workflow', 'resume', runId);
const get = archon('get', 'workflow', 'get', runId, '--json');
const worktree = readFileSync(join(capture, 'checkout.txt'), 'utf8');
assert.notEqual(resolve(worktree), resolve(lab.repo));
assert.equal(readFileSync(join(worktree, 'answer.txt'), 'utf8'), '42');
assert.equal(readFileSync(join(capture, 'prepare.txt'), 'utf8'), 'once\n');
assert.equal(resume.status, 0);
assert.equal(get.status, 0);
const final = JSON.parse(get.stdout);
assert.equal(final.status ?? final.run?.status, 'completed');
console.log(JSON.stringify({
  version: detected.stdout.split('\n')[0].trim(), failedState: run.status,
  finalStatus: final.status ?? final.run?.status ?? 'UNKNOWN',
  differentWorktree: true, preservedPatch: true, skippedCompletedNode: true, jsonResumeWasPreview: true, result: 42,
}));
