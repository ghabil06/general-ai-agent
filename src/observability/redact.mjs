/**
 * Secret redaction for every observable payload.
 *
 * Real implementation, and the ONLY module in the runtime allowed to decide
 * what a secret looks like. `src/observability/events.mjs`,
 * `src/observability/audit.mjs` and `src/store/run-store.mjs` all route their
 * payloads through `redact()` before writing.
 *
 * Two layers, in this order of confidence:
 *
 * 1. **Key-based (the guarantee).** Any object key whose words include one of
 *    `apiKey`, `authorization`, `token`, `password`, `secret`, `cookie`
 *    (case/style-insensitive: `api_key`, `X-Api-Key`, `accessToken`) has its
 *    value replaced wholesale. Word splitting means `totalTokens` and
 *    `maxTokens` are NOT redacted — token *usage* is telemetry, not a secret —
 *    while `accessToken` is.
 *
 *    Two deliberate, documented consequences of the word rule:
 *      - **Plural `tokens` is never a secret.** In this codebase `totalTokens`,
 *        `maxTokens` and `promptTokens` are always usage counters, so the plural
 *        form is exempt (see PLURAL_EXEMPT). Singular `token` is not:
 *        `sessionToken`, `accessToken` and bare `token` are redacted.
 *      - **Anything else containing a secret word IS redacted**, even when the
 *        value looks harmless: `apiKeyPresent`, `tokenCount` and
 *        `cookieHeader` all lose their values. Over-redacting a boolean costs
 *        nothing; under-redacting a key costs everything, and the runtime does
 *        not depend on those flags being observable.
 * 2. **Value-based (best effort, documented as heuristic).** Strings that look
 *    like well-known credential formats (`sk-...`, `Bearer ...`, `xoxb-...`,
 *    `ghp_...`, `AKIA...`, PEM private keys) are replaced even when the key
 *    name is innocent. This catches `{"note": "key is sk-abc123"}`, but it is
 *    a pattern match, not a proof.
 */

/** Canonical placeholder written in place of a redacted value. */
export const REDACTED = '[REDACTED]';

/** Key words that force a value to be redacted. */
export const SECRET_KEY_WORDS = Object.freeze([
  'apikey',
  'authorization',
  'token',
  'password',
  'passwd',
  'secret',
  'cookie',
  // documented extensions in the same family
  'credential',
  'privatekey',
  'sessiontoken',
]);

/** Recognisable credential shapes. Heuristic — see module docstring. */
export const SECRET_VALUE_PATTERNS = Object.freeze([
  /^sk-[A-Za-z0-9_-]{8,}$/,
  /^sk-ant-[A-Za-z0-9_-]{8,}$/,
  /^Bearer\s+\S+$/i,
  /^Basic\s+[A-Za-z0-9+/=]{8,}$/i,
  /^xox[baprs]-[A-Za-z0-9-]{6,}$/,
  /^gh[pousr]_[A-Za-z0-9]{8,}$/,
  /^AKIA[0-9A-Z]{12,}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT-ish
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

/**
 * Split a key into lowercase words, handling camelCase, snake_case,
 * kebab-case, dotted and spaced keys. `X-Api-Key` -> ['x','api','key'].
 */
function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} key
 * @returns {boolean} true when the key names a secret and its value must go.
 */
/**
 * Plural forms that must NOT be singularised: `tokens` is usage telemetry, and
 * over-redacting `totalTokens` would blind the cost accounting that makes the
 * budgets auditable.
 */
const PLURAL_EXEMPT = Object.freeze(['tokens']);

/**
 * Compound forms that only match when their words are adjacent:
 * `api_key` / `X-Api-Key` -> `apikey`, `client_secret` -> `clientsecret`,
 * `private_key` -> `privatekey`.
 */
const COMPOUND_SECRET_WORDS = Object.freeze(['apikey', 'clientsecret', 'privatekey', 'accesstoken', 'refreshtoken']);

export function isSecretKey(key) {
  const words = keyWords(key);

  for (const word of words) {
    const singular =
      word.endsWith('s') && word.length > 3 && !word.endsWith('ss') && !PLURAL_EXEMPT.includes(word)
        ? word.slice(0, -1)
        : word;
    if (SECRET_KEY_WORDS.includes(word) || SECRET_KEY_WORDS.includes(singular)) return true;
  }

  for (let i = 0; i < words.length - 1; i += 1) {
    if (COMPOUND_SECRET_WORDS.includes(`${words[i]}${words[i + 1]}`)) return true;
  }

  return false;
}

/** @returns {boolean} true when a *string value* looks like a credential. */
export function isSecretValue(value) {
  if (typeof value !== 'string' || value.length < 8) return false;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

/**
 * Deep-redact any value. Returns a new structure; never mutates the input.
 * Circular references are replaced with `'[Circular]'` rather than throwing,
 * because a crash inside an observability path must not take a run down.
 */
export function redact(value) {
  const seen = new WeakSet();

  const walk = (node, keyHint) => {
    if (keyHint !== undefined && isSecretKey(keyHint)) return REDACTED;

    if (typeof node === 'string') return isSecretValue(node) ? REDACTED : node;
    if (node === null || typeof node !== 'object') return node;

    if (seen.has(node)) return '[Circular]';
    seen.add(node);

    if (Array.isArray(node)) return node.map((item) => walk(item, undefined));

    if (node instanceof Error) {
      return { name: node.name, message: node.message, code: node.code ?? undefined };
    }
    if (node instanceof Date) return node.toISOString();
    if (node instanceof Map) {
      return Object.fromEntries([...node.entries()].map(([k, v]) => [String(k), walk(v, String(k))]));
    }
    if (node instanceof Set) return [...node.values()].map((item) => walk(item, undefined));

    const out = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = walk(child, key);
    }
    return out;
  };

  return walk(value, undefined);
}

/**
 * Redact only the well-known secret keys of a shallow record — used where a
 * deep clone would be wasteful (per-event envelopes).
 */
export function redactShallow(record) {
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    out[key] = isSecretKey(key) ? REDACTED : redact(value);
  }
  return out;
}
