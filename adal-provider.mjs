import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'adal-role.md');
const MAX_RESPONSE_BYTES = 1_000_000;
const DISABLED_TOOLS = 'Read,Search,Bash,Edit,Web,Image,Video,Consult';
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'ADAL_HOME', 'ADAL_CONFIG_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
  'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
];

function providerError(message, status, code) {
  return Object.assign(new Error(message), { status, code, provider: 'adal' });
}

function validPrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80_000) {
    throw new TypeError('prompt must be a nonempty string of at most 80,000 characters.');
  }
  return value;
}

function tokenLimit(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 4096)) {
    throw new TypeError('maxOutputTokens must be an integer from 1 to 4096.');
  }
}

function parseObject(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected one JSON object.');
  }
  return parsed;
}

function childEnvironment() {
  return {
    ...Object.fromEntries(ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])),
    ADAL_IS_SPAWNED_CHILD: '1',
  };
}

/**
 * The local AdaL CLI as a bounded fallback for the Crusoe provider.
 * It uses the separate AdaL role file and cannot access built-in tools.
 * AdaL's CLI has no max-output-tokens option; maxOutputTokens is validated for
 * API compatibility, while the response is bounded by MAX_RESPONSE_BYTES.
 */
export function createAdalProvider(options = {}) {
  const bin = options.bin ?? (process.env.ADAL_BIN?.trim() || 'adal');
  const configuredModel = options.model ?? (process.env.ADAL_MODEL?.trim() || '');
  const timeoutMs = options.timeoutMs ?? 75_000;
  const promptFile = options.promptFile ?? DEFAULT_PROMPT_FILE;
  const beforeRequest = options.beforeRequest;
  if (typeof bin !== 'string' || !bin.trim()) throw new TypeError('A nonempty AdaL executable is required.');
  if (typeof configuredModel !== 'string') throw new TypeError('Invalid AdaL model.');
  if (typeof promptFile !== 'string' || !promptFile.trim()) throw new TypeError('Invalid AdaL promptFile.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new TypeError('Invalid timeoutMs.');
  if (beforeRequest !== undefined && typeof beforeRequest !== 'function') throw new TypeError('Invalid beforeRequest.');

  async function complete({ prompt, maxOutputTokens, requestId } = {}) {
    const userPrompt = validPrompt(prompt);
    tokenLimit(maxOutputTokens);
    const localRequestId = typeof requestId === 'string' && requestId.trim()
      ? requestId.trim().slice(0, 100) : randomUUID();
    const started = Date.now();
    const args = [
      '-q', userPrompt, '-o', 'json', '--permission-mode', 'default',
      '--prompt-file', promptFile,
      '--disabled-default-tools', DISABLED_TOOLS,
      ...(configuredModel.trim() ? ['-m', configuredModel.trim()] : []),
    ];
    await beforeRequest?.({ requestId: localRequestId, attempt: 1, model: configuredModel.trim() || 'adal-default' });

    const payload = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, {
          cwd: tmpdir(),
          env: childEnvironment(),
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: false,
        });
      } catch {
        reject(providerError('AdaL could not be started.', 503, 'ADAL_UNAVAILABLE'));
        return;
      }

      const chunks = [];
      let bytes = 0;
      let failure = null;
      let settled = false;
      let forceTimer;
      const timer = setTimeout(() => stop(providerError('AdaL did not respond in time.', 504, 'ADAL_TIMEOUT')), timeoutMs);

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        if (error) reject(error);
        else resolve(result);
      }

      function stop(error) {
        if (failure || settled) return;
        failure = error;
        child.kill('SIGTERM');
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      }

      child.stdout.on('data', (chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          stop(providerError('AdaL returned an oversized response.', 502, 'ADAL_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', (error) => {
        const code = error?.code === 'ENOENT' ? 'ADAL_NOT_CONFIGURED' : 'ADAL_UNAVAILABLE';
        finish(providerError(code === 'ADAL_NOT_CONFIGURED'
          ? 'AdaL is not installed on this server.' : 'AdaL could not be started.', 503, code));
      });
      child.on('close', (code) => {
        if (failure) return finish(failure);
        if (code !== 0) return finish(providerError('AdaL could not complete this request.', 503, 'ADAL_UNAVAILABLE'));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || result.success !== true || typeof result.answer !== 'string' || !result.answer.trim()) {
            throw new Error('Missing answer');
          }
          finish(null, result);
        } catch {
          finish(providerError('AdaL returned an invalid response.', 502, 'ADAL_INVALID_RESPONSE'));
        }
      });
    });

    return {
      text: payload.answer.trim(),
      provider: 'adal',
      model: typeof payload.model === 'string' && payload.model.trim()
        ? payload.model.trim() : (configuredModel.trim() || 'adal-default'),
      durationMs: Date.now() - started,
      usage: null,
      requestId: localRequestId,
    };
  }

  async function generateText(input) {
    return complete(input);
  }

  async function generateStructured({ prompt, validate, maxOutputTokens, requestId } = {}) {
    if (validate !== undefined && typeof validate !== 'function') throw new TypeError('validate must be a function.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const actualPrompt = attempt === 0 ? prompt
        : `${prompt}\n\nYour previous response was not valid for the required schema. Retry once. Return exactly one valid JSON object, with no Markdown or extra text.`;
      const result = await complete({ prompt: actualPrompt, maxOutputTokens, requestId });
      try {
        const parsed = parseObject(result.text);
        const checked = validate ? validate(parsed) : parsed;
        if (checked === false) throw new Error('Object did not pass validation.');
        return { ...result, data: checked === undefined || checked === true ? parsed : checked };
      } catch { /* One bounded repair attempt follows. */ }
    }
    throw providerError('AdaL returned a result that could not be validated.', 502, 'ADAL_INVALID_STRUCTURE');
  }

  return Object.freeze({ generateText, generateStructured });
}
