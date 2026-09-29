import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.LAB_TEST_SOURCE_DIR || fileURLToPath(new URL('.', import.meta.url));
const isolated = await realpath(await mkdtemp(join(tmpdir(), 'bueeld-chat-test-')));
const controlPath = join(isolated, 'fake-adal-control.json');
const callsPath = join(isolated, 'fake-adal-calls.jsonl');
const fakePath = join(isolated, 'fake-adal.mjs');
const exactRequest = 'Help me define one concrete next mission with a deadline, owner, measurable outcome, and evidence to bring back. Ask for missing facts instead of inventing them.';
const reply = 'Let’s start with the missing project context.\n\nWhat project or blocker should this mission move forward?\n\nOnce we know that, we can choose the owner, deadline, and evidence together.';
let server;
let serverExit;
let serverOutput = '';

function startServer({ maxAiCalls } = {}) {
  // Deliberately omit real HOME, OAuth configuration, and credentials. The only
  // executable available as ADAL_BIN is the local deterministic fixture below.
  server = spawn(process.execPath, [join(isolated, 'server.mjs')], {
    cwd: isolated,
    env: {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
      HOME: isolated,
      TMPDIR: isolated,
      HOST: '127.0.0.1',
      PORT: '0',
      ...(maxAiCalls === undefined ? {} : { MAX_AI_CALLS: String(maxAiCalls) }),
      ADAL_BIN: fakePath,
      ADAL_MODEL: 'lab-test-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise((resolve) => server.once('close', resolve));
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => finish(new Error(`Test server did not announce its port. ${serverOutput}`)), 8000);
    function finish(error, origin) {
      clearTimeout(timer);
      server.off('error', onError);
      server.off('exit', onExit);
      server.stdout.off('data', onData);
      if (error) reject(error);
      else resolve(origin);
    }
    function onError(error) { finish(error); }
    function onExit(code, signal) { finish(new Error(`Test server exited before startup (${code ?? signal}). ${serverOutput}`)); }
    function onData(chunk) {
      stdout += chunk;
      serverOutput += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)(?:\s|$)/);
      if (match && Number(match[1]) > 0) finish(null, `http://127.0.0.1:${match[1]}`);
    }
    server.once('error', onError);
    server.once('exit', onExit);
    server.stdout.on('data', onData);
  });
}

async function stopServer() {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 1500);
    await serverExit;
    clearTimeout(force);
  }
  server = null;
}

async function configureFake(mode, answer = reply) {
  await writeFile(controlPath, JSON.stringify({ mode, answer }));
}

async function recordedCalls() {
  return (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  assert.ok(index >= 0, `Expected AdaL option ${name}`);
  assert.ok(index + 1 < args.length, `Expected a value for ${name}`);
  return args[index + 1];
}

async function postChat(origin, body) {
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: await response.json() };
}

async function usage(origin) {
  const response = await fetch(`${origin}/api/demo/usage`, { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  for (const name of ['server.mjs', 'accounts.mjs', 'connectors.mjs', 'quota.mjs', 'chat-language.mjs', 'adal-role.md']) {
    await copyFile(join(source, name), join(isolated, name));
  }
  await writeFile(fakePath, `#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + '\\n');
const { mode, answer } = JSON.parse(await readFile(${JSON.stringify(controlPath)}, 'utf8'));
if (mode === 'failed-exit') { process.stderr.write('fixture failure'); process.exit(7); }
if (mode === 'invalid-json') { process.stdout.write('not JSON'); process.exit(0); }
process.stdout.write(JSON.stringify({ success: true, answer: mode === 'empty' ? '' : answer, tool_calls: [], exit_code: 0 }));
`);
  await chmod(fakePath, 0o700);
  await configureFake('success');
  let origin = await startServer();
  assert.deepEqual(await usage(origin), { used: 0, limit: 1000 });

  const first = await postChat(origin, { message: exactRequest, history: [] });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { message: reply, source: 'adal' });
  assert.ok(first.body.message.includes('\n\nWhat project or blocker should this mission move forward?\n\n'));

  const history = [
    { role: 'user', content: 'I am testing a scheduling tool for independent tutors.' },
    { role: 'assistant', content: 'Which scheduling problem do tutors describe most often?' },
  ];
  const pinnedMission = { content: 'Interview tutors about cancellations before choosing a test.', status: 'proposed' };
  const sourceContexts = [{ name: 'Tutor notes analysis', kind: 'analysis', digest: 'b'.repeat(64), summary: 'F1 Two tutors reported last-minute cancellations [S1].' }];
  const contextual = await postChat(origin, { message: exactRequest, history, pinnedMission, sourceContexts });
  assert.equal(contextual.status, 200);
  assert.equal(contextual.body.message, reply);
  const contextCall = (await recordedCalls()).at(-1);
  const prompt = optionValue(contextCall.args, '-q');
  for (const fact of [exactRequest, ...history.map(({ content }) => content), pinnedMission.content, pinnedMission.status,
    sourceContexts[0].name, sourceContexts[0].digest, sourceContexts[0].summary]) {
    assert.ok(prompt.includes(fact), `Chat request must preserve supplied context: ${fact}`);
  }

  for (const mode of ['empty', 'invalid-json', 'failed-exit']) {
    await configureFake(mode);
    const failed = await postChat(origin, { message: exactRequest });
    assert.equal(failed.status, 502, `${mode} should not appear as a successful reply`);
    assert.equal(typeof failed.body.error, 'string');
    assert.ok(failed.body.error.length > 0);
    assert.equal(failed.body.message, undefined);
    await configureFake('success');
    const recovered = await postChat(origin, { message: exactRequest });
    assert.equal(recovered.status, 200, `${mode} must release the in-flight request lock`);
    assert.equal(recovered.body.message, reply);
  }

  const calls = await recordedCalls();
  assert.equal(calls.length, 8);
  for (const { args } of calls) {
    assert.equal(optionValue(args, '--prompt-file'), join(isolated, 'adal-role.md'));
    assert.equal(optionValue(args, '-o'), 'json');
    assert.equal(optionValue(args, '--permission-mode'), 'default');
    assert.equal(optionValue(args, '-m'), 'lab-test-model');
    const disabled = optionValue(args, '--disabled-default-tools').split(',');
    assert.deepEqual(new Set(disabled), new Set(['Read', 'Search', 'Bash', 'Edit', 'Web', 'Image', 'Video', 'Consult']));
    assert.ok(!args.some((arg) => arg === '--enabled-default-tools' || arg.startsWith('--enabled-default-tools=')));
    assert.ok(!args.includes('--yolo'));
  }

  // Five successful replies and three failed upstream calls used eight slots.
  // The expanded default must allow a useful shared public demo beyond twelve calls.
  for (let index = 0; index < 8; index += 1) {
    const continued = await postChat(origin, { message: exactRequest });
    assert.equal(continued.status, 200);
    assert.equal(continued.body.message, reply);
  }
  assert.deepEqual(await usage(origin), { used: 16, limit: 1000 });
  assert.equal((await recordedCalls()).length, 16);

  await stopServer();
  origin = await startServer({ maxAiCalls: 17 });
  assert.deepEqual(await usage(origin), { used: 16, limit: 17 });
  assert.equal((await postChat(origin, { message: exactRequest })).status, 200);
  const exhausted = await postChat(origin, { message: exactRequest });
  assert.equal(exhausted.status, 429);
  assert.match(exhausted.body.error, /AI call limit/);
  assert.deepEqual(await usage(origin), { used: 17, limit: 17 });
  assert.equal((await recordedCalls()).length, 17, 'Rejected requests must not invoke AdaL');

  await stopServer();
  origin = await startServer({ maxAiCalls: 18 });
  assert.deepEqual(await usage(origin), { used: 17, limit: 18 }, 'Raising the limit must preserve spent calls');
  const unblocked = await postChat(origin, { message: exactRequest });
  assert.equal(unblocked.status, 200, 'Raising an exhausted limit must unblock chat');
  assert.equal(unblocked.body.message, reply);
  assert.deepEqual(await usage(origin), { used: 18, limit: 18 });

  await stopServer();
  origin = await startServer({ maxAiCalls: 0 });
  assert.deepEqual(await usage(origin), { used: 18, limit: 0 });
  assert.equal((await postChat(origin, { message: exactRequest })).status, 429);
  assert.equal((await recordedCalls()).length, 18, 'An explicit zero limit must disable AI calls');

  for (const maxAiCalls of ['', '   ', 'not-a-number', '-1', '1.5', 'Infinity', '9007199254740992']) {
    await stopServer();
    origin = await startServer({ maxAiCalls });
    assert.deepEqual(await usage(origin), { used: 18, limit: 1000 },
      `Unset, blank, or invalid quota configuration must use the default: ${JSON.stringify(maxAiCalls)}`);
  }
  console.log('Chat integration tests passed: complete multiline reply, context, dedicated role, disabled tools, upstream failures, recovery, expanded and configurable quota, exhaustion, restart persistence, zero cap, invalid configuration; no live AI calls.');
} finally {
  await stopServer();
  await rm(isolated, { recursive: true, force: true });
}
