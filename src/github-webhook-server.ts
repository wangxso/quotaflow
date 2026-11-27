import {
  githubEventKey,
  normalizeGitHubWebhook,
  verifyGitHubWebhookSignature,
  type GitHubWebhookEvent,
} from './github';
import type { TaskStore } from './store';

export const maxGitHubWebhookBytes = 2_000_000;

export interface GitHubWebhookHandlerOptions {
  store: TaskStore;
  secret: string;
  path: string;
}

export interface GitHubWebhookServerOptions extends GitHubWebhookHandlerOptions {
  host: string;
  port: number;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxGitHubWebhookBytes) return null;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxGitHubWebhookBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createGitHubWebhookHandler(options: GitHubWebhookHandlerOptions) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return json({ status: 'ok' });
    if (url.pathname !== options.path) return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const eventType = request.headers.get('x-github-event')?.trim().toLowerCase();
    const deliveryId = request.headers.get('x-github-delivery')?.trim();
    const signature = request.headers.get('x-hub-signature-256')?.trim();
    if (!eventType || !deliveryId || !signature) return json({ error: 'missing_github_headers' }, 400);
    const rawBody = await readLimitedBody(request);
    if (rawBody === null) return json({ error: 'payload_too_large' }, 413);
    if (!verifyGitHubWebhookSignature(options.secret, rawBody, signature)) {
      return json({ error: 'invalid_signature' }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (eventType === 'ping') return json({ status: 'pong', deliveryId }, 200);
    let event: GitHubWebhookEvent;
    try {
      event = normalizeGitHubWebhook(eventType, payload, rawBody);
    } catch (error) {
      const unsupported = error instanceof Error && error.message.includes('Unsupported GitHub webhook event');
      return json({ error: unsupported ? 'unsupported_event' : 'invalid_payload' }, unsupported ? 422 : 400);
    }
    const baseDelivery = {
      eventType: event.eventType,
      repository: event.repository,
      pullNumber: event.pullNumber,
      headSha: event.headSha,
      payloadHash: event.payloadHash,
    };
    try {
      const delivery = options.store.recordGitHubDelivery({
        ...baseDelivery,
        deliveryId,
        eventKey: githubEventKey(baseDelivery),
      });
      const duplicate = delivery.duplicateDelivery || delivery.duplicateEvent;
      return json({
        status: duplicate ? 'duplicate' : 'accepted',
        event: {
          type: event.eventType,
          action: event.action,
          repository: event.repository,
          pullNumber: event.pullNumber,
          headSha: event.headSha,
        },
        delivery,
      }, duplicate ? 200 : 202);
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes('reused with different content');
      return json({ error: conflict ? 'delivery_conflict' : 'storage_error' }, conflict ? 409 : 500);
    }
  };
}

export function startGitHubWebhookServer(options: GitHubWebhookServerOptions) {
  return Bun.serve({
    hostname: options.host,
    port: options.port,
    maxRequestBodySize: maxGitHubWebhookBytes + 64,
    fetch: createGitHubWebhookHandler(options),
  });
}
