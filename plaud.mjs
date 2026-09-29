import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PLAUD_ORIGIN = 'https://platform-us.plaud.ai';
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const INGEST_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPTS_PER_OWNER = 30;

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(value)) {
    throw fail(400, `Invalid ${label}.`);
  }
  return value;
}
function transcriptionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,159}$/.test(value)) {
    throw fail(400, 'Invalid Plaud transcription ID.');
  }
  return value;
}
function optionalString(value, limit, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > limit) throw fail(400, `Invalid ${label}.`);
  return value.trim();
}
function optionalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw fail(400, 'Invalid recording date.');
  }
  return new Date(value).toISOString();
}
function validateDownloadUrl(value, time, extraHosts) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    throw fail(400, 'Provide the Plaud upload download URL.');
  }
  let url;
  try { url = new URL(value); }
  catch { throw fail(400, 'Invalid Plaud download URL.'); }
  const host = url.hostname.toLowerCase();
  const plaudS3 = host === 'plaud-bucket.s3.amazonaws.com';
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || url.hash || !url.pathname || url.pathname === '/' ||
      (!plaudS3 && !extraHosts.has(host))) {
    throw fail(400, 'Use a signed Plaud HTTPS upload URL.');
  }
  const signature = url.searchParams.get('X-Amz-Signature');
  const date = url.searchParams.get('X-Amz-Date');
  const expires = Number(url.searchParams.get('X-Amz-Expires'));
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date || '');
  const issuedAt = match && Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]));
  if (!signature || !match || !Number.isInteger(expires) || expires < 1 || expires > 86_400 ||
      !Number.isFinite(issuedAt) || issuedAt > time + 5 * 60_000 || issuedAt + expires * 1000 <= time) {
    throw fail(400, 'Plaud download URL is unsigned or expired. Sync the recording again.');
  }
  return url.toString();
}
function numericSeconds(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86_400) {
    throw fail(502, `Plaud returned an invalid ${label}.`);
  }
  return value;
}
function normalizePlaudTask(value, requestedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.transcription_id !== requestedId) {
    throw fail(502, 'Plaud returned an unexpected transcription task.');
  }
  if (['PENDING', 'RECEIVED', 'STARTED', 'PROGRESS'].includes(value.status)) {
    return { status: value.status, transcription: null };
  }
  if (['FAILURE', 'REVOKED'].includes(value.status)) return { status: value.status, transcription: null };
  if (value.status !== 'SUCCESS' || !value.data || typeof value.data !== 'object') {
    throw fail(502, 'Plaud returned an invalid transcription status.');
  }
  const rawSegments = Array.isArray(value.data.results) ? value.data.results : value.data.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length < 1 || rawSegments.length > 2000) {
    throw fail(502, 'Plaud returned no usable timestamped segments.');
  }
  const segments = rawSegments.map((item) => {
    if (!item || typeof item !== 'object') throw fail(502, 'Plaud returned an invalid segment.');
    const start = numericSeconds(item.start, 'segment start');
    const end = numericSeconds(item.end, 'segment end');
    const text = optionalString(item.text, 2000, 'segment text');
    if (end < start || !text) throw fail(502, 'Plaud returned an invalid segment.');
    return { start, end, text, speaker: optionalString(item.speaker_id ?? item.speaker, 80, 'speaker') || null };
  });
  const joined = segments.map((segment) => segment.text).join(' ');
  if (joined.length > 120_000) throw fail(502, 'Plaud transcript exceeds this demo’s size limit.');
  const duration = value.data.duration === undefined || value.data.duration === null
    ? Math.max(...segments.map((segment) => segment.end))
    : numericSeconds(value.data.duration, 'recording duration');
  return { status: 'SUCCESS', transcription: {
    transcriptionId: requestedId,
    text: joined,
    segments,
    duration,
    language: optionalString(value.data.language, 30, 'language') || null,
  } };
}
function publicSummary(item) {
  return { id: item.id, transcriptionId: item.transcriptionId, title: item.title,
    recordedAt: item.recordedAt, createdAt: item.createdAt, verifiedAt: item.verifiedAt,
    status: item.status, language: item.language, duration: item.duration, preview: item.text.slice(0, 180),
    segmentCount: item.segments.length, provider: 'plaud_embedded' };
}
function publicDetail(item) { return { ...publicSummary(item), text: item.text, segments: structuredClone(item.segments) }; }

export function createPlaudIntegration({ dataDir, clientId = process.env.PLAUD_CLIENT_ID,
  clientSecret = process.env.PLAUD_CLIENT_SECRET, apiKey = process.env.PLAUD_API_KEY,
  downloadHosts = process.env.PLAUD_DOWNLOAD_HOSTS || '',
  fetchImpl = globalThis.fetch, now = () => Date.now(), isOwnerActive = () => true } = {}) {
  if (!dataDir) throw new TypeError('Plaud data directory is required.');
  const configured = Boolean(clientId?.trim() && clientSecret?.trim() && apiKey?.trim());
  const filePath = join(dataDir, 'plaud-transcriptions.json');
  const pairings = new Map();
  const ingestTokens = new Map();
  const exchangeAttempts = new Map();
  const revokedOwners = new Set();
  const pollPromises = new Map();
  const submissions = new Map();
  const extraHosts = new Set(downloadHosts.split(',').map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9.-]+$/.test(host) && !host.startsWith('.') && !host.endsWith('.')));
  let partnerToken = null;
  let partnerPromise = null;
  let store = { version: 1, transcriptions: [] };
  let mutations = Promise.resolve();

  const ready = (async () => {
    try {
      const current = await lstat(dataDir);
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Unsafe Plaud data directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
    }
    await chmod(dataDir, 0o700);
    try {
      const current = await lstat(filePath);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error('Unsafe Plaud transcript store.');
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.transcriptions)) throw new Error('Invalid Plaud transcript store.');
      store = parsed;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  })();

  async function persist(next) {
    const temp = join(dataDir, `.plaud-transcriptions-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  function mutate(operation) {
    const pending = mutations.then(async () => {
      await ready;
      const draft = structuredClone(store);
      const result = operation(draft);
      if (result.changed) { await persist(draft); store = draft; }
      return result.value;
    });
    mutations = pending.catch(() => {});
    return pending;
  }
  async function readPlaud(path, options) {
    let response;
    try {
      response = await fetchImpl(`${PLAUD_ORIGIN}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
    } catch { throw fail(502, 'Plaud is unavailable. Retry shortly.'); }
    if (!response.ok) throw fail(502, 'Plaud rejected this request. Check the developer credentials and retry.');
    let raw;
    try { raw = await response.text(); }
    catch { throw fail(502, 'Plaud returned an unreadable response.'); }
    if (raw.length > 2_000_000) throw fail(502, 'Plaud response exceeds this demo’s size limit.');
    try { return JSON.parse(raw); }
    catch { throw fail(502, 'Plaud returned invalid JSON.'); }
  }
  async function getPartnerToken() {
    if (partnerToken && partnerToken.expiresAt > now() + 30_000) return partnerToken.value;
    if (!partnerPromise) {
      partnerPromise = (async () => {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const response = await readPlaud('/developer/api/oauth/partner/access-token', {
          method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (typeof response.access_token !== 'string' || !response.access_token ||
            !Number.isFinite(response.expires_in) || response.expires_in < 60) {
          throw fail(502, 'Plaud returned an invalid partner token.');
        }
        partnerToken = { value: response.access_token, expiresAt: now() + response.expires_in * 1000 };
        return partnerToken.value;
      })().finally(() => { partnerPromise = null; });
    }
    return partnerPromise;
  }
  function requireConfigured() {
    if (!configured) throw fail(503, 'Plaud developer credentials are not configured on this server.');
  }
  function expireInMemory() {
    const time = now();
    for (const [key, value] of pairings) if (value.expiresAt <= time) pairings.delete(key);
    for (const [key, value] of ingestTokens) if (value.expiresAt <= time) ingestTokens.delete(key);
    for (const [key, value] of exchangeAttempts) if (value.expiresAt <= time) exchangeAttempts.delete(key);
  }
  function createPairing({ ownerId, projectId }) {
    requireConfigured();
    ownerId = identifier(ownerId, 'owner ID');
    projectId = identifier(projectId, 'project ID');
    expireInMemory();
    for (const [code, pair] of pairings) if (pair.ownerId === ownerId) pairings.delete(code);
    if (pairings.size >= 100) throw fail(429, 'Too many pending Plaud pairings. Retry later.');
    const code = randomBytes(9).toString('base64url');
    const expiresAt = now() + PAIRING_LIFETIME_MS;
    pairings.set(code, { ownerId, projectId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  async function exchangePairing(code, remoteAddress = 'unknown') {
    requireConfigured();
    expireInMemory();
    const address = typeof remoteAddress === 'string' ? remoteAddress.slice(0, 100) : 'unknown';
    const attempts = exchangeAttempts.get(address) || { count: 0, expiresAt: now() + 10 * 60_000 };
    if (attempts.count >= 15) throw fail(429, 'Too many Plaud pairing attempts. Retry later.');
    attempts.count += 1;
    exchangeAttempts.set(address, attempts);
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(code)) throw fail(400, 'Invalid Plaud pairing code.');
    const pair = pairings.get(code);
    if (!pair) throw fail(404, 'Plaud pairing code expired or not found.');
    pairings.delete(code); // Single use, including upstream failures.
    if (revokedOwners.has(pair.ownerId) || !isOwnerActive(pair.ownerId)) {
      throw fail(401, 'The BUEELD account is no longer active.');
    }
    const partner = await getPartnerToken();
    const userId = `bueeld-${pair.ownerId}`;
    const issued = await readPlaud('/developer/api/open/partner/users/access-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${partner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, expires_in: 86400 }),
    });
    if (typeof issued.access_token !== 'string' || !issued.access_token) {
      throw fail(502, 'Plaud returned an invalid user token.');
    }
    if (revokedOwners.has(pair.ownerId) || !isOwnerActive(pair.ownerId)) {
      throw fail(401, 'The BUEELD account is no longer active.');
    }
    const ingestToken = randomBytes(32).toString('base64url');
    ingestTokens.set(tokenHash(ingestToken), { ownerId: pair.ownerId, projectId: pair.projectId,
      expiresAt: now() + INGEST_LIFETIME_MS });
    return { userId, userAccessToken: issued.access_token, ingestToken,
      expiresAt: new Date(now() + INGEST_LIFETIME_MS).toISOString() };
  }
  function bearerProject(authorization) {
    expireInMemory();
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) {
      throw fail(401, 'A Plaud pairing token is required.');
    }
    const pair = ingestTokens.get(tokenHash(authorization.slice(7)));
    if (!pair) throw fail(401, 'Plaud pairing token expired or invalid.');
    if (revokedOwners.has(pair.ownerId) || !isOwnerActive(pair.ownerId)) {
      throw fail(401, 'The BUEELD account is no longer active.');
    }
    return pair;
  }
  async function submitTranscriptionOnce({ authorization, fileUrl, title, recordedAt, externalId, transcriptionId: suppliedId }) {
    requireConfigured();
    const pair = bearerProject(authorization);
    if (suppliedId !== undefined) throw fail(400, 'Submit the Plaud upload URL, not a transcription ID.');
    const verifiedUrl = validateDownloadUrl(fileUrl, now(), extraHosts);
    title = optionalString(title, 120, 'title') || 'Plaud interview';
    recordedAt = optionalDate(recordedAt);
    externalId = optionalString(externalId, 120, 'external ID') || null;
    if (externalId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(externalId)) {
      throw fail(400, 'Invalid external ID.');
    }
    await ready;
    await mutations;
    if (externalId) {
      const existing = store.transcriptions.find((item) => item.ownerId === pair.ownerId &&
        item.projectId === pair.projectId && item.externalId === externalId);
      if (existing) return { status: existing.status, transcription: publicDetail(existing), duplicate: true };
    }
    if (store.transcriptions.filter((item) => item.ownerId === pair.ownerId).length >= MAX_TRANSCRIPTS_PER_OWNER) {
      throw fail(429, 'Plaud transcript limit reached for this account.');
    }
    const issued = await readPlaud('/developer/api/open/partner/ai/transcriptions/', {
      method: 'POST', headers: { 'X-Client-Id': clientId, 'X-Client-Api-Key': apiKey,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ file_url: verifiedUrl, params: {
        transcribe: { language: 'auto' }, vad: { decode_silence: false },
        diarization: { enabled: true, return_embedding: false },
      } }),
    });
    const issuedId = transcriptionId(issued.transcription_id);
    const task = normalizePlaudTask(issued, issuedId);
    const saved = await mutate((draft) => {
      // Deletion or logout can occur while Plaud starts its asynchronous task.
      bearerProject(authorization);
      const existingByExternalId = externalId && draft.transcriptions.find((item) =>
        item.ownerId === pair.ownerId && item.projectId === pair.projectId && item.externalId === externalId);
      if (existingByExternalId) {
        return { changed: false, value: { ...publicDetail(existingByExternalId), duplicate: true } };
      }
      if (draft.transcriptions.some((item) => item.transcriptionId === issuedId)) {
        throw fail(409, 'Plaud returned a duplicate transcription task.');
      }
      if (draft.transcriptions.filter((item) => item.ownerId === pair.ownerId).length >= MAX_TRANSCRIPTS_PER_OWNER) {
        throw fail(429, 'Plaud transcript limit reached for this account.');
      }
      const timestamp = new Date(now()).toISOString();
      const item = { id: randomUUID(), ownerId: pair.ownerId, projectId: pair.projectId,
        transcriptionId: issuedId, title, recordedAt, externalId, createdAt: timestamp,
        status: task.status, text: task.transcription?.text || '',
        segments: task.transcription?.segments || [], duration: task.transcription?.duration ?? null,
        language: task.transcription?.language || null,
        verifiedAt: task.status === 'SUCCESS' ? timestamp : null, lastCheckedAt: null };
      draft.transcriptions.push(item);
      return { changed: true, value: publicDetail(item) };
    });
    return { status: saved.status, transcription: saved, duplicate: Boolean(saved.duplicate) };
  }

  async function submitTranscription(input) {
    const pair = bearerProject(input.authorization);
    const externalId = optionalString(input.externalId, 120, 'external ID');
    const key = externalId ? `${pair.ownerId}\u0000${pair.projectId}\u0000${externalId}` : null;
    if (key && submissions.has(key)) return submissions.get(key);
    const pending = submitTranscriptionOnce(input);
    if (key) submissions.set(key, pending);
    try { return await pending; }
    finally { if (key && submissions.get(key) === pending) submissions.delete(key); }
  }

  async function refreshPending(item) {
    if (!['PENDING', 'RECEIVED', 'STARTED', 'PROGRESS'].includes(item.status) ||
        (item.lastCheckedAt && Date.parse(item.lastCheckedAt) > now() - 5_000) ||
        !isOwnerActive(item.ownerId) || revokedOwners.has(item.ownerId)) return;
    if (pollPromises.has(item.id)) return pollPromises.get(item.id);
    const pending = (async () => {
      const upstream = await readPlaud(`/developer/api/open/partner/ai/transcriptions/${encodeURIComponent(item.transcriptionId)}`, {
        method: 'GET', headers: { 'X-Client-Id': clientId, 'X-Client-Api-Key': apiKey },
      });
      const task = normalizePlaudTask(upstream, item.transcriptionId);
      await mutate((draft) => {
        const current = draft.transcriptions.find((value) => value.id === item.id &&
          value.ownerId === item.ownerId && value.projectId === item.projectId);
        if (!current || revokedOwners.has(item.ownerId) || !isOwnerActive(item.ownerId)) {
          return { changed: false, value: null };
        }
        if (!['PENDING', 'RECEIVED', 'STARTED', 'PROGRESS'].includes(current.status)) {
          return { changed: false, value: null };
        }
        const timestamp = new Date(now()).toISOString();
        current.status = task.status;
        current.lastCheckedAt = timestamp;
        if (task.status === 'SUCCESS') {
          current.text = task.transcription.text;
          current.segments = task.transcription.segments;
          current.duration = task.transcription.duration;
          current.language = task.transcription.language;
          current.verifiedAt = timestamp;
        }
        return { changed: true, value: null };
      });
    })().finally(() => pollPromises.delete(item.id));
    pollPromises.set(item.id, pending);
    return pending;
  }
  async function list({ ownerId, projectId }) {
    ownerId = identifier(ownerId, 'owner ID'); projectId = identifier(projectId, 'project ID');
    await ready; await mutations;
    if (configured) {
      const pending = store.transcriptions.filter((item) => item.ownerId === ownerId &&
        item.projectId === projectId && ['PENDING', 'RECEIVED', 'STARTED', 'PROGRESS'].includes(item.status)).slice(0, 3);
      await Promise.allSettled(pending.map(refreshPending));
      await mutations;
    }
    return store.transcriptions.filter((item) => item.ownerId === ownerId && item.projectId === projectId)
      .map(publicSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function get({ ownerId, projectId, id }) {
    ownerId = identifier(ownerId, 'owner ID'); projectId = identifier(projectId, 'project ID');
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw fail(404, 'Plaud transcript not found.');
    await ready; await mutations;
    let item = store.transcriptions.find((value) => value.id === id &&
      value.ownerId === ownerId && value.projectId === projectId);
    if (!item) throw fail(404, 'Plaud transcript not found.');
    if (configured) {
      await refreshPending(item).catch(() => {});
      await mutations;
      item = store.transcriptions.find((value) => value.id === id &&
        value.ownerId === ownerId && value.projectId === projectId);
      if (!item) throw fail(404, 'Plaud transcript not found.');
    }
    return publicDetail(item);
  }
  async function verifyQuote({ ownerId, projectId, reference, quote }) {
    if (typeof reference !== 'string' || !/^plaud:[0-9a-f-]{36}$/.test(reference)) {
      throw fail(400, 'Choose a saved Plaud transcript.');
    }
    const item = await get({ ownerId, projectId, id: reference.slice(6) });
    if (item.status !== 'SUCCESS') throw fail(409, 'Wait for Plaud transcription to finish before citing it.');
    if (!quote || typeof quote !== 'object' || Array.isArray(quote) ||
        typeof quote.start !== 'number' || !Number.isFinite(quote.start) ||
        typeof quote.text !== 'string' || !quote.text.trim() || quote.text.length > 2000) {
      throw fail(400, 'Select an exact timestamped quote from the Plaud transcript.');
    }
    const selected = item.segments.find((segment) => segment.start === quote.start && segment.text === quote.text);
    if (!selected) throw fail(409, 'The selected quote does not match this Plaud transcript.');
    const clock = new Date(quote.start * 1000).toISOString().slice(11, 19);
    return { reference: `Plaud ${clock}: ${selected.text.slice(0, 300)}`, transcript: item };
  }
  function deleteOwner(ownerId) {
    ownerId = identifier(ownerId, 'owner ID');
    revokedOwners.add(ownerId);
    for (const [code, pair] of pairings) if (pair.ownerId === ownerId) pairings.delete(code);
    for (const [hash, pair] of ingestTokens) if (pair.ownerId === ownerId) ingestTokens.delete(hash);
    return mutate((draft) => {
      const before = draft.transcriptions.length;
      draft.transcriptions = draft.transcriptions.filter((item) => item.ownerId !== ownerId);
      return { changed: draft.transcriptions.length !== before,
        value: { deletedTranscriptions: before - draft.transcriptions.length } };
    });
  }
  return { configured, createPairing, exchangePairing, submitTranscription, list, get, verifyQuote, deleteOwner };
}
