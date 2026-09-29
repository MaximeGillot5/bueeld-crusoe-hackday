import { fork } from 'node:child_process';
import { bandError } from './band-client.mjs';

// Each Band identity lives in its own OS process. The HTTP request handler only
// starts the listeners and sends the first @mention; all further turns are
// triggered by messages arriving over the corresponding Band socket.
export function createBandWorkerRuntime({ role, key, reserveCall, ...context }) {
  const env = { ...process.env };
  for (const name of ['BAND_SCOUT_AGENT_ID', 'BAND_SCOUT_API_KEY', 'BAND_CRITIC_AGENT_ID', 'BAND_CRITIC_API_KEY']) delete env[name];
  const child = fork(new URL('./band-agent-worker.mjs', import.meta.url), [], {
    env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  // A failed startup may reject done before the request handler gets to await it.
  done.catch(() => {});
  let settled = false;
  let isReady = false;
  function fail(error) {
    if (settled) return;
    settled = true;
    if (!isReady) readyReject(error);
    doneReject(error);
  }
  child.on('message', async (message) => {
    if (message?.type === 'ready') {
      isReady = true;
      readyResolve();
    } else if (message?.type === 'done') {
      if (!isReady) { isReady = true; readyResolve(); }
      if (!settled) { settled = true; doneResolve(message.result); }
    } else if (message?.type === 'failed') {
      const detail = message.error || {};
      fail(bandError(detail.status || 502, detail.message || 'A Band agent failed.', detail.code || 'BAND_AGENT_FAILED'));
    } else if (message?.type === 'reserve') {
      try {
        await reserveCall();
        child.send?.({ type: 'reserve_response', id: message.id, ok: true });
      } catch (error) {
        child.send?.({ type: 'reserve_response', id: message.id, ok: false,
          error: { status: error?.status || 429, code: error?.code || 'AI_CALL_LIMIT',
            message: error?.status ? error.message : 'The demo has reached its AI call limit.' } });
      }
    }
  });
  child.on('error', () => fail(bandError(503, 'Could not start the Band agent process.', 'BAND_AGENT_START_FAILED')));
  child.on('exit', (code) => {
    if (!settled) fail(bandError(502, `The Band ${role} agent stopped before answering (${code ?? 'signal'}).`, 'BAND_AGENT_STOPPED'));
  });
  child.send({ type: 'start', options: { role, key, ...context } });
  return { ready, done, stop: () => new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
  }) };
}
