/**
 * Identifier and hashing helpers.
 *
 * Real implementation. Uses node:crypto only — no dependency, no network, no
 * filesystem access, and nothing evaluated at import time.
 */

import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { canonicalStringify } from './canonical.mjs';

/** A prefixed, sortable-enough unique id: `run_1a2b3c4d-...`. */
export function newId(prefix) {
  const uuid = randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/** Short, human-scannable id for spans / tickets: `spn_9f3a1c2b`. */
export function shortId(prefix, bytes = 4) {
  const hex = randomBytes(bytes).toString('hex');
  return prefix ? `${prefix}_${hex}` : hex;
}

/**
 * Deterministic ticket ids for tools that must be reproducible in tests:
 * `INC-` + first 10 hex chars of sha256(seed).
 */
export function deterministicId(prefix, seed) {
  const digest = createHash('sha256').update(String(seed)).digest('hex').slice(0, 10).toUpperCase();
  return `${prefix}-${digest}`;
}

/** sha256 hex digest of any JSON-serialisable value, canonicalised first. */
export function sha256Hex(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

/** 16-char fingerprint used for loop detection and cache keys. */
export function fingerprint(value) {
  return sha256Hex(value).slice(0, 16);
}
