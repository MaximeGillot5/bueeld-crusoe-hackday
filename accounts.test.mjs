import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
const source = process.env.LAB_TEST_SOURCE_DIR || new URL('.', import.meta.url).pathname;
const isolated = await mkdtemp(join(tmpdir(), 'bueeld-account-test-'));
await copyFile(join(source, 'accounts.mjs'), join(isolated, 'accounts.mjs'));
await copyFile(join(source, 'connectors.mjs'), join(isolated, 'connectors.mjs'));
process.env.LAB_PUBLIC_ORIGIN = 'https://lab.example.test';
const { handleAccountRoute } = await import(pathToFileURL(join(isolated, 'accounts.mjs')).href);
function request(method, path, headers = {}, body) {
  const req = body === undefined ? { method, headers } : Object.assign(Readable.from([JSON.stringify(body)]), { method, headers: { 'content-type': 'application/json', ...headers } });
  const res = { destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value = '') { this.body = value; } };
  return { req, res, url: new URL(path, 'https://lab.example.test') };
}
async function call(method, path, headers = {}, body) {
  const x = request(method, path, headers, body);
  assert.equal(await handleAccountRoute(x.req, x.res, x.url), true);
  return { status: x.res.status, headers: x.res.headers, body: JSON.parse(x.res.body) };
}
try {
  const sessionA = await call('GET', '/api/auth/session');
  assert.equal(sessionA.status, 200);
  assert.equal(sessionA.body.authenticated, false);
  assert.match(sessionA.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Secure/);
  const cookieA0 = sessionA.headers['Set-Cookie'].split(';')[0];
  const sessionB = await call('GET', '/api/auth/session');
  const cookieB0 = sessionB.headers['Set-Cookie'].split(';')[0];
  assert.notEqual(cookieA0, cookieB0);
  assert.equal((await call('POST', '/api/auth/signup', { cookie: cookieA0 }, { email: 'a@example.test', password: 'this-is-a-good-password' })).status, 403);
  const signupA = await call('POST', '/api/auth/signup', { cookie: cookieA0, 'x-lab-csrf': sessionA.body.csrfToken }, { email: 'a@example.test', password: 'this-is-a-good-password' });
  assert.equal(signupA.status, 201);
  const cookieA = signupA.headers['Set-Cookie'].split(';')[0];
  assert.notEqual(cookieA, cookieA0);
  assert.notEqual(signupA.body.csrfToken, sessionA.body.csrfToken);
  const signupB = await call('POST', '/api/auth/signup', { cookie: cookieB0, 'x-lab-csrf': sessionB.body.csrfToken }, { email: 'b@example.test', password: 'this-is-another-good-password' });
  assert.equal(signupB.status, 201);
  const cookieB = signupB.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call('GET', '/api/auth/session', { cookie: cookieA0 })).body.authenticated, false);
  const emptyMemory = { project: '', target: '', goal: '', blocker: '' };
  const projectMemory = { project: 'Scheduling for tutors', target: 'Independent tutors', goal: 'Test whether reminders reduce cancellations', blocker: 'No measured cancellation baseline' };
  assert.equal((await call('GET', '/api/project-memory', { cookie: cookieA0 })).status, 401);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA0, 'x-lab-csrf': sessionA.body.csrfToken }, { projectMemory })).status, 401);
  assert.deepEqual((await call('GET', '/api/project-memory', { cookie: cookieA })).body.projectMemory, emptyMemory);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA }, { projectMemory })).status, 403);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA, 'x-lab-csrf': signupB.body.csrfToken }, { projectMemory })).status, 403);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { projectMemory: { ...projectMemory, project: 'a'.repeat(351) } })).status, 400);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { projectMemory: { project: null } })).status, 400);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, {})).status, 400);
  assert.equal((await call('PUT', '/api/project-memory', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { projectMemory })).status, 200);
  assert.deepEqual((await call('GET', '/api/project-memory', { cookie: cookieA })).body.projectMemory, projectMemory);
  assert.deepEqual((await call('GET', '/api/project-memory', { cookie: cookieB })).body.projectMemory, emptyMemory);
  const tracker = { records: [{ id: 'm1', content: 'Talk to five founders.', status: 'approved', createdAt: Date.now(), approvedAt: Date.now(), evidence: '', evidenceAt: null, area: '', outcome: '', realEvidence: false, completedAt: null }], seenLevel: 1 };
  assert.deepEqual((await call('GET', '/api/mission-tracker', { cookie: cookieA })).body.missionTracker.records, []);
  assert.equal((await call('PUT', '/api/mission-tracker', { cookie: cookieA, 'x-lab-csrf': signupB.body.csrfToken }, { missionTracker: tracker })).status, 403);
  assert.equal((await call('PUT', '/api/mission-tracker', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { missionTracker: tracker })).status, 200);
  assert.equal((await call('GET', '/api/mission-tracker', { cookie: cookieA })).body.missionTracker.records[0].learning, null);
  const learning = { assumption: 'The previous assumption was not recorded.', observation: 'The founder reports two cancelled sessions.', decision: 'Collect a baseline before selecting a target.', nextMission: 'Measure cancellations over seven days; propose at least five documented sessions.', recommendation: 'iterate' };
  const learnedTracker = { ...tracker, records: [{ ...tracker.records[0], learning }] };
  assert.equal((await call('PUT', '/api/mission-tracker', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { missionTracker: learnedTracker })).status, 200);
  assert.deepEqual((await call('GET', '/api/mission-tracker', { cookie: cookieA })).body.missionTracker.records[0].learning, learning);
  for (const invalidLearning of [{ ...learning, decision: '' }, { ...learning, assumption: 'a'.repeat(601) }, { ...learning, recommendation: 'win' }, { ...learning, unwanted: 'field' }]) {
    assert.equal((await call('PUT', '/api/mission-tracker', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { missionTracker: { ...tracker, records: [{ ...tracker.records[0], learning: invalidLearning }] } })).status, 400);
  }
  const fullHistory = { seenLevel: 1, records: Array.from({ length: 40 }, (_, index) => ({
    ...tracker.records[0], id: `history-${index}`, content: 'm'.repeat(1500), evidence: 'e'.repeat(1500),
    learning: { assumption: 'a'.repeat(600), observation: 'o'.repeat(600), decision: 'd'.repeat(600), nextMission: 'n'.repeat(600), recommendation: 'iterate' },
  })) };
  assert.equal((await call('PUT', '/api/mission-tracker', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { missionTracker: fullHistory })).status, 200);
  assert.equal((await call('GET', '/api/mission-tracker', { cookie: cookieA })).body.missionTracker.records.length, 40);
  assert.equal((await call('PUT', '/api/mission-tracker', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { missionTracker: learnedTracker })).status, 200);
  assert.deepEqual((await call('GET', '/api/mission-tracker', { cookie: cookieB })).body.missionTracker.records, []);
  const payload = {
    title: 'Founder idea',
    messages: [{ id: 'm1', role: 'user', content: 'We should test our offer.', at: Date.now(), status: 'complete' }],
    pinnedMission: { content: 'Talk to five founders.', status: 'approved', sourceMessageId: 'm1', pinnedAt: Date.now() },
    sourceContexts: [{ name: 'Notes analysis', kind: 'analysis', digest: 'a'.repeat(64), summary: 'Three interviews requested faster setup.' }],
    onboardingDraft: { step: 2, answers: ['Founder problem', 'Target user'] },
  };
  const created = await call('POST', '/api/conversations', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, payload);
  assert.equal(created.status, 201);
  const id = created.body.conversation.id;
  assert.equal((await call('GET', `/api/conversations/${id}`, { cookie: cookieB })).status, 404);
  assert.deepEqual((await call('GET', '/api/conversations', { cookie: cookieB })).body.conversations, []);
  assert.equal((await call('PUT', `/api/conversations/${id}`, { cookie: cookieB, 'x-lab-csrf': signupB.body.csrfToken }, payload)).status, 404);
  assert.equal((await call('DELETE', `/api/conversations/${id}`, { cookie: cookieB, 'x-lab-csrf': signupB.body.csrfToken })).status, 404);
  assert.equal((await call('PUT', `/api/conversations/${id}`, { cookie: cookieA, 'x-lab-csrf': signupB.body.csrfToken }, payload)).status, 403);
  assert.equal((await call('PUT', `/api/conversations/${id}`, { cookie: cookieA }, payload)).status, 403);
  const updated = await call('PUT', `/api/conversations/${id}`, { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken }, { ...payload, title: 'Revised founder idea' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.conversation.title, 'Revised founder idea');
  const dataDir = join(isolated, '.data');
  const file = join(dataDir, 'accounts.json');
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const disk = await readFile(file, 'utf8');
  assert.equal(disk.includes('this-is-a-good-password'), false);
  assert.equal(disk.includes('a@example.test'), true);
  assert.equal(disk.includes('Revised founder idea'), true);
  const reload = await import(`${pathToFileURL(join(isolated, 'accounts.mjs')).href}?reload=1`);
  const afterReload = await (async () => { const x = request('GET', `/api/conversations/${id}`, { cookie: cookieA }); await reload.handleAccountRoute(x.req, x.res, x.url); return x.res; })();
  assert.equal(afterReload.status, 200);
  assert.equal(JSON.parse(afterReload.body).conversation.sourceContexts.length, 1);
  assert.deepEqual(JSON.parse(afterReload.body).conversation.onboardingDraft.answers, ['Founder problem', 'Target user']);
  const afterReloadTracker = await (async () => { const x = request('GET', '/api/mission-tracker', { cookie: cookieA }); await reload.handleAccountRoute(x.req, x.res, x.url); return x.res; })();
  assert.equal(JSON.parse(afterReloadTracker.body).missionTracker.records.length, 1);
  assert.deepEqual(JSON.parse(afterReloadTracker.body).missionTracker.records[0].learning, learning);
  const memoryRead = request('GET', '/api/project-memory', { cookie: cookieA });
  await reload.handleAccountRoute(memoryRead.req, memoryRead.res, memoryRead.url);
  assert.deepEqual(JSON.parse(memoryRead.res.body).projectMemory, projectMemory);
  // Capture the old session, then rotate it while the body is still streaming.
  const delayedRequest = Object.assign(new PassThrough(), { method: 'PUT', headers: { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken, 'content-type': 'application/json' } });
  const delayedResponse = request('PUT', '/api/project-memory').res;
  const delayedSave = handleAccountRoute(delayedRequest, delayedResponse, new URL('/api/project-memory', 'https://lab.example.test'));
  const logout = await call('POST', '/api/auth/logout', { cookie: cookieA, 'x-lab-csrf': signupA.body.csrfToken });
  assert.equal(logout.status, 200);
  delayedRequest.end(JSON.stringify({ projectMemory: { ...projectMemory, project: 'MUST NOT SAVE AFTER LOGOUT' } }));
  await delayedSave;
  assert.equal(delayedResponse.status, 401);
  assert.equal((await readFile(file, 'utf8')).includes('MUST NOT SAVE AFTER LOGOUT'), false);
  assert.equal((await call('GET', '/api/conversations', { cookie: cookieA })).status, 401);
  const anonCookie = logout.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call('POST', '/api/auth/login', { cookie: anonCookie, 'x-lab-csrf': logout.body.csrfToken }, { email: 'a@example.test', password: 'wrong-password-12' })).status, 401);
  const login = await call('POST', '/api/auth/login', { cookie: anonCookie, 'x-lab-csrf': logout.body.csrfToken }, { email: 'a@example.test', password: 'this-is-a-good-password' });
  assert.equal(login.status, 200);
  assert.deepEqual((await call('GET', '/api/project-memory', { cookie: login.headers['Set-Cookie'].split(';')[0] })).body.projectMemory, projectMemory);
  assert.equal((await call('GET', `/api/conversations/${id}`, { cookie: login.headers['Set-Cookie'].split(';')[0] })).status, 200);
  assert.equal((await call('DELETE', `/api/conversations/${id}`, { cookie: login.headers['Set-Cookie'].split(';')[0], 'x-lab-csrf': login.body.csrfToken })).status, 200);
  assert.deepEqual((await call('GET', '/api/conversations', { cookie: login.headers['Set-Cookie'].split(';')[0] })).body.conversations, []);
  const activeCookie = login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call('DELETE', '/api/auth/account', { cookie: activeCookie, 'x-lab-csrf': login.body.csrfToken }, { password: 'wrong-password-12' })).status, 401);
  const removed = await call('DELETE', '/api/auth/account', { cookie: activeCookie, 'x-lab-csrf': login.body.csrfToken }, { password: 'this-is-a-good-password' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  assert.equal((await call('GET', '/api/auth/session', { cookie: activeCookie })).body.authenticated, false);
  assert.equal((await call('GET', '/api/auth/session', { cookie: cookieB })).body.authenticated, true);
  assert.equal((await readFile(file, 'utf8')).includes('a@example.test'), false);
  assert.equal((await readFile(file, 'utf8')).includes(projectMemory.project), false);
  console.log('Lab account tests passed: CSRF, hashes, rotation, user isolation, private atomic store, reload, CRUD, mission learning, project memory and logout race, onboarding, account deletion.');
} finally { await rm(isolated, { recursive: true, force: true }); }
