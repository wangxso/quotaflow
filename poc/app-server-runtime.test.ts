import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAppServerRuntime } from './app-server-runtime.mjs';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'quotaflow-runtime-test-'));
}

function targetFrom(script: string) {
  const match = /WriteAllText\('((?:''|[^'])*)'/.exec(script);
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
          writeFileSync(targetFrom(params.command.at(-1)), '41');
          return { value: { exitCode: 0, stdout: '', stderr: '' } };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    };
    const result = await probeAppServerRuntime(server, root);
    expect(result.inferenceCalls).toBe(0);
    expect(result.windowsSandbox).toBe('ready');
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
    expect(result.windowsSandbox).toBe('unavailable');
    expect(result.commandExec).toEqual({ status: 'error', code: 'server_closed' });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
