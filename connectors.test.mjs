import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
process.env.LAB_PUBLIC_ORIGIN = 'https://lab.example.test';
process.env.LAB_GOOGLE_CLIENT_ID = 'test-client-id';
process.env.LAB_GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.LAB_NOTION_CLIENT_ID = 'test-notion-id';
process.env.LAB_NOTION_CLIENT_SECRET = 'test-notion-secret';
const { handleConnectorRoute, connectorConfiguration, getLabSession, ensureLabSession } = await import('./connectors.mjs');
const calls = [];
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  calls.push({ url: url.href, options });
  if (url.pathname === '/v1/oauth/token') return new Response(JSON.stringify({ access_token: 'notion-private-token', workspace_name: 'Test workspace' }), { status: 200 });
  if (url.pathname === '/token') {
    const scope = String(options.body).includes('drive-code') ? 'https://www.googleapis.com/auth/drive.readonly' : 'https://www.googleapis.com/auth/gmail.readonly';
    return new Response(JSON.stringify({ access_token: 'private-token', scope, expires_in: 3600 }), { status: 200 });
  }
  if (url.pathname === '/gmail/v1/users/me/messages' && !url.pathname.endsWith('/m1')) return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 });
  if (url.pathname === '/gmail/v1/users/me/messages/m1') {
    const message = url.searchParams.get('format') === 'full'
      ? { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'Test source' }], mimeType: 'multipart/mixed', parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Selected private content').toString('base64url') } }] },
        { filename: 'attachment.txt', mimeType: 'text/plain', body: { data: Buffer.from('Do not import attachment').toString('base64url') } },
      ] } }
      : { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'Test source' }] }, snippet: 'Short' };
    return new Response(JSON.stringify(message), { status: 200 });
  }
  if (url.pathname === '/drive/v3/files') return new Response(JSON.stringify({ files: [{ id: 'pdf1', name: 'Plan.pdf', mimeType: 'application/pdf', size: '20' }] }), { status: 200 });
  if (url.pathname === '/drive/v3/files/pdf1') return new Response(Buffer.from('%PDF-1.7\nTest document'), { status: 200 });
  if (url.pathname === '/v1/search') return new Response(JSON.stringify({ results: [{ object: 'page', id: 'page1', properties: { title: { type: 'title', title: [{ plain_text: 'Test page' }] } } }] }), { status: 200 });
  if (url.pathname === '/v1/pages/page1') return new Response(JSON.stringify({ properties: { title: { type: 'title', title: [{ plain_text: 'Test page' }] } } }), { status: 200 });
  if (url.pathname === '/v1/blocks/page1/children') return new Response(JSON.stringify({ results: [{ id: 'toggle1', type: 'toggle', has_children: true, toggle: { rich_text: [{ plain_text: 'Roadmap' }] } }] }), { status: 200 });
  if (url.pathname === '/v1/blocks/toggle1/children') return new Response(JSON.stringify({ results: [{ id: 'p1', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: 'Nested customer evidence' }] } }] }), { status: 200 });
  throw new Error(`Unexpected fetch: ${url.href}`);
};
function request(method, path, headers = {}, body) {
  const req = body === undefined ? { method, headers } : Object.assign(Readable.from([JSON.stringify(body)]), { method, headers: { 'content-type': 'application/json', ...headers } });
  const res = { destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value = '') { this.body = value; } };
  return { req, res, url: new URL(path, 'https://lab.example.test') };
}
async function run(method, path, headers = {}, body) {
  const x = request(method, path, headers, body);
  assert.equal(await handleConnectorRoute(x.req, x.res, x.url), true);
  return x.res;
}
assert.equal(connectorConfiguration().filter((item) => item.available).length, 4);
const first = await run('GET', '/api/connectors/status');
assert.equal(first.status, 200);
assert.equal(first.headers['Set-Cookie'], undefined); // Anonymous status does not allocate a session.
const anonymousA = ensureLabSession({ headers: {} });
const anonymousB = ensureLabSession({ headers: {} });
assert.match(anonymousA.setCookie, /HttpOnly; SameSite=Lax; Secure/);
const cookieA = anonymousA.setCookie.split(';')[0];
const cookieB = anonymousB.setCookie.split(';')[0];
assert.notEqual(cookieA, cookieB);
getLabSession({ headers: { cookie: cookieA } }).userId = 'synthetic-a';
getLabSession({ headers: { cookie: cookieB } }).userId = 'synthetic-b';
const start = await run('GET', '/api/connectors/gmail/start', { cookie: cookieA, 'sec-fetch-site': 'same-origin' });
assert.equal(start.status, 302);
const authorization = new URL(start.headers.Location);
assert.equal(authorization.hostname, 'accounts.google.com');
assert.equal(authorization.searchParams.get('redirect_uri'), 'https://lab.example.test/api/connectors/google/callback');
assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
const state = authorization.searchParams.get('state');
assert.equal((await run('GET', `/api/connectors/google/callback?state=wrong&code=x`, { cookie: cookieA })).status, 400);
assert.equal(calls.length, 0);
const connected = await run('GET', `/api/connectors/google/callback?state=${state}&code=abc`, { cookie: cookieA });
assert.equal(connected.status, 302);
assert.equal(connected.headers.Location, '/connector-complete.html?connector=gmail&status=connected');
assert.equal((await run('GET', `/api/connectors/google/callback?state=${state}&code=abc`, { cookie: cookieA })).status, 400);
const statusA = JSON.parse((await run('GET', '/api/connectors/status', { cookie: cookieA })).body);
const statusB = JSON.parse((await run('GET', '/api/connectors/status', { cookie: cookieB })).body);
assert.equal(statusA.connectors.find((item) => item.id === 'gmail').connected, true);
assert.equal(statusB.connectors.find((item) => item.id === 'gmail').connected, false);
assert.equal(JSON.stringify(statusA).includes('private-token'), false);
assert.equal((await run('POST', '/api/connectors/gmail/disconnect', { cookie: cookieA, origin: 'https://other.example' }, {})).status, 403);
const list = await run('GET', '/api/connectors/gmail/list', { cookie: cookieA });
assert.equal(list.status, 200);
assert.deepEqual(JSON.parse(list.body).items.map((item) => item.id), ['m1']);
assert.equal((await run('POST', '/api/connectors/gmail/import', { cookie: cookieA, origin: 'https://lab.example.test' }, { ids: ['some-other-id'] })).status, 400);
assert.equal((await run('POST', '/api/connectors/gmail/import', { cookie: cookieB, origin: 'https://lab.example.test' }, { ids: ['m1'] })).status, 401);
const imported = await run('POST', '/api/connectors/gmail/import', { cookie: cookieA, origin: 'https://lab.example.test' }, { ids: ['m1'] });
assert.equal(imported.status, 200);
assert.match(JSON.parse(imported.body).sources[0].content, /Selected private content/);
assert.doesNotMatch(JSON.parse(imported.body).sources[0].content, /Do not import attachment/);
assert.equal(JSON.stringify(imported).includes('private-token'), false);
const driveStart = await run('GET', '/api/connectors/google_drive/start', { cookie: cookieA, 'sec-fetch-site': 'same-origin' });
const driveState = new URL(driveStart.headers.Location).searchParams.get('state');
assert.equal((await run('GET', `/api/connectors/google/callback?state=${driveState}&code=drive-code`, { cookie: cookieA })).status, 302);
const driveList = await run('GET', '/api/connectors/google_drive/list', { cookie: cookieA });
assert.deepEqual(JSON.parse(driveList.body).items.map((item) => item.id), ['pdf1']);
const driveImport = await run('POST', '/api/connectors/google_drive/import', { cookie: cookieA, origin: 'https://lab.example.test' }, { ids: ['pdf1'] });
assert.equal(driveImport.status, 200);
assert.equal(Buffer.from(JSON.parse(driveImport.body).sources[0].pdfBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
assert.equal(JSON.stringify(driveImport).includes('private-token'), false);
const notionStart = await run('GET', '/api/connectors/notion/start', { cookie: cookieA, 'sec-fetch-site': 'same-origin' });
const notionState = new URL(notionStart.headers.Location).searchParams.get('state');
assert.equal((await run('GET', `/api/connectors/notion/callback?state=${notionState}&code=notion-code`, { cookie: cookieA })).status, 302);
const notionList = await run('GET', '/api/connectors/notion/list', { cookie: cookieA });
assert.deepEqual(JSON.parse(notionList.body).items.map((item) => item.id), ['page1']);
const notionImport = await run('POST', '/api/connectors/notion/import', { cookie: cookieA, origin: 'https://lab.example.test' }, { ids: ['page1'] });
assert.equal(notionImport.status, 200);
assert.match(JSON.parse(notionImport.body).sources[0].content, /Nested customer evidence/);
assert.equal((await run('GET', '/api/connectors/gmail/start', { 'sec-fetch-site': 'cross-site' })).status, 403);
assert.equal((await run('GET', '/api/connectors/evil/start')).status, 404);
const forged = request('GET', '/api/connectors/gmail/list/../../internal');
assert.equal(await handleConnectorRoute(forged.req, forged.res, forged.url), false);
assert.equal(calls.every((call) => ['oauth2.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com', 'api.notion.com'].includes(new URL(call.url).hostname)), true);
assert.equal((await run('POST', '/api/connectors/gmail/disconnect', { cookie: cookieA, origin: 'https://lab.example.test' }, {})).status, 200);
assert.equal(JSON.parse((await run('GET', '/api/connectors/status', { cookie: cookieA })).body).connectors.find((item) => item.id === 'gmail').connected, false);
process.env.LAB_PUBLIC_ORIGIN = 'https://lab.example.test/private/path';
assert.equal(connectorConfiguration().filter((item) => item.available).length, 0);
console.log('OAuth connector route tests passed: state/PKCE, single use, session isolation, CSRF, selected-item import, disconnection, invalid origin.');
