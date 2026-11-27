import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGuardedAppServer, launchSupervised, verifySupervisedStop } from './supervisor';

const fixture = fileURLToPath(new URL('./fixture-agent.ts', import.meta.url));
const supervisedTest = test.skipIf(process.platform !== 'win32' && process.platform !== 'darwin');

async function removeEventually(path: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['EBUSY', 'EPERM'].includes(String(error.code))) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
  rmSync(path, { recursive: true, force: true });
}

supervisedTest('supervised fixture confirms process stop before returning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-'));
  try {
    const status = join(root, 'attempt');
    const result = await launchSupervised([process.execPath, fixture, 'complete'], root, status);
    expect(result.stop.activeProcesses).toBe(0);
    expect(result.stop.exitCode).toBe(0);
    expect(result.outcome).toMatchObject({ kind: 'success', tests: 'passed' });
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('agent\n');
    expect(readFileSync(join(root, 'answer.txt'), 'utf8')).toBe('42\n');
  } finally {
    await removeEventually(root);
  }
});

supervisedTest('supervised fixture stops a quota-held worker after its outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-'));
  try {
    const result = await launchSupervised(
      [process.execPath, fixture, 'quota'],
      root,
      join(root, 'attempt'),
    );
    expect(result.outcome).toMatchObject({ kind: 'quota' });
    expect(result.stop.activeProcesses).toBe(0);
  } finally {
    await removeEventually(root);
  }
});

supervisedTest('an abort signal stops the supervised command before returning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-cancel-'));
  try {
    const status = join(root, 'attempt');
    const controller = new AbortController();
    const running = launchSupervised(
      [process.execPath, fixture, 'hold'],
      root,
      status,
      { signal: controller.signal },
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(status, 'ready.json')) && Date.now() < deadline) {
      await Bun.sleep(30);
    }
    controller.abort();
    const result = await running;
    expect(result.stop.activeProcesses).toBe(0);
    expect(result.stop.reason).toBe('controller_closed');
  } finally {
    await removeEventually(root);
  }
});

supervisedTest('a cancellation flag stops the command and reports an empty process set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-force-'));
  try {
    const status = join(root, 'attempt');
    const running = launchSupervised(
      [process.execPath, fixture, 'hold'],
      root,
      status,
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(status, 'ready.json')) && Date.now() < deadline) {
      await Bun.sleep(30);
    }
    writeFileSync(join(status, 'cancel.flag'), JSON.stringify({ terminateOwner: false }));
    const result = await running;
    expect(result.stop).toMatchObject({
      activeProcesses: 0,
      reason: 'cancelled',
    });
    expect(JSON.parse(readFileSync(join(status, 'stopped.json'), 'utf8'))).toMatchObject({
      activeProcesses: 0,
      reason: 'cancelled',
    });
  } finally {
    await removeEventually(root);
  }
});

test.skipIf(process.platform !== 'win32')('guarded stdio keeps the worker pipe live and publishes a stop receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-stdio-'));
  try {
    const status = join(root, 'attempt');
    const child = launchGuardedAppServer(
      [process.execPath, fixture, 'echo'],
      root,
      status,
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(status, 'ready.json')) && Date.now() < deadline) {
      await Bun.sleep(30);
    }
    expect(existsSync(join(status, 'ready.json'))).toBe(true);

    let output = '';
    const echoed = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('{"method":"ping"}')) resolve();
      });
    });
    child.stdin.write('{"method":"ping"}\n');
    await echoed;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.end();
    await closed;

    expect(verifySupervisedStop(status)).toMatchObject({
      activeProcesses: 0,
      reason: 'worker_exit',
    });
  } finally {
    await removeEventually(root);
  }
}, 20_000);

test.skipIf(process.platform !== 'win32')('verification reconstructs a missing stop receipt only after the job is empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-verify-'));
  try {
    const status = join(root, 'attempt');
    await launchSupervised([process.execPath, fixture, 'complete'], root, status);
    rmSync(join(status, 'stopped.json'));
    const verified = verifySupervisedStop(status);
    expect(verified).toMatchObject({ activeProcesses: 0, exitCode: null, reason: 'job_reaped' });
    expect(existsSync(join(status, 'stopped.json'))).toBe(true);
  } finally {
    await removeEventually(root);
  }
});

supervisedTest('command timeout reports failure only after verifying process stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-supervisor-timeout-'));
  try {
    const status = join(root, 'attempt');
    await expect(launchSupervised([process.execPath, fixture, 'hold'], root, status, { timeoutMs: 1000 }))
      .rejects.toThrow('Timed out waiting for the supervised command');
    expect(verifySupervisedStop(status)).toMatchObject({ activeProcesses: 0, reason: 'controller_closed' });
  } finally {
    await removeEventually(root);
  }
}, 15_000);
