import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = process.env.LAB_TEST_SOURCE_DIR || new URL('.', import.meta.url).pathname;
const password = 'a-good-fixture-password';
const DAY = 24 * 60 * 60 * 1000;
const worker = `
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.now !== undefined) Date.now = () => input.now;
const { handleAccountRoute } = await import('./accounts.mjs');
const { getLabSession } = await import('./connectors.mjs');
let cookie = input.cookie || '';
let csrfToken = input.csrfToken || '';
const responses = [];
for (const action of input.actions) {
  if (action.blockStore || action.restoreStore) {
    const name = action.blockStore || action.restoreStore;
    if (!['accounts.json', 'auth-sessions.json'].includes(name)) throw new Error('Invalid fixture store');
    const file = './.data/' + name;
    if (action.blockStore) {
      await rename(file, file + '.fixture-backup');
      await mkdir(file);
    } else {
      await rm(file, { recursive: true });
      await rename(file + '.fixture-backup', file);
    }
    continue;
  }
  if (action.seedProvider) {
    const session = getLabSession({ headers: { cookie } });
    session.tokens.set('gmail', { accessToken: 'fixture-provider-secret', expiresAt: Date.now() + 60000 });
    session.states.set('fixture-oauth-state', { verifier: 'fixture-pkce-secret' });
    session.listings.set('gmail', [{ id: 'fixture-private-listing' }]);
    continue;
  }
  if (action.inspectSession) {
    const session = getLabSession({ headers: { cookie } });
    responses.push({ tokens: session?.tokens.size, states: session?.states.size, listings: session?.listings.size });
    continue;
  }
  const headers = { cookie: Object.hasOwn(action, 'cookie') ? action.cookie : cookie, 'x-lab-csrf': csrfToken };
  const req = action.body === undefined ? { method: action.method, headers } : Object.assign(Readable.from([JSON.stringify(action.body)]), { method: action.method, headers: { ...headers, 'content-type': 'application/json' } });
  const res = { destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body = '') { this.body = body; } };
  const handled = await handleAccountRoute(req, res, new URL(action.path, process.env.LAB_PUBLIC_ORIGIN));
  if (!handled) throw new Error('Unhandled fixture route: ' + action.path);
  const body = JSON.parse(res.body);
  if (res.headers['Set-Cookie']) cookie = res.headers['Set-Cookie'].split(';')[0];
  if (body.csrfToken) csrfToken = body.csrfToken;
  responses.push({ status: res.status, headers: res.headers, body, cookie, csrfToken });
}
process.stdout.write(JSON.stringify({ responses, cookie, csrfToken }));
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bueeld-session-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(['accounts.mjs', 'connectors.mjs'].map((name) => copyFile(join(source, name), join(directory, name))));
  await writeFile(join(directory, 'worker.mjs'), worker);
  return directory;
}

// Each call is a genuinely fresh Node process; module-cache reloads cannot prove session durability.
function run(directory, actions, options = {}) {
  const port = options.port || 4173;
  const result = spawnSync(process.execPath, [join(directory, 'worker.mjs')], {
    cwd: directory,
    env: { PORT: String(port), LAB_PUBLIC_ORIGIN: `http://localhost:${port}` },
    input: JSON.stringify({ ...options, actions }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const session = { method: 'GET', path: '/api/auth/session' };
const signup = (email = 'founder@example.test') => ({ method: 'POST', path: '/api/auth/signup', body: { email, password } });
const login = (email = 'founder@example.test') => ({ method: 'POST', path: '/api/auth/login', body: { email, password } });
const logout = { method: 'POST', path: '/api/auth/logout' };
const snapshot = async (directory) => JSON.parse(await readFile(join(directory, '.data', 'auth-sessions.json'), 'utf8'));

test('authenticated reloads survive fresh processes with the same CSRF and private hashed storage', async (t) => {
  const directory = await fixture(t);
  const created = run(directory, [session, signup()]);
  assert.equal(created.responses[1].status, 201);
  assert.match(created.responses[1].headers['Set-Cookie'], /Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax/);
  const resumed = run(directory, [session, session, { method: 'GET', path: '/api/conversations' }], created);
  assert.equal(resumed.responses[0].body.authenticated, true);
  assert.equal(resumed.responses[0].body.user.id, created.responses[1].body.user.id);
  assert.equal(resumed.csrfToken, created.csrfToken);
  assert.equal(resumed.responses[1].body.authenticated, true);
  assert.equal(resumed.responses[0].headers['Set-Cookie'], undefined);
  assert.equal(resumed.responses[1].headers['Set-Cookie'], undefined);
  assert.equal(resumed.responses[2].status, 200);
  const memory = { project: 'Fixture project', target: '', goal: '', blocker: '' };
  const saved = run(directory, [{ method: 'PUT', path: '/api/project-memory', body: { projectMemory: memory } }], resumed);
  assert.equal(saved.responses[0].status, 200);
  const store = await snapshot(directory);
  assert.equal(store.version, 1);
  assert.equal(store.sessions.length, 1);
  assert.deepEqual(Object.keys(store.sessions[0]).sort(), ['csrfToken', 'expiresAt', 'key', 'userId']);
  assert.match(store.sessions[0].key, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(store).includes(created.cookie.split('=')[1]), false);
  assert.equal((await stat(join(directory, '.data'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, '.data', 'auth-sessions.json'))).mode & 0o777, 0o600);
});

test('login survives restart and logout stays revoked after another restart', async (t) => {
  const directory = await fixture(t);
  const created = run(directory, [session, signup(), logout]);
  assert.equal(created.responses[2].status, 200);
  assert.match(created.responses[2].headers['Set-Cookie'], /Max-Age=7200;/);
  const signedIn = run(directory, [session, login()], created);
  assert.equal(signedIn.responses[1].status, 200);
  const resumed = run(directory, [session, logout], signedIn);
  assert.equal(resumed.responses[0].body.authenticated, true);
  assert.equal(resumed.responses[1].status, 200);
  const revoked = run(directory, [session], signedIn);
  assert.equal(revoked.responses[0].body.authenticated, false);
  assert.equal((await snapshot(directory)).sessions.length, 0);
});

test('anonymous sessions stay temporary and authenticated sessions expire at 30 days', async (t) => {
  const directory = await fixture(t);
  const now = 1800000000000;
  const anonymous = run(directory, [session], { now });
  assert.match(anonymous.responses[0].headers['Set-Cookie'], /Max-Age=7200;/);
  const nextAnonymous = run(directory, [session], { ...anonymous, now });
  assert.equal(nextAnonymous.responses[0].body.authenticated, false);
  assert.notEqual(nextAnonymous.cookie, anonymous.cookie);
  const created = run(directory, [session, signup()], { now });
  const valid = run(directory, [session], { ...created, now: now + 30 * DAY - 1 });
  assert.equal(valid.responses[0].body.authenticated, true);
  const expired = run(directory, [session], { ...created, now: now + 30 * DAY });
  assert.equal(expired.responses[0].body.authenticated, false);
  assert.equal(run(directory, [session], { ...created, now: now + 31 * DAY }).responses[0].body.authenticated, false);
});

test('two localhost ports keep independent cookies in the same browser cookie jar', async (t) => {
  const main = await fixture(t);
  const qa = await fixture(t);
  const first = run(main, [session, signup('main@example.test')], { port: 4173 });
  const second = run(qa, [session, signup('qa@example.test')], { port: 4174, cookie: first.cookie });
  assert.equal(first.cookie.split('=')[0], 'bueeld_lab_session_4173');
  assert.equal(second.cookie.split('=')[0], 'bueeld_lab_session_4174');
  const cookie = `${first.cookie}; ${second.cookie}`;
  const mainReload = run(main, [session], { port: 4173, cookie });
  const qaReload = run(qa, [session], { port: 4174, cookie });
  assert.equal(mainReload.responses[0].body.user.email, 'main@example.test');
  assert.equal(qaReload.responses[0].body.user.email, 'qa@example.test');
  assert.equal(mainReload.responses[0].headers['Set-Cookie'], undefined);
  assert.equal(qaReload.responses[0].headers['Set-Cookie'], undefined);
});

test('deleting an account revokes every persisted session across restarts', async (t) => {
  const directory = await fixture(t);
  const first = run(directory, [session, signup()]);
  const second = run(directory, [session, login()]);
  assert.equal((await snapshot(directory)).sessions.length, 2);
  const removed = run(directory, [{ method: 'DELETE', path: '/api/auth/account', body: { password } }], first);
  assert.equal(removed.responses[0].status, 200);
  assert.equal(removed.responses[0].body.deleted, true);
  assert.equal(run(directory, [session], first).responses[0].body.authenticated, false);
  assert.equal(run(directory, [session], second).responses[0].body.authenticated, false);
  assert.equal((await snapshot(directory)).sessions.length, 0);
});

test('provider tokens, OAuth state and cached source listings never become durable', async (t) => {
  const directory = await fixture(t);
  const created = run(directory, [session, signup(), { seedProvider: true }, { ...session, cookie: '' }, login()]);
  const first = created.responses[1];
  const disk = await readFile(join(directory, '.data', 'auth-sessions.json'), 'utf8');
  for (const value of ['fixture-provider-secret', 'fixture-oauth-state', 'fixture-pkce-secret', 'fixture-private-listing']) assert.equal(disk.includes(value), false);
  const restored = run(directory, [session, { inspectSession: true }], first);
  assert.equal(restored.responses[0].body.authenticated, true);
  assert.deepEqual(restored.responses[1], { tokens: 0, states: 0, listings: 0 });
});

test('failed durable revocation leaves the account and its existing session usable', async (t) => {
  const directory = await fixture(t);
  const created = run(directory, [session, signup()]);
  const failed = run(directory, [
    { blockStore: 'auth-sessions.json' },
    { method: 'DELETE', path: '/api/auth/account', body: { password } },
    { restoreStore: 'auth-sessions.json' },
    session,
    { method: 'GET', path: '/api/conversations' },
  ], created);
  assert.equal(failed.responses[0].status, 503);
  assert.equal(failed.responses[1].body.authenticated, true);
  assert.equal(failed.responses[2].status, 200);
  assert.equal(run(directory, [session], created).responses[0].body.authenticated, true);
});

test('failed account deletion write preserves the account while prior sessions stay revoked', async (t) => {
  const directory = await fixture(t);
  const first = run(directory, [session, signup()]);
  const second = run(directory, [session, login()]);
  const failed = run(directory, [
    { blockStore: 'accounts.json' },
    { method: 'DELETE', path: '/api/auth/account', body: { password } },
    { restoreStore: 'accounts.json' },
    session,
  ], first);
  assert.ok(failed.responses[0].status >= 500);
  assert.equal(failed.responses[1].body.authenticated, false);
  assert.equal(run(directory, [session], first).responses[0].body.authenticated, false);
  assert.equal(run(directory, [session], second).responses[0].body.authenticated, false);
  assert.equal((await snapshot(directory)).sessions.length, 0);
  const recovered = run(directory, [session, login()]);
  assert.equal(recovered.responses[1].status, 200);
  assert.equal(recovered.responses[1].body.user.id, first.responses[1].body.user.id);
});
