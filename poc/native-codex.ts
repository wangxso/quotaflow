import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServer } from './live-probe.mjs';
import { probeAppServerRuntime } from './app-server-runtime.mjs';
import { checkpoint, createLab, git } from './git.ts';

const [executable = 'codex', mode = 'agent-write', requestedTransport = 'stdio'] = process.argv.slice(2);
if (!['agent-write', 'structured'].includes(mode)) throw new Error('Expected agent-write or structured mode');
if (!['stdio', 'daemon'].includes(requestedTransport)) throw new Error('Expected stdio or daemon transport');
const transport = requestedTransport as 'stdio' | 'daemon';
const structured = mode === 'structured';
const lab = createLab();
const env = { ...process.env };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) delete env[key];
const args = ['-c', 'model_provider="openai"', '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"'];
const requestedModel = process.env.QUOTAFLOW_CODEX_MODEL;
const requestedBaseUrl = process.env.QUOTAFLOW_CODEX_OPENAI_BASE_URL;
if (requestedModel) args.push('-c', `model=${JSON.stringify(requestedModel)}`);
if (requestedBaseUrl) args.push('-c', `openai_base_url=${JSON.stringify(requestedBaseUrl)}`);
const session = {
  cwd: lab.workspace,
  sandbox: structured ? 'read-only' : 'workspace-write',
  approvalPolicy: 'never',
  modelProvider: 'openai',
  ...(requestedModel ? { model: requestedModel } : {}),
};
let server = new AppServer(executable, args, { cwd: lab.workspace, env, transport });
const result: Record<string, unknown> = {
  inferenceTurnsRequested: 0,
  mode,
  transport,
  requestedModel: requestedModel ?? 'configured default',
  requestedBaseUrl: requestedBaseUrl ?? 'configured default',
  billingAttribution: process.env.QUOTAFLOW_BILLING_ATTRIBUTION ?? 'UNKNOWN',
};

try {
  if (!(await server.initialize({ experimentalApi: true })).value) throw new Error('App Server initialize failed');
  const runtime = await probeAppServerRuntime(server, lab.workspace);
  result.runtimePreflight = runtime;
  if (runtime.commandExec.status !== 'completed' || runtime.commandExec.exitCode !== 0 || !runtime.commandExec.fileWritten ||
      git(lab.workspace, ['status', '--short'])) {
    throw new Error('Workspace runtime preflight failed before any model turn');
  }
  const account = (await server.call('account/read', { refreshToken: false })).value?.account;
  result.accountType = account?.type ?? 'UNKNOWN';
  result.accountPlan = account?.planType ?? 'UNKNOWN';
  const usage = (await server.call('account/rateLimits/read')).value;
  const limits = usage?.rateLimits;
  if (account?.type !== 'chatgpt' || account.planType !== 'plus' || usage?.ordinaryUsageAllowed !== true ||
      limits?.credits?.hasCredits !== false || limits.credits.unlimited !== false ||
      [limits.primary, limits.secondary].some((window) => !window || !Number.isFinite(window.usedPercent) || window.usedPercent >= 80)) {
    throw new Error('This smoke run requires a verified Plus subscription with two available windows and no credits');
  }

  const start = await server.call('thread/start', { ...session, ephemeral: false });
  const threadId = start.value?.thread?.id;
  if (!threadId || start.value?.modelProvider !== 'openai') throw new Error(`Native thread creation failed (${start.code ?? 'unexpected config'})`);
  result.threadStarted = true;
  result.model = start.value.model ?? 'UNKNOWN';
  result.provider = start.value.modelProvider;
  result.inferenceTurnsRequested = 1;
  const prompt = structured
    ? 'Return a JSON object with an integer value for 40 plus 1. Do not use tools or modify files.'
    : 'In this temporary test worktree, use the terminal to run exactly one PowerShell command that writes the text 41 to app.txt, then read app.txt to verify it. Do not use apply_patch or a file editor. Do not touch any other file or use the network. Stop after verification.';
  const turn = await server.call('turn/start', {
    threadId,
    sandboxPolicy: structured ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [lab.workspace], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    ...(structured ? { outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } : {}),
    input: [{ type: 'text', text: prompt }],
  });
  const turnId = turn.value?.turn?.id;
  if (!turnId) throw new Error(`Turn request failed (${turn.code ?? 'unknown status'})`);
  const done = await server.notification('turn/completed', (event) => event.turn?.id === turnId, 60_000);
  if (!done) {
    const interrupt = await server.call('turn/interrupt', { threadId, turnId });
    result.interruptAccepted = interrupt.code === undefined;
    throw new Error('Timed out waiting for the native turn');
  }
  result.turnStatus = done.turn.status;
  const tokenUpdate = await server.notification('thread/tokenUsage/updated', (event) => event.threadId === threadId, 1000);
  result.tokenUsageEvent = Boolean(tokenUpdate);
  if (structured && done.turn.status === 'completed') {
    const message = await server.notification('item/completed', (event) =>
      event.turnId === turnId && event.item?.type === 'agentMessage' && event.item?.text?.trim().startsWith('{'), 1000);
    const parsed = JSON.parse(message?.item?.text ?? '{}');
    if (parsed.value !== 41 || Object.keys(parsed).length !== 1 || git(lab.workspace, ['status', '--short'])) {
      throw new Error('The structured result or read-only worktree failed validation');
    }
    writeFileSync(join(lab.workspace, 'app.txt'), `${parsed.value}\n`);
    result.structuredResult = parsed.value;
    result.writeOwner = 'controller';
  }
  result.expectedFile = readFileSync(join(lab.workspace, 'app.txt'), 'utf8').trim() === '41';
  result.onlyExpectedFile = git(lab.workspace, ['status', '--short']) === 'M app.txt';
  await server.close();
  server = new AppServer(executable, args, { cwd: lab.workspace, env, transport });
  if (!(await server.initialize()).value) throw new Error('App Server restart initialize failed');
  const resume = await server.call('thread/resume', { ...session, threadId });
  result.resumedAfterRestart = resume.value?.thread?.id === threadId;
  if (!result.resumedAfterRestart) throw new Error(`Native thread resume failed (${resume.code ?? 'missing thread'})`);
  if (done.turn.status !== 'completed' || !result.expectedFile || !result.onlyExpectedFile) throw new Error('Native turn did not meet the file assertions');
  result.gitCheckpoint = checkpoint(lab.workspace, lab.root, 1);
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ ...result, error: error instanceof Error ? error.message : 'native_probe_failed' }));
  process.exitCode = 1;
} finally {
  await server.close();
}
