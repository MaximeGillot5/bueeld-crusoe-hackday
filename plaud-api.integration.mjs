// Local API integration check using a synthetic Plaud response, never a real credential.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), 'bueeld-plaud-api-'));
const server = spawn(process.execPath, ['--import', join(root, 'plaud-api-test-fetch.mjs'), join(root, 'server.mjs')], {
  cwd: root,
  env: { PATH: process.env.PATH || '', HOST: '127.0.0.1', PORT: '0',
    LAB_DATA_DIR: dataDir, PLAUD_CLIENT_ID: 'fixture-client',
    PLAUD_CLIENT_SECRET: 'fixture-secret', PLAUD_API_KEY: 'fixture-api-key' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function origin() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Server did not start: ${serverLog}`)), 10_000);
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Server exited (${code}): ${serverLog}`));
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
      if (error) reject(error); else resolve(value);
    }
    server.once('error', onError);
    server.once('exit', onExit);
    server.stdout.on('data', onData);
  });
}

async function run() {
  const base = await origin();
  async function request(path, { method = 'GET', body, cookie, csrf, bearer } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-lab-csrf': csrf } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
  }
  async function signup() {
    const session = await request('/api/auth/session');
    const result = await request('/api/auth/signup', { method: 'POST',
      body: { email: `${randomUUID()}@example.test`, password: 'Synthetic-Test-Password-2026!' },
      cookie: session.cookie, csrf: session.body.csrfToken });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return { cookie: result.cookie, csrf: result.body.csrfToken };
  }
  assert.deepEqual((await request('/api/plaud/status')).body, { configured: true });
  const a = await signup();
  const b = await signup();
  const paired = await request('/api/plaud/pairings', { method: 'POST', cookie: a.cookie, csrf: a.csrf });
  assert.equal(paired.status, 201);
  const exchanged = await request('/api/plaud/pairings/exchange', { method: 'POST', body: { code: paired.body.code } });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.body.userAccessToken, 'fixture-user-token');
  const stamp = new Date(Date.now() - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fileUrl = `https://plaud-bucket.s3.amazonaws.com/interview.mp3?X-Amz-Signature=fixture&X-Amz-Date=${stamp}&X-Amz-Expires=3600`;
  const rejectedId = await request('/api/plaud/transcriptions', { method: 'POST',
    bearer: exchanged.body.ingestToken, body: { transcriptionId: 'task_exec_foreign', fileUrl } });
  assert.equal(rejectedId.status, 400);
  const submitted = await request('/api/plaud/transcriptions', { method: 'POST',
    bearer: exchanged.body.ingestToken, body: { fileUrl, title: 'Customer interview', externalId: 'recording-fixture' } });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  assert.equal(submitted.body.transcription.status, 'PENDING');
  const id = submitted.body.transcription.id;
  const listed = await request('/api/plaud/transcriptions', { cookie: a.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.transcriptions[0].status, 'SUCCESS');
  const detail = await request(`/api/plaud/transcriptions/${id}`, { cookie: a.cookie });
  assert.equal(detail.body.transcription.segments[0].text, 'The onboarding takes too long.');
  assert.deepEqual((await request('/api/plaud/transcriptions', { cookie: b.cookie })).body.transcriptions, []);
  assert.equal((await request(`/api/plaud/transcriptions/${id}`, { cookie: b.cookie })).status, 404);
  const validation = { method: 'POST', cookie: a.cookie, csrf: a.csrf,
    body: { evidence: { summary: 'Founder heard a real account of onboarding friction: The onboarding takes too long.', real: true },
      source: { kind: 'import', reference: `plaud:${id}` }, outcome: 'met', requestId: randomUUID() } };
  const fakeQuote = await request('/api/projects/current/milestones/field_observations/validate', {
    ...validation, body: { ...validation.body, plaudQuote: { start: 0, text: 'Invented quote' } } });
  assert.equal(fakeQuote.status, 409);
  const realQuote = await request('/api/projects/current/milestones/field_observations/validate', {
    ...validation, body: { ...validation.body,
      plaudQuote: { start: 0, text: 'The onboarding takes too long.' } } });
  assert.equal(realQuote.status, 200, JSON.stringify(realQuote.body));
  assert.equal(realQuote.body.transition.gain, 10);
  console.log('BUEELD Plaud API integration passed: pairing, owner-bound submission, polling, isolation, cited evidence.');
}

try { await run(); }
finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('close', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
