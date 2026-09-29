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
  env: { PATH: process.env.PATH || '', HOME: dataDir, HOST: '127.0.0.1', PORT: '0', BUEELD_SKIP_LOCAL_ENV: '1',
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
    const email = `${randomUUID()}@example.test`;
    const created = await request('/api/auth/signup', { method: 'POST',
      body: { email, password },
      cookie: session.cookie, csrf: session.body.csrfToken });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { cookie: created.cookie, csrf: created.body.csrfToken, password, email, userId: created.body.user.id };
  }

  const guestAi = await request('/api/chat', { method: 'POST', body: {} });
  assert.equal(guestAi.status, 401);
  const bandStatus = await request('/api/band/status');
  assert.deepEqual(bandStatus.body, { configured: false });
  const guestBand = await request('/api/band/advice', { method: 'POST',
    body: { question: 'What would challenge this mission?' } });
  assert.equal(guestBand.status, 401);
  const guestBandChat = await request('/api/band/chat-reply', { method: 'POST',
    body: { question: 'What did Lia miss?', liaReply: 'Lia suggested a pilot.' } });
  assert.equal(guestBandChat.status, 401);
  const guestBandCreate = await request('/api/band/create', { method: 'POST', body: { context: {} } });
  assert.equal(guestBandCreate.status, 401);
  const a = await signup();
  const b = await signup();
  const loginCase = await signup();
  const loggedOut = await request('/api/auth/logout', { method: 'POST', cookie: loginCase.cookie,
    csrf: loginCase.csrf });
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.body.authenticated, false);
  const visitor = await request('/api/auth/session', { cookie: loggedOut.cookie });
  assert.equal(visitor.status, 200);
  assert.equal(visitor.body.authenticated, false);
  const loggedIn = await request('/api/auth/login', { method: 'POST', cookie: visitor.cookie || loggedOut.cookie,
    csrf: visitor.body.csrfToken, body: { email: loginCase.email, password: loginCase.password } });
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));
  assert.equal(loggedIn.body.authenticated, true);
  assert.equal(loggedIn.body.user.id, loginCase.userId);
  const restoredSession = await request('/api/auth/session', { cookie: loggedIn.cookie });
  assert.equal(restoredSession.status, 200);
  assert.equal(restoredSession.body.authenticated, true);
  assert.equal(restoredSession.body.user.id, loginCase.userId);
  const bandNoCsrf = await request('/api/band/advice', { method: 'POST', cookie: a.cookie,
    body: { question: 'What would challenge this mission?' } });
  assert.equal(bandNoCsrf.status, 403);
  const bandChatNoCsrf = await request('/api/band/chat-reply', { method: 'POST', cookie: a.cookie,
    body: { question: 'What did Lia miss?', liaReply: 'Lia suggested a pilot.' } });
  assert.equal(bandChatNoCsrf.status, 403);
  const bandCreateNoCsrf = await request('/api/band/create', { method: 'POST', cookie: a.cookie, body: { context: {} } });
  assert.equal(bandCreateNoCsrf.status, 403);
  const bandUnconfigured = await request('/api/band/advice', { method: 'POST', cookie: a.cookie, csrf: a.csrf,
    body: { question: 'What would challenge this mission?' } });
  assert.equal(bandUnconfigured.status, 503);
  const bandChatUnconfigured = await request('/api/band/chat-reply', { method: 'POST', cookie: a.cookie, csrf: a.csrf,
    body: { question: 'What did Lia miss?', liaReply: 'Lia suggested a pilot.' } });
  assert.equal(bandChatUnconfigured.status, 503);
  const bandCreateUnconfigured = await request('/api/band/create', { method: 'POST', cookie: a.cookie, csrf: a.csrf,
    body: { context: {} } });
  assert.equal(bandCreateUnconfigured.status, 503);
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
  const duplicate = await request('/api/projects/current/milestones/target_problem/validate', {
    method: 'POST', cookie: a.cookie, csrf: a.csrf, body: milestoneBody });
  assert.equal(duplicate.body.transition.gain, 0);
  const other = await request('/api/projects/current/maturity', { cookie: b.cookie });
  assert.equal(other.body.maturity.percent, 0);
  const noCsrf = await request('/api/projects/current/milestones/value_proposition/validate', {
    method: 'POST', cookie: a.cookie, body: milestoneBody });
  assert.equal(noCsrf.status, 403);

  // Guided chat never persists an answer when AI is unavailable. The legacy
  // direct-write endpoint is closed, so a client cannot bypass analysis.
  const guided = await signup();
  const guidedMission = '/api/projects/current/milestones/target_problem';
  const guidedStart = await request('/api/projects/current/maturity', { cookie: guided.cookie });
  assert.equal(guidedStart.status, 200);
  const firstMilestone = guidedStart.body.maturity.milestones.find((item) => item.id === 'target_problem');
  assert.ok(Array.isArray(firstMilestone.questions) && firstMilestone.questions.length === 3,
    'the mission must supply Lia with its questions');
  assert.deepEqual(firstMilestone.draft.answers, ['', '', '']);
  assert.equal(firstMilestone.draft.answeredCount, 0);
  const resetNoCsrf = await request(`${guidedMission}/reset`, { method: 'POST', cookie: guided.cookie, body: {} });
  assert.equal(resetNoCsrf.status, 403, 'resetting a guided mission requires the account CSRF token');
  const resetPending = await request(`${guidedMission}/reset`, { method: 'POST', cookie: guided.cookie,
    csrf: guided.csrf, body: {} });
  assert.equal(resetPending.status, 200, JSON.stringify(resetPending.body));
  assert.deepEqual(resetPending.body.maturity.milestones.find((item) => item.id === 'target_problem').draft.answers,
    ['', '', '']);
  const resetValidated = await request(`${guidedMission}/reset`, { method: 'POST', cookie: a.cookie,
    csrf: a.csrf, body: {} });
  assert.equal(resetValidated.status, 409, 'a validated mission cannot be reset');
  const answer = 'Independent neighborhood bookstore owners in San Francisco who handle online orders themselves.';
  const missingCsrf = await request(`${guidedMission}/turn`, { method: 'POST', cookie: guided.cookie,
    body: { stepIndex: 0, message: answer } });
  assert.equal(missingCsrf.status, 403);
  const legacyWrite = await request(`${guidedMission}/answers`, { method: 'PUT',
    cookie: guided.cookie, csrf: guided.csrf, body: { stepIndex: 0, answer } });
  assert.equal(legacyWrite.status, 410);
  const beforeAnswers = await request(`${guidedMission}/complete`, { method: 'POST',
    cookie: guided.cookie, csrf: guided.csrf, body: { confirmed: true, requestId: randomUUID() } });
  assert.ok(beforeAnswers.status >= 400, 'an unanswered mission cannot be completed');
  const failedAnalysis = await request(`${guidedMission}/turn`, { method: 'POST',
    cookie: guided.cookie, csrf: guided.csrf, body: { stepIndex: 0, message: answer } });
  assert.equal(failedAnalysis.status, 503, JSON.stringify(failedAnalysis.body));
  const resumed = await request('/api/projects/current/maturity', { cookie: guided.cookie });
  assert.equal(resumed.status, 200);
  const resumedMission = resumed.body.maturity.milestones.find((item) => item.id === 'target_problem');
  assert.deepEqual(resumedMission.draft.answers, ['', '', ''], 'AI outage must not save an answer');
  assert.equal(resumedMission.draft.answeredCount, 0);
  assert.equal(resumedMission.draft.complete, false);
  assert.equal(resumed.body.maturity.percent, 0);
  const separateFounder = await request('/api/projects/current/maturity', { cookie: b.cookie });
  assert.equal(JSON.stringify(separateFounder.body).includes(answer), false, 'answers are owner-scoped');

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
  if (server.exitCode === null && server.signalCode === null) {
    const closed = new Promise((resolve) => server.once('close', resolve));
    server.kill('SIGTERM');
    await closed;
  }
  await rm(dataDir, { recursive: true, force: true });
}
