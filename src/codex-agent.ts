import { AppServer } from '../poc/live-probe.mjs';
import { probeAppServerRuntime } from '../poc/app-server-runtime.mjs';
import {
  ProcessStopUnverifiedError,
  type AgentAdapter,
  type AgentContext,
  type AgentResult,
} from './agent';
import type { LaneConfig } from './domain';
import {
  launchGuardedAppServer,
  verifySupervisedStop,
  type SupervisorStop,
} from './supervisor';

type Response = {
  value?: {
    thread?: { id?: string };
    model?: string;
    modelProvider?: string;
    turn?: { id?: string; status?: string };
    [key: string]: unknown;
  };
  code?: string | number;
};

export interface CodexServer {
  initialize(capabilities?: unknown): Promise<Response>;
  call(method: string, params?: unknown, timeout?: number): Promise<Response>;
  notification(
    method: string,
    filter: (event: { turn?: { id?: string; status?: string } }) => boolean,
    timeout?: number,
  ): Promise<{ turn?: { id?: string; status?: string } } | null>;
  close(): Promise<SupervisorStop | null>;
  readonly stderr: string;
}

export type CodexServerFactory = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; attemptDir: string },
) => CodexServer;

type RuntimePreflight = (
  server: CodexServer,
  workspace: string,
) => Promise<{
  inferenceCalls: number;
  commandExec: { status?: string; exitCode?: number; fileWritten?: boolean };
}>;

class SupervisedCodexServer implements CodexServer {
  readonly #server: CodexServer;
  readonly #statusDir: string;

  constructor(server: CodexServer, statusDir: string) {
    this.#server = server;
    this.#statusDir = statusDir;
  }

  get stderr() {
    return this.#server.stderr;
  }

  initialize(capabilities?: unknown) {
    return this.#server.initialize(capabilities);
  }

  call(method: string, params?: unknown, timeout?: number) {
    return this.#server.call(method, params, timeout);
  }

  notification(
    method: string,
    filter: (event: { turn?: { id?: string; status?: string } }) => boolean,
    timeout?: number,
  ) {
    return this.#server.notification(method, filter, timeout);
  }

  async close() {
    await this.#server.close();
    return verifySupervisedStop(this.#statusDir);
  }
}

function defaultFactory(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; attemptDir: string },
): CodexServer {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('Supervised Codex App Server requires Windows or macOS');
  }
  const command = [
    executable,
    'app-server',
    '--listen',
    'stdio://',
    ...args,
  ];
  const child = launchGuardedAppServer(command, options.cwd, options.attemptDir, {
    env: options.env,
  });
  const server = new AppServer(executable, args, { child }) as unknown as CodexServer;
  return new SupervisedCodexServer(server, options.attemptDir);
}

export class CodexAppServerAgent implements AgentAdapter {
  readonly id: string;
  readonly #lane: LaneConfig;
  readonly #factory: CodexServerFactory;
  readonly #preflight: RuntimePreflight;

  constructor(
    lane: LaneConfig,
    factory: CodexServerFactory = defaultFactory,
    preflight: RuntimePreflight = probeAppServerRuntime as RuntimePreflight,
  ) {
    this.id = `codex:${lane.id}`;
    this.#lane = lane;
    this.#factory = factory;
    this.#preflight = preflight;
  }

  async run(context: AgentContext): Promise<AgentResult> {
    const args = [
      '-c', 'model_provider="openai"',
      '-c', `model=${JSON.stringify(this.#lane.model)}`,
    ];
    if (this.#lane.baseUrl) args.push('-c', `openai_base_url=${JSON.stringify(this.#lane.baseUrl)}`);
    const env = { ...process.env };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) {
      delete env[key];
    }
    const server = this.#factory(this.#lane.executable ?? 'codex', args, {
      cwd: context.workspacePath,
      env,
      attemptDir: context.attemptDir,
    });

    let result: AgentResult | null = null;
    let failure: unknown;
    let failed = false;
    try {
      result = await this.#execute(context, server);
    } catch (error) {
      failed = true;
      failure = error;
    }

    let stop: SupervisorStop | null = null;
    try {
      stop = await server.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (stop?.activeProcesses !== 0) {
      const detail = failure instanceof Error ? `: ${failure.message}` : '';
      throw new ProcessStopUnverifiedError(`Codex App Server stop was not verified${detail}`);
    }
    if (failed) throw failure;
    if (!result) throw new Error('Codex App Server returned no result');
    return { ...result, activeProcesses: stop.activeProcesses };
  }

  async #execute(context: AgentContext, server: CodexServer): Promise<AgentResult> {
    const initialize = await server.initialize({ experimentalApi: true });
    if (!initialize.value) throw new Error(`Codex App Server initialize failed (${initialize.code ?? 'unknown'})`);
    if (context.signal?.aborted) {
      return {
        status: 'cancelled',
        reason: 'cancelled_by_operator',
        tests: 'not_run',
      };
    }
    const runtime = await this.#preflight(server, context.workspacePath);
    if (
      runtime.commandExec.status !== 'completed'
      || runtime.commandExec.exitCode !== 0
      || !runtime.commandExec.fileWritten
    ) {
      throw new Error('Codex workspace runtime preflight failed');
    }
    if (context.signal?.aborted) {
      return {
        status: 'cancelled',
        reason: 'cancelled_by_operator',
        tests: 'not_run',
      };
    }

    const started = await server.call('thread/start', {
      cwd: context.workspacePath,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      modelProvider: 'openai',
      model: this.#lane.model,
      ephemeral: false,
    });
    const threadId = started.value?.thread?.id;
    if (!threadId) throw new Error(`Codex thread creation failed (${started.code ?? 'missing thread'})`);
    if (context.signal?.aborted) {
      return {
        status: 'cancelled',
        reason: 'cancelled_by_operator',
        tests: 'not_run',
      };
    }

    const turn = await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: context.handoff?.prompt ?? context.task.prompt }],
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [context.workspacePath, ...(context.handoff ? [context.handoff.directory] : [])],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    const turnId = turn.value?.turn?.id;
    if (!turnId) throw new Error(`Codex turn start failed (${turn.code ?? 'missing turn'})`);

    let removeAbortListener = () => {};
    const interrupted = new Promise<null>((resolve) => {
      const onAbort = () => {
        void server.call('turn/interrupt', { threadId, turnId }, 10_000).catch(() => {});
        resolve(null);
      };
      if (context.signal?.aborted) {
        onAbort();
        return;
      }
      context.signal?.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => context.signal?.removeEventListener('abort', onAbort);
    });
    let completed: { turn?: { id?: string; status?: string } } | null;
    try {
      completed = await Promise.race([
        server.notification(
          'turn/completed',
          (event) => event.turn?.id === turnId,
          120_000,
        ),
        interrupted,
      ]);
    } finally {
      removeAbortListener();
    }
    if (context.signal?.aborted) {
      return {
        status: 'cancelled',
        reason: 'cancelled_by_operator',
        tests: 'not_run',
      };
    }
    if (!completed) {
      await server.call('turn/interrupt', { threadId, turnId }, 10_000);
      throw new Error('Timed out waiting for the Codex turn');
    }
    const status = completed.turn?.status;
    return {
      status: status === 'completed' ? 'completed' : 'failed',
      reason: status === 'completed' ? 'codex_turn_completed' : `codex_turn_${status ?? 'unknown'}`,
      tests: 'not_run',
      actualModel: started.value?.model ?? this.#lane.model,
    };
  }
}
