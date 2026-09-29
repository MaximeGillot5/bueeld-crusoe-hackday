import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Run the browser's actual quota handling and Send-button rendering with a
// deterministic usage endpoint. No server, account, or AI call is involved.
const appPath = process.env.BUEELD_APP_JS || fileURLToPath(new URL('./app.js', import.meta.url));
const source = readFileSync(appPath, 'utf8');
const quotaStart = source.indexOf('let demoUsage = null;');
const quotaEnd = source.indexOf('async function postJson(', quotaStart);
assert.ok(quotaStart >= 0 && quotaEnd > quotaStart);
const renderChat = source.match(/^function renderChat\([^\n]*\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(renderChat, 'Expected the actual chat renderer');
const listeners = source.match(/^(?:window|document)\.addEventListener\("(?:focus|visibilitychange)", refreshDemoUsageWhenVisible\);$/gm) || [];
assert.equal(listeners.length, 2, 'Both focus and visibility changes must refresh usage');

class Element {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.classList = { toggle() {} };
  }
  replaceChildren() {}
  setAttribute() {}
  querySelectorAll() { return []; }
}

function harness(initialUsage = { used: 2, limit: 2 }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const events = new Map();
  const timers = new Map();
  const backend = { usage: initialUsage, fail: false, requests: 0 };
  let timerId = 0;
  const document = {
    hidden: false,
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener: (name, callback) => events.set(`document:${name}`, callback),
  };
  const context = vm.createContext({
    document,
    window: { addEventListener: (name, callback) => events.set(`window:${name}`, callback) },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async path => {
      assert.equal(path, '/api/demo/usage');
      backend.requests += 1;
      if (backend.fail) throw new Error('Temporary usage endpoint outage');
      const data = { ...backend.usage };
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(`
    const $ = id => document.getElementById(id);
    let chatMessages = [];
    let accountSession = { authenticated: false };
    let accountReady = true;
    let guestHidden = false;
    let onboarding = { active: false };
    let sourceEntries = [];
    let chatBusy = false;
    let sourceBusy = false;
    let pendingAttachment = null;
    const CHAT_LIMIT = 1500;
    const EVIDENCE_PREFIX = 'Evidence for our pinned mission: ';
    const renderOnboarding = () => {};
    const activeMissionRecord = () => null;
    const renderMissionTracker = () => {};
    const renderActiveSources = () => {};
    const renderAttachment = () => {};
    const updateSourceControls = () => {};
    const resizeChatInput = () => {};
    const scrollChatToLatest = () => {};
    ${source.slice(quotaStart, quotaEnd)}
    ${renderChat}
    ${listeners.join('\n')}
  `, context, { filename: appPath });
  element('chat-input').value = 'Continue working on my project.';
  const settled = () => new Promise(resolve => setImmediate(resolve));
  return {
    backend, document, element, timers,
    run: expression => vm.runInContext(expression, context),
    refresh: () => vm.runInContext('refreshDemoUsage()', context),
    async fire(name) {
      assert.ok(events.has(name), `Missing browser event handler: ${name}`);
      events.get(name)();
      await settled();
    },
    async tick() {
      assert.equal(timers.size, 1, 'Expected one pending refresh timer');
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 15_000);
      timers.delete(id);
      timer.callback();
      await settled();
    },
  };
}

for (const event of ['window:focus', 'document:visibilitychange']) {
  test(`raising a quota re-enables Send on ${event} without losing the draft`, async () => {
    const h = harness();
    await h.refresh();
    assert.equal(h.element('chat-send').disabled, true);
    assert.equal(h.timers.size, 1);
    h.backend.usage = { used: 2, limit: 1000 };
    await h.fire(event);
    assert.equal(h.backend.requests, 2);
    assert.equal(h.element('chat-send').disabled, false);
    assert.equal(h.element('chat-input').value, 'Continue working on my project.');
    assert.equal(h.element('demo-quota-alert').hidden, true);
    assert.match(h.element('demo-usage').textContent, /998 of 1000/);
    assert.equal(h.timers.size, 0, 'Available quota must stop periodic polling');
  });
}

test('an exhausted visible tab discovers increased quota without a focus change', async () => {
  const h = harness();
  await h.refresh();
  h.backend.usage = { used: 2, limit: 1000 };
  await h.tick();
  assert.equal(h.element('chat-send').disabled, false);
  assert.equal(h.backend.requests, 2);
  assert.equal(h.timers.size, 0);
});

test('hidden tabs stop polling and check quota when visible again', async () => {
  const h = harness();
  await h.refresh();
  h.document.hidden = true;
  await h.fire('document:visibilitychange');
  await h.fire('window:focus');
  assert.equal(h.timers.size, 0);
  assert.equal(h.backend.requests, 1);
  h.document.hidden = false;
  await h.fire('document:visibilitychange');
  assert.equal(h.backend.requests, 2);
  assert.equal(h.element('chat-send').disabled, true);
  assert.equal(h.timers.size, 1);
});

test('temporary refresh failure retains the known quota and retries while exhausted', async () => {
  const h = harness();
  await h.refresh();
  h.backend.fail = true;
  await h.tick();
  assert.equal(h.element('chat-send').disabled, true);
  assert.equal(h.timers.size, 1);
  h.backend.fail = false;
  h.backend.usage = { used: 2, limit: 1000 };
  await h.tick();
  assert.equal(h.element('chat-send').disabled, false);
  assert.equal(h.backend.requests, 3);
  assert.equal(h.timers.size, 0);
});

test('available quota does not poll but focus detects exhaustion elsewhere', async () => {
  const h = harness({ used: 1, limit: 2 });
  await h.refresh();
  assert.equal(h.element('chat-send').disabled, false);
  assert.equal(h.timers.size, 0);
  h.backend.usage = { used: 2, limit: 2 };
  await h.fire('window:focus');
  assert.equal(h.element('chat-send').disabled, true);
  assert.equal(h.timers.size, 1);
});

for (const blockingState of ['chatBusy = true', 'pendingAttachment = {}']) {
  test(`quota recovery preserves the independent Send gate: ${blockingState}`, async () => {
    const h = harness();
    await h.refresh();
    h.run(blockingState);
    h.backend.usage = { used: 2, limit: 1000 };
    await h.fire('window:focus');
    assert.equal(h.element('chat-send').disabled, true);
    assert.equal(h.timers.size, 0);
  });
}
