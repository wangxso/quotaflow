import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from './live-probe.mjs';
import { probeAppServerRuntime } from './app-server-runtime.mjs';
import { launchGuardedAppServer, verifySupervisedStop } from '../src/supervisor';

const executable = process.argv[2] ?? 'codex';
const root = mkdtempSync(join(tmpdir(), 'quotaflow-codex-stop-smoke-'));
const statusDir = join(root, 'attempt');
const detachedMarker = join(root, 'detached-child.pid');
let detachedPid: number | undefined;

try {
  const child = launchGuardedAppServer(
    [executable, 'app-server', '--listen', 'stdio://'],
    root,
    statusDir,
    { env: process.env },
  );
  const server = new AppServer(executable, [], { child });
  try {
    const initialized = await server.initialize({ experimentalApi: true });
    if (!initialized.value) throw new Error(`App Server initialize failed (${initialized.code ?? 'unknown'})`);
    const runtime = await probeAppServerRuntime(server, root);
    if (runtime.commandExec.status !== 'completed' || runtime.commandExec.exitCode !== 0 || !runtime.commandExec.fileWritten) {
      throw new Error(`App Server command/exec runtime probe failed: ${JSON.stringify(runtime.commandExec)}`);
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const execution = await server.call('command/exec', {
        command: ['/bin/sh', '-c', 'sleep 60 & echo $! > "$1"', 'quotaflow-tree-smoke', detachedMarker],
        cwd: root,
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [root],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        timeoutMs: 5_000,
      }, 10_000);
      if (!execution.value || !existsSync(detachedMarker)) throw new Error('Could not start the detached child probe');
      detachedPid = Number(readFileSync(detachedMarker, 'utf8'));
    }
  } finally {
    await server.close();
  }
  const stop = verifySupervisedStop(statusDir);
  if (detachedPid) {
    await Bun.sleep(100);
    let active = false;
    try {
      process.kill(detachedPid, 0);
      active = true;
    } catch {}
    if (active) throw new Error(`Detached child ${detachedPid} survived the stop receipt`);
  }
  console.log(JSON.stringify({
    initialized: true,
    commandExec: 'passed',
    detachedProcessTree: process.platform === 'darwin' || process.platform === 'linux' ? 'stopped' : 'not_applicable',
    inferenceTurnsRequested: 0,
    stop: {
      activeProcesses: stop.activeProcesses,
      exitCode: stop.exitCode,
      reason: stop.reason,
    },
  }, null, 2));
} finally {
  if (detachedPid) {
    try { process.kill(detachedPid, 'SIGKILL'); } catch {}
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
