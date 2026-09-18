/**
 * Observability: the event bus, trace assembly, the audit writer and memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { EVENT_TYPES, createEventBus, createJsonlSink, createMemorySink } from '../../src/observability/events.mjs';
import { SPAN_STATUS, SPAN_TYPES, createTraceBuilder, traceFromEvents } from '../../src/observability/traces.mjs';
import { AUDIT_TYPES, auditRecordFromEvent, auditTypeForEvent, createAuditWriter } from '../../src/observability/audit.mjs';
import { createJsonlStore } from '../../src/store/jsonl-store.mjs';
import { createRunStore } from '../../src/store/run-store.mjs';
import { createMemoryStore, MEMORY_SCOPES } from '../../src/memory/store.mjs';
import { fixedClock, tempStorageDir } from '../helpers/fixtures.mjs';

// ── events ─────────────────────────────────────────────────────────────────

test('the event envelope is stable: type, runId, sessionId, agentId, seq, ts, iso, payload', () => {
  const clock = fixedClock(1_700_000_000_000);
  const events = createEventBus({ runId: 'run_1', sessionId: 'ses_1', agentId: 'svc_03', now: clock });

  const first = events.emit(EVENT_TYPES.RUN_STARTED, { agent: 'svc_03' });
  assert.equal(first.type, 'run.started');
  assert.equal(first.runId, 'run_1');
  assert.equal(first.sessionId, 'ses_1');
  assert.equal(first.agentId, 'svc_03');
  assert.equal(first.seq, 1);
  assert.equal(first.ts, 1_700_000_000_000);
  assert.equal(first.iso, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(first.payload, { agent: 'svc_03' });
  assert.equal(first.spanId, null);

  const second = events.emit(EVENT_TYPES.STATE_CHANGED, { from: 'IDLE', to: 'PLANNING' }, { spanId: 'spn_x' });
  assert.equal(second.seq, 2, 'seq is monotonic per bus');
  assert.equal(second.spanId, 'spn_x');
  assert.equal(events.seq, 2);
});

test('every event type named in the design exists and is stable', () => {
  const required = [
    'run.started',
    'run.finished',
    'state.changed',
    'model.called',
    'memory.retrieved',
    'tool.proposed',
    'policy.decided',
    'tool.executed',
    'approval.requested',
    'approval.resolved',
    'validation.failed',
    'run.error',
  ];
  for (const type of required) {
    assert.equal(Object.values(EVENT_TYPES).includes(type), true, `${type} must be an event type`);
  }
});

test('an empty or non-string event type is a programming error', () => {
  const events = createEventBus({});
  assert.throws(() => events.emit('', {}), TypeError);
  assert.throws(() => events.emit(undefined, {}), TypeError);
});

test('subscribers receive events, and unsubscribing works', () => {
  const events = createEventBus({});
  const seen = [];
  const unsubscribe = events.subscribe((event) => seen.push(event.type));
  events.emit('run.started', {});
  unsubscribe();
  events.emit('run.finished', {});
  assert.deepEqual(seen, ['run.started']);

  const only = [];
  events.on('run.finished', (event) => only.push(event.type));
  events.emit('run.started', {});
  events.emit('run.finished', {});
  assert.deepEqual(only, ['run.finished']);
});

test('a JSONL sink persists the stream, and the store re-reads it', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'events' });
  const events = createEventBus({ runId: 'run_1', sinks: [createJsonlSink(store)], now: fixedClock() });

  events.emit('run.started', { agentId: 'svc_03' });
  events.emit('tool.proposed', { tool: 'query_po_database', args: { poNumber: '990' } });

  const { records } = store.readAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 'run.started');
  assert.equal(records[1].payload.tool, 'query_po_database');
  assert.equal(records[1].runId, 'run_1');
});

// ── traces ─────────────────────────────────────────────────────────────────

test('the trace builder nests spans and computes durations from the clock', () => {
  const clock = fixedClock();
  const trace = createTraceBuilder({ runId: 'run_1', agentId: 'svc_03', now: clock });

  const root = trace.startSpan({ name: 'run:svc_03', type: SPAN_TYPES.RUN });
  clock.advance(10);
  const model = trace.startSpan({ name: 'model:mock', type: SPAN_TYPES.MODEL_CALL, parentId: root, input: { messages: 2 } });
  clock.advance(25);
  trace.endSpan(model, { status: SPAN_STATUS.OK, output: { text: 'hi' } });
  clock.advance(5);
  const tool = trace.recordSpan({ name: 'tool:query_po_database', type: SPAN_TYPES.TOOL_CALL, parentId: root, output: { status: 'OK' }, durationMs: 3 });
  trace.endSpan(root, { status: SPAN_STATUS.OK });

  assert.equal(trace.size, 3);
  const tree = trace.toTree();
  assert.equal(tree.name, 'run:svc_03');
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map((child) => child.type), [SPAN_TYPES.MODEL_CALL, SPAN_TYPES.TOOL_CALL]);
  const modelSpan = tree.children[0];
  assert.equal(modelSpan.durationMs, 25);
  assert.deepEqual(modelSpan.output, { text: 'hi' });
  assert.equal(modelSpan.parentId, root);
  const toolSpan = tree.children[1];
  assert.equal(toolSpan.durationMs, 3);
  assert.equal(toolSpan.status, SPAN_STATUS.OK);
  assert.equal(trace.getSpan(tool).name, 'tool:query_po_database');

  const json = trace.toJSON();
  assert.equal(json.runId, 'run_1');
  assert.equal(typeof json.builtAt, 'string');
  assert.equal(JSON.parse(JSON.stringify(json)).root.children.length, 2, 'a trace is pure data');
});

test('endSpan is idempotent and unknown spans are refused', () => {
  const trace = createTraceBuilder({ now: fixedClock() });
  const spanId = trace.startSpan({ name: 'x', type: SPAN_TYPES.STATE });
  const first = trace.endSpan(spanId, { status: SPAN_STATUS.OK });
  const second = trace.endSpan(spanId, { status: SPAN_STATUS.ERROR, output: 'should not apply' });
  assert.equal(second.endedAt, first.endedAt, 'a second end cannot re-time a span');
  assert.equal(second.status, SPAN_STATUS.OK);
  assert.throws(() => trace.endSpan('spn_nope'), /unknown spanId/);
});

test('an orphaned span is re-parented, and a trace with no root span gets one', () => {
  const trace = createTraceBuilder({ runId: 'run_x', now: fixedClock() });
  trace.recordSpan({ name: 'orphan', type: SPAN_TYPES.STATE });
  const tree = trace.toTree();
  assert.equal(tree.name, 'run', 'a synthetic root is created');
  assert.equal(tree.attributes.synthesized, true);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].name, 'orphan');
});

test('traceFromEvents rebuilds the tree from an event stream', () => {
  // The bus has no snapshot API on purpose: a trace is rebuilt from a persisted
  // event stream, which is what a memory sink (or the JSONL sink) holds.
  const sink = createMemorySink();
  const events2 = createEventBus({ runId: 'run_2', agentId: 'svc_06', sinks: [sink], now: fixedClock() });
  events2.emit(EVENT_TYPES.RUN_STARTED, {});
  events2.emit(EVENT_TYPES.MODEL_CALLED, { provider: 'mock', model: 'mock-1' });
  events2.emit(EVENT_TYPES.MEMORY_RETRIEVED, { query: { scope: 'agent' }, count: 1 });
  events2.emit(EVENT_TYPES.TOOL_PROPOSED, { tool: 'submit_paper_order', args: { ticker: 'AAPL' } });
  events2.emit(EVENT_TYPES.POLICY_DECIDED, { decision: 'DENY', rule: 'svc_06.trading_boundary' });
  events2.emit(EVENT_TYPES.TOOL_FAILED, { tool: 'submit_paper_order', error: { message: 'blocked' } });
  events2.emit(EVENT_TYPES.RUN_FINISHED, { status: 'BLOCKED' });

  const rebuilt = traceFromEvents(sink.events);
  assert.equal(rebuilt.runId, 'run_2');
  assert.equal(rebuilt.agentId, 'svc_06');
  const types = rebuilt.root.children.map((child) => child.type);
  assert.ok(types.includes(SPAN_TYPES.MODEL_CALL));
  assert.ok(types.includes(SPAN_TYPES.MEMORY_RETRIEVAL));
  assert.ok(types.includes(SPAN_TYPES.TOOL_CALL));
  assert.ok(types.includes(SPAN_TYPES.FINAL_RESPONSE));
  const toolSpan = rebuilt.root.children.find((child) => child.type === SPAN_TYPES.TOOL_CALL);
  const childTypes = toolSpan.children.map((child) => child.type);
  assert.ok(childTypes.includes(SPAN_TYPES.POLICY_CHECK), 'the policy verdict is nested under the tool call');
  assert.ok(childTypes.includes(SPAN_TYPES.TOOL_RESULT));
  const policySpan = toolSpan.children.find((child) => child.type === SPAN_TYPES.POLICY_CHECK);
  assert.equal(policySpan.status, SPAN_STATUS.BLOCKED, 'a DENY is recorded as a blocked span');
});

test('traceFromEvents tolerates an empty or partial stream', () => {
  const empty = traceFromEvents([]);
  assert.equal(empty.runId, 'unknown');
  assert.equal(empty.root.name, 'run');

  const partial = traceFromEvents([{ type: EVENT_TYPES.MODEL_CALLED, runId: 'run_p', agentId: 'svc_03', seq: 1, payload: { provider: 'mock' } }]);
  assert.equal(partial.runId, 'run_p');
  assert.equal(partial.root.children[0].type, SPAN_TYPES.MODEL_CALL);
});

// ── audit ──────────────────────────────────────────────────────────────────

test('the audit writer persists redacted JSONL rows and maps event types', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'audit' });
  const audit = createAuditWriter({ store, now: fixedClock() });

  assert.equal(auditTypeForEvent('policy.decided'), AUDIT_TYPES.POLICY_DECISION);
  assert.equal(auditTypeForEvent('tool.executed'), AUDIT_TYPES.TOOL_EXECUTION);
  assert.equal(auditTypeForEvent('state.changed'), null);

  const event = {
    type: 'policy.decided',
    runId: 'run_1',
    sessionId: 'ses_1',
    agentId: 'svc_03',
    seq: 4,
    ts: 1,
    iso: '2026-01-15T15:30:00.000Z',
    payload: { decision: 'DENY', rule: 'svc_03.invoice_boundary', authorization: 'Bearer leak' },
  };
  assert.equal(auditRecordFromEvent(event).type, AUDIT_TYPES.POLICY_DECISION);
  const row = audit.writeEvent(event);

  assert.equal(row.type, AUDIT_TYPES.POLICY_DECISION);
  assert.equal(row.payload.authorization, '[REDACTED]');
  assert.equal(row.payload.decision, 'DENY');
  assert.equal(typeof row.recordedAt, 'number');

  audit.writeDecision({ runId: 'run_1', agentId: 'svc_03', action: 'request_human_approval', reasoning: '850.00 over the ceiling' });
  const breach = audit.writeBreach({ runId: 'run_1', agentId: 'svc_03', rule: 'svc_03.invoice_boundary', reason: 'over the cap', evidence: { amount: 850 } });

  assert.equal(breach.type, AUDIT_TYPES.GUARDRAIL_BREACH);
  const { records, errors } = audit.readAll();
  assert.equal(errors.length, 0);
  assert.deepEqual(
    records.map((record) => record.type),
    ['policy.decision', 'decision', 'guardrail.breach'],
  );
  assert.equal(records[1].action, 'request_human_approval');
  assert.equal(JSON.stringify(records).includes('Bearer leak'), false);

  assert.equal(audit.writeEvent({ type: 'state.changed', payload: {} }), null, 'non-auditable events are ignored');
  assert.equal(typeof audit.path, 'string');
});

test('the default audit store lives under the storage directory', () => {
  const storageDir = tempStorageDir();
  const runStore = createRunStore({ storageDir });
  assert.equal(runStore.paths.audit.startsWith(storageDir), true);
  const audit = createAuditWriter({ store: runStore.get('audit'), now: fixedClock() });
  audit.write({ type: 'run.started', runId: 'run_1', agentId: 'svc_03' });
  assert.equal(runStore.readAudit().records.length, 1);
});

// ── memory ─────────────────────────────────────────────────────────────────

test('memory remembers and recalls latest-wins, per scope and key', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'memory' });
  const clock = fixedClock();
  const memory = createMemoryStore({ store, now: clock });

  memory.remember({ scope: MEMORY_SCOPES.AGENT, scopeId: 'svc_03', key: 'po_990_status', value: 'open' });
  clock.advance(10);
  memory.remember({ scope: MEMORY_SCOPES.AGENT, scopeId: 'svc_03', key: 'po_990_status', value: 'closed' });
  clock.advance(10);
  memory.remember({ scope: MEMORY_SCOPES.RUN, scopeId: 'run_1', key: 'invoice_101', value: { action: 'auto_approve' }, tags: ['invoice'] });

  const agent = memory.recall({ scope: MEMORY_SCOPES.AGENT, scopeId: 'svc_03' });
  assert.equal(agent.records.length, 1, 'one key, latest value wins');
  assert.equal(agent.records[0].value, 'closed');
  assert.equal(agent.corruptLines, 0);

  // both writes are still on disk: memory is append-only, not rewritten
  assert.equal(store.count(), 3);

  const byKey = memory.recall({ keys: ['po_990_status'] });
  assert.equal(byKey.records.length, 1);
  const byTag = memory.recall({ tags: ['invoice'] });
  assert.equal(byTag.records.length, 1);
  assert.equal(byTag.records[0].key, 'invoice_101');

  const runScoped = memory.recallFor(MEMORY_SCOPES.RUN, 'run_1');
  assert.equal(runScoped.records.length, 1);
  assert.deepEqual(runScoped.records[0].value, { action: 'auto_approve' });

  assert.equal(memory.recall({ scopeId: 'svc_99' }).records.length, 0);
  assert.equal(memory.scopeIdField('agent'), 'agentId');
  assert.deepEqual(memory.scopes(), ['run', 'agent', 'session']);
});

test('memory refuses nonsense and survives a corrupt line', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'memory' });
  const memory = createMemoryStore({ store, now: fixedClock() });

  assert.throws(() => memory.remember({ scope: 'nonsense', key: 'x' }), /unknown scope/);
  assert.throws(() => memory.remember({ key: '' }), /non-empty string/);

  memory.remember({ scope: MEMORY_SCOPES.AGENT, scopeId: 'svc_06', key: 'halt', value: true });
  fs.appendFileSync(store.path, 'not json\n', 'utf8');

  const recalled = memory.recall({ scope: MEMORY_SCOPES.AGENT, scopeId: 'svc_06' });
  assert.equal(recalled.records.length, 1);
  assert.equal(recalled.corruptLines, 1, 'the corrupt line is reported, not hidden');
});
