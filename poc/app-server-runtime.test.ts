import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAppServerRuntime } from './app-server-runtime.mjs';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'quotaflow-runtime-test-'));
}

function targetFrom(command: string[]) {
  const last = command.at(-1)!;
  if (process.platform !== 'win32') return last;
  const match = /WriteAllText\('((?:''|[^'])*)'/.exec(last);
  if (!match) throw new Error('Probe script does not contain a target path');
  return match[1].replaceAll("''", "'");
}

test('runtime probe writes through command/exec without model inference and removes its fixture', async () => {
  const root = workspace();
  try {
    const server = {
      async call(method: string, params: any) {
        if (method === 'windowsSandbox/readiness') return { value: { status: 'ready' } };
        if (method === 'command/exec') {
          expect(params.cwd).toBe(realpathSync(root));
          expect(params.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [realpathSync(root)] });
          writeFileSync(targetFrom(params.command), '41');
          return { value: { exitCode: 0, stdout: '', stderr: '' } };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    };
    const result = await probeAppServerRuntime(server, root);
    expect(result.inferenceCalls).toBe(0);
    expect(result.windowsSandbox).toBe(process.platform === 'win32' ? 'ready' : 'not_checked');
    expect(result.commandExec).toMatchObject({ status: 'completed', exitCode: 0, fileWritten: true });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime probe reports a failed command without leaving a fixture', async () => {
  const root = workspace();
  try {
    const server = {
      async call(method: string) {
        if (method === 'windowsSandbox/readiness') return { code: 'unavailable' };
        if (method === 'command/exec') return { code: 'server_closed' };
        throw new Error(`Unexpected method: ${method}`);
      },
    };
    const result = await probeAppServerRuntime(server, root);
    expect(result.windowsSandbox).toBe(process.platform === 'win32' ? 'unavailable' : 'not_checked');
    expect(result.commandExec).toEqual({ status: 'error', code: 'server_closed' });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only runtime probe checks workspace access without writing', async () => {
  const root = workspace();
  try {
    const server = {
      async call(method: string, params: any) {
        expect(method).toBe('command/exec');
        expect(params.cwd).toBe(realpathSync(root));
        expect(params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
        return { value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    };
    const result = await probeAppServerRuntime(server, root, { readOnly: true });
    expect(result.commandExec).toMatchObject({
      status: 'completed',
      exitCode: 0,
      fileWritten: false,
      workspaceRead: true,
    });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
