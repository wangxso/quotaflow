import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchSupervised, verifySupervisedStop } from './supervisor';

const fixture = fileURLToPath(new URL('./fixture-agent.ts', import.meta.url));

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

test('supervised fixture confirms process stop before returning', async () => {
  if (process.platform !== 'win32') return;
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

test('supervised fixture stops a quota-held worker after its outcome', async () => {
  if (process.platform !== 'win32') return;
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

test('an abort signal stops the supervised job before returning', async () => {
  if (process.platform !== 'win32') return;
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

test('verification reconstructs a missing stop receipt only after the job is empty', async () => {
  if (process.platform !== 'win32') return;
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
