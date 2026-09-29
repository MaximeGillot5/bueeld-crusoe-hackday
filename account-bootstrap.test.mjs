import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appPath = process.env.BUEELD_APP_JS || fileURLToPath(new URL('./app.js', import.meta.url));
const source = readFileSync(appPath, 'utf8');
const functions = ['accountApi', 'fetchAccountSession', 'initializeAccount'].map(name => {
  const declaration = source.match(new RegExp(`^async function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(declaration, `Expected the browser's actual ${name}`);
  return declaration;
}).join('\n');
const signedIn = { authenticated: true, user: { id: 'founder-1', email: 'founder@example.test' }, csrfToken: 'server-issued-token' };

function harness(responses, { guestHidden = false, storageUnavailable = false } = {}) {
  const calls = [], waits = [], events = [], messages = [], storageReads = [];
  const context = vm.createContext({
    fetch: async (path, options) => {
      calls.push({ path, options });
      assert.ok(responses.length, 'Unexpected extra session request');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return {
        ok: !response.status || response.status < 400,
        status: response.status || 200,
        json: async () => {
          if (response.invalidJson) throw new SyntaxError('Invalid JSON');
          return response.data;
        },
      };
    },
    setTimeout: (callback, delay) => { waits.push(delay); callback(); },
    localStorage: {
      getItem: key => {
        storageReads.push(key);
        if (storageUnavailable) throw new Error('Storage unavailable');
        return guestHidden ? '1' : null;
      },
      setItem: () => assert.fail('Session bootstrap must not cache authentication or credentials'),
    },
    accountMessage: (message, error) => messages.push({ message, error }),
    loadAccountWorkspace: () => events.push('workspace'),
    loadServerMissionTracker: async () => events.push('missions'),
    refreshConversations: async () => events.push('conversations'),
    selectRecentConversationIfNeeded: () => events.push('select'),
    hydrateActiveConversation: async () => events.push('hydrate'),
  });
  vm.runInContext(`
    const GUEST_HIDDEN_KEY = 'guest-visibility';
    let accountSession = { authenticated: false, user: null, csrfToken: '' };
    let accountReady = false;
    let guestHidden = false;
    ${functions}
  `, context, { filename: appPath });
  return {
    calls, waits, events, messages, storageReads,
    run: () => vm.runInContext('initializeAccount()', context),
    state: () => JSON.parse(vm.runInContext('JSON.stringify({ accountSession, accountReady, guestHidden })', context)),
  };
}

function assertSessionRestored(client) {
  assert.deepEqual(client.state().accountSession, signedIn);
  assert.equal(client.state().accountReady, true);
  assert.equal(client.events[0], 'workspace');
  assert.deepEqual([...client.events].sort(), ['workspace', 'missions', 'conversations', 'select', 'hydrate'].sort());
  assert.deepEqual(client.messages, []);
  for (const call of client.calls) {
    assert.equal(call.path, '/api/auth/session');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.credentials, 'same-origin');
  }
  assert.deepEqual(client.storageReads, ['guest-visibility']);
}

test('reload restores the server session without reading cached authentication', async () => {
  const client = harness([{ data: signedIn }]);
  await client.run();
  assertSessionRestored(client);
  assert.deepEqual(client.waits, []);
  assert.equal(client.calls.length, 1);
});

for (const [name, first] of [
  ['network failure', new TypeError('Failed to fetch')],
  ['temporary service outage', { status: 503, data: { error: 'Restarting' } }],
  ['invalid JSON from the proxy', { invalidJson: true }],
  ['missing session status', { data: {} }],
  ['null payload', { data: null }],
  ['incorrect session status type', { data: { authenticated: 'false' } }],
  ['authenticated session without its user', { data: { authenticated: true, csrfToken: 'token' } }],
  ['authenticated session without CSRF', { data: { authenticated: true, user: { id: 'founder-1' } } }],
]) {
  test(`${name} retries and restores the account before opening the workspace`, async () => {
    const client = harness([first, { data: signedIn }]);
    await client.run();
    assertSessionRestored(client);
    assert.deepEqual(client.waits, [250]);
    assert.equal(client.calls.length, 2);
    assert.equal(client.events.filter(event => event === 'workspace').length, 1);
  });
}

test('two transient failures recover on the final bounded attempt', async () => {
  const client = harness([
    { status: 502, invalidJson: true },
    new TypeError('Failed to fetch'),
    { data: signedIn },
  ]);
  await client.run();
  assertSessionRestored(client);
  assert.deepEqual(client.waits, [250, 750]);
  assert.equal(client.calls.length, 3);
});

test('a server-confirmed guest opens immediately without retries', async () => {
  const client = harness([{ data: { authenticated: false } }], { guestHidden: true });
  await client.run();
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.waits, []);
  assert.deepEqual(client.events, ['workspace']);
  assert.deepEqual(client.messages, []);
  assert.deepEqual(client.state(), {
    accountSession: { authenticated: false, user: null, csrfToken: '' },
    accountReady: true,
    guestHidden: true,
  });
});

test('a guest response after a retry remains authoritative', async () => {
  const client = harness([new TypeError('Failed to fetch'), { data: { authenticated: false } }]);
  await client.run();
  assert.equal(client.state().accountSession.authenticated, false);
  assert.deepEqual(client.events, ['workspace']);
  assert.deepEqual(client.waits, [250]);
  assert.deepEqual(client.messages, []);
});

test('persistent failure stops after three attempts and preserves the guest fallback', async () => {
  const client = harness(Array.from({ length: 3 }, () => ({ status: 503, data: {} })), { guestHidden: true });
  await client.run();
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.waits, [250, 750]);
  assert.deepEqual(client.events, ['workspace']);
  assert.equal(client.state().accountReady, true);
  assert.equal(client.state().accountSession.authenticated, false);
  assert.equal(client.state().guestHidden, true);
  assert.equal(client.messages.length, 1);
  assert.match(client.messages[0].message, /Account service is unavailable/);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} fails immediately without retrying a rejected session`, async () => {
    const client = harness([{ status, data: { error: 'Rejected' } }]);
    await client.run();
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.waits, []);
    assert.deepEqual(client.events, ['workspace']);
    assert.equal(client.state().accountSession.authenticated, false);
    assert.equal(client.messages.length, 1);
  });
}

test('unavailable browser storage does not prevent cookie-based session recovery', async () => {
  const client = harness([{ data: signedIn }], { storageUnavailable: true });
  await client.run();
  assertSessionRestored(client);
  assert.equal(client.state().guestHidden, false);
});
