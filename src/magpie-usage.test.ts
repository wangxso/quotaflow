import { expect, test } from 'bun:test';
import { reconcileMagpieUsage, usageActualModel } from './magpie-usage';

const sessionId = 'ses_test';
const startedAt = Date.parse('2026-11-27T15:48:04.000+08:00');
const endedAt = Date.parse('2026-11-27T15:48:20.000+08:00');

function row(overrides: Record<string, unknown> = {}) {
  return {
    t: '2026-11-27T15:48:10.000+08:00',
    agent: 'opencode',
    provider: 'opencode-go',
    providerName: 'OpenCode Go',
    req: 'opencode-go/hy4-flash-free',
    served: 'hy4-flash-free',
    in: 100,
    out: 20,
    cache_read: 10,
    cache_write: 0,
    reasoning: 0,
    status: 200,
    stop: 'stop',
    response_id: 'request-1',
    session: sessionId,
    cost: 0,
    priced: true,
    ...overrides,
  };
}

test('filters Magpie usage by session and attempt window', async () => {
  let requested = '';
  const report = await reconcileMagpieUsage({
    baseUrl: 'http://127.0.0.1:3425/v1',
    sessionId,
    startedAt,
    endedAt,
    fetchImpl: async (url) => {
      requested = url;
      return new Response(JSON.stringify({
        total: 3,
        rows: [
          row({ t: '2026-11-27T15:48:07.000+08:00', response_id: 'request-1', cost: 0.001 }),
          row({ t: '2026-11-27T15:48:15.000+08:00', response_id: 'request-2', cost: 0.002 }),
          row({ t: '2026-11-27T15:48:10.000+08:00', session: 'unrelated' }),
        ],
      }), { status: 200 });
    },
  });

  const url = new URL(requested);
  expect(url.pathname).toBe('/v1/magpie/usage/requests');
  expect(url.searchParams.get('agent')).toBe('opencode');
  expect(url.searchParams.get('q')).toBe(sessionId);
  expect(url.searchParams.get('period')).toBe('30d');
  expect(report).toMatchObject({
    status: 'recorded',
    actualModel: 'hy4-flash-free',
    costEstimate: 0.003,
    priced: true,
    providerInvoice: 'UNKNOWN',
  });
  expect(report.rows.map((entry) => entry.sourceRequestId)).toEqual(['request-1', 'request-2']);
});

test('does not invent an actual model when served models are mixed', async () => {
  const report = await reconcileMagpieUsage({
    baseUrl: 'http://127.0.0.1:3425/v1',
    sessionId,
    startedAt,
    endedAt,
    fetchImpl: async () => new Response(JSON.stringify({
      total: 2,
      rows: [
        row({ response_id: 'request-1', served: 'model-a' }),
        row({ response_id: 'request-2', served: 'model-b' }),
      ],
    }), { status: 200 }),
  });

  expect(report.status).toBe('recorded');
  expect(report.actualModel).toBeUndefined();
  expect(usageActualModel(report)).toBeUndefined();
});

test('reports not_found without failing the caller', async () => {
  const report = await reconcileMagpieUsage({
    baseUrl: 'http://127.0.0.1:3425/v1',
    sessionId,
    startedAt,
    endedAt,
    fetchImpl: async () => new Response(JSON.stringify({
      total: 1,
      rows: [row({ session: 'unrelated' })],
    }), { status: 200 }),
  });

  expect(report).toMatchObject({
    status: 'not_found',
    providerInvoice: 'UNKNOWN',
    rows: [],
  });
  expect(report.error).toContain(sessionId);
});

test('returns unavailable on a non-2xx Magpie response', async () => {
  const report = await reconcileMagpieUsage({
    baseUrl: 'http://127.0.0.1:3425/v1',
    sessionId,
    startedAt,
    endedAt,
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  });

  expect(report).toMatchObject({
    status: 'unavailable',
    providerInvoice: 'UNKNOWN',
    rows: [],
  });
  expect(report.error).toContain('503');
});
