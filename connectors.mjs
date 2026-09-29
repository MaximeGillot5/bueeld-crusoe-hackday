import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cookies are shared across ports, so independent local Lab servers need distinct names.
const COOKIE = `bueeld_lab_session_${Number(process.env.PORT || 4173)}`;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ACCOUNT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 180; // 50 accounts x 3 active sessions plus anonymous sign-in capacity.
const MAX_PROVIDER_READS = 35;
const MAX_USER_PROVIDER_READS = 60;
const userReadBudgets = new Map();
const PROVIDERS = {
  gmail: { name: 'Gmail', family: 'google', scope: 'https://www.googleapis.com/auth/gmail.readonly' },
  google_drive: { name: 'Google Drive', family: 'google', scope: 'https://www.googleapis.com/auth/drive.readonly' },
  google_calendar: { name: 'Google Calendar', family: 'google', scope: 'https://www.googleapis.com/auth/calendar.events.readonly' },
  notion: { name: 'Notion', family: 'notion' },
};
const sessions = new Map();
const sessionDirectory = join(dirname(fileURLToPath(import.meta.url)), '.data');
const sessionFile = join(sessionDirectory, 'auth-sessions.json');

function sessionKey(id) { return createHash('sha256').update(id).digest('hex'); }
function emptyConnectorState() {
  return { states: new Map(), tokens: new Map(), listings: new Map(), reads: 0, readsResetAt: Date.now() + SESSION_TTL_MS };
}
function privateSessionDirectory() {
  try { mkdirSync(sessionDirectory, { mode: 0o700 }); }
  catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  const info = lstatSync(sessionDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe Lab session directory');
  chmodSync(sessionDirectory, 0o700);
}
function loadSessions() {
  try {
    const directory = lstatSync(sessionDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe Lab session directory');
    const info = lstatSync(sessionFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe Lab session store');
    const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
    if (saved?.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > MAX_SESSIONS) throw new Error('Invalid Lab session store');
    for (const item of saved.sessions) {
      if (!/^[a-f0-9]{64}$/.test(item?.key) || !/^[A-Za-z0-9_-]{43}$/.test(item?.csrfToken) ||
          typeof item.userId !== 'string' || !item.userId || item.userId.length > 100 || !Number.isSafeInteger(item.expiresAt)) throw new Error('Invalid Lab session record');
      if (item.expiresAt > Date.now()) sessions.set(item.key, { ...item, persistent: true, ...emptyConnectorState() });
    }
    chmodSync(sessionDirectory, 0o700);
    chmodSync(sessionFile, 0o600);
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
}
function persistSessions() {
  privateSessionDirectory();
  const temporary = join(sessionDirectory, `.auth-sessions-${randomToken()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    // Only hashed bearer IDs and authentication metadata survive a restart.
    // OAuth tokens, authorization states and imported source listings stay in memory.
    const records = [...sessions].filter(([, session]) => session.persistent && session.userId && session.expiresAt > Date.now())
      .map(([key, { userId, csrfToken, expiresAt }]) => ({ key, userId, csrfToken, expiresAt }));
    writeFileSync(descriptor, JSON.stringify({ version: 1, sessions: records }));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, sessionFile);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
}
function changeSessions(operation) {
  const previous = new Map(sessions);
  try {
    const result = operation();
    persistSessions();
    return result;
  } catch (cause) {
    sessions.clear();
    for (const [key, session] of previous) sessions.set(key, session);
    throw error(503, 'Your sign-in could not be saved. Please retry.');
  }
}
loadSessions();

function error(status, message) { return Object.assign(new Error(message), { status }); }
function clip(value, size = 1800) { return String(value ?? '').trim().slice(0, size); }
function randomToken() { return randomBytes(32).toString('base64url'); }
function configuredOrigin() {
  const value = process.env.LAB_PUBLIC_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.href !== `${url.origin}/` && value !== url.origin) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
function providerConfigured(id) {
  if (!configuredOrigin()) return false;
  if (id === 'notion') return Boolean(process.env.LAB_NOTION_CLIENT_ID && process.env.LAB_NOTION_CLIENT_SECRET);
  return Boolean(process.env.LAB_GOOGLE_CLIENT_ID && process.env.LAB_GOOGLE_CLIENT_SECRET);
}
export function connectorConfiguration() {
  return Object.entries(PROVIDERS).map(([id, provider]) => ({
    id, name: provider.name, available: providerConfigured(id),
    ...(!providerConfigured(id) ? { reason: 'OAuth app credentials and a registered callback URL are required.' } : {}),
  }));
}
function headers(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    ...extra,
  };
}
function send(res, status, data, extra = {}) {
  if (res.destroyed) return;
  res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
  res.end(JSON.stringify(data));
}
function redirect(res, location, extra = {}) {
  if (res.destroyed) return;
  res.writeHead(302, headers({ Location: location, ...extra }));
  res.end();
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((entry) => {
    const [key, ...value] = entry.trim().split('=');
    return [key, value.join('=')];
  }).filter(([key]) => key));
}
function cookieHeader(id, age = 7200, req = null) {
  const forwardedTls = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https';
  const tunnelHost = /(?:^|\.)trycloudflare\.com(?::\d+)?$/i.test(String(req?.headers?.host || ''));
  const secure = configuredOrigin()?.startsWith('https:') || forwardedTls || tunnelHost ? '; Secure' : '';
  return `${COOKIE}=${id}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
function prune() {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  for (const [id, budget] of userReadBudgets) if (budget.expiresAt <= now) userReadBudgets.delete(id);
}
function getSession(req) {
  prune();
  const id = cookies(req)[COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  return sessions.get(sessionKey(id)) || null;
}
function ensureSession(req) {
  const existing = getSession(req);
  if (existing) return { session: existing, setCookie: null };
  while (sessions.size >= MAX_SESSIONS) {
    const anonymous = [...sessions].find(([, value]) => !value.userId);
    if (!anonymous) throw error(429, 'The demo has reached its active session limit. Please retry later.');
    sessions.delete(anonymous[0]);
  }
  const id = randomToken();
  const key = sessionKey(id);
  const session = { key, csrfToken: randomToken(), userId: null, expiresAt: Date.now() + SESSION_TTL_MS, ...emptyConnectorState() };
  sessions.set(key, session);
  return { session, setCookie: cookieHeader(id, 7200, req) };
}
export function getLabSession(req) { return getSession(req); }
export function ensureLabSession(req) { return ensureSession(req); }
export function revokeLabUserSessions(userId) {
  changeSessions(() => {
    for (const [key, session] of sessions) if (session.userId === userId) sessions.delete(key);
  });
}
export function rotateLabSession(req, userId = null) {
  const old = getSession(req);
  return changeSessions(() => {
    if (old) sessions.delete(old.key);
    const next = ensureSession({ headers: { ...req.headers, cookie: '' } });
    next.session.userId = userId;
    if (userId) {
      next.session.persistent = true;
      next.session.expiresAt = Date.now() + ACCOUNT_SESSION_TTL_MS;
      next.setCookie = next.setCookie.replace('Max-Age=7200;', `Max-Age=${ACCOUNT_SESSION_TTL_MS / 1000};`);
      const userSessions = [...sessions].filter(([, value]) => value.userId === userId);
      while (userSessions.length > 3) sessions.delete(userSessions.shift()[0]);
    }
    return next;
  });
}
function requireSameOrigin(req) {
  const origin = configuredOrigin();
  if (!origin || req.headers.origin !== origin) throw error(403, 'This action must come from the demo page.');
}
async function readBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw error(415, 'Send JSON.');
  const timer = setTimeout(() => req.destroy(error(408, 'Request body timed out.')), 10_000);
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2000) throw error(413, 'Selection is too large.');
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error(400, 'Invalid JSON.');
    return parsed;
  } catch (cause) {
    if (cause.status) throw cause;
    throw error(400, 'Invalid or incomplete JSON.');
  } finally { clearTimeout(timer); }
}
function countRead(session, cost = 1) {
  prune();
  if (session.readsResetAt <= Date.now()) {
    session.reads = 0;
    session.readsResetAt = Date.now() + SESSION_TTL_MS;
  }
  const budget = userReadBudgets.get(session.userId) || { used: 0, expiresAt: Date.now() + SESSION_TTL_MS };
  if (session.reads + cost > MAX_PROVIDER_READS || budget.used + cost > MAX_USER_PROVIDER_READS) {
    throw error(429, 'The demo has reached its connector read limit. Please retry later.');
  }
  session.reads += cost;
  budget.used += cost;
  userReadBudgets.set(session.userId, budget);
}
async function limitedFetch(url, options = {}, maxBytes = 200_000, binary = false) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['www.googleapis.com', 'gmail.googleapis.com', 'oauth2.googleapis.com', 'api.notion.com'].includes(target.hostname)) {
    throw error(400, 'Invalid provider endpoint.');
  }
  let response;
  try {
    response = await fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch { throw error(502, 'The source provider is unavailable.'); }
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw error(502, 'Provider response is too large.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw error(502, 'Provider response is too large.');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw error(401, 'Source access expired or was denied. Reconnect the account.');
    if (response.status === 404) throw error(404, 'This source is unavailable.');
    throw error(502, 'The source provider could not complete the request.');
  }
  return binary ? body : body.toString('utf8');
}
async function providerJSON(url, token, method = 'GET', body = undefined, notion = false) {
  const raw = await limitedFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(notion ? { 'Notion-Version': '2026-03-11' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try { return JSON.parse(raw); } catch { throw error(502, 'The source provider returned invalid data.'); }
}
function oauthCallback(family) { return `${configuredOrigin()}/api/connectors/${family}/callback`; }
function oauthUrl(id, state, verifier) {
  if (id === 'notion') {
    const url = new URL('https://api.notion.com/v1/oauth/authorize');
    url.search = new URLSearchParams({ owner: 'user', client_id: process.env.LAB_NOTION_CLIENT_ID, redirect_uri: oauthCallback('notion'), response_type: 'code', state }).toString();
    return url.href;
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  url.search = new URLSearchParams({ client_id: process.env.LAB_GOOGLE_CLIENT_ID, redirect_uri: oauthCallback('google'), response_type: 'code', scope: PROVIDERS[id].scope, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' }).toString();
  return url.href;
}
async function exchangeCode(id, code, verifier) {
  if (id === 'notion') {
    const basic = Buffer.from(`${process.env.LAB_NOTION_CLIENT_ID}:${process.env.LAB_NOTION_CLIENT_SECRET}`).toString('base64');
    const raw = await limitedFetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: oauthCallback('notion') }),
    }, 50_000);
    const value = JSON.parse(raw);
    if (!value.access_token) throw error(502, 'Notion did not return an access token.');
    return { accessToken: value.access_token, expiresAt: Date.now() + Math.min(Math.max(Number(value.expires_in) || 7200, 60), 7200) * 1000, account: clip(value.workspace_name || 'Notion workspace', 100) };
  }
  const body = new URLSearchParams({ code, client_id: process.env.LAB_GOOGLE_CLIENT_ID, client_secret: process.env.LAB_GOOGLE_CLIENT_SECRET, redirect_uri: oauthCallback('google'), grant_type: 'authorization_code', code_verifier: verifier });
  const raw = await limitedFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 50_000);
  const value = JSON.parse(raw);
  if (!value.access_token || !String(value.scope || '').split(' ').includes(PROVIDERS[id].scope)) throw error(502, 'Google did not grant the requested read permission.');
  const expiresIn = Math.min(Math.max(Number(value.expires_in) || 3600, 60), 3600);
  return { accessToken: value.access_token, expiresAt: Date.now() + (expiresIn - 30) * 1000, account: 'Google account' };
}
function requireToken(session, id) {
  const token = session?.tokens.get(id);
  if (!token || token.expiresAt <= Date.now()) {
    if (token) session.tokens.delete(id);
    throw error(401, 'Connect this source account first.');
  }
  return token.accessToken;
}
function base64UrlText(value) {
  if (typeof value !== 'string' || value.length > 300_000) return '';
  try { return Buffer.from(value, 'base64url').toString('utf8'); } catch { return ''; }
}
function gmailBody(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const plain = [];
  const html = [];
  let visited = 0;
  function visit(part, depth) {
    if (!part || typeof part !== 'object' || depth > 8 || visited++ >= 100) return;
    const disposition = (Array.isArray(part.headers) ? part.headers : []).find((header) =>
      String(header.name).toLowerCase() === 'content-disposition');
    if (!part.filename && !/^attachment\b/i.test(String(disposition?.value || ''))) {
      const body = base64UrlText(part.body?.data);
      if (body && part.mimeType === 'text/plain') plain.push(body);
      else if (body && part.mimeType === 'text/html') html.push(body);
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) visit(child, depth + 1);
  }
  visit(payload, 0);
  if (plain.length) return plain.join('\n');
  return html.join('\n').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
function gmailHeaders(message) {
  const headers = message.payload?.headers || [];
  const get = (key) => clip(headers.find((header) => String(header.name).toLowerCase() === key)?.value, 200);
  return { subject: get('subject') || '(No subject)', from: get('from'), date: get('date') };
}
async function listGmail(token) {
  const data = await providerJSON('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=8', token);
  const messages = (data.messages || []).slice(0, 8);
  const details = await Promise.all(messages.map(async (message) => {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(message.id)) return null;
    try {
      const item = await providerJSON(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, token);
      const h = gmailHeaders(item);
      return { id: item.id, name: h.subject, kind: 'gmail', modifiedAt: h.date, description: clip(`${h.from} — ${item.snippet || ''}`, 220) };
    } catch { return null; }
  }));
  return details.filter(Boolean);
}
const DRIVE_EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
const DRIVE_BINARY_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const DRIVE_PDF = 'application/pdf';
const MAX_DRIVE_PDF_BYTES = 2_000_000;
async function listDrive(token) {
  const mimeTypes = [...Object.keys(DRIVE_EXPORT), ...DRIVE_BINARY_TEXT, DRIVE_PDF];
  const q = `trashed=false and (${mimeTypes.map((type) => `mimeType='${type}'`).join(' or ')})`;
  const params = new URLSearchParams({ pageSize: '30', q, orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,description,modifiedTime,size),nextPageToken' });
  const data = await providerJSON(`https://www.googleapis.com/drive/v3/files?${params}`, token);
  return (data.files || []).filter((file) => DRIVE_EXPORT[file.mimeType] || DRIVE_BINARY_TEXT.has(file.mimeType) ||
    (file.mimeType === DRIVE_PDF && (!file.size || Number(file.size) <= MAX_DRIVE_PDF_BYTES))).slice(0, 20).map((file) => ({
    id: file.id, name: clip(file.name, 120), kind: 'google_drive', mimeType: file.mimeType,
    modifiedAt: file.modifiedTime, description: clip(file.description, 220),
  }));
}
async function listCalendar(token) {
  const now = Date.now();
  const params = new URLSearchParams({ timeMin: new Date(now - 14 * 864e5).toISOString(), timeMax: new Date(now + 45 * 864e5).toISOString(), maxResults: '20', singleEvents: 'true', orderBy: 'startTime' });
  const data = await providerJSON(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, token);
  return (data.items || []).filter((item) => item.id && item.status !== 'cancelled').map((item) => ({
    id: item.id, name: clip(item.summary || '(Untitled event)', 120), kind: 'google_calendar',
    modifiedAt: item.start?.dateTime || item.start?.date || '', description: clip(item.description, 220),
  }));
}
function notionTitle(page) {
  const titleProperty = Object.values(page.properties || {}).find((property) => property?.type === 'title');
  return clip((titleProperty?.title || page.title || []).map((entry) => entry.plain_text || entry.text?.content || '').join(''), 120) || '(Untitled page)';
}
async function listNotion(token) {
  const data = await providerJSON('https://api.notion.com/v1/search', token, 'POST', { page_size: 30, sort: { direction: 'descending', timestamp: 'last_edited_time' } }, true);
  return (data.results || []).filter((item) => item.object === 'page' && item.id).slice(0, 20).map((item) => ({
    id: item.id, name: notionTitle(item), kind: 'notion', modifiedAt: item.last_edited_time,
    description: 'Page shared with this Notion connection',
  }));
}
async function listProvider(id, token) {
  if (id === 'gmail') return listGmail(token);
  if (id === 'google_drive') return listDrive(token);
  if (id === 'google_calendar') return listCalendar(token);
  return listNotion(token);
}
async function importGmail(token, item) {
  const data = await providerJSON(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`, token);
  const h = gmailHeaders(data);
  return { name: h.subject, kind: 'gmail', content: clip(`From: ${h.from}\nDate: ${h.date}\nSubject: ${h.subject}\n\n${gmailBody(data.payload) || data.snippet || ''}`) };
}
async function importDrive(token, item) {
  const type = item.mimeType;
  let url;
  if (type === DRIVE_PDF) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?alt=media`;
    const pdf = await limitedFetch(url, { headers: { Authorization: `Bearer ${token}` } }, MAX_DRIVE_PDF_BYTES, true);
    if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw error(400, 'This Drive file is not a readable PDF.');
    return { name: item.name, kind: 'google_drive', pdfBase64: pdf.toString('base64') };
  }
  if (DRIVE_EXPORT[type]) {
    const params = new URLSearchParams({ mimeType: DRIVE_EXPORT[type] });
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}/export?${params}`;
  } else if (DRIVE_BINARY_TEXT.has(type)) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?alt=media`;
  } else throw error(400, 'This Drive file cannot be imported as text. Download it and attach it locally.');
  const content = await limitedFetch(url, { headers: { Authorization: `Bearer ${token}` } }, 80_000);
  return { name: item.name, kind: 'google_drive', content: clip(content) };
}
async function importCalendar(token, item) {
  const event = await providerJSON(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(item.id)}`, token);
  const content = [
    `Event: ${clip(event.summary, 200)}`,
    `When: ${clip(event.start?.dateTime || event.start?.date, 100)} to ${clip(event.end?.dateTime || event.end?.date, 100)}`,
    `Where: ${clip(event.location, 200)}`,
    `Description: ${clip(event.description, 1200)}`,
  ].join('\n');
  return { name: item.name, kind: 'google_calendar', content: clip(content) };
}
function notionBlockText(block) {
  const data = block?.[block.type] || {};
  const rich = data.rich_text || data.title || [];
  const richText = Array.isArray(rich) ? rich.map((item) => item.plain_text || item.text?.content || '').join('') : '';
  return clip(richText || (typeof data.title === 'string' ? data.title : '') ||
    data.caption?.map((item) => item.plain_text).join('') || '', 400);
}
async function importNotion(token, item) {
  const page = await providerJSON(`https://api.notion.com/v1/pages/${encodeURIComponent(item.id)}`, token, 'GET', undefined, true);
  const lines = [];
  let remainingBlocks = 40;
  let remainingNestedReads = 4;
  async function readChildren(parentId, depth) {
    if (!remainingBlocks) return;
    const blocks = await providerJSON(`https://api.notion.com/v1/blocks/${encodeURIComponent(parentId)}/children?page_size=${Math.min(remainingBlocks, 20)}`, token, 'GET', undefined, true);
    for (const block of Array.isArray(blocks.results) ? blocks.results : []) {
      if (!remainingBlocks) break;
      remainingBlocks -= 1;
      const content = notionBlockText(block);
      if (content) lines.push(`${'  '.repeat(depth)}${content}`);
      if (block.has_children && block.id && depth < 2 && remainingNestedReads && remainingBlocks) {
        remainingNestedReads -= 1;
        await readChildren(block.id, depth + 1);
      }
    }
  }
  await readChildren(item.id, 0);
  return { name: notionTitle(page), kind: 'notion', content: clip(`Page: ${notionTitle(page)}\nLast edited: ${clip(page.last_edited_time, 80)}\n\n${lines.join('\n')}`) };
}
async function importProvider(id, token, item) {
  if (id === 'gmail') return importGmail(token, item);
  if (id === 'google_drive') return importDrive(token, item);
  if (id === 'google_calendar') return importCalendar(token, item);
  return importNotion(token, item);
}
function statusFor(session) {
  return Object.entries(PROVIDERS).map(([id, provider]) => {
    const token = session?.tokens.get(id);
    const connected = Boolean(session?.userId && token && token.expiresAt > Date.now());
    return {
      id, name: provider.name, configured: providerConfigured(id), connected,
      ...(connected ? { account: token.account, expiresAt: new Date(token.expiresAt).toISOString() } : {}),
      ...(!providerConfigured(id) ? { reason: 'OAuth setup required for this demo URL.' } : {}),
    };
  });
}
function safeProvider(id) { if (!PROVIDERS[id]) throw error(404, 'Connector not found.'); return id; }

export async function handleConnectorRoute(req, res, url) {
  const path = url.pathname;
  if (path === '/api/connectors/status' && req.method === 'GET') {
    const session = getSession(req);
    send(res, 200, { connectors: statusFor(session) });
    return true;
  }
  const match = /^\/api\/connectors\/([a-z_]+)\/(start|callback|list|import|disconnect)$/.exec(path);
  if (!match) return false;
  const [, rawId, action] = match;
  try {
    if (action === 'callback') {
      if (req.method !== 'GET' || !['google', 'notion'].includes(rawId)) throw error(404, 'Callback not found.');
      const session = getSession(req);
      const state = url.searchParams.get('state');
      const attempt = session?.states.get(state);
      if (!session?.userId || !attempt || attempt.family !== rawId || attempt.expiresAt <= Date.now()) throw error(400, 'The connection attempt expired. Start again.');
      session.states.delete(state); // Single use, including provider-denied flows.
      const id = attempt.id;
      if (url.searchParams.has('error')) {
        redirect(res, `/connector-complete.html?connector=${id}&status=error`);
        return true;
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4000) throw error(400, 'The provider returned no valid authorization code.');
      const token = await exchangeCode(id, code, attempt.verifier);
      if (getSession(req) !== session || !session.userId) throw error(401, 'Your Lab session changed. Start the connection again.');
      session.tokens.set(id, token);
      session.listings.delete(id);
      redirect(res, `/connector-complete.html?connector=${id}&status=connected`);
      return true;
    }
    const id = safeProvider(rawId);
    if (action === 'start') {
      if (req.method !== 'GET') throw error(404, 'Not found.');
      if (!providerConfigured(id)) throw error(503, 'This connector needs OAuth credentials and an exact registered callback URL.');
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw error(403, 'Start the connection from the demo page.');
      const { session, setCookie } = ensureSession(req);
      if (!session.userId) throw error(401, 'Create or sign in to a Lab account before connecting a source.');
      const state = randomToken();
      const verifier = randomBytes(48).toString('base64url');
      session.states.set(state, { id, family: PROVIDERS[id].family, verifier, expiresAt: Date.now() + STATE_TTL_MS });
      if (session.states.size > 5) session.states.delete(session.states.keys().next().value);
      redirect(res, oauthUrl(id, state, verifier), setCookie ? { 'Set-Cookie': setCookie } : {});
      return true;
    }
    if (!providerConfigured(id)) throw error(503, 'This connector is not configured yet.');
    const session = getSession(req);
    if (!session?.userId) throw error(401, 'Sign in to a Lab account first.');
    const userId = session.userId;
    if (action === 'disconnect') {
      if (req.method !== 'POST') throw error(404, 'Not found.');
      requireSameOrigin(req);
      if (!session) throw error(401, 'Open the demo again to reconnect.');
      session.tokens.delete(id);
      session.listings.delete(id);
      send(res, 200, { connected: false });
      return true;
    }
    const token = requireToken(session, id);
    if (action === 'list') {
      if (req.method !== 'GET') throw error(404, 'Not found.');
      countRead(session, id === 'gmail' ? 9 : 1);
      const items = await listProvider(id, token);
      if (getSession(req) !== session || session.userId !== userId) throw error(401, 'Your Lab session changed. Reload before reading sources.');
      session.listings.set(id, { items: new Map(items.map((item) => [item.id, item])), expiresAt: Date.now() + 10 * 60 * 1000 });
      send(res, 200, { items });
      return true;
    }
    if (action === 'import') {
      if (req.method !== 'POST') throw error(404, 'Not found.');
      requireSameOrigin(req);
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 4 || !body.ids.every((value) => typeof value === 'string') || new Set(body.ids).size !== body.ids.length) throw error(400, 'Select one to four source items.');
      const listing = session.listings.get(id);
      if (!listing || listing.expiresAt <= Date.now()) throw error(400, 'Refresh the connector source list first.');
      const selected = body.ids.map((value) => listing.items.get(value));
      if (selected.some((item) => !item)) throw error(400, 'Select items from the current connector list.');
      countRead(session, selected.length * (id === 'notion' ? 6 : 1));
      const sources = await Promise.all(selected.map((item) => importProvider(id, token, item)));
      if (getSession(req) !== session || session.userId !== userId) throw error(401, 'Your Lab session changed. Reload before reading sources.');
      send(res, 200, { sources });
      return true;
    }
    throw error(404, 'Not found.');
  } catch (cause) {
    // Deliberately exclude provider responses, tokens, source content, and authorization codes from logs.
    send(res, cause.status || 502, { error: cause.message || 'Connector request failed.' });
    return true;
  }
}
