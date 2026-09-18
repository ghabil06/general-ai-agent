/**
 * The five memory kinds: write, recall, list, events, and the failure paths.
 *
 * Everything here runs through the real JSONL store in a temp directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKindedMemory, MEMORY_KIND, MEMORY_KINDS, KIND_SPEC, RETRIEVAL_MODEL, MATCH_BY, tokenize } from '../../src/memory/kinds.mjs';
import { createMemoryStore } from '../../src/memory/store.mjs';
import { createJsonlStore } from '../../src/store/jsonl-store.mjs';
import { EVENT_TYPES } from '../../src/observability/events.mjs';
import { makeTestRuntime } from '../helpers/runtime.mjs';
import { fixedClock } from '../helpers/fixtures.mjs';

/** A kinded memory over a real JSONL store in a temp dir. */
function makeMemory(options = {}) {
  const storageDir = options.storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const store = createJsonlStore({ dir: storageDir, name: 'memory' });
  const events = [];
  const memory = createKindedMemory({
    store,
    now: options.now ?? fixedClock(),
    emit: options.emit ?? ((type, payload) => events.push({ type, payload })),
  });
  return { memory, store, events, storageDir };
}

const FIVE_KINDS = ['working', 'conversation', 'episodic', 'semantic', 'user'];

test('the five kinds are declared, named and documented', () => {
  assert.deepEqual(MEMORY_KINDS, FIVE_KINDS);
  assert.equal(MEMORY_KIND.WORKING, 'working');
  for (const kind of FIVE_KINDS) {
    assert.ok(KIND_SPEC[kind].description.length > 20, `${kind} has a description`);
    assert.ok(KIND_SPEC[kind].scopeDefault, `${kind} declares a default scope`);
    assert.ok(KIND_SPEC[kind].retention > 0, `${kind} declares a recall ceiling`);
  }
});

test('the retrieval model states plainly that there is no vector search', () => {
  assert.equal(RETRIEVAL_MODEL.exact, true);
  assert.equal(RETRIEVAL_MODEL.latestWins, true);
  assert.equal(RETRIEVAL_MODEL.keywordOverlap, true);
  assert.equal(RETRIEVAL_MODEL.vectorSearch, false);
  assert.equal(RETRIEVAL_MODEL.embeddings, false);
  assert.equal(RETRIEVAL_MODEL.llm, false);
  assert.match(RETRIEVAL_MODEL.note, /no vector search/i);
});

test('each kind writes, recalls and lists through its own interface', () => {
  const { memory, events } = makeMemory();
  for (const kind of FIVE_KINDS) {
    const handle = memory.forKind(kind);
    assert.equal(handle.kind, kind);
    const written = handle.write({ key: `${kind}-key`, value: `fact for ${kind}`, tags: [kind] });
    assert.equal(written.ok, true);
    assert.equal(written.record.kind, kind);
    assert.equal(written.record.scope, KIND_SPEC[kind].scopeDefault, `${kind} uses its default scope`);

    const recalled = handle.recall({ text: `fact for ${kind}` });
    assert.equal(recalled.ok, true);
    assert.equal(recalled.count, 1, `${kind} recalls its own record`);
    assert.equal(recalled.records[0].key, `${kind}-key`);
    assert.equal(recalled.records[0].why.matchedBy, MATCH_BY.KEYWORD_OVERLAP);

    const listed = handle.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.count, 1);
  }

  // One write event per kind, and one retrieval event per recall (list() is a
  // read too, but it is the inspection read and does not claim a retrieval).
  const written = events.filter((event) => event.type === EVENT_TYPES.MEMORY_WRITTEN);
  const retrieved = events.filter((event) => event.type === EVENT_TYPES.MEMORY_RETRIEVED);
  assert.equal(written.length, FIVE_KINDS.length);
  assert.equal(retrieved.length, FIVE_KINDS.length);
  assert.ok(written.every((event) => FIVE_KINDS.includes(event.payload.kind)));
  assert.ok(retrieved.every((event) => event.payload.count >= 1 && event.payload.matcher.vectorSearch === false));
});

test('kind isolation: a recall for one kind never returns another kind', () => {
  const { memory } = makeMemory();
  memory.write({ kind: 'semantic', key: 'shared', value: 'the semantic one' });
  memory.write({ kind: 'episodic', key: 'shared', value: 'the episodic one' });

  const semantic = memory.recall({ keys: ['shared'], kind: 'semantic' });
  assert.equal(semantic.count, 1);
  assert.equal(semantic.records[0].kind, 'semantic');

  const episodic = memory.recall({}, { kind: 'episodic' });
  assert.equal(episodic.count, 1);
  assert.equal(episodic.records[0].value, 'the episodic one');

  const all = memory.recall({ keys: ['shared'] });
  assert.equal(all.count, 2, 'without a kind filter both records come back');
});

test('latest-wins: the newest record per key is what stands, and the history survives', () => {
  let tick = 1_700_000_000_000;
  const { memory, store } = makeMemory({ now: () => tick });
  memory.write({ kind: 'semantic', key: 'ceiling', value: 400 });
  tick += 1_000;
  memory.write({ kind: 'semantic', key: 'ceiling', value: 500 });

  const recalled = memory.recall({ keys: ['ceiling'], kind: 'semantic' });
  assert.equal(recalled.count, 1, 'one key, one standing value');
  assert.equal(recalled.records[0].value, 500, 'the newest value wins');

  const raw = store.readAll();
  assert.equal(raw.records.length, 2, 'the earlier value is still on disk as history');
});

test('every recalled record explains why it matched', () => {
  const { memory } = makeMemory();
  memory.write({ kind: 'episodic', key: 'invoice-109-escalated', value: 'invoice 109 was escalated to a human', tags: ['invoice', 'escalation'] });
  memory.write({ kind: 'episodic', key: 'invoice-110-approved', value: 'invoice 110 was approved autonomously', tags: ['invoice'] });

  const byKey = memory.recall({ keys: ['invoice-109-escalated'], kind: 'episodic' });
  assert.equal(byKey.records[0].why.matchedBy, MATCH_BY.EXACT_KEY);
  assert.equal(byKey.records[0].why.score, 1);
  assert.match(byKey.records[0].why.explanation, /requested exactly/);

  const byText = memory.recall({ text: 'which was escalated', kind: 'episodic' });
  assert.equal(byText.count, 1, 'only the record containing the query term comes back');
  assert.equal(byText.records[0].key, 'invoice-109-escalated');
  assert.equal(byText.records[0].why.matchedBy, MATCH_BY.KEYWORD_OVERLAP);
  assert.ok(byText.records[0].why.score > 0 && byText.records[0].why.score <= 1);
  assert.match(byText.records[0].why.explanation, /keyword overlap/);

  // Keyword overlap is a FILTER on any overlap, not a similarity threshold: a
  // shared word is enough, which is why the report says "keyword overlap".
  const sharedWord = memory.recall({ text: 'invoice', kind: 'episodic' });
  assert.equal(sharedWord.count, 2, 'both records mention an invoice');

  const byTag = memory.recall({ tags: ['escalation'], kind: 'episodic' });
  assert.equal(byTag.count, 1);
  assert.equal(byTag.records[0].why.matchedBy, MATCH_BY.TAG);

  // Zero keyword overlap is not a match.
  const unrelated = memory.recall({ text: 'completely unrelated zebra', kind: 'episodic' });
  assert.equal(unrelated.count, 0);
  assert.equal(unrelated.ok, true, 'a no-match recall is still a successful recall');
});

test('ranking is deterministic: higher overlap ranks first, and the order never varies', () => {
  const { memory } = makeMemory();
  memory.write({ kind: 'semantic', key: 'threshold-rules', value: 'escalation threshold rules govern the invoice' });
  memory.write({ kind: 'semantic', key: 'loose-note', value: 'escalation happens sometimes' });

  const first = memory.recall({ text: 'escalation threshold rules', kind: 'semantic' });
  const second = memory.recall({ text: 'escalation threshold rules', kind: 'semantic' });
  assert.deepEqual(
    first.records.map((record) => record.key),
    second.records.map((record) => record.key),
    'the same query returns the same order',
  );
  assert.equal(first.records[0].key, 'threshold-rules', 'the record with more of the query terms ranks first');
  assert.ok(first.records[0].why.score > first.records[1].why.score);
});

test('tokenisation is deterministic and drops stop words', () => {
  assert.deepEqual(tokenize('The Invoice WAS approved'), ['invoice', 'approved']);
  assert.deepEqual(tokenize('rule-level 12, escalated!'), ['rule-level', '12', 'escalated']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('the write ceiling and kind validation are enforced', () => {
  const { memory } = makeMemory();
  assert.throws(() => memory.write({ kind: 'telepathy', key: 'k', value: 1 }), (error) => {
    assert.equal(error.code, 'MEMORY_UNKNOWN_KIND');
    assert.match(error.message, /known: working, conversation, episodic, semantic, user/);
    return true;
  });
  assert.throws(() => memory.write({ kind: 'working' }), (error) => {
    assert.equal(error.code, 'MEMORY_INVALID_RECORD');
    return true;
  });
  assert.throws(() => memory.recall({}, { kind: 'nope' }), (error) => {
    assert.equal(error.code, 'MEMORY_UNKNOWN_KIND');
    return true;
  });
});

test('an unreadable store returns a structured error and never throws', () => {
  const memory = createKindedMemory({
    store: {
      path: '<hostile>',
      append() {
        throw new Error('read-only filesystem');
      },
      readAll() {
        throw new Error('permission denied');
      },
    },
  });

  const recalled = memory.recall({ text: 'anything', kind: 'working' });
  assert.equal(recalled.ok, false);
  assert.equal(recalled.error.code, 'MEMORY_STORE_READ_FAILED');
  assert.match(recalled.error.message, /permission denied/);
  assert.deepEqual(recalled.records, []);
  assert.equal(recalled.count, 0);
  assert.equal(recalled.matcher.vectorSearch, false, 'the matcher is still reported');

  const written = memory.write({ kind: 'working', key: 'k', value: 1 });
  assert.equal(written.ok, false);
  assert.equal(written.error.code, 'MEMORY_STORE_WRITE_FAILED');

  const listed = memory.list({ kind: 'working' });
  assert.equal(listed.ok, false);
  assert.equal(listed.error.code, 'MEMORY_STORE_READ_FAILED');

  const stats = memory.stats();
  assert.equal(stats.ok, false);
  assert.equal(stats.records, 0);
});

test('a corrupt line is reported and the surrounding records still come back', () => {
  const { memory, store } = makeMemory();
  memory.write({ kind: 'semantic', key: 'good', value: 'a real record' });
  fs.appendFileSync(store.path, '{not json at all\n', 'utf8');
  memory.write({ kind: 'semantic', key: 'also-good', value: 'another real record' });

  const recalled = memory.recall({ kind: 'semantic' });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.corruptLines, 1);
  assert.equal(recalled.count, 2, 'both valid records survive one bad line');
  assert.equal(memory.stats().corruptLines, 1);
});

test('an absent store is not an error: it is an empty result', () => {
  const { memory } = makeMemory();
  const recalled = memory.recall({ kind: 'user' });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.count, 0);
  assert.equal(recalled.absent, true);
  assert.equal(memory.list({ kind: 'user' }).count, 0);
});

test('writes are redacted on the way to disk when the store redacts', () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-redact-'));
  const { runtime } = makeTestRuntime({ storageDir });
  const run = runtime.createRun({ agentId: 'svc_03' });

  run.memory.write({
    kind: 'episodic',
    key: 'credential-note',
    // Key-based redaction is the guarantee: `token` and `apiKey` are secret
    // words, so those values go — including a plain-looking one, which is what
    // shows the rule is the key and not the value shape.
    value: { sessionToken: 'sk-abcdef0123456789', apiKey: 'plain-looking-value', note: 'pasted by the operator' },
    scopeId: run.runId,
  });
  run.memory.write({
    kind: 'episodic',
    key: 'bare-credential',
    // Value-based redaction is a documented heuristic: an anchored pattern, so
    // it fires when the value IS the credential.
    value: 'sk-abcdef0123456789',
    scopeId: run.runId,
  });

  const raw = fs.readFileSync(runtime.runStore.paths.memory, 'utf8');
  assert.equal(/sk-abcdef0123456789/.test(raw), false, 'the credential never reaches the file');
  assert.equal(/plain-looking-value/.test(raw), false, 'a key named apiKey takes its value whatever the value looks like');
  assert.match(raw, /pasted by the operator/, 'an innocent key keeps its value: redaction is per key, not per record');
  assert.match(raw, /\[REDACTED\]/);

  // The call-1 store keeps working beside it, on the same file.
  const legacy = createMemoryStore({ store: runtime.runStore.redacting('memory') });
  const written = legacy.remember({ scope: 'run', scopeId: run.runId, key: 'legacy', value: 1 });
  assert.ok(written.memoryId);
  const legacyRecall = legacy.recall({ scope: 'run', scopeId: run.runId });
  assert.equal(legacyRecall.records.length >= 1, true, 'the call-1 store still recalls its own records');
  run.finish({ status: 'COMPLETED' });
});

test('a credential embedded in prose is NOT caught: the value patterns are anchored (documented limitation)', () => {
  // This test pins the real behaviour of src/observability/redact.mjs so a
  // change to it is visible. It is a limitation, not a feature: the module's
  // own comment gives `{"note": "key is sk-abc123"}` as an example of the
  // value heuristic catching an innocent key name, and an anchored pattern
  // cannot do that. Reported in the call-2 gap list; call-1 behaviour is
  // deliberately unchanged here.
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-redact2-'));
  const { runtime } = makeTestRuntime({ storageDir });
  const run = runtime.createRun({ agentId: 'svc_03' });
  run.memory.write({
    kind: 'episodic',
    key: 'innocent-key-name',
    value: 'the note says the key is sk-abcdef0123456789 here',
    scopeId: run.runId,
  });
  const raw = fs.readFileSync(runtime.runStore.paths.memory, 'utf8');
  assert.match(raw, /sk-abcdef0123456789/, 'an embedded credential survives: only whole-value patterns match');
  run.finish({ status: 'COMPLETED' });
});
