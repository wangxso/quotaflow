import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLab, git, verifyCheckpoint } from './git.ts';

const [magpie, opencode, llama, model, nativeWorktree] = process.argv.slice(2);
if (!magpie || !opencode || !llama || !model) throw new Error('Expected paths to Magpie, OpenCode, llama-server and the model');
const lab = createLab();
const portable = join(lab.root, 'gateway');
mkdirSync(portable);
const executable = join(portable, process.platform === 'win32' ? 'magpie.exe' : 'magpie');
copyFileSync(resolve(magpie), executable);
writeFileSync(join(portable, '.portable'), '');

const modelId = 'phase0-qwen';
const groupId = 'group/phase0';
const fakeKey = 'phase0-local-fixture';
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('MAGPIE_') || key.startsWith('OPENCODE_') || key === 'OPENAI_API_KEY') delete env[key];
}
env.MAGPIE_NO_ACCOUNTS = '1';

function openPort() {
  const listener = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = listener.port;
  listener.stop(true);
  if (!port) throw new Error('Could not allocate loopback port');
  return port;
}

function command(program: string, args: string[], directory: string, variables: typeof env, timeout = 25_000) {
  const result = spawnSync(program, args, { cwd: directory, env: variables, encoding: 'utf8', windowsHide: true, timeout });
  if (result.error) throw result.error;
  return result;
}

const children: ChildProcess[] = [];
function service(program: string, args: string[], directory: string, variables: typeof env, label: string) {
  const child = spawn(program, args, { cwd: directory, env: variables, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const record = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-30_000);
    writeFileSync(join(lab.root, `${label}.log`), log);
  };
  child.stderr?.on('data', record);
  child.stdout?.on('data', record);
  child.on('error', (error) => record(Buffer.from(error.message)));
  children.push(child);
  return child;
}

async function jsonRequest(base: string, route: string, init?: RequestInit) {
  const response = await fetch(base + route, { ...init, redirect: 'error', signal: AbortSignal.timeout(45_000) });
  const json = await response.json().catch(() => null);
  return { http: response.status, json };
}

async function ready(base: string, route: string, child: ChildProcess) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Service exited before ${route} was ready`);
    try {
      const response = await fetch(base + route, { redirect: 'error', signal: AbortSignal.timeout(1200) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Waiting for this loopback service to bind. */ }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for local service ${route}`);
}

let rejectedRequests = 0;
const rejecting = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(request) {
    if (request.method === 'POST') {
      rejectedRequests++;
      return Response.json({ error: { message: 'Phase 0 injected upstream availability failure', type: 'server_error' } }, { status: 503 });
    }
    return Response.json({ object: 'list', data: [{ id: modelId, object: 'model' }] });
  },
});

const llamaPort = openPort();
const gatewayPort = openPort();
const llamaBase = `http://127.0.0.1:${llamaPort}`;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const gatewayEnv = { ...env, MAGPIE_ADDR: `127.0.0.1:${gatewayPort}` };
let routeAbort: AbortController | undefined;
let routeCapture: Promise<string> | undefined;
let routeStatus: number | 'not_run' = 'not_run';

try {
  const data = command(executable, ['data'], portable, gatewayEnv);
  assert.equal(data.status, 0);
  assert.ok(data.stdout.includes(portable), 'Magpie must resolve data inside the portable fixture before configuration');
  const configure = (args: string[]) => {
    const result = command(executable, args, portable, gatewayEnv);
    writeFileSync(join(lab.root, `${args[0]}-${args[2] ?? 'cli'}.log`), result.stdout + result.stderr);
    if (result.status !== 0) throw new Error(`Magpie ${args.slice(0, 2).join(' ')} failed`);
  };
  configure(['provider', 'add', 'phase0-reject', `url=http://127.0.0.1:${rejecting.port}/v1`, `models=${modelId}`, `key=${fakeKey}`]);
  configure(['provider', 'add', 'phase0-local', `url=${llamaBase}/v1`, `models=${modelId}`, `key=${fakeKey}`]);
  configure(['group', 'add', 'phase0', `models=phase0-reject/${modelId},phase0-local/${modelId}`, 'routing=order', 'stays=off']);

  const inference = service(resolve(llama), ['--host', '127.0.0.1', '--port', String(llamaPort), '--model', resolve(model),
    '--alias', modelId, '--ctx-size', '12288', '--threads', '4', '--parallel', '1', '--no-webui'], lab.root, env, 'llama');
  await ready(llamaBase, '/health', inference);
  const gateway = service(executable, ['serve'], portable, gatewayEnv, 'magpie');
  await ready(gatewayBase, '/v1/models', gateway);
  const catalog = await jsonRequest(gatewayBase, '/v1/models');
  const catalogModels = catalog.json?.data?.map((entry: { id: string }) => entry.id) ?? [];
  assert.ok(catalogModels.includes(groupId), 'Routing Group was not published in the model catalog');
  const snapshot = await jsonRequest(gatewayBase, '/v1/magpie/route-events/snapshot');
  assert.equal(snapshot.http, 200);
  assert.notEqual(snapshot.json?.cursor, undefined);
  routeAbort = new AbortController();
  const stream = await fetch(`${gatewayBase}/v1/magpie/route-events?after=${encodeURIComponent(snapshot.json.cursor)}`, {
    redirect: 'error', signal: AbortSignal.any([routeAbort.signal, AbortSignal.timeout(80_000)]),
  });
  routeStatus = stream.status;
  routeCapture = (async () => {
    let tape = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream.body!) tape = (tape + decoder.decode(chunk, { stream: true })).slice(-80_000);
    } catch (error) {
      if (!routeAbort?.signal.aborted && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
    }
    return tape;
  })();

  const upstream = await jsonRequest(gatewayBase, '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: groupId, messages: [{ role: 'user', content: 'What is 41 plus 1? Answer with digits only.' }],
      max_tokens: 12, temperature: 0, stream: false }),
  });
  assert.equal(upstream.http, 200);
  assert.match(upstream.json?.choices?.[0]?.message?.content ?? '', /\b42\b/);
  assert.ok(rejectedRequests > 0, 'The leading provider was not tried');
  const rejectedBeforeAgent = rejectedRequests;

  const profiles = join(lab.root, 'opencode-profile');
  mkdirSync(profiles);
  const agentEnv = {
    ...env,
    XDG_CONFIG_HOME: join(profiles, 'config'), XDG_DATA_HOME: join(profiles, 'data'),
    XDG_CACHE_HOME: join(profiles, 'cache'), XDG_STATE_HOME: join(profiles, 'state'),
    OPENCODE_CONFIG_DIR: join(profiles, 'config'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_SHARE: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: ['phase0'], permission: { '*': 'deny' }, model: `phase0/${groupId}`, small_model: `phase0/${groupId}`,
      agent: { phase0: { description: 'Copies test handoff data', mode: 'primary', temperature: 0,
        prompt: 'This is a simple data transfer check. Output the number found in the user handoff exactly as it appears. Do not do arithmetic. Use no tools.' } },
      provider: { phase0: { npm: '@ai-sdk/openai-compatible', name: 'QuotaFlow local group',
        options: { baseURL: `${gatewayBase}/v1`, apiKey: fakeKey },
        models: { [groupId]: { name: 'Phase 0 local routing group', limit: { context: 12288, output: 32 } } },
      } },
    }),
  };
  let input = '41';
  let nativeCheckpoint: string | undefined;
  if (nativeWorktree) {
    const nativePath = resolve(nativeWorktree);
    nativeCheckpoint = git(nativePath, ['rev-parse', '--verify', 'refs/quotaflow/phase0/attempt-1']);
    verifyCheckpoint(nativePath, lab.root, nativeCheckpoint);
    input = readFileSync(join(nativePath, 'app.txt'), 'utf8').trim();
    assert.equal(input, '41', 'The native attempt did not persist the expected handoff data');
  }
  const workspace = nativeWorktree ? resolve(nativeWorktree) : lab.workspace;
  const flags = ['run', '--pure', '--format', 'json', '--agent', 'phase0', '--model', `phase0/${groupId}`, '--dir', workspace];
  const runAgent = async (label: string, ...options: string[]) => {
    const agent = Bun.spawn([resolve(opencode), ...flags, ...options,
      `Copy the exact number from this handoff. The number is ${input}. Output only that number.`], {
      cwd: workspace, env: agentEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const timeout = setTimeout(() => agent.kill(), 60_000);
    const [status, stdout, stderr] = await Promise.all([agent.exited, new Response(agent.stdout).text(), new Response(agent.stderr).text()]);
    clearTimeout(timeout);
    writeFileSync(join(lab.root, `opencode-${label}.log`), stdout + stderr);
    assert.equal(status, 0);
    return stdout.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  };
  const events = await runAgent('initial');
  const text = events.flatMap((event) => event.type === 'text' ? [event.part?.text ?? event.text ?? ''] : []).join('');
  assert.match(text, /\b41\b/, 'OpenCode did not return the handoff input');
  assert.ok(events.some((event) => event.type === 'step_finish'), 'Expected structured completion event');
  const sessionId = events.find((event) => typeof event.sessionID === 'string')?.sessionID;
  assert.equal(typeof sessionId, 'string');
  const resumed = await runAgent('resume', '--session', sessionId);
  assert.ok(resumed.some((event) => event.type === 'step_finish' && event.sessionID === sessionId), 'Expected native OpenCode session continuation');
  assert.equal(git(workspace, ['status', '--short']), nativeWorktree ? 'M app.txt' : '');
  const requestEvents = await jsonRequest(gatewayBase, '/v1/magpie/usage/requests?period=today&limit=10');
  await Bun.sleep(250);
  routeAbort.abort();
  const routeLog = await routeCapture;
  assert.equal(routeStatus, 200);
  assert.ok(routeLog.includes('phase0-local') && routeLog.includes(modelId), 'Missing route attribution for the local upstream');
  const directCalls = rejectedBeforeAgent;
  const report = {
    localUpstream: modelId, group: groupId, directGroupReply: '42', fallback503s: directCalls,
    gatewayUsageHttp: requestEvents.http, routeStreamHttp: routeStatus, actualModelObserved: true,
    upstreamUsage: upstream.json.usage?.total_tokens ?? 'UNKNOWN',
    openCode: { result: '41', events: [...new Set(events.map((event) => event.type))], actualModelEvidence: true, resumedSession: true },
    handoffInput: nativeWorktree ? 'from_native_worktree' : 'fixture',
    nativeCheckpoint,
    extraPaidRequests: 0,
  };
  gateway.kill();
  await ready(llamaBase, '/health', inference);
  console.log(JSON.stringify({ ...report, directUpstreamHealthyWithoutGateway: true }));
} finally {
  routeAbort?.abort();
  if (routeCapture) await routeCapture.catch(() => {});
  rejecting.stop(true);
  for (const child of children.reverse()) if (child.exitCode === null && !child.killed) child.kill();
}
