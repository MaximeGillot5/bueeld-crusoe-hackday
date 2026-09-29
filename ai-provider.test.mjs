import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrusoeProvider } from './ai-provider.mjs';

function response(status, value, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(value),
  };
}

function completion(content, extra = {}) {
  return response(200, {
    model: 'deepseek-ai/Deepseek-V4-Flash',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    ...extra,
  });
}

test('requires a server-side Crusoe key before making a request', async () => {
  let called = false;
  const provider = createCrusoeProvider({ apiKey: '', systemPrompt: 'Lia', fetchImpl: async () => { called = true; } });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), { code: 'CRUSOE_NOT_CONFIGURED', status: 503 });
  assert.equal(called, false);
});

test('sends Lia instructions and returns verified provider metadata', async () => {
  let request;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret',
    systemPrompt: 'You are Lia.',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return completion('One clear answer.');
    },
  });
  const result = await provider.generateText({ prompt: 'What next?', requestId: 'mission-7' });
  assert.equal(request.url, 'https://api.inference.crusoecloud.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(request.options.body).messages, [
    { role: 'system', content: 'You are Lia.' },
    { role: 'user', content: 'What next?' },
  ]);
  assert.equal(JSON.parse(request.options.body).max_tokens, 2048);
  assert.equal(result.text, 'One clear answer.');
  assert.equal(result.provider, 'crusoe');
  assert.equal(result.model, 'deepseek-ai/Deepseek-V4-Flash');
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  assert.equal(result.requestId, 'mission-7');
  assert.ok(result.durationMs >= 0);
});

test('retries 429 once and preserves a bounded number of requests', async () => {
  let calls = 0;
  let reservations = 0;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia', retryBaseMs: 0,
    beforeRequest: () => { reservations++; },
    fetchImpl: async () => ++calls === 1 ? response(429, {}, { 'retry-after': '0' }) : completion('Ready.'),
  });
  assert.equal((await provider.generateText({ prompt: 'Hello' })).text, 'Ready.');
  assert.equal(calls, 2);
  assert.equal(reservations, 2);
});

test('a quota hook can stop the request before using Crusoe', async () => {
  let called = false;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia',
    beforeRequest: () => { throw Object.assign(new Error('Quota reached'), { status: 429 }); },
    fetchImpl: async () => { called = true; return completion('Unexpected'); },
  });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), { status: 429 });
  assert.equal(called, false);
});

test('stops after three 503 responses without exposing upstream bodies', async () => {
  let calls = 0;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia', retryBaseMs: 0,
    fetchImpl: async () => { calls++; return response(503, { detail: 'secret upstream information' }); },
  });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), (error) => {
    assert.equal(error.code, 'CRUSOE_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /secret upstream information/);
    return true;
  });
  assert.equal(calls, 3);
});

test('does not retry invalid credentials', async () => {
  let calls = 0;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia', retryBaseMs: 0,
    fetchImpl: async () => { calls++; return response(401, { detail: 'bad key' }); },
  });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), { code: 'CRUSOE_AUTH' });
  assert.equal(calls, 1);
});

test('recognizes a payment-required response as exhausted Crusoe credits', async () => {
  let calls = 0;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia',
    fetchImpl: async () => { calls++; return response(402, {}); },
  });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), {
    code: 'CRUSOE_CREDITS_EXHAUSTED', status: 503,
  });
  assert.equal(calls, 1);
});

test('recognizes an explicit credit error on 429 without mistaking normal rate limiting for credits', async () => {
  let calls = 0;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia', retryBaseMs: 0,
    fetchImpl: async () => {
      calls++;
      return response(429, { error: { code: 'insufficient_credits', message: 'Account credits exhausted' } });
    },
  });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), {
    code: 'CRUSOE_CREDITS_EXHAUSTED', status: 503,
  });
  assert.equal(calls, 1);
});

test('repairs malformed structured output once and applies app validation', async () => {
  let calls = 0;
  const prompts = [];
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia',
    fetchImpl: async (_url, options) => {
      prompts.push(JSON.parse(options.body).messages[1].content);
      return ++calls === 1 ? completion('{bad') : completion('{"decision":"iterate"}');
    },
  });
  const result = await provider.generateStructured({
    prompt: 'Return one JSON object.',
    validate: (value) => {
      if (!['continue', 'iterate', 'stop'].includes(value.decision)) throw new Error('Invalid decision');
      return { decision: value.decision };
    },
  });
  assert.deepEqual(result.data, { decision: 'iterate' });
  assert.equal(calls, 2);
  assert.match(prompts[1], /Retry once/);
});

test('rejects a second invalid object without an unbounded repair loop', async () => {
  let calls = 0;
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia',
    fetchImpl: async () => { calls++; return completion('{"notDecision":true}'); },
  });
  await assert.rejects(provider.generateStructured({
    prompt: 'Return one JSON object.',
    validate: (value) => { if (!value.decision) throw new Error('Missing decision'); },
  }), { code: 'CRUSOE_INVALID_STRUCTURE', status: 502 });
  assert.equal(calls, 2);
});

test('does not pass an incomplete answer to the application', async () => {
  const provider = createCrusoeProvider({
    apiKey: 'test-secret', systemPrompt: 'Lia',
    fetchImpl: async () => completion('Half', { choices: [{ message: { content: 'Half' }, finish_reason: 'length' }] }),
  });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), { code: 'CRUSOE_INCOMPLETE_RESPONSE' });
});
