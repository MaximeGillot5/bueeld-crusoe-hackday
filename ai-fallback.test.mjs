import assert from 'node:assert/strict';
import test from 'node:test';
import { createCreditFallbackProvider } from './ai-fallback.mjs';

function providers(primary, fallback) {
  return {
    primary: { generateText: primary, generateStructured: primary },
    fallback: { generateText: fallback, generateStructured: fallback },
  };
}

test('uses Crusoe first and reports its real provider metadata', async () => {
  let fallbackCalls = 0;
  const router = createCreditFallbackProvider(providers(
    async () => ({ text: 'Crusoe answer', provider: 'crusoe' }),
    async () => { fallbackCalls++; return { text: 'AdaL answer', provider: 'adal' }; },
  ));
  assert.deepEqual(await router.generateText({ prompt: 'Hello' }), { text: 'Crusoe answer', provider: 'crusoe' });
  assert.equal(fallbackCalls, 0);
});

test('switches on an explicit credit failure, then probes Crusoe after a cooldown', async () => {
  let time = 1_000;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = createCreditFallbackProvider({ ...providers(
    async () => {
      primaryCalls++;
      if (primaryCalls === 1) throw Object.assign(new Error('No credits'), { code: 'CRUSOE_CREDITS_EXHAUSTED' });
      return { text: 'Credits restored', provider: 'crusoe' };
    },
    async () => { fallbackCalls++; return { text: 'AdaL answer', provider: 'adal' }; },
  ), now: () => time, retryAfterMs: 300_000 });
  const first = await router.generateText({ prompt: 'First' });
  assert.equal(first.provider, 'adal');
  assert.equal(first.fallbackReason, 'crusoe_credits_exhausted');
  assert.equal((await router.generateText({ prompt: 'Second' })).provider, 'adal');
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 2);
  time += 300_000;
  assert.equal((await router.generateText({ prompt: 'Third' })).provider, 'crusoe');
  assert.equal(primaryCalls, 2);
});

test('applies the same credit fallback to structured experiment reviews', async () => {
  const router = createCreditFallbackProvider(providers(
    async () => { throw Object.assign(new Error('Payment required'), { code: 'CRUSOE_CREDITS_EXHAUSTED' }); },
    async () => ({ data: { summary: 'Useful evidence' }, provider: 'adal', model: 'adal-default' }),
  ));
  assert.deepEqual(await router.generateStructured({ prompt: 'Review' }), {
    data: { summary: 'Useful evidence' }, provider: 'adal', model: 'adal-default',
    fallbackReason: 'crusoe_credits_exhausted',
  });
});

test('does not hide missing keys, authentication, or rate-limit failures', async () => {
  for (const code of ['CRUSOE_NOT_CONFIGURED', 'CRUSOE_AUTH', 'CRUSOE_RATE_LIMITED']) {
    let fallbackCalls = 0;
    const router = createCreditFallbackProvider(providers(
      async () => { throw Object.assign(new Error('Primary failed'), { code }); },
      async () => { fallbackCalls++; return { provider: 'adal' }; },
    ));
    await assert.rejects(router.generateText({ prompt: 'Hello' }), { code });
    assert.equal(fallbackCalls, 0);
  }
});

test('explicit local opt-in routes an unconfigured Crusoe provider to AdaL for structured turns', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = createCreditFallbackProvider({ ...providers(
    async () => {
      primaryCalls++;
      throw Object.assign(new Error('No Crusoe key'), { code: 'CRUSOE_NOT_CONFIGURED' });
    },
    async () => {
      fallbackCalls++;
      return { data: { outcome: 'continue', reply: 'Please clarify.' }, provider: 'adal' };
    },
  ), fallbackOnUnconfigured: true, now: () => 1_000 });
  const result = await router.generateStructured({ prompt: 'Analyze mission answer' });
  assert.deepEqual(result, {
    data: { outcome: 'continue', reply: 'Please clarify.' }, provider: 'adal',
    fallbackReason: 'crusoe_not_configured',
  });
  assert.equal((await router.generateStructured({ prompt: 'Next turn' })).fallbackReason, 'crusoe_not_configured');
  assert.equal(primaryCalls, 1, 'the missing primary key is not retried during the fallback cooldown');
  assert.equal(fallbackCalls, 2);
});

test('missing-key opt-in still rejects unrelated Crusoe authentication and rate-limit errors', async () => {
  for (const code of ['CRUSOE_AUTH', 'CRUSOE_RATE_LIMITED']) {
    let fallbackCalls = 0;
    const router = createCreditFallbackProvider({ ...providers(
      async () => { throw Object.assign(new Error('Primary failed'), { code }); },
      async () => { fallbackCalls++; return { provider: 'adal' }; },
    ), fallbackOnUnconfigured: true });
    await assert.rejects(router.generateText({ prompt: 'Hello' }), { code });
    assert.equal(fallbackCalls, 0);
  }
});

test('reports a fallback failure instead of pretending the request succeeded', async () => {
  const router = createCreditFallbackProvider(providers(
    async () => { throw Object.assign(new Error('No credits'), { code: 'CRUSOE_CREDITS_EXHAUSTED' }); },
    async () => { throw Object.assign(new Error('AdaL unavailable'), { code: 'ADAL_UNAVAILABLE' }); },
  ));
  await assert.rejects(router.generateText({ prompt: 'Hello' }), { code: 'ADAL_UNAVAILABLE' });
});
