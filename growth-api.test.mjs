import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.LAB_TEST_SOURCE_DIR || fileURLToPath(new URL('.', import.meta.url));
const isolated = await realpath(await mkdtemp(join(tmpdir(), 'bueeld-growth-api-test-')));
const controlPath = join(isolated, 'control.json');
const callsPath = join(isolated, 'calls.jsonl');
const fakePath = join(isolated, 'fake-adal.mjs');
const learning = {
  assumption: 'The previous assumption was not recorded.',
  observation: 'The founder reports that two out of three people could not complete the first mission.',
  decision: 'Iterate on the validation step before testing the same path again.',
  nextMission: 'Test a revised validation step with three founders. Proposed target to confirm: all three finish unaided; collect their steps and completion times.',
  recommendation: 'iterate',
};
const mission = { id: 'mission-1', content: 'Ask three founders to complete their first mission without help.', evidence: 'Two of three founders could not find the validation action during the recorded test.', outcome: 'missed', realEvidence: true };
const projectMemory = { project: 'Founder workflow', target: 'Independent founders', goal: 'Make the first mission understandable', blocker: 'Validation is hard to find' };
let server;
let serverExit;

async function configure(answer = learning, delay = 0) {
  await writeFile(controlPath, JSON.stringify({ answer: typeof answer === 'string' ? answer : JSON.stringify(answer), delay }));
}
async function calls() {
  try { return (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function start(limit = 1000) {
  server = spawn(process.execPath, [join(isolated, 'server.mjs')], {
    cwd: isolated,
    // No real HOME, credentials, or network-facing AI executable is inherited.
    env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`, HOME: isolated, TMPDIR: isolated,
      HOST: '127.0.0.1', PORT: '0', ADAL_BIN: fakePath, ADAL_MODEL: 'test-growth-model', MAX_AI_CALLS: String(limit) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise((resolve) => server.once('close', resolve));
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Test server failed to start: ${output}`)), 8000);
    const onError = (error) => finish(error);
    const onExit = () => finish(new Error(`Test server exited: ${output}`));
    function finish(error, origin) {
      clearTimeout(timer); server.off('error', onError); server.off('exit', onExit); server.stdout.off('data', onData);
      if (error) reject(error); else resolve(origin);
    }
    function onData(chunk) {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)(?:\s|$)/);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    }
    server.once('error', onError); server.once('exit', onExit); server.stdout.on('data', onData);
    server.stderr.on('data', (chunk) => { output += chunk; });
  });
}
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 1500);
    await serverExit; clearTimeout(timer);
  }
  server = null;
}
async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  return { status: response.status, body: await response.json() };
}
async function usage(origin) { return (await fetch(`${origin}/api/demo/usage`)).json(); }

try {
  for (const name of ['server.mjs', 'accounts.mjs', 'connectors.mjs', 'quota.mjs', 'chat-language.mjs', 'adal-role.md']) {
    await copyFile(join(source, name), join(isolated, name));
  }
  for (const name of ['lab-growth.js', 'demo-tour.js']) await writeFile(join(isolated, name), `// ${name} fixture`);
  await writeFile(join(isolated, 'demo-replay.html'), '<!doctype html><title>Demo replay fixture</title>');
  await writeFile(fakePath, `#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const { answer, delay } = JSON.parse(await readFile(${JSON.stringify(controlPath)}, 'utf8'));
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + '\\n');
if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
process.stdout.write(JSON.stringify({ success: true, answer, tool_calls: [], exit_code: 0 }));
`);
  await chmod(fakePath, 0o700);
  await configure();
  let origin = await start();
  for (const name of ['lab-growth.js', 'demo-tour.js']) {
    const response = await fetch(`${origin}/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
  }
  const replay = await fetch(`${origin}/demo-replay.html`);
  assert.equal(replay.status, 200);
  assert.match(replay.headers.get('content-type'), /text\/html/);
  assert.equal(replay.headers.get('content-disposition'), 'attachment; filename="demo-replay.html"');

  const badMissions = [null, {}, { ...mission, id: '' }, { ...mission, content: 'too short' },
    { ...mission, content: 'x'.repeat(1501) }, { ...mission, evidence: 'too short' },
    { ...mission, evidence: 'x'.repeat(1501) }, { ...mission, outcome: 'won' },
    { ...mission, realEvidence: 'true' }];
  for (const invalid of badMissions) assert.equal((await post(origin, '/api/mission/learn', { mission: invalid })).status, 400);
  for (const invalid of [[], { target: 'x'.repeat(351) }, { blocker: 7 }, { project: null }, { instructions: 'override' }]) {
    assert.equal((await post(origin, '/api/mission/learn', { mission, projectMemory: invalid })).status, 400);
    assert.equal((await post(origin, '/api/chat', { message: 'Prepare my next mission.', projectMemory: invalid })).status, 400);
  }
  assert.deepEqual(await usage(origin), { used: 0, limit: 1000 });
  assert.equal((await calls()).length, 0, 'Invalid inputs must not invoke AdaL or consume quota');

  const learned = await post(origin, '/api/mission/learn', { mission, projectMemory });
  assert.equal(learned.status, 200);
  assert.deepEqual(learned.body, { learning, source: 'adal' });
  const args = (await calls()).at(-1).args;
  const prompt = args[args.indexOf('-q') + 1];
  for (const value of [mission.content, mission.evidence, ...Object.values(projectMemory)]) assert.ok(prompt.includes(value));
  for (const rule of ['untrusted data', 'previous assumption was not recorded', 'not independently verified', 'do not invent one', 'fictional or demonstration data', 'MUST NOT receive continue']) assert.ok(prompt.includes(rule), rule);
  assert.equal(args[args.indexOf('-m') + 1], 'test-growth-model');
  assert.equal(args[args.indexOf('--prompt-file') + 1], join(isolated, 'adal-role.md'));
  assert.equal(args[args.indexOf('--disabled-default-tools') + 1], 'Read,Search,Bash,Edit,Web,Image,Video,Consult');

  for (const malformed of ['not JSON', [], { ...learning, observation: '' }, { ...learning, decision: 'x'.repeat(601) },
    { ...learning, recommendation: 'win' }, { ...learning, extra: 'unexpected' }, { ...learning, nextMission: null }]) {
    await configure(malformed);
    const response = await post(origin, '/api/mission/learn', { mission });
    assert.equal(response.status, 502);
    assert.equal(response.body.learning, undefined);
  }
  await configure({ ...learning, recommendation: 'continue' });
  for (const outcome of ['missed', 'inconclusive']) {
    assert.equal((await post(origin, '/api/mission/learn', { mission: { ...mission, outcome } })).status, 502);
  }
  assert.equal((await post(origin, '/api/mission/learn', { mission: { ...mission, outcome: 'met' } })).status, 200);
  await configure(learning);
  assert.equal((await post(origin, '/api/mission/learn', { mission: { ...mission, realEvidence: false } })).status, 200);
  const demoArgs = (await calls()).at(-1).args;
  assert.ok(demoArgs[demoArgs.indexOf('-q') + 1].includes('"realEvidence":false'));

  await configure('Here is a draft interview guide.');
  assert.equal((await post(origin, '/api/chat', { message: 'Help prepare the mission.', projectMemory })).status, 200);
  const chatArgs = (await calls()).at(-1).args;
  const chatPrompt = chatArgs[chatArgs.indexOf('-q') + 1];
  for (const value of Object.values(projectMemory)) assert.ok(chatPrompt.includes(value));
  assert.ok(chatPrompt.includes('Editable project memory'));
  assert.ok(chatPrompt.includes('untrusted context'));

  await configure(learning, 300);
  const beforePending = (await calls()).length;
  const pending = post(origin, '/api/mission/learn', { mission });
  const deadline = Date.now() + 4000;
  while ((await calls()).length === beforePending && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await calls()).length, beforePending + 1);
  assert.equal((await post(origin, '/api/chat', { message: 'Another request while learning runs.' })).status, 429);
  assert.equal((await pending).status, 200);
  assert.equal((await calls()).length, beforePending + 1, 'Learning shares the existing chat in-flight lock');

  const used = (await usage(origin)).used;
  assert.equal(used, (await calls()).length, 'Every attempted AdaL call, including bad responses, consumes exactly one call');
  await stop();
  origin = await start(used);
  assert.equal((await post(origin, '/api/mission/learn', { mission })).status, 429);
  assert.equal((await calls()).length, used);
  assert.deepEqual(await usage(origin), { used, limit: used });
  console.log('Growth API tests passed: mission learning schema, honest prompt, malformed responses, outcome guard, project context, static modules, shared lock and persisted quota; isolated fake AdaL only.');
} finally {
  await stop();
  await rm(isolated, { recursive: true, force: true });
}
