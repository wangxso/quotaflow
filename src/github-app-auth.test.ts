import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubAppTokenProvider } from './github-app-auth';

function privateKeyFile(root: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = join(root, 'app.pem');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return file;
}

test('creates and caches a GitHub App installation token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-app-auth-'));
  try {
    const privateKeyPath = privateKeyFile(root);
    let requests = 0;
    let authorization = '';
    const provider = new GitHubAppTokenProvider({
      appId: 123,
      installationId: 456,
      privateKeyPath,
    }, {
      now: () => Date.parse('2026-11-28T00:00:00Z'),
      fetcher: async (_input, init) => {
        requests += 1;
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json({
          token: 'installation-token',
          expires_at: '2026-11-28T01:00:00Z',
        });
      },
    });
    expect(await provider.getToken()).toBe('installation-token');
    expect(await provider.getToken()).toBe('installation-token');
    expect(requests).toBe(1);
    expect(authorization).toStartWith('Bearer ');
    expect(authorization).not.toContain('installation-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surfaces safe installation token errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quotaflow-app-auth-'));
  try {
    const provider = new GitHubAppTokenProvider({
      appId: 123,
      installationId: 456,
      privateKeyPath: privateKeyFile(root),
    }, {
      fetcher: async () => Response.json({ message: 'Not Found' }, { status: 404 }),
    });
    await expect(provider.getToken()).rejects.toThrow(
      'GitHub App installation token request failed (404): Not Found',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
