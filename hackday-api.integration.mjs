// Disposable local integration check. Run with `npm run test:integration` in an
// environment that permits listening on 127.0.0.1. No external AI call is made.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), 'bueeld-hackday-api-'));
const server = spawn(process.execPath, [join(root, 'server.mjs')], {
  cwd: root,
  env: { PATH: process.env.PATH || '', HOME: dataDir, HOST: '127.0.0.1', PORT: '0',
    LAB_DATA_DIR: dataDir, MAX_AI_CALLS: '3', MAX_AI_CALLS_PER_USER: '2' },
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
  const plaudScript = await fetch(`${base}/plaud-web.js`);
  assert.equal(plaudScript.status, 200);
  assert.match(await plaudScript.text(), /plaud\/transcriptions/);
  async function request(path, { method = 'GET', body, cookie, csrf } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-lab-csrf': csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    return { status: response.status, body: payload,
      cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
  }
  async function signup() {
    const session = await request('/api/auth/session');
    assert.equal(session.status, 200);
    const password = 'Synthetic-Test-Password-2026!';
    const created = await request('/api/auth/signup', { method: 'POST',
      body: { email: `${randomUUID()}@example.test`, password },
      cookie: session.cookie, csrf: session.body.csrfToken });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { cookie: created.cookie, csrf: created.body.csrfToken, password };
  }

  const guestAi = await request('/api/chat', { method: 'POST', body: {} });
  assert.equal(guestAi.status, 401);
  const plaudStatus = await request('/api/plaud/status');
  assert.deepEqual(plaudStatus.body, { configured: false });
  const guestPlaud = await request('/api/plaud/transcriptions');
  assert.equal(guestPlaud.status, 401);
  const a = await signup();
  const b = await signup();
  const plaudWithoutCsrf = await request('/api/plaud/pairings', { method: 'POST', cookie: a.cookie });
  assert.equal(plaudWithoutCsrf.status, 403);
  const plaudWithoutCredentials = await request('/api/plaud/pairings', {
    method: 'POST', cookie: a.cookie, csrf: a.csrf });
  assert.equal(plaudWithoutCredentials.status, 503);
  const emptyPlaudList = await request('/api/plaud/transcriptions', { cookie: a.cookie });
  assert.deepEqual(emptyPlaudList.body, { transcriptions: [] });
  const memory = await request('/api/project-memory', { method: 'PUT', cookie: a.cookie, csrf: a.csrf,
    body: { projectMemory: { project: 'Synthetic test project', target: 'Test founders', goal: 'Run a first pilot', blocker: 'Demand is unknown' } } });
  assert.equal(memory.status, 200, JSON.stringify(memory.body));
  const start = await request('/api/projects/current/maturity', { cookie: a.cookie });
  assert.equal(start.body.maturity.percent, 0);
  assert.equal(start.body.nextMission.milestoneId, 'target_problem');
  const milestoneBody = { evidence: { summary: 'We defined a specific founder segment and documented the problem they face.', real: true },
    source: { kind: 'manual' }, outcome: 'met', requestId: randomUUID() };
  const advanced = await request('/api/projects/current/milestones/target_problem/validate', {
    method: 'POST', cookie: a.cookie, csrf: a.csrf, body: milestoneBody });
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
  assert.equal(advanced.body.transition.gain, 5);
  const inventedPlaudId = randomUUID();
  const inventedPlaud = await request('/api/projects/current/milestones/field_observations/validate', {
    method: 'POST', cookie: a.cookie, csrf: a.csrf,
    body: { evidence: { summary: 'A purported Plaud conversation described onboarding friction.', real: true },
      source: { kind: 'import', reference: `plaud:${inventedPlaudId}` }, outcome: 'met',
      plaudQuote: { start: 0, text: 'An invented quote' }, requestId: randomUUID() } });
  assert.equal(inventedPlaud.status, 404);
  assert.equal((await request('/api/projects/current/maturity', { cookie: a.cookie })).body.maturity.percent, 5);
  const duplicate = await request('/api/projects/current/milestones/target_problem/validate', {
    method: 'POST', cookie: a.cookie, csrf: a.csrf, body: milestoneBody });
  assert.equal(duplicate.body.transition.gain, 0);
  const other = await request('/api/projects/current/maturity', { cookie: b.cookie });
  assert.equal(other.body.maturity.percent, 0);
  const noCsrf = await request('/api/projects/current/milestones/value_proposition/validate', {
    method: 'POST', cookie: a.cookie, body: milestoneBody });
  assert.equal(noCsrf.status, 403);

  const proposed = await request('/api/experiments/propose', { method: 'POST', cookie: a.cookie, csrf: a.csrf,
    body: { missionId: 'interest_test', title: 'Would founders try BUEELD?',
      hypothesis: 'Founders will try a guided customer test.', audience: 'Independent founders',
      question: 'Would you try it this week?', options: ['Yes', 'No'], successOption: 'Yes',
      minimumResponses: 2, thresholdPercent: 50 } });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const id = proposed.body.experiment.id;
  const published = await request(`/api/experiments/${id}/publish`, { method: 'POST', cookie: a.cookie, csrf: a.csrf });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const publicId = published.body.experiment.publicId;
  const page = await request(`/api/public/experiments/${publicId}`);
  assert.equal(page.status, 200);
  assert.equal('hypothesis' in page.body.experiment, false);
  const response = await request(`/api/public/experiments/${publicId}/responses`, { method: 'POST',
    body: { qualified: true, choice: 'No', comment: 'The workflow is unclear.', submissionId: randomUUID() } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const ownerOnly = await request(`/api/experiments/${id}/results`, { cookie: b.cookie });
  assert.equal(ownerOnly.status, 404);
  const closed = await request(`/api/experiments/${id}/close`, { method: 'POST', cookie: a.cookie, csrf: a.csrf });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.stats.responses, 1);
  assert.equal(closed.body.stats.metThreshold, false);
  const review = await request(`/api/experiments/${id}/review`, { method: 'POST', cookie: a.cookie, csrf: a.csrf });
  assert.equal(review.status, 503); // No Crusoe key in this isolated test server.
  const after = await request(`/api/experiments/${id}/results`, { cookie: a.cookie });
  assert.equal(after.body.stats.responses, 1); // Collection survives AI outage.
  const deleted = await request('/api/auth/account', { method: 'DELETE', cookie: a.cookie, csrf: a.csrf,
    body: { password: a.password } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const gone = await request(`/api/public/experiments/${publicId}`);
  assert.equal(gone.status, 404);
  console.log('BUEELD local API integration passed: auth, CSRF, maturity, isolation, public response, closure, AI outage, deletion.');
}

try { await run(); }
finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('close', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
