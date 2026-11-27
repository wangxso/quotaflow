import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from './live-probe.mjs';
import { launchGuardedAppServer, verifySupervisedStop } from '../src/supervisor';

const executable = process.argv[2] ?? 'codex';
const root = mkdtempSync(join(tmpdir(), 'quotaflow-codex-stop-smoke-'));
const statusDir = join(root, 'attempt');

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
  } finally {
    await server.close();
  }
  const stop = verifySupervisedStop(statusDir);
  console.log(JSON.stringify({
    initialized: true,
    inferenceTurnsRequested: 0,
    stop: {
      activeProcesses: stop.activeProcesses,
      exitCode: stop.exitCode,
      reason: stop.reason,
    },
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
