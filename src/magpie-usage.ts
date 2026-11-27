import type { UsageObservation, UsageReport } from './domain';

type MagpieRow = Record<string, unknown>;

export type MagpieUsageFetcher = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface MagpieUsageInput {
  baseUrl: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  fetchImpl?: MagpieUsageFetcher;
  limit?: number;
  timeoutMs?: number;
}

const clockSkewMs = 60_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tokenCount(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function observedAt(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function observation(row: MagpieRow, sessionId: string): UsageObservation | null {
  const time = observedAt(row.t);
  if (time === null || row.session !== sessionId) return null;
  return {
    source: 'magpie',
    sourceRequestId: text(row.response_id),
    observedAt: time,
    provider: text(row.provider),
    providerName: text(row.providerName),
    agent: text(row.agent),
    sessionId,
    requestModel: text(row.req),
    servedModel: text(row.served),
    httpStatus: finiteNumber(row.status),
    stopReason: text(row.stop),
    inputTokens: tokenCount(row.in),
    outputTokens: tokenCount(row.out),
    cacheReadTokens: tokenCount(row.cache_read),
    cacheWriteTokens: tokenCount(row.cache_write),
    reasoningTokens: tokenCount(row.reasoning),
    costEstimate: finiteNumber(row.cost),
    priced: booleanValue(row.priced),
    providerInvoice: 'UNKNOWN',
  };
}

function aggregate(rows: UsageObservation[]): Pick<UsageReport, 'actualModel' | 'costEstimate' | 'priced'> {
  const servedModels = new Set(
    rows.map((row) => row.servedModel).filter((model): model is string => Boolean(model)),
  );
  const costs = rows
    .map((row) => row.costEstimate)
    .filter((cost): cost is number => cost !== null);
  return {
    ...(servedModels.size === 1 ? { actualModel: [...servedModels][0] } : {}),
    ...(costs.length > 0 ? { costEstimate: costs.reduce((total, cost) => total + cost, 0) } : {}),
    priced: rows.length > 0 && rows.every((row) => row.priced === true),
  };
}

function reportUrl(input: MagpieUsageInput): string {
  const base = new URL(input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`);
  const url = new URL('magpie/usage/requests', base);
  url.searchParams.set('period', '30d');
  url.searchParams.set('limit', String(input.limit ?? 1000));
  url.searchParams.set('agent', 'opencode');
  url.searchParams.set('q', input.sessionId);
  return url.toString();
}

export async function reconcileMagpieUsage(input: MagpieUsageInput): Promise<UsageReport> {
  const start = input.startedAt - clockSkewMs;
  const end = input.endedAt + clockSkewMs;
  const queryWindow = { start, end };
  const baseReport = {
    source: 'magpie',
    sessionId: input.sessionId,
    queryWindow,
    rows: [] as UsageObservation[],
    priced: null,
    providerInvoice: 'UNKNOWN' as const,
  };

  try {
    const fetcher: MagpieUsageFetcher = input.fetchImpl ?? ((url, init) => fetch(url, init));
    const response = await fetcher(reportUrl(input), {
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      return {
        ...baseReport,
        status: 'unavailable',
        error: `Magpie usage returned HTTP ${response.status}`,
      };
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ...baseReport, status: 'unavailable', error: 'Magpie usage returned an invalid payload' };
    }
    const raw = payload as Record<string, unknown>;
    if (!Array.isArray(raw.rows)) {
      return { ...baseReport, status: 'unavailable', error: 'Magpie usage payload has no rows array' };
    }
    const rows = raw.rows
      .filter((row): row is MagpieRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
      .map((row) => observation(row, input.sessionId))
      .filter((row): row is UsageObservation => row !== null)
      .filter((row) => row.observedAt >= start && row.observedAt <= end)
      .sort((left, right) => left.observedAt - right.observedAt);
    const totalRows = finiteNumber(raw.total);
    const truncated = totalRows !== null && totalRows > raw.rows.length;
    if (rows.length === 0) {
      return {
        ...baseReport,
        status: 'not_found',
        ...(totalRows === null ? {} : { totalRows }),
        ...(truncated ? { truncated } : {}),
        error: `No Magpie request rows matched session ${input.sessionId} in the attempt window`,
      };
    }
    return {
      ...baseReport,
      status: 'recorded',
      rows,
      ...aggregate(rows),
      ...(totalRows === null ? {} : { totalRows }),
      ...(truncated ? { truncated } : {}),
    };
  } catch (error) {
    return {
      ...baseReport,
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function usageActualModel(report?: UsageReport): string | undefined {
  if (!report || report.status !== 'recorded') return undefined;
  const models = new Set(
    report.rows
      .map((row) => row.servedModel)
      .filter((model): model is string => Boolean(model)),
  );
  return models.size === 1 ? [...models][0] : undefined;
}
