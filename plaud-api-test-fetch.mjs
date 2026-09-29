// Test-only Plaud endpoint fixture loaded into the child BUEELD server process.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith('https://platform-us.plaud.ai/developer/api/')) {
    return originalFetch(url, options);
  }
  const path = new URL(target).pathname;
  let body;
  if (path.endsWith('/oauth/partner/access-token')) {
    body = { access_token: 'fixture-partner-token', expires_in: 3600 };
  } else if (path.endsWith('/users/access-token')) {
    body = { access_token: 'fixture-user-token', expires_in: 86400 };
  } else if (path.endsWith('/ai/transcriptions/') && options.method === 'POST') {
    body = { transcription_id: 'task_exec_fixture1', status: 'PENDING', data: {} };
  } else if (path.endsWith('/ai/transcriptions/task_exec_fixture1') && options.method === 'GET') {
    body = { transcription_id: 'task_exec_fixture1', status: 'SUCCESS', data: {
      duration: 5, language: 'en', results: [
        { start: 0, end: 5, text: 'The onboarding takes too long.', speaker_id: 'Speaker 1' },
      ],
    } };
  } else {
    return new Response(JSON.stringify({ error: 'Unknown fixture route' }), { status: 404 });
  }
  return new Response(JSON.stringify(body), { status: 200,
    headers: { 'content-type': 'application/json' } });
};
