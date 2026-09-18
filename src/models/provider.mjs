/**
 * The model provider contract.
 *
 * This module is the interface every provider implements and the only place
 * `ModelError` is defined. It contains no network code and no provider
 * implementation — see `src/models/providers/`.
 *
 * ┌─ Provider contract ──────────────────────────────────────────────────────┐
 * │ id(): string                       stable id, e.g. 'openai'               │
 * │ capabilities(): {                  static, no I/O                        │
 * │   tools: boolean,                  can emit tool calls                   │
 * │   json: boolean,                   honours responseFormat json           │
 * │   streaming: boolean,              reserved; false everywhere today      │
 * │   maxContextTokens: number,        router uses this to filter candidates │
 * │   deterministic: boolean,          true only for the mock provider       │
 * │   mock: boolean                    true only for test doubles            │
 * │ }                                                                        │
 * │ complete({                                                               │
 * │   messages: [{ role, content }],   roles: system|user|assistant|tool     │
 * │   tools?: [tool definition],       see src/tools/registry.mjs            │
 * │   responseFormat?: 'text'|'json',                                        │
 * │   timeoutMs?: number,                                                    │
 * │   signal?: AbortSignal                                                   │
 * │ }) => Promise<{                                                          │
 * │   text: string,                    '' when the turn is tool calls only   │
 * │   toolCalls: [{ id, name, arguments }],  [] when none                    │
 * │   usage: { promptTokens, completionTokens, totalTokens },                │
 * │   raw?: unknown,                   provider payload, for debugging only  │
 * │ }>                                                                       │
 * │                                                                          │
 * │ On failure: throw a `ModelError` with one of MODEL_ERROR_CODES. Never    │
 * │ return a fabricated completion.                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** Typed failure codes. Every provider failure is one of these. */
export const MODEL_ERROR_CODES = Object.freeze({
  /** the provider or endpoint could not be reached / is not configured */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** no credential is present — never fabricate a response instead */
  AUTH_MISSING: 'AUTH_MISSING',
  /** the call exceeded its timeout */
  TIMEOUT: 'TIMEOUT',
  /** the provider answered, but not with the contracted shape */
  MALFORMED_OUTPUT: 'MALFORMED_OUTPUT',
  /** throttled by the provider (HTTP 429) */
  RATE_LIMITED: 'RATE_LIMITED',
});

export const MODEL_ERROR_CODE_LIST = Object.freeze(Object.values(MODEL_ERROR_CODES));

/** Errors that a caller may reasonably retry. */
export const RETRYABLE_MODEL_ERRORS = Object.freeze([
  MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
  MODEL_ERROR_CODES.TIMEOUT,
  MODEL_ERROR_CODES.RATE_LIMITED,
]);

/** @extends Error */
export class ModelError extends Error {
  /**
   * @param {string} code    one of MODEL_ERROR_CODES
   * @param {string} message human-readable, safe to log (never the key itself)
   * @param {object} [details] `{ provider, model, status, cause, retryable }`
   */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'ModelError';
    this.code = code;
    this.detail = message;
    this.provider = details.provider ?? null;
    this.model = details.model ?? null;
    this.status = details.status ?? null;
    this.retryable = details.retryable ?? RETRYABLE_MODEL_ERRORS.includes(code);
    if (details.cause !== undefined) this.cause = details.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.detail,
      provider: this.provider,
      model: this.model,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

/** @returns {boolean} */
export function isModelError(error) {
  return error instanceof ModelError || (error?.name === 'ModelError' && typeof error?.code === 'string');
}

/** Default capability block. Providers override the fields that differ. */
export const DEFAULT_CAPABILITIES = Object.freeze({
  tools: false,
  json: false,
  streaming: false,
  maxContextTokens: 8_192,
  deterministic: false,
  mock: false,
});

/**
 * Duck-type validation of the contract. Called by the provider registry so a
 * half-implemented provider fails at wiring time, not mid-run.
 *
 * @param {object} provider
 * @returns {object} the same provider
 */
export function assertProvider(provider) {
  const problems = [];
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('assertProvider: provider must be an object');
  }
  if (typeof provider.id !== 'function') problems.push('id()');
  if (typeof provider.capabilities !== 'function') problems.push('capabilities()');
  if (typeof provider.complete !== 'function') problems.push('complete()');

  let id = '<unknown>';
  try {
    id = provider.id();
  } catch {
    problems.push('id() must not throw');
  }

  if (problems.length) {
    throw new TypeError(`provider "${id}" does not implement the contract: missing ${problems.join(', ')}`);
  }

  const capabilities = provider.capabilities();
  const missing = Object.keys(DEFAULT_CAPABILITIES).filter((key) => capabilities?.[key] === undefined);
  if (missing.length) {
    throw new TypeError(`provider "${id}" capabilities() is missing: ${missing.join(', ')}`);
  }

  return provider;
}

/**
 * Normalise and validate a completion result. A provider that returns the
 * wrong shape is a MALFORMED_OUTPUT model error, not a crash three frames
 * later.
 */
export function normalizeCompletion(result, { provider, model } = {}) {
  const fail = (message) => {
    throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, message, { provider, model });
  };

  if (!result || typeof result !== 'object') fail('completion result must be an object');

  const text = typeof result.text === 'string' ? result.text : result.text === undefined ? '' : fail('`text` must be a string');

  const rawToolCalls = result.toolCalls ?? [];
  if (!Array.isArray(rawToolCalls)) fail('`toolCalls` must be an array');

  const toolCalls = rawToolCalls.map((call, index) => {
    if (!call || typeof call !== 'object') fail(`toolCalls[${index}] must be an object`);
    if (typeof call.name !== 'string' || !call.name) fail(`toolCalls[${index}].name must be a non-empty string`);
    const args = call.arguments ?? {};
    if (args !== null && typeof args !== 'object') fail(`toolCalls[${index}].arguments must be an object`);
    return { id: call.id ?? `${call.name}-${index}`, name: call.name, arguments: args ?? {} };
  });

  const usage = result.usage ?? {};
  const promptTokens = Number(usage.promptTokens) || 0;
  const completionTokens = Number(usage.completionTokens) || 0;
  const totalTokens = Number(usage.totalTokens) || promptTokens + completionTokens;

  return {
    text,
    toolCalls,
    usage: { promptTokens, completionTokens, totalTokens },
    raw: result.raw,
  };
}

/**
 * A tiny in-process provider registry. Later calls (and the API server) look
 * providers up by id here rather than constructing them.
 */
export function createProviderRegistry({ providers = [], defaultProviderId } = {}) {
  const map = new Map();
  for (const provider of providers) {
    const checked = assertProvider(provider);
    map.set(checked.id(), checked);
  }

  return {
    ids: () => [...map.keys()],
    has: (id) => map.has(id),
    get(id) {
      const provider = map.get(id);
      if (!provider) throw new ModelError(MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE, `no provider registered as "${id}"`, { provider: id });
      return provider;
    },
    list: () => [...map.values()],
    /**
     * Is this provider actually usable right now? Providers implement
     * `isAvailable()` (`false` when the credential or base URL is missing);
     * anything without it is assumed available. The router uses this to fail
     * closed instead of routing into a guaranteed AUTH_MISSING.
     */
    isAvailable(id) {
      const provider = map.get(id);
      if (!provider) return false;
      if (typeof provider.isAvailable === 'function') return Boolean(provider.isAvailable());
      return true;
    },
    defaultProviderId: defaultProviderId ?? [...map.keys()][0] ?? null,
    describe() {
      return [...map.values()].map((provider) => ({
        id: provider.id(),
        available: this.isAvailable(provider.id()),
        ...provider.capabilities(),
      }));
    },
  };
}
