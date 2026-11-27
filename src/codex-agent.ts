import { AppServer } from '../poc/live-probe.mjs';
import { probeAppServerRuntime } from '../poc/app-server-runtime.mjs';
import type { AgentAdapter, AgentContext, AgentResult } from './agent';
import type { LaneConfig } from './domain';

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
  close(): Promise<void>;
  readonly stderr: string;
}

export type CodexServerFactory = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => CodexServer;

type RuntimePreflight = (
  server: CodexServer,
  workspace: string,
) => Promise<{
  inferenceCalls: number;
  commandExec: { status?: string; exitCode?: number; fileWritten?: boolean };
}>;

function defaultFactory(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): CodexServer {
  return new AppServer(executable, args, options) as unknown as CodexServer;
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
    });

    try {
      const initialize = await server.initialize({ experimentalApi: true });
      if (!initialize.value) throw new Error(`Codex App Server initialize failed (${initialize.code ?? 'unknown'})`);
      const runtime = await this.#preflight(server, context.workspacePath);
      if (
        runtime.commandExec.status !== 'completed'
        || runtime.commandExec.exitCode !== 0
        || !runtime.commandExec.fileWritten
      ) {
        throw new Error('Codex workspace runtime preflight failed');
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

      const turn = await server.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: context.task.prompt }],
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [context.workspacePath],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      const turnId = turn.value?.turn?.id;
      if (!turnId) throw new Error(`Codex turn start failed (${turn.code ?? 'missing turn'})`);

      const completed = await server.notification(
        'turn/completed',
        (event) => event.turn?.id === turnId,
        120_000,
      );
      if (!completed) {
        await server.call('turn/interrupt', { threadId, turnId }, 10_000);
        throw new Error('Timed out waiting for the Codex turn');
      }
      const status = completed.turn?.status;
      return {
        status: status === 'completed' ? 'completed' : 'failed',
        reason: status === 'completed' ? 'codex_turn_completed' : `codex_turn_${status ?? 'unknown'}`,
        tests: 'not_run',
        activeProcesses: 0,
        actualModel: started.value?.model ?? this.#lane.model,
      };
    } finally {
      await server.close();
    }
  }
}
