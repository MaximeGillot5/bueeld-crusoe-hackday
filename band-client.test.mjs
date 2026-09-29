import assert from 'node:assert/strict';
import test from 'node:test';
import { createBandClient } from './band-client.mjs';

const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCOUT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CRITIC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MESSAGE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function makeWire() {
  const calls = [];
  const frames = [];
  const responses = new Map([
    ['GET me', { id: SCOUT, owner_uuid: OWNER, name: 'Scout', handle: 'scout' }],
    ['POST chats', { id: ROOM }],
    [`PATCH chats/${ROOM}`, { id: ROOM }],
    [`POST chats/${ROOM}/participants`, { success: true }],
    [`GET chats/${ROOM}/participants`, [{ id: OWNER, name: 'Maxime', handle: 'maxime' }]],
    [`POST chats/${ROOM}/messages`, { id: MESSAGE }],
    [`POST chats/${ROOM}/events`, { id: MESSAGE }],
    [`POST chats/${ROOM}/messages/${MESSAGE}/processing`, {}],
    [`POST chats/${ROOM}/messages/${MESSAGE}/processed`, {}],
  ]);
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v1/agent/', '');
    const key = `${options.method} ${path}`;
    calls.push({ key, options });
    assert.equal(options.headers['X-API-Key'], 'agent-secret');
    if (!responses.has(key)) return { status: 404, ok: false, text: async () => '{}' };
    return { status: key.startsWith('POST') ? 201 : 200, ok: true,
      text: async () => JSON.stringify({ data: responses.get(key) }) };
  };
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
    }
    addEventListener(type, callback) {
      const entries = this.listeners.get(type) || [];
      entries.push(callback);
      this.listeners.set(type, entries);
    }
    emit(type, payload) { for (const callback of this.listeners.get(type) || []) callback(payload); }
    send(raw) {
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (frame[3] === 'phx_join') queueMicrotask(() => this.emit('message', {
        data: JSON.stringify(['1', '1', frame[2], 'phx_reply', { status: 'ok', response: {} }]),
      }));
    }
    close() { this.readyState = 3; this.emit('close', {}); }
  }
  return { calls, frames, fetchImpl, WebSocketImpl: FakeWebSocket };
}

test('REST commands use each agent key and explicit structured @mention', async () => {
  const wire = makeWire();
  const client = createBandClient(wire);
  assert.equal((await client.profile('agent-secret')).ownerId, OWNER);
  assert.equal(await client.createRoom('agent-secret'), ROOM);
  await client.renameRoom('agent-secret', ROOM, 'BUEELD · interest test');
  await client.addParticipant('agent-secret', ROOM, CRITIC);
  assert.equal((await client.listParticipants('agent-secret', ROOM))[0].id, OWNER);
  assert.equal(await client.sendMessage('agent-secret', ROOM, { id: CRITIC, name: 'Critic', handle: 'critic' }, 'Challenge this.'), MESSAGE);
  const body = JSON.parse(wire.calls.find((call) => call.key.endsWith('/messages')).options.body);
  assert.equal(body.message.content, '@critic Challenge this.');
  assert.deepEqual(body.message.mentions, [{ id: CRITIC, name: 'Critic', handle: 'critic' }]);
  await client.sendEvent('agent-secret', ROOM, 'task', 'Review started.');
  await client.markProcessing('agent-secret', ROOM, MESSAGE);
  await client.markProcessed('agent-secret', ROOM, MESSAGE);
});

test('Phoenix subscription joins before accepting a live addressed message', async () => {
  const wire = makeWire();
  const client = createBandClient(wire);
  const socket = await client.subscribe('agent-secret', ROOM, CRITIC);
  assert.deepEqual(wire.frames[0], ['1', '1', `chat_room:${ROOM}`, 'phx_join', {}]);
  assert.equal(new URL(socket.socket.url).searchParams.get('agent_id'), CRITIC);
  const pending = socket.nextFrom(SCOUT, 1_000);
  let delivered = false;
  pending.then(() => { delivered = true; });
  socket.socket.emit('message', { data: JSON.stringify([null, null, `chat_room:${ROOM}`, 'message_created', {
    id: MESSAGE, sender_id: SCOUT, sender_name: 'Scout', content: 'General room message', message_type: 'text',
    metadata: { mentions: [] },
  }]) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, false, 'a message without @mention cannot trigger the agent');
  socket.socket.emit('message', { data: JSON.stringify([null, null, `chat_room:${ROOM}`, 'message_created', {
    id: MESSAGE, sender_id: SCOUT, sender_name: 'Scout', content: '@critic Please review', message_type: 'text',
    metadata: { mentions: [{ id: CRITIC, name: 'Critic' }] },
  }]) });
  assert.deepEqual(await pending, { id: MESSAGE, senderId: SCOUT, content: '@critic Please review' });
  socket.close();
});

test('a missing live handoff times out instead of inventing a second agent response', async () => {
  const wire = makeWire();
  const socket = await createBandClient(wire).subscribe('agent-secret', ROOM, SCOUT);
  await assert.rejects(socket.nextFrom(CRITIC, 5), { code: 'BAND_TIMEOUT', status: 504 });
  socket.close();
});

test('upstream auth failures expose a safe error without returning credentials', async () => {
  const client = createBandClient({ fetchImpl: async () => ({ status: 401, ok: false }) });
  await assert.rejects(client.profile('private-agent-key'), (error) => {
    assert.equal(error.code, 'BAND_AUTH');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /private-agent-key/);
    return true;
  });
});
