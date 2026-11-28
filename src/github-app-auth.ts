import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GitHubAppConfig } from './domain';

type GitHubAppFetcher = typeof fetch;

export interface GitHubAppTokenProviderOptions {
  fetcher?: GitHubAppFetcher;
  now?: () => number;
}

type CachedToken = {
  token: string;
  expiresAt: number;
};

function apiBase(config: GitHubAppConfig): string {
  const value = config.apiUrl ?? 'https://api.github.com';
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('GitHub App API URL must use HTTPS or loopback HTTP without credentials, query or fragment');
  }
  return value.replace(/\/+$/, '');
}

export class GitHubAppTokenProvider {
  readonly #config: GitHubAppConfig;
  readonly #fetcher: GitHubAppFetcher;
  readonly #now: () => number;
  #cached: CachedToken | null = null;
  #pending: Promise<CachedToken> | null = null;

  constructor(config: GitHubAppConfig, options: GitHubAppTokenProviderOptions = {}) {
    this.#config = config;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const now = this.#now();
    if (this.#cached && this.#cached.expiresAt > now + 60_000) return this.#cached.token;
    if (!this.#pending) {
      this.#pending = this.#requestToken().finally(() => {
        this.#pending = null;
      });
    }
    return (await this.#pending).token;
  }

  async #requestToken(): Promise<CachedToken> {
    const nowSeconds = Math.floor(this.#now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: this.#config.appId,
    })}`;
    const privateKey = createPrivateKey(readFileSync(this.#config.privateKeyPath));
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
    const url = `${apiBase(this.#config)}/app/installations/${this.#config.installationId}/access_tokens`;
    const response = await this.#fetcher(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'User-Agent': 'quotaflow',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: '{}',
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`GitHub App installation token request failed (${response.status})`);
    }
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && !Array.isArray(payload)
        && typeof (payload as Record<string, unknown>).message === 'string'
        ? `: ${(payload as Record<string, unknown>).message}`
        : '';
      throw new Error(`GitHub App installation token request failed (${response.status})${message}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('GitHub App installation token response must be an object');
    }
    const body = payload as Record<string, unknown>;
    if (typeof body.token !== 'string' || !body.token) throw new Error('GitHub App installation token is missing');
    if (typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))) {
      throw new Error('GitHub App installation token expiry is invalid');
    }
    const cached = {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    };
    this.#cached = cached;
    return cached;
  }
}
