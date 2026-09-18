/**
 * Canonical JSON serialisation.
 *
 * Real implementation. Object keys are emitted in sorted order and undefined
 * values are dropped, so two structurally equal values always hash to the same
 * digest regardless of key insertion order. Used by id/loop fingerprinting,
 * trace diffing and the JSONL stores.
 */

/**
 * @param {unknown} value
 * @returns {string} canonical JSON
 * @throws {TypeError} on circular references (better a loud error than a
 *   silently truncated fingerprint)
 */
export function canonicalStringify(value) {
  const seen = new WeakSet();

  const walk = (node) => {
    if (node === null) return 'null';

    const type = typeof node;
    if (type === 'number') return Number.isFinite(node) ? String(node) : 'null';
    if (type === 'boolean') return node ? 'true' : 'false';
    if (type === 'string') return JSON.stringify(node);
    if (type === 'bigint') return JSON.stringify(node.toString());
    if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;

    if (Array.isArray(node)) {
      const items = node.map((item) => {
        const encoded = walk(item);
        return encoded === undefined ? 'null' : encoded;
      });
      return `[${items.join(',')}]`;
    }

    if (type === 'object') {
      if (seen.has(node)) throw new TypeError('canonicalStringify: circular reference');
      seen.add(node);
      const keys = Object.keys(node).sort();
      const parts = [];
      for (const key of keys) {
        const encoded = walk(node[key]);
        if (encoded === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      seen.delete(node);
      return `{${parts.join(',')}}`;
    }

    return 'null';
  };

  const encoded = walk(value);
  return encoded === undefined ? 'null' : encoded;
}

/** Deep clone through the canonical form — strips prototypes and functions. */
export function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(canonicalStringify(value));
}

/**
 * Stable-sort a list of records by a key function, tie-breaking on the
 * canonical form so ordering never depends on engine sort stability.
 */
export function stableSortBy(records, keyFn) {
  return [...records].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return canonicalStringify(a).localeCompare(canonicalStringify(b));
  });
}
