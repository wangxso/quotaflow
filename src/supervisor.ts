import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface SupervisorStop {
  supervisorPid: number;
  workerPid: number;
  exitCode: number | null;
  activeProcesses: number;
  reason: string;
}

export interface SupervisorOutcome {
  kind: 'success' | 'failed' | 'quota' | string;
  reason?: string;
  tests?: 'passed' | 'failed' | 'not_run';
  [key: string]: unknown;
}

export interface SupervisorOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const guardScript = fileURLToPath(new URL('../poc/guard-win.ps1', import.meta.url));

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function stopReceipt(dir: string): SupervisorStop | null {
  const error = join(dir, 'guard-error.txt');
  if (existsSync(error)) throw new Error(readFileSync(error, 'utf8').trim() || 'process supervisor failed');
  return readJson<SupervisorStop>(join(dir, 'stopped.json'));
}

export function verifySupervisedStop(statusDir: string): SupervisorStop {
  const published = stopReceipt(statusDir);
  if (published) {
    if (published.activeProcesses !== 0) {
      throw new Error('Supervisor stop receipt still reports active processes');
    }
    return published;
  }
  if (process.platform !== 'win32') {
    throw new Error('No verified process supervisor stop receipt');
  }
  if (!existsSync(join(statusDir, 'ready.json'))) {
    throw new Error('No supervisor launch evidence');
  }
  const verification = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    guardScript,
  ], {
    windowsHide: true,
    timeout: 8_000,
    stdio: 'ignore',
    env: {
      ...process.env,
      QUOTAFLOW_GUARD_VERIFY: '1',
      QUOTAFLOW_GUARD_STATUS: statusDir,
    },
  });
  if (verification.error) throw verification.error;
  if (verification.status !== 0) {
    throw new Error(`Could not verify the old Windows Job Object (${verification.status ?? 'unknown'})`);
  }
  const verified = stopReceipt(statusDir);
  if (!verified) throw new Error('The old Windows Job Object is still active');
  if (verified.activeProcesses !== 0) {
    throw new Error('Verified supervisor stop still reports active processes');
  }
  return verified;
}

export async function launchSupervised(
  command: string[],
  cwd: string,
  statusDir: string,
  options: SupervisorOptions = {},
): Promise<{ stop: SupervisorStop; outcome: SupervisorOutcome | null }> {
  if (process.platform !== 'win32') throw new Error('The Phase 1 process supervisor currently requires Windows');
  if (command.length === 0) throw new Error('A supervised command is required');
  const timeoutMs = options.timeoutMs ?? 60_000;
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  mkdirSync(statusDir, { recursive: true });

  const guard = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', guardScript], {
    windowsHide: true,
    cwd,
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      ...env,
      QUOTAFLOW_GUARD_EXE: command[0],
      QUOTAFLOW_GUARD_ARGS: JSON.stringify({ args: command.slice(1) }),
      QUOTAFLOW_GUARD_CWD: cwd,
      QUOTAFLOW_GUARD_STATUS: statusDir,
      QUOTAFLOW_GUARD_OWNER: String(process.pid),
      QUOTAFLOW_GUARD_CREATED_BY: String(Date.now()),
      QUOTAFLOW_GUARD_JOB: `QuotaFlow-Phase0-${randomUUID()}`,
      QUOTAFLOW_GUARD_VERIFY: '0',
      QUOTAFLOW_ATTEMPT_DIR: statusDir,
    },
  });
  guard.stdin.on('error', () => {});
  let guardExit: number | null = null;
  let diagnostics = '';
  guard.on('error', () => { guardExit = 70; });
  guard.on('exit', (code) => { guardExit = code ?? 70; });
  guard.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-2_000);
  });

  const deadline = Date.now() + timeoutMs;
  let completed = false;
  const cancel = () => {
    if (!guard.stdin.writableEnded) guard.stdin.end();
  };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (Date.now() <= deadline) {
      const outcome = readJson<SupervisorOutcome>(join(statusDir, 'outcome.json'));
      if (outcome?.kind === 'quota' && !guard.stdin.writableEnded) guard.stdin.end();
      const stop = stopReceipt(statusDir);
      if (stop) {
        if (stop.activeProcesses !== 0) throw new Error('Supervisor did not confirm an empty process set');
        completed = true;
        return { stop, outcome };
      }
      if (guardExit !== null) {
        throw new Error(`Supervisor exited without a stop receipt (${guardExit}) ${diagnostics.trim()}`);
      }
      await Bun.sleep(30);
    }
    throw new Error('Timed out waiting for supervised process stop');
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    guard.stdin.end();
    if (!completed && guard.exitCode === null) guard.kill();
  }
}
