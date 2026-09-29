import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureLabSession, getLabSession, rotateLabSession, revokeLabUserSessions } from './connectors.mjs';

const scrypt = promisify(scryptCallback);
const directory = process.env.LAB_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '.data');
const accountsFile = join(directory, 'accounts.json');
const MAX_ACCOUNTS = 50;
const MAX_CONVERSATIONS = 12;
const MAX_MESSAGES = 60;
const MAX_CONVERSATION_CHARS = 160_000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_EMAIL_ATTEMPTS = 8;
const AUTH_GLOBAL_ATTEMPTS = 100;
const attempts = new Map();
const signupsByAddress = new Map();
let globalAttempts = { count: 0, resetAt: 0 };
let store = { version: 1, accounts: [] };
let mutations = Promise.resolve();
let accountDeletionHook = async () => {};
const deletingAccounts = new Set();
const fakeSalt = randomBytes(16).toString('hex');
const fakeHash = randomBytes(64);

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
    'Content-Type': 'application/json; charset=utf-8', ...extra };
}
function send(res, status, value, extra = {}) {
  if (res.destroyed) return;
  res.writeHead(status, noStore(extra));
  res.end(JSON.stringify(value));
}
async function initializeStore() {
  try {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Unsafe Lab data directory');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (creationError) { if (creationError.code !== 'EEXIST') throw creationError; }
    // The quota store can create the shared directory during module startup.
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Unsafe Lab data directory');
  }
  await chmod(directory, 0o700);
  try {
    const current = await lstat(accountsFile);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('Unsafe Lab account store');
    const parsed = JSON.parse(await readFile(accountsFile, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) throw new Error('Invalid Lab account store');
    store = parsed;
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
}
await initializeStore();

async function writeSnapshot() {
  const temp = join(directory, `.accounts-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify(store), 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(temp, accountsFile);
  } catch (cause) {
    if (file) await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw cause;
  }
}
function mutate(operation) {
  const task = mutations.then(async () => {
    const prior = structuredClone(store);
    try {
      const result = operation();
      await writeSnapshot();
      return result;
    } catch (cause) {
      store = prior;
      throw cause;
    }
  });
  mutations = task.catch(() => {});
  return task;
}
function normalizeEmail(value) {
  if (typeof value !== 'string') throw fail(400, 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
  return email;
}
function normalizePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw fail(400, 'Use a password of 12 to 128 characters.');
  return value;
}
function countAttempt(email) {
  const now = Date.now();
  if (now >= globalAttempts.resetAt) globalAttempts = { count: 0, resetAt: now + AUTH_WINDOW_MS };
  for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
  const entry = attempts.get(email) || { count: 0, resetAt: now + AUTH_WINDOW_MS };
  if (globalAttempts.count >= AUTH_GLOBAL_ATTEMPTS || entry.count >= AUTH_EMAIL_ATTEMPTS) {
    throw fail(429, 'Too many sign-in attempts. Please retry later.');
  }
  globalAttempts.count += 1;
  entry.count += 1;
  attempts.set(email, entry);
}
function countSignupAddress(req) {
  const raw = req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown';
  const address = typeof raw === 'string' ? raw.slice(0, 100) : 'unknown';
  const now = Date.now();
  for (const [key, value] of signupsByAddress) if (value.resetAt <= now) signupsByAddress.delete(key);
  const entry = signupsByAddress.get(address) || { count: 0, resetAt: now + 86_400_000 };
  if (entry.count >= 10) throw fail(429, 'Too many account creations from this connection today.');
  entry.count += 1;
  signupsByAddress.set(address, entry);
}
async function derive(password, salt) {
  return scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
}
function publicUser(account) { return { id: account.id, email: account.email }; }
function csrf(session, req) {
  const supplied = req.headers['x-lab-csrf'];
  if (typeof supplied !== 'string' || supplied.length !== session?.csrfToken?.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))) {
    throw fail(403, 'Refresh the page and retry this action.');
  }
}
async function bodyJSON(req, maxChars = 250_000) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'Send JSON.');
  const timer = setTimeout(() => req.destroy(fail(408, 'Request body timed out.')), 10_000);
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > maxChars) throw fail(413, 'Request is too large.');
    }
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Invalid JSON.');
    return value;
  } catch (cause) {
    if (cause.status) throw cause;
    throw fail(400, 'Invalid or incomplete JSON.');
  } finally { clearTimeout(timer); }
}
function normalizeMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.id !== 'string' || !value.id || value.id.length > 100 ||
      !['user', 'assistant'].includes(value.role) ||
      typeof value.content !== 'string' || !value.content.trim() || value.content.length > 6000 ||
      typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0 || value.at > Date.now() + 86_400_000 ||
      !['complete', 'failed', 'pending'].includes(value.status)) {
    throw fail(400, 'Conversation contains an invalid message.');
  }
  return { id: value.id, role: value.role, content: value.content, at: value.at,
    status: value.status === 'pending' ? 'failed' : value.status };
}
function normalizePinned(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.content !== 'string' || !value.content.trim() || value.content.length > 1500 ||
      !['proposed', 'approved'].includes(value.status) ||
      typeof value.sourceMessageId !== 'string' || !value.sourceMessageId || value.sourceMessageId.length > 100 ||
      typeof value.pinnedAt !== 'number' || !Number.isFinite(value.pinnedAt) || value.pinnedAt < 0) {
    throw fail(400, 'Pinned mission is invalid.');
  }
  return { content: value.content.trim(), status: value.status, sourceMessageId: value.sourceMessageId, pinnedAt: value.pinnedAt };
}
function normalizeSourceContexts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 3) throw fail(400, 'Keep at most three source summaries.');
  return value.map((item) => {
    if (!item || item.kind !== 'analysis' || typeof item.name !== 'string' ||
        !item.name.trim() || item.name.length > 120 || typeof item.summary !== 'string' ||
        !item.summary.trim() || item.summary.length > 1200 ||
        typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/.test(item.digest)) {
      throw fail(400, 'Source summary is invalid.');
    }
    return { name: item.name.trim(), kind: 'analysis', digest: item.digest, summary: item.summary.trim() };
  });
}
export function normalizeProjectMemory(value) {
  if (value === undefined || value === null) value = {};
  const fields = ['project', 'target', 'goal', 'blocker'];
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key))) throw fail(400, 'Project memory is invalid.');
  return Object.fromEntries(fields.map((key) => {
    const item = value[key] === undefined ? '' : value[key];
    if (typeof item !== 'string' || item.length > 350) throw fail(400, 'Keep each project memory field within 350 characters.');
    return [key, item.trim()];
  }));
}
function normalizeLearning(value) {
  if (value === undefined || value === null) return null;
  const fields = ['assumption', 'observation', 'decision', 'nextMission', 'recommendation'];
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...fields].sort().join(',') ||
      fields.some((key) => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 600) ||
      !['continue', 'iterate', 'stop'].includes(value.recommendation)) throw fail(400, 'Mission learning is invalid.');
  return Object.fromEntries(fields.map((key) => [key, value[key].trim()]));
}
function normalizeTracker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.records) || value.records.length > 40 ||
      !Number.isInteger(value.seenLevel) || value.seenLevel < 1 || value.seenLevel > 1000) {
    throw fail(400, 'Mission tracker is invalid.');
  }
  const dateOrNull = (number) => number === null || (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Date.now() + 86_400_000);
  const records = value.records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.id !== 'string' || !record.id || record.id.length > 100 ||
        typeof record.content !== 'string' || !record.content.trim() || record.content.length > 1500 ||
        !['proposed', 'approved', 'completed'].includes(record.status) ||
        !dateOrNull(record.createdAt) || record.createdAt === null ||
        !dateOrNull(record.approvedAt) || !dateOrNull(record.evidenceAt) || !dateOrNull(record.completedAt) ||
        typeof record.evidence !== 'string' || record.evidence.length > 1500 ||
        !['', 'need', 'demand', 'delivery', 'economics'].includes(record.area) ||
        !['', 'met', 'missed', 'inconclusive'].includes(record.outcome) ||
        typeof record.realEvidence !== 'boolean') throw fail(400, 'Mission tracker contains an invalid record.');
    return { id: record.id, content: record.content.trim(), status: record.status, createdAt: record.createdAt,
      approvedAt: record.approvedAt, evidence: record.evidence, evidenceAt: record.evidenceAt,
      area: record.area, outcome: record.outcome, realEvidence: record.realEvidence, completedAt: record.completedAt,
      learning: normalizeLearning(record.learning) };
  });
  const tracker = { records, seenLevel: value.seenLevel };
  if (JSON.stringify(tracker).length > 250_000) throw fail(413, 'Mission tracker is too large.');
  return tracker;
}
function normalizeOnboardingDraft(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isInteger(value.step) || value.step < 0 || value.step > 4 ||
      !Array.isArray(value.answers) || value.answers.length > 4 ||
      !value.answers.every((answer) => typeof answer === 'string' && answer.length <= 350)) {
    throw fail(400, 'Onboarding draft is invalid.');
  }
  return { step: value.step, answers: [...value.answers] };
}
function normalizeConversation(value) {
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title || title.length > 120) throw fail(400, 'Give the conversation a title of up to 120 characters.');
  if (!Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) throw fail(400, 'Keep at most 60 messages in a saved conversation.');
  const messages = value.messages.map(normalizeMessage);
  const pinnedMission = normalizePinned(value.pinnedMission);
  const sourceContexts = normalizeSourceContexts(value.sourceContexts);
  const onboardingDraft = normalizeOnboardingDraft(value.onboardingDraft);
  const result = { title, messages, pinnedMission, sourceContexts, onboardingDraft };
  if (JSON.stringify(result).length > MAX_CONVERSATION_CHARS) throw fail(413, 'Conversation is too large to save.');
  return result;
}
function assertCurrentSession(req, session, userId = session?.userId) {
  if (getLabSession(req) !== session || session?.userId !== userId) throw fail(401, 'Your Lab session changed. Reload before saving.');
}
function accountFor(req) {
  const session = getLabSession(req);
  if (!session?.userId) throw fail(401, 'Sign in to your Lab account first.');
  if (deletingAccounts.has(session.userId)) throw fail(409, 'Account deletion is in progress.');
  const account = store.accounts.find((item) => item.id === session.userId);
  if (!account) throw fail(401, 'Sign in to your Lab account again.');
  return { account, session };
}
export function registerAccountDeletionHook(hook) {
  if (typeof hook !== 'function') throw new TypeError('Account deletion hook must be a function.');
  accountDeletionHook = hook;
}
export function projectForLabSession(req) {
  const { account } = accountFor(req);
  const memory = normalizeProjectMemory(account.projectMemory);
  return {
    ownerId: account.id,
    projectId: account.id,
    projectName: memory.project || 'Your project',
    projectSummary: [memory.target, memory.goal].filter(Boolean).join(' · '),
    projectMemory: memory,
  };
}
function summary(conversation) {
  return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt, messageCount: conversation.messages.length };
}
function conversationId(path) {
  const match = /^\/api\/conversations\/([0-9a-f-]{36})$/.exec(path);
  return match ? match[1] : null;
}

export async function handleAccountRoute(req, res, url) {
  const path = url.pathname;
  const auth = /^\/api\/auth\/(session|signup|login|logout)$/.exec(path);
  const accountDeletion = path === '/api/auth/account';
  const conversations = path === '/api/conversations' || conversationId(path);
  const missionTrackerPath = path === '/api/mission-tracker';
  const projectMemoryPath = path === '/api/project-memory';
  if (!auth && !accountDeletion && !conversations && !missionTrackerPath && !projectMemoryPath) return false;
  try {
    if (auth) {
      const action = auth[1];
      if (action === 'session') {
        if (req.method !== 'GET') throw fail(404, 'Not found.');
        const { session, setCookie } = ensureLabSession(req);
        const account = session.userId && store.accounts.find((item) => item.id === session.userId);
        send(res, 200, { authenticated: Boolean(account), ...(account ? { user: publicUser(account) } : {}), csrfToken: session.csrfToken },
          setCookie ? { 'Set-Cookie': setCookie } : {});
        return true;
      }
      if (req.method !== 'POST') throw fail(404, 'Not found.');
      const session = getLabSession(req);
      csrf(session, req);
      if (action === 'logout') {
        const next = rotateLabSession(req);
        send(res, 200, { authenticated: false, csrfToken: next.session.csrfToken }, { 'Set-Cookie': next.setCookie });
        return true;
      }
      const data = await bodyJSON(req, 1500);
      const email = normalizeEmail(data.email);
      const password = normalizePassword(data.password);
      countAttempt(email);
      if (action === 'signup') {
        countSignupAddress(req);
        const salt = randomBytes(16).toString('hex');
        const hash = (await derive(password, salt)).toString('hex');
        if (getLabSession(req) !== session) throw fail(401, 'Your session changed. Retry sign-up.');
        const created = await mutate(() => {
          assertCurrentSession(req, session, null);
          if (store.accounts.some((item) => item.email === email)) throw fail(409, 'This email already has a Lab account.');
          if (store.accounts.length >= MAX_ACCOUNTS) throw fail(429, 'The demo account limit has been reached.');
          const account = { id: randomUUID(), email, salt, hash, createdAt: Date.now(), conversations: [], projectMemory: normalizeProjectMemory() };
          store.accounts.push(account);
          return publicUser(account);
        });
        if (getLabSession(req) !== session) throw fail(401, 'Your session changed. Sign in to the new account.');
        const next = rotateLabSession(req, created.id);
        send(res, 201, { authenticated: true, user: created, csrfToken: next.session.csrfToken }, { 'Set-Cookie': next.setCookie });
        return true;
      }
      const account = store.accounts.find((item) => item.email === email);
      const candidate = await derive(password, account?.salt || fakeSalt);
      if (getLabSession(req) !== session) throw fail(401, 'Your session changed. Retry sign-in.');
      if (!timingSafeEqual(candidate, account ? Buffer.from(account.hash, 'hex') : fakeHash) ||
          !store.accounts.some((item) => item.id === account?.id)) {
        throw fail(401, 'Invalid email or password.');
      }
      const next = rotateLabSession(req, account.id);
      send(res, 200, { authenticated: true, user: publicUser(account), csrfToken: next.session.csrfToken }, { 'Set-Cookie': next.setCookie });
      return true;
    }
    const { account, session } = accountFor(req);
    if (accountDeletion) {
      if (req.method !== 'DELETE') throw fail(404, 'Not found.');
      csrf(session, req);
      const body = await bodyJSON(req, 1500);
      const password = normalizePassword(body.password);
      countAttempt(account.email);
      const candidate = await derive(password, account.salt);
      assertCurrentSession(req, session, account.id);
      if (!timingSafeEqual(candidate, Buffer.from(account.hash, 'hex'))) throw fail(401, 'Invalid password.');
      if (deletingAccounts.has(account.id)) throw fail(409, 'Account deletion is already in progress.');
      deletingAccounts.add(account.id);
      try {
        // Keep the identity and session available if a related-store deletion fails.
        // Every related-store hook is idempotent, so the owner can retry safely.
        await accountDeletionHook(account.id);
        await mutate(() => {
          assertCurrentSession(req, session, account.id);
          const index = store.accounts.findIndex((item) => item.id === account.id);
          if (index === -1) throw fail(404, 'Account not found.');
          store.accounts.splice(index, 1);
        });
        revokeLabUserSessions(account.id);
        const next = ensureLabSession(req);
        send(res, 200, { deleted: true, authenticated: false, csrfToken: next.session.csrfToken }, { 'Set-Cookie': next.setCookie });
        return true;
      } finally { deletingAccounts.delete(account.id); }
    }
    if (projectMemoryPath) {
      if (req.method === 'GET') {
        send(res, 200, { projectMemory: normalizeProjectMemory(account.projectMemory) });
        return true;
      }
      if (req.method !== 'PUT') throw fail(404, 'Not found.');
      csrf(session, req);
      const body = await bodyJSON(req, 6500);
      if (!Object.hasOwn(body, 'projectMemory')) throw fail(400, 'Provide the project memory to save.');
      const projectMemory = normalizeProjectMemory(body.projectMemory);
      await mutate(() => {
        assertCurrentSession(req, session, account.id);
        const current = store.accounts.find((item) => item.id === account.id);
        if (!current) throw fail(401, 'Sign in to your Lab account again.');
        current.projectMemory = projectMemory;
      });
      assertCurrentSession(req, session, account.id);
      send(res, 200, { projectMemory });
      return true;
    }
    if (missionTrackerPath) {
      if (req.method === 'GET') {
        send(res, 200, { missionTracker: account.missionTracker || { records: [], seenLevel: 1 } });
        return true;
      }
      if (req.method !== 'PUT') throw fail(404, 'Not found.');
      csrf(session, req);
      const body = await bodyJSON(req, 270_000);
      const tracker = normalizeTracker(body.missionTracker);
      await mutate(() => {
        assertCurrentSession(req, session, account.id);
        const current = store.accounts.find((item) => item.id === account.id);
        current.missionTracker = tracker;
      });
      if (getLabSession(req) !== session || session.userId !== account.id) throw fail(401, 'Your session changed. Reload your mission tracker.');
      send(res, 200, { missionTracker: tracker });
      return true;
    }
    if (path === '/api/conversations') {
      if (req.method === 'GET') {
        send(res, 200, { conversations: [...account.conversations].sort((a, b) => b.updatedAt - a.updatedAt).map(summary) });
        return true;
      }
      if (req.method !== 'POST') throw fail(404, 'Not found.');
      csrf(session, req);
      const normalized = normalizeConversation(await bodyJSON(req));
      const conversation = await mutate(() => {
        assertCurrentSession(req, session, account.id);
        const current = store.accounts.find((item) => item.id === account.id);
        if (current.conversations.length >= MAX_CONVERSATIONS) throw fail(409, 'This account has reached 12 saved conversations. Delete one to save another.');
        const now = Date.now();
        const value = { id: randomUUID(), ...normalized, createdAt: now, updatedAt: now };
        current.conversations.push(value);
        return value;
      });
      if (getLabSession(req) !== session || session.userId !== account.id) throw fail(401, 'Your session changed. Reload your conversations.');
      send(res, 201, { conversation });
      return true;
    }
    const id = conversationId(path);
    const existing = account.conversations.find((item) => item.id === id);
    if (!existing) throw fail(404, 'Conversation not found.');
    if (req.method === 'GET') {
      send(res, 200, { conversation: existing });
      return true;
    }
    csrf(session, req);
    if (req.method === 'PUT') {
      const normalized = normalizeConversation(await bodyJSON(req));
      const conversation = await mutate(() => {
        assertCurrentSession(req, session, account.id);
        const current = store.accounts.find((item) => item.id === account.id).conversations.find((item) => item.id === id);
        if (!current) throw fail(404, 'Conversation not found.');
        Object.assign(current, normalized, { updatedAt: Date.now() });
        return current;
      });
      if (getLabSession(req) !== session || session.userId !== account.id) throw fail(401, 'Your session changed. Reload your conversations.');
      send(res, 200, { conversation });
      return true;
    }
    if (req.method === 'DELETE') {
      await mutate(() => {
        assertCurrentSession(req, session, account.id);
        const current = store.accounts.find((item) => item.id === account.id);
        const index = current.conversations.findIndex((item) => item.id === id);
        if (index === -1) throw fail(404, 'Conversation not found.');
        current.conversations.splice(index, 1);
      });
      if (getLabSession(req) !== session || session.userId !== account.id) throw fail(401, 'Your session changed. Reload your conversations.');
      send(res, 200, { deleted: true });
      return true;
    }
    throw fail(404, 'Not found.');
  } catch (cause) {
    send(res, cause.status || 500, { error: cause.status ? cause.message : 'Lab account storage is unavailable. Please retry.' });
    return true;
  }
}
