/**
 * Agent memory, in the five kinds the target architecture names.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `src/memory/store.mjs` (call 1) is the storage primitive: append-only,
 * scope-keyed, latest-wins. This module is the *interface* on top of it — five
 * clearly separated kinds, each with `write`, `recall` and `list`, each
 * emitting `memory.written` / `memory.retrieved` through the caller's event bus.
 *
 *   kind           what it holds                                   scope default
 *   -------------  ---------------------------------------------  -------------
 *   working        the scratchpad for the run in flight             run
 *   conversation   what was said, in order                          session
 *   episodic       what happened ("run X escalated invoice 109")    agent
 *   semantic       durable facts and definitions                    agent
 *   user           the human's preferences and standing context     user
 *
 * ── WHAT THE MATCHER IS, EXACTLY ────────────────────────────────────────────
 * There is **no vector search, no embeddings and no LLM in this path**. The
 * retrieval model is:
 *
 *   1. **exact** — a record matches a query key exactly (highest rank);
 *   2. **latest-wins** — for one (kind, scope, scopeId, key) the newest record
 *      is the one that stands, because the history is the audit trail, not the
 *      state;
 *   3. **keyword overlap** — otherwise, the query text is tokenised and scored
 *      by the fraction of its terms that appear in a record's key, tags or
 *      serialised value. A record with zero overlap does not match.
 *
 * Every returned record carries `why` naming which of those matched it and with
 * what score, so a caller (and a trace) can see the reason rather than trusting
 * a ranked list. `RETRIEVAL_MODEL` below is the machine-readable statement of
 * that, and it is reported in every recall result.
 *
 * ── FAILURE IS STRUCTURED, NEVER THROWN ─────────────────────────────────────
 * A recall that cannot read its store returns `{ ok: false, error: {...} }`
 * with an empty record list. Corrupt lines are reported per line (`corruptLines`)
 * and the parseable records around them are still returned. Nothing in this
 * module throws for a storage problem: a run must be able to record "memory was
 * unavailable" and carry on.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { newId } from '../util/ids.mjs';
import { canonicalStringify } from '../util/canonical.mjs';
import { MEMORY_SCOPES } from './store.mjs';

/** The five kinds. Stable strings — they are persisted in every record. */
export const MEMORY_KIND = Object.freeze({
  WORKING: 'working',
  CONVERSATION: 'conversation',
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
  USER: 'user',
});

export const MEMORY_KINDS = Object.freeze(Object.values(MEMORY_KIND));

/**
 * Per-kind behaviour. `scopeDefault` is which scope id a write anchors to;
 * `retention` is the recall ceiling this kind may return in one call (a
 * guard against an unbounded scratchpad, not a deletion policy — nothing is
 * ever deleted, because the log is append-only).
 */
export const KIND_SPEC = Object.freeze({
  [MEMORY_KIND.WORKING]: Object.freeze({
    kind: MEMORY_KIND.WORKING,
    scopeDefault: MEMORY_SCOPES.RUN,
    retention: 50,
    description: 'The run-in-flight scratchpad: intermediate values, current hypotheses, partial results.',
  }),
  [MEMORY_KIND.CONVERSATION]: Object.freeze({
    kind: MEMORY_KIND.CONVERSATION,
    scopeDefault: MEMORY_SCOPES.SESSION,
    retention: 100,
    description: 'What was said, in order: user turns and agent turns for a session.',
  }),
  [MEMORY_KIND.EPISODIC]: Object.freeze({
    kind: MEMORY_KIND.EPISODIC,
    scopeDefault: MEMORY_SCOPES.AGENT,
    retention: 200,
    description: 'What happened: completed dispositions, escalations, refusals, with their run ids.',
  }),
  [MEMORY_KIND.SEMANTIC]: Object.freeze({
    kind: MEMORY_KIND.SEMANTIC,
    scopeDefault: MEMORY_SCOPES.AGENT,
    retention: 200,
    description: 'Durable facts and definitions: thresholds, vendor quirks, pattern names.',
  }),
  [MEMORY_KIND.USER]: Object.freeze({
    kind: MEMORY_KIND.USER,
    scopeDefault: 'user',
    retention: 50,
    description: "The human's standing context: preferences, delegated authority, working hours.",
  }),
});

/** The matcher, named. Reported in every recall result so nobody assumes more. */
export const RETRIEVAL_MODEL = Object.freeze({
  name: 'exact-latest-wins-keyword-overlap',
  exact: true,
  latestWins: true,
  keywordOverlap: true,
  vectorSearch: false,
  embeddings: false,
  llm: false,
  note:
    'Retrieval is exact (scope/key), latest-wins (newest record per key) and keyword overlap (token intersection ' +
    'over key/tags/value). There is no vector search and no semantic similarity: this repository has no embedding ' +
    'model and takes no dependency that would provide one.',
});

export const MATCH_BY = Object.freeze({
  EXACT_KEY: 'exact_key',
  KEYWORD_OVERLAP: 'keyword_overlap',
  TAG: 'tag_match',
  SCOPE: 'scope_latest',
});

export const MEMORY_ERROR_CODES = Object.freeze({
  UNKNOWN_KIND: 'MEMORY_UNKNOWN_KIND',
  INVALID_RECORD: 'MEMORY_INVALID_RECORD',
  STORE_READ_FAILED: 'MEMORY_STORE_READ_FAILED',
  STORE_WRITE_FAILED: 'MEMORY_STORE_WRITE_FAILED',
  NO_STORE: 'MEMORY_NO_STORE',
});

export class MemoryError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`);
    this.name = 'MemoryError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on',
  'or', 'that', 'the', 'this', 'to', 'was', 'were', 'what', 'when', 'which', 'who', 'will', 'with',
]);

/** Deterministic tokenisation: lowercase, split on non-alphanumerics, stop-words out. */
export function tokenize(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9$._/-]+/)
    .map((token) => token.replace(/^[._/-]+|[._/-]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function textOf(record) {
  const parts = [record.key ?? ''];
  if (Array.isArray(record.tags)) parts.push(record.tags.join(' '));
  try {
    parts.push(typeof record.value === 'string' ? record.value : canonicalStringify(record.value));
  } catch {
    parts.push(String(record.value));
  }
  return parts.join(' ');
}

/**
 * @param {object}   options
 * @param {object}   options.store      JSONL store; usually `runStore.redacting('memory')`
 * @param {Function} [options.now]
 * @param {Function} [options.emit]     `(eventType, payload) => void` — the run's event bus
 * @param {number}   [options.defaultLimit]
 */
export function createKindedMemory({ store, now = () => Date.now(), emit = null, defaultLimit = 20 } = {}) {
  if (!store || typeof store.append !== 'function') {
    throw new MemoryError(MEMORY_ERROR_CODES.NO_STORE, 'createKindedMemory: a store with append(record) is required');
  }

  const writeCounts = Object.create(null);
  const recallCounts = Object.create(null);

  function requireKind(kind) {
    if (!MEMORY_KINDS.includes(kind)) {
      throw new MemoryError(
        MEMORY_ERROR_CODES.UNKNOWN_KIND,
        `unknown memory kind ${JSON.stringify(kind)} (known: ${MEMORY_KINDS.join(', ')})`,
        { kind },
      );
    }
    return kind;
  }

  /** Read every record, tolerating corruption and reporting an unreadable store. */
  function readAll() {
    try {
      const outcome = store.readAll();
      return {
        ok: true,
        records: outcome.records ?? [],
        corruptLines: outcome.errors?.length ?? 0,
        errors: outcome.errors ?? [],
        absent: (outcome.lineCount ?? outcome.records?.length ?? 0) === 0,
        path: outcome.path ?? store.path ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        records: [],
        corruptLines: 0,
        errors: [],
        absent: false,
        path: store.path ?? null,
        error: {
          code: MEMORY_ERROR_CODES.STORE_READ_FAILED,
          message: `memory store could not be read: ${err?.message ?? String(err)}`,
          name: err?.name ?? 'Error',
          cause: err?.code ?? null,
        },
      };
    }
  }

  /**
   * Append a record of one kind.
   *
   * @param {object} record
   * @param {string} record.kind
   * @param {string} record.key
   * @param {unknown} record.value
   */
  function write({ kind, key, value = null, tags = [], scope = null, scopeId = null, runId = null, agentId = null, sessionId = null, label = null, source = 'runtime' } = {}, { emit: writeEmit = emit } = {}) {
    requireKind(kind);
    if (typeof key !== 'string' || !key.trim()) {
      throw new MemoryError(MEMORY_ERROR_CODES.INVALID_RECORD, 'write: `key` must be a non-empty string', { kind });
    }
    const spec = KIND_SPEC[kind];
    const at = now();
    const record = {
      memoryId: newId('mem'),
      kind,
      scope: scope ?? spec.scopeDefault,
      scopeId,
      key,
      value,
      tags: Array.isArray(tags) ? [...tags] : [],
      label,
      source,
      agentId,
      runId,
      sessionId,
      at,
      iso: new Date(at).toISOString(),
    };

    try {
      store.append(record);
    } catch (err) {
      const failure = {
        ok: false,
        error: {
          code: MEMORY_ERROR_CODES.STORE_WRITE_FAILED,
          message: `memory record could not be written: ${err?.message ?? String(err)}`,
          name: err?.name ?? 'Error',
        },
        record,
      };
      if (typeof writeEmit === 'function') {
        writeEmit('memory.written', { kind, key, memoryId: record.memoryId, ok: false, error: failure.error });
      }
      return failure;
    }

    writeCounts[kind] = (writeCounts[kind] ?? 0) + 1;
    if (typeof writeEmit === 'function') {
      writeEmit('memory.written', {
        kind,
        key,
        memoryId: record.memoryId,
        scope: record.scope,
        scopeId: record.scopeId,
        tags: record.tags,
        ok: true,
      });
    }
    return { ok: true, record, error: null };
  }

  /**
   * Retrieve records, with the reason each one matched.
   *
   * @param {object}   query
   * @param {string}   [query.text]    free text for keyword overlap
   * @param {string}   [query.kind]    restrict to one kind (also the `options.kind` form)
   * @param {string[]} [query.keys]    exact keys
   * @param {string[]} [query.tags]    every tag must be present
   * @param {string}   [query.scope]
   * @param {string}   [query.scopeId]
   * @param {number}   [options.limit]
   * @param {string}   [options.kind]  kind filter (explicit second position, as documented)
   * @returns {{ok: boolean, records: object[], count: number, kind: string|null, matcher: object,
   *            corruptLines: number, error: object|null, absent: boolean}}
   */
  function recall(query = {}, options = {}) {
    const kind = options.kind ?? query.kind ?? null;
    const limit = options.limit ?? query.limit ?? KIND_SPEC[kind]?.retention ?? defaultLimit;
    const { text = null, keys = null, tags = null, scope = null, scopeId = null } = query;

    if (kind !== null) requireKind(kind);

    const read = readAll();
    const base = {
      kind,
      query: { text, keys, tags, scope, scopeId },
      matcher: RETRIEVAL_MODEL,
      corruptLines: read.corruptLines,
      absent: read.absent,
      path: read.path,
    };

    if (!read.ok) {
      recallCounts.failed = (recallCounts.failed ?? 0) + 1;
      if (typeof emit === 'function') {
        emit('memory.retrieved', { ...base, count: 0, ok: false, error: read.error });
      }
      return { ok: false, records: [], count: 0, error: read.error, ...base };
    }

    const wantedKeys = keys ? new Set(keys) : null;
    const wantedTags = tags ? [...tags] : null;
    const queryTerms = text ? tokenize(text) : [];

    /** (kind, scope, scopeId, key) -> {record, why} */
    const latest = new Map();

    for (const record of read.records) {
      if (kind !== null && record.kind !== kind) continue;
      if (scope && record.scope !== scope) continue;
      if (scopeId && record.scopeId !== scopeId) continue;
      if (wantedKeys && !wantedKeys.has(record.key)) continue;
      if (wantedTags && !wantedTags.every((tag) => (record.tags ?? []).includes(tag))) continue;

      // --- why does this record match the query at all? ---------------------
      let matchedBy = null;
      let score = 0;

      if (wantedKeys && wantedKeys.has(record.key)) {
        matchedBy = MATCH_BY.EXACT_KEY;
        score = 1;
      } else if (wantedTags && wantedTags.length) {
        matchedBy = MATCH_BY.TAG;
        score = 1;
      } else if (queryTerms.length) {
        const haystack = new Set(tokenize(textOf(record)));
        const hits = queryTerms.filter((term) => haystack.has(term));
        if (!hits.length) continue; // keyword overlap is the filter: zero overlap is not a match
        matchedBy = MATCH_BY.KEYWORD_OVERLAP;
        score = hits.length / queryTerms.length;
      } else {
        matchedBy = MATCH_BY.SCOPE;
        score = 0;
      }

      const composite = `${record.kind}:${record.scope ?? ''}:${record.scopeId ?? ''}:${record.key}`;
      const why = { matchedBy, score, terms: queryTerms, at: record.at ?? 0 };
      const previous = latest.get(composite);
      // Latest-wins: the newest record per key stands; the older one is history.
      if (!previous || (record.at ?? 0) >= (previous.record.at ?? 0)) latest.set(composite, { record, why });
    }

    const ranked = [...latest.values()].sort((a, b) => {
      // Rank: exact/tag matches, then keyword score, then recency, then id — a
      // total, stable order, so the same query always returns the same list.
      const rank = (entry) => (entry.why.matchedBy === MATCH_BY.EXACT_KEY ? 3 : entry.why.matchedBy === MATCH_BY.TAG ? 2 : entry.why.matchedBy === MATCH_BY.KEYWORD_OVERLAP ? 1 : 0);
      return (
        rank(b) - rank(a) ||
        b.why.score - a.why.score ||
        (b.record.at ?? 0) - (a.record.at ?? 0) ||
        String(a.record.memoryId).localeCompare(String(b.record.memoryId))
      );
    });

    const results = ranked.slice(0, limit).map((entry) => ({
      ...entry.record,
      why: {
        matchedBy: entry.why.matchedBy,
        score: entry.why.score,
        terms: entry.why.terms,
        explanation:
          entry.why.matchedBy === MATCH_BY.EXACT_KEY
            ? `key "${entry.record.key}" was requested exactly`
            : entry.why.matchedBy === MATCH_BY.TAG
              ? `tags [${wantedTags.join(', ')}] were requested and all are present`
              : entry.why.matchedBy === MATCH_BY.KEYWORD_OVERLAP
                ? `${Math.round(entry.why.score * 100)}% of the query terms appear in this record (keyword overlap)`
                : 'no query filter: this is the latest record for its key',
      },
    }));

    recallCounts[kind ?? 'any'] = (recallCounts[kind ?? 'any'] ?? 0) + 1;
    if (typeof emit === 'function') {
      emit('memory.retrieved', {
        ...base,
        count: results.length,
        candidates: read.records.length,
        ok: true,
        matchedBy: results.map((record) => ({ memoryId: record.memoryId, matchedBy: record.why.matchedBy, score: record.why.score })),
      });
    }

    return { ok: true, records: results, count: results.length, error: null, ...base };
  }

  /** Latest record per key, one kind at a time, no query — for inspection. */
  function list({ kind = null, limit = null } = {}) {
    if (kind !== null) requireKind(kind);
    const read = readAll();
    if (!read.ok) return { ok: false, records: [], count: 0, error: read.error, corruptLines: read.corruptLines };
    const latest = new Map();
    for (const record of read.records) {
      if (kind !== null && record.kind !== kind) continue;
      const composite = `${record.kind}:${record.scope ?? ''}:${record.scopeId ?? ''}:${record.key}`;
      const previous = latest.get(composite);
      if (!previous || (record.at ?? 0) >= (previous.at ?? 0)) latest.set(composite, record);
    }
    let records = [...latest.values()].sort(
      (a, b) => (b.at ?? 0) - (a.at ?? 0) || String(a.memoryId).localeCompare(String(b.memoryId)),
    );
    if (typeof limit === 'number') records = records.slice(0, limit);
    return { ok: true, records, count: records.length, error: null, corruptLines: read.corruptLines };
  }

  /** The explicit, separately-named interface for one kind. */
  function forKind(kind) {
    requireKind(kind);
    return Object.freeze({
      kind,
      spec: KIND_SPEC[kind],
      write: (record = {}, options = {}) => write({ ...record, kind }, options),
      recall: (query = {}, options = {}) => recall({ ...query, kind }, { ...options, kind }),
      list: (options = {}) => list({ ...options, kind }),
    });
  }

  return {
    kinds: MEMORY_KINDS,
    spec: KIND_SPEC,
    retrievalModel: RETRIEVAL_MODEL,
    write,
    recall,
    list,
    forKind,
    working: () => forKind(MEMORY_KIND.WORKING),
    conversation: () => forKind(MEMORY_KIND.CONVERSATION),
    episodic: () => forKind(MEMORY_KIND.EPISODIC),
    semantic: () => forKind(MEMORY_KIND.SEMANTIC),
    user: () => forKind(MEMORY_KIND.USER),
    path: store.path ?? null,
    stats() {
      const read = readAll();
      const byKind = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0]));
      for (const record of read.records) if (byKind[record.kind] !== undefined) byKind[record.kind] += 1;
      return {
        records: read.records.length,
        byKind,
        corruptLines: read.corruptLines,
        writes: { ...writeCounts },
        recalls: { ...recallCounts },
        ok: read.ok,
        error: read.ok ? null : read.error,
      };
    },
  };
}
