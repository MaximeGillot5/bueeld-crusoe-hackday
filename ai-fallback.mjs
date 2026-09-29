const CREDIT_ERROR = 'CRUSOE_CREDITS_EXHAUSTED';
const UNCONFIGURED_ERROR = 'CRUSOE_NOT_CONFIGURED';
const CREDIT_FALLBACK_REASON = 'crusoe_credits_exhausted';
const UNCONFIGURED_FALLBACK_REASON = 'crusoe_not_configured';

/** Crusoe stays primary. Missing-key fallback requires an explicit local-only caller opt-in. */
export function createCreditFallbackProvider({ primary, fallback, now = Date.now,
  retryAfterMs = 300_000, fallbackOnUnconfigured = false }) {
  for (const provider of [primary, fallback]) {
    if (typeof provider?.generateText !== 'function' || typeof provider?.generateStructured !== 'function') {
      throw new TypeError('Both AI providers must support text and structured requests.');
    }
  }
  if (typeof now !== 'function' || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 ||
      typeof fallbackOnUnconfigured !== 'boolean') {
    throw new TypeError('Invalid fallback settings.');
  }
  let retryPrimaryAt = 0;
  let activeFallbackReason = CREDIT_FALLBACK_REASON;

  async function run(method, input) {
    async function useFallback(reason) {
      const result = await fallback[method](input);
      return { ...result, fallbackReason: reason };
    }
    if (now() < retryPrimaryAt) return useFallback(activeFallbackReason);
    try {
      return await primary[method](input);
    } catch (error) {
      const reason = error?.code === CREDIT_ERROR ? CREDIT_FALLBACK_REASON
        : fallbackOnUnconfigured && error?.code === UNCONFIGURED_ERROR ? UNCONFIGURED_FALLBACK_REASON : null;
      if (!reason) throw error;
      retryPrimaryAt = now() + retryAfterMs;
      activeFallbackReason = reason;
      return useFallback(reason);
    }
  }

  return Object.freeze({
    generateText: (input) => run('generateText', input),
    generateStructured: (input) => run('generateStructured', input),
  });
}
