import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ENDPOINT = 'https://api.inference.crusoecloud.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/Deepseek-V4-Flash';
const MAX_RESPONSE_CHARACTERS = 1_000_000;
let defaultRolePromise;

function providerError(message, status, code) {
  return Object.assign(new Error(message), { status, code, provider: 'crusoe' });
}

function defaultRole() {
  defaultRolePromise ||= readFile(new URL('./lia-role.md', import.meta.url), 'utf8');
  return defaultRolePromise;
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('').trim();
  }
  return '';
}

function parseObject(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected one JSON object.');
  }
  return parsed;
}

function tokenLimit(value) {
  if (value === undefined) return 2048;
  if (!Number.isSafeInteger(value) || value < 1 || value > 4096) {
    throw new TypeError('maxOutputTokens must be an integer from 1 to 4096.');
  }
  return value;
}

function validPrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80_000) {
    throw new TypeError('prompt must be a nonempty string of at most 80,000 characters.');
  }
  return value;
}

function retryDelay(response, attempt, baseMs) {
  const retryAfter = response.headers?.get?.('retry-after');
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(3_000, Math.ceil(seconds * 1_000));
  }
  return Math.min(3_000, baseMs * 2 ** (attempt - 1));
}

async function isCreditFailure(response) {
  if (response.status === 402) return true;
  if (![400, 403, 429].includes(response.status)) return false;
  let payload;
  try {
    const body = await response.text();
    if (body.length > 8_000) return false;
    payload = JSON.parse(body);
  } catch { return false; }
  const error = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const code = String(error?.code || error?.type || payload?.code || '').toLowerCase();
  if (['insufficient_credits', 'credits_exhausted', 'credit_balance_exhausted',
    'insufficient_quota', 'insufficient_funds', 'payment_required', 'billing_quota_exceeded'].includes(code)) return true;
  const message = String(error?.message || error?.detail || '').toLowerCase();
  return /(?:insufficient|exhausted|depleted|no remaining|out of|not enough)\s+(?:\w+\s+){0,2}credits?\b/.test(message)
    || /\bcredit balance\b.*\b(?:zero|exhausted|insufficient|depleted)\b/.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Crusoe Serverless Inference adapter. No CLI or other model-provider fallback is used.
 * `fetchImpl`, `apiKey`, and `systemPrompt` are injectable for tests.
 */
export function createCrusoeProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const endpoint = options.endpoint ?? ENDPOINT;
  const model = options.model ?? (process.env.CRUSOE_MODEL?.trim() || DEFAULT_MODEL);
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('A Crusoe model is required.');
  const timeoutMs = options.timeoutMs ?? 75_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 350;
  const beforeRequest = options.beforeRequest;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new TypeError('Invalid timeoutMs.');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new TypeError('Invalid maxAttempts.');
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 0 || retryBaseMs > 3_000) throw new TypeError('Invalid retryBaseMs.');
  if (beforeRequest !== undefined && typeof beforeRequest !== 'function') throw new TypeError('Invalid beforeRequest.');

  async function complete({ prompt, maxOutputTokens, requestId } = {}) {
    const userPrompt = validPrompt(prompt);
    const maxTokens = tokenLimit(maxOutputTokens);
    const key = options.apiKey ?? process.env.CRUSOE_API_KEY;
    if (typeof key !== 'string' || !key.trim()) {
      throw providerError('Crusoe is not configured for this server.', 503, 'CRUSOE_NOT_CONFIGURED');
    }
    const systemPrompt = options.systemPrompt ?? await defaultRole();
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      throw providerError('Lia instructions are unavailable.', 503, 'LIA_ROLE_UNAVAILABLE');
    }
    const localRequestId = typeof requestId === 'string' && requestId.trim()
      ? requestId.trim().slice(0, 100) : randomUUID();
    const started = Date.now();
    const deadline = started + timeoutMs;
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      stream: false,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (deadline <= Date.now()) throw providerError('Lia did not respond in time.', 504, 'CRUSOE_TIMEOUT');
      await beforeRequest?.({ requestId: localRequestId, attempt, model });
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw providerError('Lia did not respond in time.', 504, 'CRUSOE_TIMEOUT');
      const signal = AbortSignal.timeout(remainingMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body,
          signal,
        });
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw providerError('Lia did not respond in time.', 504, 'CRUSOE_TIMEOUT');
        }
        throw providerError('Crusoe could not be reached.', 503, 'CRUSOE_NETWORK');
      }

      if (await isCreditFailure(response)) {
        throw providerError('Crusoe credits are exhausted or billing is required.', 503, 'CRUSOE_CREDITS_EXHAUSTED');
      }
      if (response.status === 401 || response.status === 403) {
        throw providerError('Crusoe rejected the server credentials.', 503, 'CRUSOE_AUTH');
      }
      if (response.status === 429 || response.status === 503) {
        if (attempt < maxAttempts) {
          const delay = Math.min(retryDelay(response, attempt, retryBaseMs), Math.max(0, deadline - Date.now() - 1));
          await sleep(delay);
          continue;
        }
        throw providerError(response.status === 429 ? 'Crusoe is rate limited. Please retry.' : 'Crusoe is temporarily unavailable. Please retry.', 503,
          response.status === 429 ? 'CRUSOE_RATE_LIMITED' : 'CRUSOE_UNAVAILABLE');
      }
      if (!response.ok) {
        throw providerError(`Crusoe rejected the request (HTTP ${response.status}).`, 502, 'CRUSOE_REQUEST_FAILED');
      }

      let payload;
      try {
        const raw = await response.text();
        if (raw.length > MAX_RESPONSE_CHARACTERS) throw new Error('Response too large');
        payload = JSON.parse(raw);
      } catch {
        if (signal.aborted) throw providerError('Lia did not respond in time.', 504, 'CRUSOE_TIMEOUT');
        throw providerError('Crusoe returned an invalid response.', 502, 'CRUSOE_INVALID_RESPONSE');
      }
      const choice = payload?.choices?.[0];
      const answer = contentText(choice?.message?.content);
      if (!answer || choice?.finish_reason === 'length') {
        throw providerError('Crusoe returned an incomplete response.', 502, 'CRUSOE_INCOMPLETE_RESPONSE');
      }
      return {
        text: answer,
        provider: 'crusoe',
        model: typeof payload.model === 'string' && payload.model.trim() ? payload.model : model,
        durationMs: Date.now() - started,
        usage: normalizeUsage(payload.usage),
        requestId: localRequestId,
      };
    }
    throw providerError('Crusoe is temporarily unavailable.', 503, 'CRUSOE_UNAVAILABLE');
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
    throw providerError('Lia returned a result that could not be validated.', 502, 'CRUSOE_INVALID_STRUCTURE');
  }

  return Object.freeze({ generateText, generateStructured });
}

const defaultProvider = createCrusoeProvider();
export const generateText = (input) => defaultProvider.generateText(input);
export const generateStructured = (input) => defaultProvider.generateStructured(input);
export const askLia = async (prompt) => (await defaultProvider.generateText({ prompt })).text;
