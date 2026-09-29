import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = new URL('./quota.mjs', import.meta.url);
const isolated = await mkdtemp(join(tmpdir(), 'bueeld-quota-test-'));
try {
  const target = join(isolated, 'quota.mjs');
  await copyFile(source, target);
  const url = pathToFileURL(target).href;
  const quota = await import(url);
  assert.equal(quota.aiCallsUsed(), 0);
  assert.equal(await quota.reserveAiCall(2), 1);
  assert.equal(await quota.reserveAiCall(2), 2);
  await assert.rejects(quota.reserveAiCall(2), (cause) => cause.status === 429);
  const persisted = JSON.parse(await readFile(join(isolated, '.data', 'demo-usage.json'), 'utf8'));
  assert.equal(persisted.used, 2);
  assert.equal((await stat(join(isolated, '.data', 'demo-usage.json'))).mode & 0o777, 0o600);
  const restarted = await import(`${url}?restart=1`);
  assert.equal(restarted.aiCallsUsed(), 2);
  await assert.rejects(restarted.reserveAiCall(2), (cause) => cause.status === 429);
  console.log('Persistent demo quota tests passed: atomic increment, cap, private mode, restart.');
} finally { await rm(isolated, { recursive: true, force: true }); }
