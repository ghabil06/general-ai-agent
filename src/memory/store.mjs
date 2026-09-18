/**
 * Agent memory.
 *
 * Real implementation, deliberately small: an append-only, scope-keyed record
 * store on top of the JSONL machinery in `src/store/jsonl-store.mjs`.
 *
 *   remember({ scope, key, value })   append a record
 *   recall({ scope, keys })           latest record per key (newest first)
 *
 * "Latest wins" is implemented by appending and reducing, never by rewriting a
 * line — so the history of what an agent believed is preserved, and a bad
 * value can be corrected by remembering a new one rather than by forgetting.
 *
 * What this is NOT: it is not a vector store, not semantic search and not an
 * embedding index. Retrieval is exact-match on (scope, key) plus optional tags.
 * Anything else would need a model and a dependency, and this repository has
 * neither. That limitation is stated here so nobody mistakes `recall()` for
 * relevance search.
 *
 * The runtime emits `memory.retrieved` whenever `recall()` is called through a
 * run handle (`src/runtime/run.mjs`), so a trace shows what an agent was given.
 */

import { newId } from '../util/ids.mjs';

export const MEMORY_SCOPES = Object.freeze({
  RUN: 'run',
  AGENT: 'agent',
  SESSION: 'session',
});

const SCOPE_ID_FIELD = Object.freeze({
  run: 'runId',
  agent: 'agentId',
  session: 'sessionId',
});

/**
 * @param {object}   options
 * @param {object}   options.store   JSONL store (usually `runStore.redacting('memory')`)
 * @param {Function} [options.now]
 * @param {number}   [options.maxRecordsPerScope] safety valve for unbounded writers
 */
export function createMemoryStore({ store, now = () => Date.now(), maxRecordsPerScope = 5_000 } = {}) {
  if (!store || typeof store.append !== 'function') {
    throw new TypeError('createMemoryStore: a store with append(record) is required');
  }

  function remember({ scope = MEMORY_SCOPES.RUN, scopeId = null, key, value, tags = [], agentId = null, runId = null } = {}) {
    if (!Object.values(MEMORY_SCOPES).includes(scope)) {
      throw new TypeError(`remember: unknown scope "${scope}"`);
    }
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('remember: `key` must be a non-empty string');
    }

    const record = {
      memoryId: newId('mem'),
      scope,
      scopeId,
      key,
      value,
      tags: Array.isArray(tags) ? tags : [],
      agentId,
      runId,
      at: now(),
      iso: new Date(now()).toISOString(),
    };
    store.append(record);
    return record;
  }

  /**
   * Latest record per key within a scope.
   *
   * @param {object}   query
   * @param {string}   [query.scope]
   * @param {string}   [query.scopeId]
   * @param {string[]} [query.keys]  filter to these keys
   * @param {string[]} [query.tags]  every tag must be present
   * @param {number}   [query.limit]
   */
  function recall({ scope = null, scopeId = null, keys = null, tags = null, limit = 50 } = {}) {
    const { records, errors } = store.readAll();
    const wantedKeys = keys ? new Set(keys) : null;
    const wantedTags = tags ? [...tags] : null;

    const latest = new Map();
    for (const record of records) {
      if (scope && record.scope !== scope) continue;
      if (scopeId && record.scopeId !== scopeId) continue;
      if (wantedKeys && !wantedKeys.has(record.key)) continue;
      if (wantedTags && !wantedTags.every((tag) => (record.tags ?? []).includes(tag))) continue;
      const composite = `${record.scope}:${record.scopeId ?? ''}:${record.key}`;
      const previous = latest.get(composite);
      if (!previous || (record.at ?? 0) >= (previous.at ?? 0)) latest.set(composite, record);
    }

    const results = [...latest.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
    return { records: results, corruptLines: errors.length };
  }

  /** Convenience: recall for a run or agent without spelling out the scope id. */
  function recallFor(scope, scopeId, options = {}) {
    return recall({ scope, scopeId, ...options });
  }

  return {
    remember,
    recall,
    recallFor,
    /** Field name a scope uses to identify itself — used by callers building records. */
    scopeIdField: (scope) => SCOPE_ID_FIELD[scope] ?? null,
    scopes: () => Object.values(MEMORY_SCOPES),
    path: store.path,
  };
}
