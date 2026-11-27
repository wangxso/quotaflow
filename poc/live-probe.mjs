import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

class AppServer {
  #child;
  #id = 0;
  #pending = new Map();
  #notifications = [];
  #closed = false;

  constructor(executable, args = [], options = {}) {
    this.#child = spawn(executable, ['app-server', '--listen', 'stdio://', ...args], {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => {});
    this.#child.on('error', () => this.#failPending('spawn_failed'));
    this.#child.on('close', () => {
      this.#closed = true;
      this.#failPending('server_closed');
    });
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id === undefined) {
        this.#notifications.push(message);
        if (this.#notifications.length > 256) this.#notifications.shift();
      } else if (message.method && message.id !== undefined) {
        this.#write({ id: message.id, error: { code: -32601, message: 'Host requests are disabled in this probe' } });
      } else if (this.#pending.has(message.id)) {
        const complete = this.#pending.get(message.id);
        complete(message.error ? { code: message.error.code } : { value: message.result });
      }
    });
  }

  #write(message) {
    if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #failPending(code) {
    for (const complete of this.#pending.values()) complete({ code });
  }

  call(method, params = {}, timeout = 12_000) {
    const id = ++this.#id;
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ code: 'timeout' }), timeout);
      this.#pending.set(id, finish);
      this.#write({ id, method, params });
    });
  }

  async initialize() {
    const result = await this.call('initialize', {
      clientInfo: { name: 'quotaflow_phase0', title: 'QuotaFlow Phase 0', version: '0.1.0' },
    });
    if (result.value) this.#write({ method: 'initialized' });
    return result;
  }

  async notification(method, filter, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = this.#notifications.find((event) => event.method === method && filter(event.params));
      if (found) return found.params;
      if (this.#child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async close() {
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode) return;
    const closed = once(this.#child, 'close').catch(() => {});
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 2500);
    await closed;
    clearTimeout(timer);
  }
}

function windows(snapshot) {
  return [snapshot?.primary, snapshot?.secondary].filter(Boolean).map((entry) => ({
    usedPercent: Number.isFinite(entry.usedPercent) ? entry.usedPercent : 'UNKNOWN',
    durationMins: entry.windowDurationMins ?? 'UNKNOWN',
    resetsAtKnown: Number.isFinite(entry.resetsAt),
  }));
}

async function probeCodex(executable) {
  const server = new AppServer(executable);
  try {
    const initialize = await server.initialize();
    if (!initialize.value) return { initialize: initialize.code ?? 'UNKNOWN' };
    const account = await server.call('account/read', { refreshToken: false });
    const auth = account.value?.account;
    const caps = await server.call('account/rateLimits/read', {}, 15_000);
    const limits = caps.value?.rateLimits;
    return {
      initialize: 'ok',
      account: { type: auth?.type ?? (account.code ?? 'none'), plan: auth?.planType ?? 'UNKNOWN' },
      rateLimits: {
        status: limits ? 'ok' : (caps.code ?? 'UNKNOWN'),
        windows: windows(limits),
        observedBuckets: Object.keys(caps.value?.rateLimitsByLimitId ?? {}).length,
        credits: limits?.credits ? { hasCredits: limits.credits.hasCredits, unlimited: limits.credits.unlimited } : 'UNKNOWN',
        ordinaryUsageAllowed: caps.value?.ordinaryUsageAllowed ?? 'UNKNOWN',
      },
      inferenceCalls: 0,
    };
  } finally {
    await server.close();
  }
}

const paths = {
  catalog: '/v1/models',
  quota: '/v1/magpie/quotas',
  quotaHistory: '/v1/magpie/quotas/history?limit=1',
  accounts: '/v1/magpie/accounts',
  usage: '/v1/magpie/usage?period=today',
  requests: '/v1/magpie/usage/requests?limit=1',
  concurrency: '/v1/magpie/concurrency',
  routeSnapshot: '/v1/magpie/route-events/snapshot',
  admin: '/v1/magpie/admin/providers',
};

const knownFields = new Set([
  'accounts', 'active', 'cards', 'codes', 'cost', 'cursor', 'data', 'entries', 'events', 'groups',
  'history', 'input', 'items', 'limit', 'models', 'object', 'output', 'period', 'points', 'providers',
  'quotas', 'requests', 'routes', 'summary', 'tokens', 'tools', 'totals', 'usage', 'waiting', 'windows',
]);

function summary(value) {
  if (Array.isArray(value)) return { entries: value.length };
  if (!value || typeof value !== 'object') return {};
  const result = { fields: Object.keys(value).filter((key) => knownFields.has(key)).sort() };
  for (const key of result.fields) if (Array.isArray(value[key])) result[key] = value[key].length;
  if ('data' in value && Array.isArray(value.data)) {
    result.routingGroupModels = value.data.filter((item) => /^group\//.test(item?.id ?? '')).length;
  }
  return result;
}

async function probeMagpie(address) {
  const base = new URL(address);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
    throw new Error('Use an HTTP address bound to 127.0.0.1');
  }
  const token = process.env.QUOTAFLOW_MAGPIE_READ_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let cursor;
  const results = await Promise.all(Object.entries(paths).map(async ([name, path]) => {
    try {
      const response = await fetch(new URL(path, base), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok || name === 'admin') {
        await response.body?.cancel();
        return [name, { http: response.status }];
      }
      const data = await response.json();
      if (name === 'routeSnapshot') cursor = data?.cursor;
      return [name, { http: response.status, ...summary(data) }];
    } catch (error) {
      return [name, { status: error.name === 'TimeoutError' ? 'timeout' : 'unavailable' }];
    }
  }));
  if (typeof cursor === 'string' || typeof cursor === 'number') {
    try {
      const address = new URL('/v1/magpie/route-events', base);
      address.searchParams.set('after', String(cursor));
      const response = await fetch(address, { headers, redirect: 'error', signal: AbortSignal.timeout(6000) });
      const sse = response.headers.get('content-type')?.startsWith('text/event-stream') ?? false;
      await response.body?.cancel();
      results.push(['routeStream', { http: response.status, sse }]);
    } catch {
      results.push(['routeStream', { status: 'unavailable' }]);
    }
  }
  return { authorization: token ? 'explicit_read_token' : 'loopback', endpoints: Object.fromEntries(results), inferenceCalls: 0 };
}

export { AppServer, probeCodex, probeMagpie };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, value] = process.argv.slice(2);
  if (mode === 'codex') console.log(JSON.stringify(await probeCodex(value ?? 'codex')));
  else if (mode === 'magpie' && value) console.log(JSON.stringify(await probeMagpie(value)));
  else throw new Error('Usage: node live-probe.mjs codex [exe] | magpie http://127.0.0.1:PORT');
}
