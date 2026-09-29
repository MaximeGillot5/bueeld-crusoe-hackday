import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPlaudIntegration, parsePlaudSrt } from './plaud.mjs';

const account = (id) => ({ ownerId: id, projectId: id });
const task = (id, results, status = 'SUCCESS') => ({ transcription_id: id, status,
  data: { language: 'en', duration: 12, results } });
const segments = [
  { start: 0, end: 3.2, text: 'The onboarding takes too long.', speaker_id: 'Speaker 1' },
  { start: 3.3, end: 8.4, text: 'I stopped before connecting an account.', speaker_id: 'Speaker 2' },
];
function signedPlaudUrl(time = Date.now()) {
  const date = new Date(time - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `https://plaud-bucket.s3.amazonaws.com/interview.mp3?X-Amz-Signature=test-signature&X-Amz-Date=${date}&X-Amz-Expires=3600`;
}

async function fixture(t, { getTask = (id) => task(id, segments),
  submitTask = () => ({ transcription_id: 'task_exec_test1', status: 'PENDING', data: {} }),
  isOwnerActive = () => true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bueeld-plaud-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  let clock = Date.now();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path.endsWith('/oauth/partner/access-token')) {
      return new Response(JSON.stringify({ access_token: 'test-partner-token', expires_in: 3600 }), { status: 200 });
    }
    if (path.endsWith('/users/access-token')) {
      return new Response(JSON.stringify({ access_token: 'test-user-token', expires_in: 86400 }), { status: 200 });
    }
    if (path.endsWith('/ai/transcriptions/') && options.method === 'POST') {
      return new Response(JSON.stringify(submitTask()), { status: 200 });
    }
    if (path.includes('/ai/transcriptions/') && options.method === 'GET') {
      const id = path.split('/').at(-1);
      return new Response(JSON.stringify(getTask(id)), { status: 200 });
    }
    throw new Error('Unexpected Plaud endpoint');
  };
  const plaud = createPlaudIntegration({ dataDir, clientId: 'test-client',
    clientSecret: 'test-secret', apiKey: 'test-key', fetchImpl,
    now: () => clock, isOwnerActive });
  return { dataDir, calls, plaud, fetchImpl, now: () => clock, advance: (ms) => { clock += ms; } };
}

test('Plaud is unavailable without all developer credentials', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bueeld-plaud-off-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const plaud = createPlaudIntegration({ dataDir, clientId: '', clientSecret: '', apiKey: '' });
  assert.equal(plaud.configured, false);
  assert.throws(() => plaud.createPairing(account('founder-123')), { status: 503 });
  assert.deepEqual(await plaud.list(account('founder-123')), []);
});

test('manual Plaud SRT parser preserves precise timestamps and quoted text', () => {
  const parsed = parsePlaudSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nIntervenant 1: Ça prend\r\ntrop de temps.\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.125\r\n<img src=x onerror=alert(1)>\r\n');
  assert.equal(parsed.duration, 5.125);
  assert.deepEqual(parsed.segments, [
    { start: 1.25, end: 3.5, text: 'Intervenant 1: Ça prend trop de temps.', speaker: null },
    { start: 4, end: 5.125, text: '<img src=x onerror=alert(1)>', speaker: null },
  ]);
  assert.match(parsed.text, /Ça prend trop de temps/);
  for (const bad of [
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNo',
    '1\n00:00:03,000 --> 00:00:02,000\nBackwards',
    '1\n00:00:01,000 --> 00:00:02,000\n',
    '1\n00:00:01,000 --> 00:00:02,000\nText\n\nBroken block',
    `1\n00:00:01,000 --> 00:00:02,000\n${'x'.repeat(2001)}`,
    '1\n00:00:01,000 --> 00:00:02,000\nBad\u0000text',
    'x'.repeat(160_001),
  ]) assert.throws(() => parsePlaudSrt(bad), { status: 400 });
});

test('manual SRT imports remain private, persistent, and separate from Embedded SDK results', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bueeld-plaud-srt-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let active = true;
  const options = { dataDir, clientId: '', clientSecret: '', apiKey: '',
    isOwnerActive: (ownerId) => ownerId !== 'disabled' && active };
  const plaud = createPlaudIntegration(options);
  const srt = '1\n00:00:00,000 --> 00:00:02,000\nThe setup is confusing.\n\n2\n00:00:02,500 --> 00:00:04,000\nI would ask for help.\n';
  const first = await plaud.importSrt({ ...account('founder-123'), srt, title: 'Plaud Web export' });
  assert.equal(first.duplicate, false);
  assert.equal(first.transcription.provider, 'plaud_export_manual');
  assert.equal(first.transcription.status, 'SUCCESS');
  assert.equal(first.transcription.verifiedAt, null);
  assert.equal((await plaud.list(account('founder-123')))[0].provider, 'plaud_export_manual');
  assert.deepEqual(await plaud.list(account('another-founder')), []);
  await assert.rejects(plaud.get({ ...account('another-founder'), id: first.transcription.id }), { status: 404 });
  const quote = { start: 0, text: 'The setup is confusing.' };
  const linked = await plaud.verifyQuote({ ...account('founder-123'),
    reference: `plaud:${first.transcription.id}`, quote });
  assert.match(linked.reference, /^User-supplied SRT \(Plaud origin unverified\) 00:00:00:/);
  await assert.rejects(plaud.verifyQuote({ ...account('founder-123'),
    reference: `plaud:${first.transcription.id}`, quote: { ...quote, text: 'Invented quote' } }), { status: 409 });
  const repeated = await plaud.importSrt({ ...account('founder-123'), srt, title: 'Different name' });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.transcription.id, first.transcription.id);
  assert.equal((await stat(join(dataDir, 'plaud-transcriptions.json'))).mode & 0o777, 0o600);
  const restarted = createPlaudIntegration(options);
  assert.equal((await restarted.get({ ...account('founder-123'), id: first.transcription.id })).provider,
    'plaud_export_manual');
  await assert.rejects(plaud.importSrt({ ...account('disabled'), srt }), { status: 401 });
  active = false;
  await assert.rejects(plaud.importSrt({ ...account('founder-123'), srt: srt + '\n' }), { status: 401 });
  active = true;
  await plaud.deleteOwner('founder-123');
  assert.deepEqual(await plaud.list(account('founder-123')), []);
  await assert.rejects(plaud.importSrt({ ...account('founder-123'), srt }), { status: 401 });
});

test('one-time pairing mints a Plaud user token and a scoped BUEELD ingest token', async (t) => {
  const { plaud, calls } = await fixture(t);
  const { code, expiresAt } = plaud.createPairing(account('founder-123'));
  assert.match(code, /^[A-Za-z0-9_-]{12}$/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  const exchanged = await plaud.exchangePairing(code, '127.0.0.1');
  assert.equal(exchanged.userId, 'bueeld-founder-123');
  assert.equal(exchanged.userAccessToken, 'test-user-token');
  assert.match(exchanged.ingestToken, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(plaud.exchangePairing(code, '127.0.0.1'), { status: 404 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization,
    `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { user_id: 'bueeld-founder-123', expires_in: 86400 });
});

test('server owns the Plaud task, saves private segments, and validates exact quotes', async (t) => {
  const { dataDir, plaud, calls, fetchImpl, now } = await fixture(t);
  const paired = await plaud.exchangePairing(plaud.createPairing(account('founder-123')).code);
  const authorized = `Bearer ${paired.ingestToken}`;
  const fileUrl = signedPlaudUrl(now());
  const submitted = await plaud.submitTranscription({ authorization: authorized, fileUrl,
    title: 'Customer interview', recordedAt: '2026-09-29T12:00:00Z', externalId: 'recording-1' });
  assert.equal(submitted.status, 'PENDING');
  assert.equal(submitted.transcription.segmentCount, 0);
  const submitCall = calls.at(-1);
  assert.equal(submitCall.options.method, 'POST');
  assert.equal(submitCall.options.headers['X-Client-Api-Key'], 'test-key');
  assert.equal(submitCall.options.headers['X-Client-Id'], 'test-client');
  assert.equal(JSON.parse(submitCall.options.body).file_url, fileUrl);
  const listed = await plaud.list(account('founder-123'));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'SUCCESS');
  assert.equal('text' in listed[0], false);
  const saved = await plaud.get({ ...account('founder-123'), id: submitted.transcription.id });
  assert.equal(saved.segmentCount, 2);
  assert.deepEqual(saved.segments[0], { start: 0, end: 3.2,
    text: 'The onboarding takes too long.', speaker: 'Speaker 1' });
  const upstreamCall = calls.at(-1);
  assert.equal(upstreamCall.options.headers['X-Client-Api-Key'], 'test-key');
  assert.equal(upstreamCall.options.headers['X-Client-Id'], 'test-client');
  assert.deepEqual(await plaud.list(account('another-founder')), []);
  await assert.rejects(plaud.get({ ...account('another-founder'), id: saved.id }), { status: 404 });
  const source = `plaud:${saved.id}`;
  const quote = { start: 0, text: segments[0].text };
  const checked = await plaud.verifyQuote({ ...account('founder-123'), reference: source, quote });
  assert.match(checked.reference, /Plaud 00:00:00: The onboarding takes too long/);
  await assert.rejects(plaud.verifyQuote({ ...account('another-founder'), reference: source, quote }), { status: 404 });
  await assert.rejects(plaud.verifyQuote({ ...account('founder-123'), reference: source,
    quote: { start: 0, text: 'An invented quote' } }), { status: 409 });
  const duplicate = await plaud.submitTranscription({ authorization: authorized,
    fileUrl, externalId: 'recording-1' });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await plaud.list(account('founder-123'))).length, 1);
  const otherPair = await plaud.exchangePairing(plaud.createPairing(account('another-founder')).code);
  await assert.rejects(plaud.get({ ...account('another-founder'), id: saved.id }), { status: 404 });
  await assert.rejects(plaud.submitTranscription({ authorization: `Bearer ${otherPair.ingestToken}`,
    transcriptionId: 'task_exec_test1', fileUrl }), { status: 400 });
  const path = join(dataDir, 'plaud-transcriptions.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const disk = await readFile(path, 'utf8');
  assert.equal(disk.includes('test-key'), false);
  assert.equal(disk.includes(paired.ingestToken), false);
  assert.equal(disk.includes('test-user-token'), false);
  const restarted = createPlaudIntegration({ dataDir, clientId: 'test-client',
    clientSecret: 'test-secret', apiKey: 'test-key', fetchImpl });
  assert.equal((await restarted.list(account('founder-123'))).length, 1);
  await plaud.deleteOwner('founder-123');
  assert.deepEqual(await plaud.list(account('founder-123')), []);
  await assert.rejects(plaud.submitTranscription({ authorization: authorized,
    fileUrl: signedPlaudUrl(now()) }), { status: 401 });
});

test('pending jobs persist and both documented segment shapes are supported', async (t) => {
  let pending = true;
  const { plaud, dataDir, advance, now } = await fixture(t, { getTask: (id) => pending
    ? { transcription_id: id, status: 'PROGRESS', data: {} }
    : { transcription_id: id, status: 'SUCCESS', data: { language: 'fr', duration: 4,
      segments: [{ start: 0, end: 4, text: 'Un vrai entretien.', speaker: 'Intervenant 1' }] } } });
  const paired = await plaud.exchangePairing(plaud.createPairing(account('founder-123')).code);
  const waiting = await plaud.submitTranscription({ authorization: `Bearer ${paired.ingestToken}`,
    fileUrl: signedPlaudUrl(now()) });
  assert.equal(waiting.status, 'PENDING');
  const disk = JSON.parse(await readFile(join(dataDir, 'plaud-transcriptions.json'), 'utf8'));
  assert.equal(disk.transcriptions[0].status, 'PENDING');
  assert.equal((await plaud.list(account('founder-123')))[0].status, 'PROGRESS');
  pending = false;
  advance(6000);
  const imported = await plaud.get({ ...account('founder-123'), id: waiting.transcription.id });
  assert.equal(imported.status, 'SUCCESS');
  assert.equal(imported.segments[0].speaker, 'Intervenant 1');
});

test('rejects arbitrary task IDs, unsafe hosts, and expired or unsigned audio URLs before a Plaud submission', async (t) => {
  const { plaud, calls, now } = await fixture(t);
  const paired = await plaud.exchangePairing(plaud.createPairing(account('founder-123')).code);
  const authorization = `Bearer ${paired.ingestToken}`;
  const good = signedPlaudUrl(now());
  const badUrls = [
    good.replace('https:', 'http:'),
    good.replace('plaud-bucket.s3.amazonaws.com', 'evil.example'),
    good.replace('plaud-bucket.s3.amazonaws.com', 'plaudevil.s3.amazonaws.com'),
    good.replace('X-Amz-Signature=test-signature', 'X-Amz-Signature='),
    good.replace('X-Amz-Expires=3600', 'X-Amz-Expires=100000'),
    signedPlaudUrl(now() - 4 * 60 * 60_000),
  ];
  for (const fileUrl of badUrls) {
    await assert.rejects(plaud.submitTranscription({ authorization, fileUrl }), { status: 400 });
  }
  await assert.rejects(plaud.submitTranscription({ authorization, fileUrl: good,
    transcriptionId: 'task_exec_foreign' }), { status: 400 });
  assert.equal(calls.filter((call) => call.options.method === 'POST' &&
    new URL(call.url).pathname.endsWith('/ai/transcriptions/')).length, 0);
});

test('concurrent retries with one external ID submit only one Plaud task', async (t) => {
  const { plaud, calls, now } = await fixture(t);
  const paired = await plaud.exchangePairing(plaud.createPairing(account('founder-123')).code);
  const input = { authorization: `Bearer ${paired.ingestToken}`,
    fileUrl: signedPlaudUrl(now()), externalId: 'same-recording' };
  const [first, second] = await Promise.all([
    plaud.submitTranscription(input), plaud.submitTranscription(input),
  ]);
  assert.equal(first.transcription.id, second.transcription.id);
  assert.equal(calls.filter((call) => call.options.method === 'POST' &&
    new URL(call.url).pathname.endsWith('/ai/transcriptions/')).length, 1);
});

test('deletion or missing account revokes pairing even while a code exists', async (t) => {
  let active = true;
  const { plaud } = await fixture(t, { isOwnerActive: () => active });
  const first = plaud.createPairing(account('founder-123'));
  active = false;
  await assert.rejects(plaud.exchangePairing(first.code), { status: 401 });
  active = true;
  const second = plaud.createPairing(account('founder-123'));
  await plaud.deleteOwner('founder-123');
  await assert.rejects(plaud.exchangePairing(second.code), { status: 404 });
});
