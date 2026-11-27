import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProcessStopUnverifiedError } from './agent';
import guardMacSource from './guard-macos.c' with { type: 'text' };

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
export const supervisorLaunchFile = 'launch.json';

export function hasSupervisorEvidence(statusDir: string): boolean {
  return [supervisorLaunchFile, 'ready.json', 'stopped.json'].some((file) => existsSync(join(statusDir, file)));
}

function recordLaunch(statusDir: string, backend: string): void {
  writeFileSync(join(statusDir, supervisorLaunchFile), JSON.stringify({ backend }), { flag: 'wx' });
}

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

export function launchGuardedAppServer(
  command: string[],
  cwd: string,
  statusDir: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('Supervised Codex App Server requires Windows or macOS');
  }
  if (command.length === 0) throw new Error('A supervised command is required');
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  mkdirSync(statusDir, { recursive: true });
  return launchCommandGuard(command, cwd, statusDir, env, true) as ChildProcessWithoutNullStreams;
}

function launchMacGuard(
  command: string[],
  cwd: string,
  statusDir: string,
  env: NodeJS.ProcessEnv,
  proxyStdio: boolean,
) {
  const buildDir = mkdtempSync(join(tmpdir(), 'quotaflow-guard-'));
  const removeBuild = () => rmSync(buildDir, { recursive: true, force: true });
  try {
    const executable = join(buildDir, 'guard-macos');
    const build = spawnSync('/usr/bin/cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-x', 'c', '-', '-o', executable,
    ], { input: guardMacSource, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) {
      throw new Error(`Could not build the macOS process supervisor. Install Xcode Command Line Tools. ${build.stderr.trim()}`);
    }
    // Persist the launch intent before the guard can start a writer.
    recordLaunch(statusDir, 'macos_process_tree');
    const guard = spawn(executable, [String(process.pid), statusDir, ...command], {
      cwd,
      detached: true,
      stdio: proxyStdio ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
      env: {
        ...env,
        QUOTAFLOW_GUARD_STATUS: statusDir,
        QUOTAFLOW_GUARD_PROXY_STDIO: proxyStdio ? '1' : '0',
        QUOTAFLOW_ATTEMPT_DIR: statusDir,
      },
    });
    guard.once('close', removeBuild);
    return guard;
  } catch (error) {
    removeBuild();
    throw error;
  }
}

function launchCommandGuard(
  command: string[],
  cwd: string,
  statusDir: string,
  env: NodeJS.ProcessEnv,
  proxyStdio = false,
) {
  if (process.platform === 'darwin') return launchMacGuard(command, cwd, statusDir, env, proxyStdio);
  recordLaunch(statusDir, 'windows_job');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', guardScript], {
    windowsHide: true,
    cwd,
    stdio: proxyStdio ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
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
      QUOTAFLOW_GUARD_PROXY_STDIO: proxyStdio ? '1' : '0',
      QUOTAFLOW_ATTEMPT_DIR: statusDir,
    },
  });
}

export async function launchSupervised(
  command: string[],
  cwd: string,
  statusDir: string,
  options: SupervisorOptions = {},
): Promise<{ stop: SupervisorStop; outcome: SupervisorOutcome | null }> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('Supervised commands require Windows or macOS');
  }
  if (command.length === 0) throw new Error('A supervised command is required');
  const timeoutMs = options.timeoutMs ?? 60_000;
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const directory = resolve(statusDir);
  mkdirSync(directory, { recursive: true });
  const guard = launchCommandGuard(command, resolve(cwd), directory, env);
  guard.stdin.on('error', () => {});
  let guardExit: number | null = null;
  let diagnostics = '';
  guard.on('error', (error) => {
    diagnostics = error.message;
    guardExit = 70;
  });
  guard.on('close', (code) => { guardExit ??= code ?? 70; });
  guard.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-2_000);
  });

  let deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let verifiedStop = false;
  const cancel = () => {
    if (!guard.stdin.writableEnded) guard.stdin.end();
  };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const outcome = readJson<SupervisorOutcome>(join(directory, 'outcome.json'));
      if (outcome?.kind === 'quota' && !guard.stdin.writableEnded) guard.stdin.end();
      let stop: SupervisorStop | null;
      try {
        stop = stopReceipt(directory);
      } catch (error) {
        throw new ProcessStopUnverifiedError(String(error));
      }
      if (stop) {
        if (stop.activeProcesses !== 0) {
          throw new ProcessStopUnverifiedError('Supervisor did not confirm an empty process set');
        }
        verifiedStop = true;
        if (timedOut) throw new Error('Timed out waiting for the supervised command');
        return { stop, outcome: readJson<SupervisorOutcome>(join(directory, 'outcome.json')) };
      }
      if (guardExit !== null) {
        throw new ProcessStopUnverifiedError(`Supervisor exited without a stop receipt (${guardExit}) ${diagnostics.trim()}`);
      }
      if (Date.now() >= deadline) {
        if (timedOut) throw new ProcessStopUnverifiedError('Timed out waiting for verified process stop');
        timedOut = true;
        deadline = Date.now() + 8_000;
        cancel();
      }
      await Bun.sleep(30);
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    guard.stdin.end();
    if (!verifiedStop && guardExit === null) {
      if (process.platform === 'win32') guard.kill();
      else {
        // The macOS guard can finish reaping after the controller gives up waiting.
        guard.unref();
        guard.stderr.destroy();
      }
    }
  }
}
