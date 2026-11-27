import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessStopUnverifiedError, type AgentAdapter, type AgentContext, type AgentResult } from './agent';
import type { LaneConfig, UsageReport } from './domain';
import { reconcileMagpieUsage, usageActualModel } from './magpie-usage';
import {
  launchSupervised,
  type SupervisorOptions,
  type SupervisorOutcome,
  type SupervisorStop,
} from './supervisor';

type OpenCodeEvent = {
  type?: string;
  text?: string;
  model?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    reason?: string;
    model?: string;
    tokens?: unknown;
    cost?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenCodeRunner = (
  command: string[],
  cwd: string,
  statusDir: string,
  options?: SupervisorOptions,
) => Promise<{ stop: SupervisorStop; outcome: SupervisorOutcome | null }>;

export type OpenCodeUsageLookup = typeof reconcileMagpieUsage;

const providerId = 'magpie';
const providerPackage = '@ai-sdk/openai-compatible';

const runGuardedOpenCode: OpenCodeRunner = (command, cwd, statusDir, options) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Supervised OpenCode requires Windows, macOS, or Linux');
  }
  return launchSupervised(command, cwd, statusDir, options);
};

function openCodeModel(lane: LaneConfig): { modelId: string; fullModel: string } {
  if (lane.provider !== providerId) {
    throw new Error(`OpenCode adapter currently requires a Magpie lane, received ${lane.provider}`);
  }
  const modelId = lane.model.startsWith(`${providerId}/`)
    ? lane.model.slice(providerId.length + 1)
    : lane.model;
  if (!modelId) throw new Error('OpenCode lane model must not be empty');
  return { modelId, fullModel: `${providerId}/${modelId}` };
}

function parseEvents(log: string): { events: OpenCodeEvent[]; diagnostics: string } {
  const events: OpenCodeEvent[] = [];
  const diagnostics: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as OpenCodeEvent);
      } else {
        diagnostics.push(trimmed);
      }
    } catch {
      diagnostics.push(trimmed);
    }
  }
  return { events, diagnostics: diagnostics.join('\n').slice(-4_000) };
}

function sessionId(events: OpenCodeEvent[]): string | undefined {
  for (const event of events) {
    if (typeof event.sessionID === 'string' && event.sessionID) return event.sessionID;
  }
  return undefined;
}

function isQuotaFailure(log: string): boolean {
  return /\b(429|quota|rate[-\s]?limit|usage limit|insufficient (?:credit|balance)|capacity)\b/i.test(log);
}

function outputText(events: OpenCodeEvent[]): string | undefined {
  const parts: string[] = [];
  for (const event of events) {
    if (event.part?.type === 'text' && typeof event.part.text === 'string') {
      parts.push(event.part.text);
    } else if (event.type === 'text' && typeof event.text === 'string') {
      parts.push(event.text);
    }
  }
  const output = parts.join('\n').trim().slice(0, 50_000);
  return output || undefined;
}

export class OpenCodeAgent implements AgentAdapter {
  readonly id: string;
  readonly supportsReadOnly = true;
  readonly maxPromptLength = 24_000;
  readonly #lane: LaneConfig;
  readonly #runner: OpenCodeRunner;
  readonly #usage: OpenCodeUsageLookup;

  constructor(
    lane: LaneConfig,
    runner: OpenCodeRunner = runGuardedOpenCode,
    usage: OpenCodeUsageLookup = reconcileMagpieUsage,
  ) {
    this.id = `opencode:${lane.id}`;
    this.#lane = lane;
    this.#runner = runner;
    this.#usage = usage;
  }

  async run(context: AgentContext): Promise<AgentResult> {
    const baseUrl = this.#lane.baseUrl;
    if (!baseUrl) throw new Error(`OpenCode lane ${this.#lane.id} requires baseUrl`);
    const readOnly = context.task.accessMode === 'read_only';
    const prompt = context.handoff?.prompt ?? context.task.prompt;
    if (prompt.length > this.maxPromptLength) {
      throw new Error('Task prompt exceeds the OpenCode Windows command-line limit');
    }

    const { modelId, fullModel } = openCodeModel(this.#lane);
    const profile = join(context.attemptDir, 'opencode');
    const configRoot = join(profile, 'config');
    const cacheRoot = join(profile, 'cache');
    const dataRoot = join(profile, 'data');
    const stateRoot = join(profile, 'state');
    const configFile = join(configRoot, 'opencode.json');
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(cacheRoot, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });

    const config = {
      $schema: 'https://opencode.ai/config.json',
      enabled_providers: [providerId],
      model: fullModel,
      small_model: fullModel,
      share: 'disabled',
      snapshot: false,
      autoupdate: false,
      permission: {
        '*': 'deny',
        read: 'allow',
        edit: readOnly ? 'deny' : 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        bash: readOnly ? 'deny' : 'allow',
        task: 'deny',
        external_directory: !readOnly && context.handoff
          ? { '*': 'deny', [join(context.handoff.directory, '*')]: 'allow' }
          : 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        codesearch: 'deny',
        skill: 'deny',
      },
      provider: {
        [providerId]: {
          name: 'Magpie',
          npm: providerPackage,
          options: {
            apiKey: 'magpie',
            baseURL: baseUrl.replace(/\/+$/, ''),
            setCacheKey: true,
          },
          models: {
            [modelId]: {
              name: modelId,
              tool_call: true,
            },
          },
        },
      },
    };
    writeFileSync(configFile, JSON.stringify(config, null, 2));

    const env: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('OPENCODE_')
        || key.startsWith('MAGPIE_')
        || /^(?:OPENAI|CODEX|ANTHROPIC|GEMINI|GOOGLE|OPENROUTER)_(?:API_KEY|BASE_URL|ORG_ID|PROJECT_ID)$/.test(key)
      ) {
        env[key] = undefined;
      }
    }
    Object.assign(env, {
      OPENCODE_CONFIG: configFile,
      OPENCODE_CONFIG_DIR: configRoot,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DB: join(profile, 'opencode.db'),
      OPENCODE_PURE: '1',
      XDG_CONFIG_HOME: configRoot,
      XDG_CACHE_HOME: cacheRoot,
      XDG_DATA_HOME: dataRoot,
      XDG_STATE_HOME: stateRoot,
      NO_COLOR: '1',
    });

    const command = [
      this.#lane.executable ?? 'opencode',
      'run',
      '--pure',
      '--format',
      'json',
      '--model',
      fullModel,
      '--dir',
      context.workspacePath,
      prompt,
    ];
    const { stop } = await this.#runner(command, context.workspacePath, context.attemptDir, {
      env,
      timeoutMs: this.#lane.timeoutMs ?? 300_000,
      signal: context.signal,
    });
    if (stop.activeProcesses !== 0) {
      throw new ProcessStopUnverifiedError('OpenCode supervisor did not confirm an empty process set');
    }
    if (context.signal?.aborted) {
      return {
        status: 'cancelled',
        reason: 'cancelled_by_operator',
        tests: 'not_run',
        activeProcesses: stop.activeProcesses,
      };
    }

    const log = readFileSync(join(context.attemptDir, 'worker.log'), 'utf8');
    const { events, diagnostics } = parseEvents(log);
    const finishes = events.filter((event) => event.type === 'step_finish');
    const errors = events.filter((event) => event.type === 'error' || event.part?.type === 'error');
    if (stop.exitCode !== 0) {
      const quota = isQuotaFailure(`${log}\n${diagnostics}`);
      return {
        status: quota ? 'waiting_quota' : 'failed',
        reason: quota ? 'opencode_quota' : `opencode_exit_${stop.exitCode ?? 'unknown'}`,
        tests: 'not_run',
        retryAfterMs: quota ? 60_000 : undefined,
        activeProcesses: stop.activeProcesses,
      };
    }
    if (errors.length > 0) {
      return { status: 'failed', reason: 'opencode_event_error', tests: 'not_run', activeProcesses: stop.activeProcesses };
    }
    if (finishes.length === 0) {
      return { status: 'failed', reason: 'opencode_missing_step_finish', tests: 'not_run', activeProcesses: stop.activeProcesses };
    }

    const endedAt = Date.now();
    const openCodeSession = sessionId(events);
    let usage: UsageReport;
    if (!openCodeSession) {
      usage = {
        source: 'magpie',
        status: 'unavailable',
        sessionId: null,
        queryWindow: { start: context.attempt.startedAt, end: endedAt },
        rows: [],
        priced: null,
        providerInvoice: 'UNKNOWN',
        error: 'OpenCode output did not include a session ID',
      };
    } else {
      try {
        usage = await this.#usage({
          baseUrl,
          sessionId: openCodeSession,
          startedAt: context.attempt.startedAt,
          endedAt,
        });
      } catch (error) {
        usage = {
          source: 'magpie',
          status: 'unavailable',
          sessionId: openCodeSession,
          queryWindow: { start: context.attempt.startedAt, end: endedAt },
          rows: [],
          priced: null,
          providerInvoice: 'UNKNOWN',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const actualModel = usageActualModel(usage);
    const output = outputText(events);
    return {
      status: 'completed',
      reason: 'opencode_run_completed',
      tests: 'not_run',
      activeProcesses: stop.activeProcesses,
      ...(actualModel ? { actualModel } : {}),
      ...(output ? { output } : {}),
      usage,
    };
  }
}
