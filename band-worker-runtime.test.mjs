import assert from 'node:assert/strict';
import test from 'node:test';
import { createBandWorkerRuntime } from './band-worker-runtime.mjs';

test('a separate Band agent process reports startup failures over IPC', async () => {
  const child = createBandWorkerRuntime({ role: 'invalid', key: 'unused', roomId: 'unused',
    context: {}, scout: {}, critic: {}, human: {}, responseTimeoutMs: 100,
    reserveCall: async () => {} });
  try {
    await assert.rejects(child.ready, { code: 'BAND_AGENT_FAILED', status: 502 });
    await assert.rejects(child.done, { code: 'BAND_AGENT_FAILED', status: 502 });
  } finally {
    await child.stop();
  }
});
