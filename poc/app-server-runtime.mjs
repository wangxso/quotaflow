import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function findPowerShell() {
  const requested = process.env.QUOTAFLOW_PREFLIGHT_SHELL;
  if (requested) return requested;
  const found = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean) ?? 'pwsh.exe' : 'powershell.exe';
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function removeProbe(target) {
  if (!existsSync(target)) return;
  if (!lstatSync(target).isFile()) throw new Error('Runtime probe target is not a regular file');
  unlinkSync(target);
}

export async function probeAppServerRuntime(server, workspace) {
  const windows = process.platform === 'win32';
  const shell = windows ? findPowerShell() : '/bin/sh';
  const root = realpathSync(workspace);
  const target = join(root, `.quotaflow-runtime-${process.pid}-${Date.now()}.tmp`);
  const result = {
    inferenceCalls: 0,
    shell,
    windowsSandbox: 'not_checked',
    commandExec: { status: 'not_run' },
  };

  try {
    removeProbe(target);
    let command;
    if (windows) {
      const readiness = await server.call('windowsSandbox/readiness', {}, 10_000);
      result.windowsSandbox = readiness.value?.status ?? readiness.code ?? 'unknown';
      const script = `[IO.File]::WriteAllText(${quotePowerShell(target)}, '41'); `
        + `if ((Get-Content -Raw -LiteralPath ${quotePowerShell(target)}).Trim() -ne '41') { exit 9 }`;
      command = [shell, '-NoProfile', '-NonInteractive', '-Command', script];
    } else {
      command = [shell, '-c', 'printf "41\\n" > "$1" && test "$(cat "$1")" = 41', 'quotaflow-preflight', target];
    }

    const execution = await server.call('command/exec', {
      command,
      cwd: root,
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [root],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      timeoutMs: 15_000,
    }, 20_000);

    if (execution.value) {
      result.commandExec = {
        status: 'completed',
        exitCode: execution.value.exitCode,
        stdout: String(execution.value.stdout ?? '').slice(-1_000),
        stderr: String(execution.value.stderr ?? '').slice(-1_000),
        fileWritten: existsSync(target) && readFileSync(target, 'utf8').trim() === '41',
      };
    } else {
      result.commandExec = { status: 'error', code: execution.code ?? 'unknown' };
    }
    return result;
  } finally {
    removeProbe(target);
  }
}
