// End-to-end credit fallback check. Both AI backends are simulated locally;
// the server cannot make a real outbound AI request in this test process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'bueeld-fallback-http-'));
const dataDir = join(temp, 'data');
const crusoeCallsFile = join(temp, 'crusoe-calls.txt');
const adalCallsFile = join(temp, 'adal-calls.txt');
const preloadFile = join(temp, 'mock-crusoe.mjs');
const adalBin = join(temp, 'fake-adal');

await Promise.all([
  writeFile(crusoeCallsFile, ''),
  writeFile(adalCallsFile, ''),
  writeFile(preloadFile, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url !== 'https://api.inference.crusoecloud.com/v1/chat/completions') {
    throw new Error('Unexpected outbound AI request');
  }
  appendFileSync(${JSON.stringify(crusoeCallsFile)}, '1\\n');
  return new Response(JSON.stringify({ error: { code: 'insufficient_credits' } }), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
};
`),
  writeFile(adalBin, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(adalCallsFile)}, '1\\n');
process.stdout.write(JSON.stringify({ success: true, answer: 'AdaL integration answer', model: 'adal-integration' }));
`, { mode: 0o700 }),
]);
await chmod(adalBin, 0o700);

const server = spawn(process.execPath, ['--import', preloadFile, join(root, 'server.mjs')], {
  cwd: root,
  env: {
    PATH: process.env.PATH || '',
    BUEELD_SKIP_LOCAL_ENV: '1',
    HOME: temp,
    TMPDIR: temp,
    HOST: '127.0.0.1',
    PORT: '0',
    LAB_DATA_DIR: dataDir,
    MAX_AI_CALLS: '3',
    MAX_AI_CALLS_PER_USER: '3',
    CRUSOE_API_KEY: 'integration-test-key',
    ADAL_BIN: adalBin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const closed = new Promise((resolve) => server.once('close', resolve));
let serverError = '';
server.stderr.on('data', (chunk) => {
  serverError = (serverError + chunk).slice(-2_000);
});

async function origin() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Test server did not start.')), 10_000);
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Test server exited before listening (code ${code}): ${serverError.replaceAll('integration-test-key', '[redacted]')}`));
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    };
    function finish(error, value) {
      clearTimeout(timer);
      server.off('error', onError);
      server.off('exit', onExit);
      server.stdout.off('data', onData);
      if (error) reject(error);
      else resolve(value);
    }
    server.once('error', onError);
    server.once('exit', onExit);
    server.stdout.on('data', onData);
  });
}

function callCount(content) {
  return content.split('\n').filter(Boolean).length;
}

async function run() {
  const base = await origin();
  async function request(path, { method = 'GET', body, cookie, csrf } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-lab-csrf': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || null,
    };
  }

  const initial = await request('/api/demo/usage');
  assert.deepEqual(initial.body, { used: 0, limit: 3 });
  const session = await request('/api/auth/session');
  assert.equal(session.status, 200);
  const created = await request('/api/auth/signup', {
    method: 'POST',
    cookie: session.cookie,
    csrf: session.body.csrfToken,
    body: { email: `${randomUUID()}@example.test`, password: 'Synthetic-Test-Password-2026!' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const chat = (message) => request('/api/chat', {
    method: 'POST',
    cookie: created.cookie,
    csrf: created.body.csrfToken,
    body: { message },
  });
  const first = await chat('First synthetic question');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.message, 'AdaL integration answer');
  assert.equal(first.body.source, 'adal');
  assert.equal(first.body.model, 'adal-integration');
  assert.equal(first.body.fallbackReason, 'crusoe_credits_exhausted');
  assert.equal((await request('/api/demo/usage')).body.used, 2,
    'the failed Crusoe request and the successful AdaL request both count toward quota');
  assert.equal(callCount(await readFile(crusoeCallsFile, 'utf8')), 1);

  const second = await chat('Second synthetic question');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.source, 'adal');
  assert.equal(second.body.fallbackReason, 'crusoe_credits_exhausted');
  assert.equal((await request('/api/demo/usage')).body.used, 3);
  assert.equal(callCount(await readFile(crusoeCallsFile, 'utf8')), 1,
    'the cooldown must skip a second Crusoe attempt');
  assert.equal(callCount(await readFile(adalCallsFile, 'utf8')), 2);
  console.log('AI fallback HTTP integration passed: Crusoe 402, AdaL relay, quota, cooldown.');
}

try { await run(); }
finally {
  server.kill('SIGTERM');
  await closed;
  await rm(temp, { recursive: true, force: true });
}
