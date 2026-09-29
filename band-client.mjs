// Band Agent API transport. REST sends commands; Phoenix channels deliver @mentions.
// https://docs.band.ai/api/agent-api
// https://docs.band.ai/websocket/agent/chat-room/message-created
const API = 'https://app.band.ai/api/v1/agent';
const SOCKET = 'wss://app.band.ai/api/v1/socket/websocket';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bandError(status, message, code = 'BAND_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function requiredUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw bandError(502, `Band returned an invalid ${label}.`, 'BAND_INVALID_RESPONSE');
  return value;
}

function cleanIdentity(value) {
  if (!value || typeof value !== 'object') throw bandError(502, 'Band returned an invalid agent profile.', 'BAND_INVALID_RESPONSE');
  const id = requiredUuid(value.id, 'agent ID');
  const ownerId = requiredUuid(value.owner_uuid, 'owner ID');
  const name = String(value.name || '').trim();
  const handle = String(value.handle || '').trim();
  if (!name || !handle || name.length > 120 || handle.length > 120) {
    throw bandError(502, 'Band returned an incomplete agent profile.', 'BAND_INVALID_RESPONSE');
  }
  return { id, ownerId, name, handle };
}

function mention(identity) {
  return { id: identity.id, name: identity.name, handle: identity.handle };
}

class RoomSocket {
  constructor({ WebSocketImpl, socketUrl, apiKey, agentId, roomId, timeoutMs }) {
    this.WebSocketImpl = WebSocketImpl;
    this.agentId = requiredUuid(agentId, 'agent ID');
    this.url = `${socketUrl}?api_key=${encodeURIComponent(apiKey)}&agent_id=${encodeURIComponent(this.agentId)}&vsn=2.0.0`;
    this.roomId = roomId;
    this.topic = `chat_room:${roomId}`;
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.waiters = [];
    this.socket = null;
    this.heartbeat = null;
    this.closed = false;
  }

  async open() {
    if (typeof this.WebSocketImpl !== 'function') throw bandError(503, 'This Node runtime has no WebSocket support. Use Node 22.', 'BAND_WEBSOCKET_UNAVAILABLE');
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    const opened = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(bandError(504, 'Band live connection timed out.', 'BAND_TIMEOUT')), this.timeoutMs);
      const onOpen = () => { clearTimeout(timer); resolve(true); };
      const onError = () => { clearTimeout(timer); reject(bandError(503, 'Band live connection failed.', 'BAND_WEBSOCKET_FAILED')); };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    }).catch((error) => { socket.close(); throw error; });
    if (!opened) throw bandError(503, 'Band live connection failed.');
    socket.addEventListener('message', (event) => this.onFrame(event.data));
    socket.addEventListener('close', () => this.failWaiters(bandError(503, 'Band live connection closed.', 'BAND_WEBSOCKET_CLOSED')));
    socket.addEventListener('error', () => this.failWaiters(bandError(503, 'Band live connection failed.', 'BAND_WEBSOCKET_FAILED')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.joinWaiter = null;
        reject(bandError(504, 'Band room subscription timed out.', 'BAND_TIMEOUT'));
      }, this.timeoutMs);
      this.joinWaiter = (ok) => {
        clearTimeout(timer);
        ok ? resolve() : reject(bandError(503, 'Band rejected the room subscription.', 'BAND_JOIN_FAILED'));
      };
      this.send(['1', '1', this.topic, 'phx_join', {}]);
    }).catch((error) => { this.close(); throw error; });
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.send([null, String(Date.now()), 'phoenix', 'heartbeat', {}]);
    }, 25_000);
    this.heartbeat.unref?.();
    return this;
  }

  send(frame) {
    if (this.closed || this.socket?.readyState !== 1) throw bandError(503, 'Band live connection is unavailable.', 'BAND_WEBSOCKET_CLOSED');
    this.socket.send(JSON.stringify(frame));
  }

  onFrame(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (!Array.isArray(frame) || frame.length < 5) return;
    const [, ref, topic, event, payload] = frame;
    if (topic !== this.topic) return;
    if (event === 'phx_reply' && ref === '1' && this.joinWaiter) {
      const waiter = this.joinWaiter;
      this.joinWaiter = null;
      waiter(payload?.status === 'ok');
      return;
    }
    if (event !== 'message_created' || !payload || typeof payload !== 'object') return;
    if (payload.message_type !== 'text' || !Array.isArray(payload.metadata?.mentions) ||
        !payload.metadata.mentions.some((item) => item?.id === this.agentId)) return;
    if (!UUID.test(payload.id) || !UUID.test(payload.sender_id) || typeof payload.content !== 'string') return;
    const message = { id: payload.id, senderId: payload.sender_id, content: payload.content };
    const index = this.waiters.findIndex((waiter) => waiter.senderId === message.senderId);
    if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
    else if (this.queue.length < 20) this.queue.push(message);
  }

  nextFrom(senderId, timeoutMs = this.timeoutMs) {
    requiredUuid(senderId, 'sender ID');
    const index = this.queue.findIndex((item) => item.senderId === senderId);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    if (this.closed) return Promise.reject(bandError(503, 'Band live connection is closed.', 'BAND_WEBSOCKET_CLOSED'));
    return new Promise((resolve, reject) => {
      const waiter = { senderId, resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(bandError(504, 'The other Band agent did not answer in time.', 'BAND_TIMEOUT'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  failWaiters(error) {
    this.closed = true;
    if (this.joinWaiter) { const waiter = this.joinWaiter; this.joinWaiter = null; waiter(false); }
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.failWaiters(bandError(503, 'Band live connection closed.', 'BAND_WEBSOCKET_CLOSED'));
    try { this.socket?.close(); } catch { /* Already closed. */ }
  }
}

export function createBandClient({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  baseUrl = API, socketUrl = SOCKET, timeoutMs = 12_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Band requires fetch.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid Band timeout.');
  async function request(apiKey, method, path, body) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw bandError(503, 'Band agent credentials are missing.', 'BAND_NOT_CONFIGURED');
    let response;
    try {
      response = await fetchImpl(new URL(path, `${baseUrl.replace(/\/$/, '')}/`), {
        method, headers: { 'X-API-Key': apiKey, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? bandError(504, 'Band did not respond in time.', 'BAND_TIMEOUT')
        : bandError(503, 'Band could not be reached.', 'BAND_NETWORK');
    }
    if (response.status === 401 || response.status === 403) throw bandError(503, 'Band rejected an agent credential or room permission.', 'BAND_AUTH');
    if (response.status === 429) throw bandError(503, 'Band is rate limited. Please retry.', 'BAND_RATE_LIMIT');
    if (!response.ok) throw bandError(502, `Band rejected ${method} ${path} (HTTP ${response.status}).`, 'BAND_REQUEST_FAILED');
    let payload;
    try {
      const raw = await response.text();
      if (raw.length > 100_000) throw new Error('too large');
      payload = raw ? JSON.parse(raw) : {};
    } catch { throw bandError(502, 'Band returned invalid JSON.', 'BAND_INVALID_RESPONSE'); }
    return payload?.data ?? payload;
  }
  return Object.freeze({
    profile: async (key) => cleanIdentity(await request(key, 'GET', 'me')),
    createRoom: async (key) => requiredUuid((await request(key, 'POST', 'chats', { chat: {} }))?.id, 'room ID'),
    renameRoom: (key, roomId, title) => request(key, 'PATCH', `chats/${requiredUuid(roomId, 'room ID')}`, { chat: { title } }),
    addParticipant: (key, roomId, participantId) => request(key, 'POST', `chats/${requiredUuid(roomId, 'room ID')}/participants`,
      { participant: { participant_id: requiredUuid(participantId, 'participant ID') } }),
    listParticipants: (key, roomId) => request(key, 'GET', `chats/${requiredUuid(roomId, 'room ID')}/participants`),
    sendMessage: async (key, roomId, target, content) => {
      const data = await request(key, 'POST', `chats/${requiredUuid(roomId, 'room ID')}/messages`,
        { message: { content: `@${target.handle} ${content}`, mentions: [mention(target)] } });
      return requiredUuid(data?.id, 'message ID');
    },
    sendEvent: (key, roomId, messageType, content, metadata = {}) => request(key, 'POST',
      `chats/${requiredUuid(roomId, 'room ID')}/events`, { event: { content, message_type: messageType, metadata } }),
    markProcessing: (key, roomId, messageId) => request(key, 'POST', `chats/${requiredUuid(roomId, 'room ID')}/messages/${requiredUuid(messageId, 'message ID')}/processing`, {}),
    markProcessed: (key, roomId, messageId) => request(key, 'POST', `chats/${requiredUuid(roomId, 'room ID')}/messages/${requiredUuid(messageId, 'message ID')}/processed`, {}),
    markFailed: (key, roomId, messageId, error) => request(key, 'POST', `chats/${requiredUuid(roomId, 'room ID')}/messages/${requiredUuid(messageId, 'message ID')}/failed`, { error: String(error).slice(0, 200) }),
    subscribe: (key, roomId, agentId) => new RoomSocket({ WebSocketImpl, socketUrl, apiKey: key, agentId,
      roomId: requiredUuid(roomId, 'room ID'), timeoutMs }).open(),
  });
}
