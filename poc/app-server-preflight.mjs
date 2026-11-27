import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AppServer } from './live-probe.mjs';
import { probeAppServerRuntime } from './app-server-runtime.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function clean(directory) {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  if (target.startsWith(`${root}${sep}`)) rmSync(target, { recursive: true, force: true });
}

const executable = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'codex';
const transport = option('--transport', 'stdio');
const keep = process.argv.includes('--keep');
if (!['stdio', 'daemon'].includes(transport)) throw new Error('Expected --transport stdio or --transport daemon');

const root = mkdtempSync(join(tmpdir(), 'quotaflow-preflight-'));
const server = new AppServer(executable, [], { cwd: root, transport });
const result = {
  inferenceCalls: 0,
  transport,
  initialize: 'not_started',
  windowsSandbox: 'not_checked',
  commandExec: { status: 'not_run' },
};

try {
  const initialize = await server.initialize({ experimentalApi: true });
  result.initialize = initialize.value ? 'ok' : initialize.code ?? 'failed';
  if (!initialize.value) throw new Error('App Server initialize failed');

  const runtime = await probeAppServerRuntime(server, root);
  result.shell = runtime.shell;
  result.windowsSandbox = runtime.windowsSandbox;
  result.commandExec = runtime.commandExec;

  if (result.commandExec.status !== 'completed' || result.commandExec.exitCode !== 0 || !result.commandExec.fileWritten) {
    process.exitCode = 1;
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : 'preflight_failed';
  if (server.stderr.trim()) result.serverStderr = server.stderr.trim().slice(-1_500);
  process.exitCode = 1;
} finally {
  await server.close();
  if (keep) result.workspace = root;
  else clean(root);
  console.log(JSON.stringify(result));
}
