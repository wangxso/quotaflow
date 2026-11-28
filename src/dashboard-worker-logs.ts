import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { EventRecord } from './domain';
import { redactSensitiveText } from './github-ci';

export const MAX_DASHBOARD_WORKER_LOG_BYTES = 64 * 1024;
export const dashboardRequestIdPattern = /^[A-Za-z0-9._-]{8,100}$/;

export interface DashboardWorkerRun {
  requestId: string;
  state: 'requested' | 'started' | 'exited' | 'failed';
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  requestedAt: number;
  startedAt: number | null;
  exitedAt: number | null;
  logAvailable: boolean;
  logBytes: number | null;
  logModifiedAt: number | null;
}

export interface DashboardWorkerLog {
  text: string;
  bytes: number;
  sourceBytes: number;
  truncated: boolean;
  modifiedAt: number;
}

interface OpenLog {
  descriptor: number;
  bytes: number;
  modifiedAt: number;
}

function detailRecord(event: EventRecord): Record<string, unknown> {
  return event.detail && typeof event.detail === 'object'
    ? event.detail as Record<string, unknown>
    : {};
}

function stringDetail(event: EventRecord, key: string): string | null {
  const value = detailRecord(event)[key];
  return typeof value === 'string' ? value : null;
}

function numberDetail(event: EventRecord, key: string): number | null {
  const value = detailRecord(event)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function eventsForRequest(events: EventRecord[], kind: string, requestId: string): EventRecord[] {
  return events.filter((event) =>
    event.kind === kind && stringDetail(event, 'requestId') === requestId);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function logPath(directory: string, requestId: string): string {
  if (!dashboardRequestIdPattern.test(requestId)) throw new Error('Dashboard request ID is invalid');
  return join(directory, `${requestId}.log`);
}

function openWorkerLog(directory: string, requestId: string): OpenLog | null {
  const path = logPath(directory, requestId);
  let descriptor: number | null = null;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      closeSync(descriptor);
      descriptor = null;
      return null;
    }
    return {
      descriptor,
      bytes: stats.size,
      modifiedAt: stats.mtimeMs,
    };
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (errorCode(error)) return null;
    throw error;
  }
}

export function dashboardWorkerRuns(
  events: EventRecord[],
  logDirectory: string | undefined,
): DashboardWorkerRun[] {
  const starts = events.filter((event) =>
    event.kind === 'dashboard_action'
    && stringDetail(event, 'action') === 'start'
    && dashboardRequestIdPattern.test(stringDetail(event, 'requestId') ?? ''));

  return starts
    .slice()
    .reverse()
    .map((request) => {
      const requestId = stringDetail(request, 'requestId')!;
      const started = eventsForRequest(events, 'dashboard_worker_started', requestId).at(-1);
      const exited = eventsForRequest(events, 'dashboard_worker_exited', requestId).at(-1);
      const failed = eventsForRequest(events, 'dashboard_worker_spawn_failed', requestId).at(-1);
      const exitError = exited ? stringDetail(exited, 'error') : null;
      const exitCode = exited ? numberDetail(exited, 'exitCode') : null;
      const log = logDirectory ? openWorkerLog(logDirectory, requestId) : null;
      if (log) closeSync(log.descriptor);
      const runError = failed ? stringDetail(failed, 'error') : exitError;
      return {
        requestId,
        state: failed || exitError || (exitCode !== null && exitCode !== 0)
          ? 'failed'
          : exited
            ? 'exited'
            : started
              ? 'started'
              : 'requested',
        pid: started ? numberDetail(started, 'pid') : failed ? numberDetail(failed, 'pid') : null,
        exitCode,
        error: runError ? cleanTerminalOutput(runError) : null,
        requestedAt: numberDetail(request, 'now') ?? request.createdAt,
        startedAt: started ? numberDetail(started, 'now') ?? started.createdAt : null,
        exitedAt: exited
          ? numberDetail(exited, 'now') ?? exited.createdAt
          : failed
            ? numberDetail(failed, 'now') ?? failed.createdAt
            : null,
        logAvailable: log !== null,
        logBytes: log?.bytes ?? null,
        logModifiedAt: log?.modifiedAt ?? null,
      };
    });
}

function cleanTerminalOutput(value: string): string {
  const terminalText = value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return redactSensitiveText(terminalText);
}

export function readDashboardWorkerLog(
  directory: string,
  requestId: string,
): DashboardWorkerLog | null {
  const opened = openWorkerLog(directory, requestId);
  if (!opened) return null;
  try {
    const start = Math.max(0, opened.bytes - MAX_DASHBOARD_WORKER_LOG_BYTES);
    const buffer = Buffer.alloc(opened.bytes - start);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(
        opened.descriptor,
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      );
      if (read === 0) break;
      offset += read;
    }
    return {
      text: cleanTerminalOutput(buffer.subarray(0, offset).toString('utf8')),
      bytes: offset,
      sourceBytes: opened.bytes,
      truncated: start > 0,
      modifiedAt: opened.modifiedAt,
    };
  } finally {
    closeSync(opened.descriptor);
  }
}
