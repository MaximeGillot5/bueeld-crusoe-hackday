import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdalProvider } from './adal-provider.mjs';

async function withFakeCli(body, run) {
  const directory = await mkdtemp(join(tmpdir(), 'bueeld-adal-test-'));
  const bin = join(directory, 'fake-adal');
  await writeFile(bin, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  try {
    return await run({ bin, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('runs AdaL with its role, disabled tools, isolated cwd, and provider metadata', async () => {
  await withFakeCli(`
    const result = {
      argv: process.argv.slice(2), cwd: process.cwd(),
      spawnedChild: process.env.ADAL_IS_SPAWNED_CHILD,
    };
    process.stdout.write(JSON.stringify({ success: true, answer: JSON.stringify(result) }));
  `, async ({ bin }) => {
    const provider = createAdalProvider({ bin, model: 'test-model' });
    const response = await provider.generateText({ prompt: 'Hello from Lia', requestId: 'mission-7' });
    const details = JSON.parse(response.text);
    const args = details.argv;
    assert.equal(args[args.indexOf('-q') + 1], 'Hello from Lia');
    assert.equal(args[args.indexOf('-o') + 1], 'json');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
    assert.match(args[args.indexOf('--prompt-file') + 1], /adal-role\.md$/);
    assert.equal(args[args.indexOf('--disabled-default-tools') + 1], 'Read,Search,Bash,Edit,Web,Image,Video,Consult');
    assert.equal(args[args.indexOf('-m') + 1], 'test-model');
    assert.equal(details.cwd, await realpath(tmpdir()));
    assert.equal(details.spawnedChild, '1');
    assert.equal(response.provider, 'adal');
    assert.equal(response.model, 'test-model');
    assert.equal(response.requestId, 'mission-7');
    assert.equal(response.usage, null);
    assert.ok(response.durationMs >= 0);
  });
});

test('repairs invalid structured output once and applies application validation', async () => {
  await withFakeCli(`
    const query = process.argv[process.argv.indexOf('-q') + 1];
    const answer = query.includes('Retry once') ? '{"decision":"iterate"}' : '{bad';
    process.stdout.write(JSON.stringify({ success: true, answer }));
  `, async ({ bin }) => {
    let reservations = 0;
    const provider = createAdalProvider({ bin, beforeRequest: () => { reservations++; } });
    const result = await provider.generateStructured({
      prompt: 'Return a decision as JSON.',
      validate: (value) => {
        if (!['continue', 'iterate', 'stop'].includes(value.decision)) throw new Error('Invalid decision');
        return { decision: value.decision };
      },
    });
    assert.deepEqual(result.data, { decision: 'iterate' });
    assert.equal(reservations, 2);
  });
});

test('a failed quota hook prevents launching AdaL', async () => {
  await withFakeCli(`
    const { writeFileSync } = require('node:fs');
    writeFileSync(process.argv[1] + '.launched', 'launched');
    process.stdout.write(JSON.stringify({ success: true, answer: 'Unexpected' }));
  `, async ({ bin }) => {
    const provider = createAdalProvider({
      bin,
      beforeRequest: () => { throw Object.assign(new Error('Quota reached'), { status: 429 }); },
    });
    await assert.rejects(provider.generateText({ prompt: 'Hello' }), { status: 429 });
    await assert.rejects(readFile(`${bin}.launched`), { code: 'ENOENT' });
  });
});

test('reports a missing CLI as a configuration failure', async () => {
  const provider = createAdalProvider({ bin: join(tmpdir(), 'not-an-actual-adal-executable') });
  await assert.rejects(provider.generateText({ prompt: 'Hello' }), {
    code: 'ADAL_NOT_CONFIGURED', status: 503,
  });
});

test('stops a stalled CLI at the configured timeout', async () => {
  await withFakeCli('setInterval(() => {}, 1000);', async ({ bin }) => {
    const provider = createAdalProvider({ bin, timeoutMs: 150 });
    await assert.rejects(provider.generateText({ prompt: 'Hello' }), {
      code: 'ADAL_TIMEOUT', status: 504,
    });
  });
});

test('rejects oversized output without parsing or exposing it', async () => {
  await withFakeCli('process.stdout.write("x".repeat(1_100_000));', async ({ bin }) => {
    const provider = createAdalProvider({ bin });
    await assert.rejects(provider.generateText({ prompt: 'Hello' }), (error) => {
      assert.equal(error.code, 'ADAL_RESPONSE_TOO_LARGE');
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /xxx/);
      return true;
    });
  });
});

test('rejects a second invalid structured result after two bounded attempts', async () => {
  await withFakeCli('process.stdout.write(JSON.stringify({ success: true, answer: "{}" }));', async ({ bin }) => {
    let calls = 0;
    const provider = createAdalProvider({ bin, beforeRequest: () => { calls++; } });
    await assert.rejects(provider.generateStructured({
      prompt: 'Return a decision.',
      validate: (value) => { if (!value.decision) throw new Error('Missing decision'); },
    }), { code: 'ADAL_INVALID_STRUCTURE', status: 502 });
    assert.equal(calls, 2);
  });
});
