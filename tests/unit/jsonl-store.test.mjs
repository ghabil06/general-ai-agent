/**
 * JSONL store: append, tolerant reads, list-by-id, and survival across a
 * "restart" (a fresh store object reading the same file).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { JsonlStore, createJsonlStore } from '../../src/store/jsonl-store.mjs';
import { createRunStore, COLLECTIONS } from '../../src/store/run-store.mjs';
import { tempStorageDir } from '../helpers/fixtures.mjs';

test('a missing file reads as empty, not as an error', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'nothing' });
  const result = store.readAll();
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.lineCount, 0);
  assert.equal(store.exists(), false);
});

test('append creates directories, and readAll returns the records in order', () => {
  const dir = path.join(tempStorageDir(), 'nested', 'deeper');
  const store = createJsonlStore({ dir, name: 'records' });

  store.append({ id: 'a', value: 1 });
  store.append({ id: 'b', value: 2 });
  store.append({ id: 'a', value: 3 });

  assert.equal(store.exists(), true);
  const { records, errors, lineCount } = store.readAll();
  assert.equal(errors.length, 0);
  assert.equal(lineCount, 3);
  assert.deepEqual(records.map((record) => record.value), [1, 2, 3]);

  // the file is plain JSONL: one object per line
  const lines = fs.readFileSync(store.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { id: 'a', value: 1 });
});

test('listById returns every match and latestById the newest', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'lifecycle' });
  store.append({ approvalId: 'apr_1', status: 'pending' });
  store.append({ approvalId: 'apr_2', status: 'pending' });
  store.append({ approvalId: 'apr_1', status: 'approved' });

  assert.deepEqual(store.listById('apr_1', 'approvalId').map((record) => record.status), ['pending', 'approved']);
  assert.equal(store.latestById('apr_1', 'approvalId').status, 'approved');
  assert.equal(store.latestById('apr_missing', 'approvalId'), null);
  assert.equal(store.count(), 3);
  assert.equal(store.readTail(2).length, 2);
});

test('reduceLatest collapses a collection to latest-wins state', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'reduce' });
  store.append({ id: 'x', n: 1 });
  store.append({ id: 'y', n: 1 });
  store.append({ id: 'x', n: 2 });
  store.append({ noId: true });
  const reduced = store.reduceLatest('id');
  assert.equal(reduced.size, 2);
  assert.equal(reduced.get('x').n, 2);
  assert.equal(reduced.get('y').n, 1);
});

test('a corrupt line becomes a structured error and never breaks the read', () => {
  const dir = tempStorageDir();
  const store = createJsonlStore({ dir, name: 'corrupt' });
  store.append({ id: 'good-1', value: 1 });

  fs.appendFileSync(store.path, '{ this is not json\n', 'utf8');
  store.append({ id: 'good-2', value: 2 });
  fs.appendFileSync(store.path, '[1,2,3]\n', 'utf8'); // valid JSON, wrong shape
  fs.appendFileSync(store.path, '\n', 'utf8'); // blank line
  fs.appendFileSync(store.path, 'null\n', 'utf8');

  const { records, errors, lineCount } = store.readAll();
  assert.deepEqual(records.map((record) => record.id), ['good-1', 'good-2']);
  assert.equal(lineCount, 5);
  assert.equal(errors.length, 3);

  assert.equal(errors[0].line, 2);
  assert.match(errors[0].error, /invalid JSON/);
  assert.match(errors[0].raw, /this is not json/);

  assert.equal(errors[1].line, 4);
  assert.match(errors[1].error, /expected a JSON object, got array/);

  assert.equal(errors[2].line, 6);
  assert.match(errors[2].error, /got null/);

  for (const error of errors) {
    assert.equal(error.ok, false);
    assert.equal(typeof error.raw, 'string');
  }
});

test('writes survive a fresh store instance (process restart)', () => {
  const dir = tempStorageDir();
  const first = createJsonlStore({ dir, name: 'persist' });
  first.append({ id: 'run_1', status: 'finished' });

  const afterRestart = new JsonlStore({ dir, name: 'persist' });
  assert.equal(afterRestart.count(), 1);
  assert.equal(afterRestart.latestById('run_1').status, 'finished');

  // and a second instance sees the new write too
  afterRestart.append({ id: 'run_2', status: 'finished' });
  assert.equal(first.count(), 2);
});

test('append refuses values that are not objects', () => {
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'strict' });
  assert.throws(() => store.append(null), TypeError);
  assert.throws(() => store.append('a string'), TypeError);
  assert.throws(() => store.append([1, 2]), TypeError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => store.append(cyclic), /not serialisable/);
});

test('the run store lays out every collection and reports health', () => {
  const storageDir = tempStorageDir();
  const runStore = createRunStore({ storageDir, now: () => 1_700_000_000_000 });

  assert.deepEqual(Object.keys(COLLECTIONS).sort(), [
    'approvals',
    'audit',
    'events',
    'incidents',
    'memory',
    'orders',
    'runs',
    'traces',
  ]);

  runStore.startRun({ runId: 'run_1', agentId: 'svc_03', startedAt: 1 });
  runStore.finishRun({ runId: 'run_1', agentId: 'svc_03', status: 'COMPLETED', startedAt: 1, finishedAt: 2 });
  runStore.appendEvent({ runId: 'run_1', type: 'run.started', seq: 1 });
  runStore.appendIncident({ ticketId: 'INC-1', title: 'x' });
  runStore.appendOrder({ orderId: 'ord_1', ticker: 'AAPL' });
  runStore.appendTrace({ runId: 'run_1', trace: { root: null } });

  const health = runStore.health();
  assert.equal(health.runs.records, 2, 'start and finish rows are both appended');
  assert.equal(health.events.records, 1);
  assert.equal(runStore.getRun('run_1').status, 'COMPLETED', 'latest row wins');
  assert.deepEqual(runStore.listRuns().map((run) => run.runId), ['run_1']);
  assert.equal(runStore.listIncidents().length, 1);
  assert.equal(runStore.listOrders().length, 1);
  assert.equal(runStore.getTrace('run_1').trace.root, null);

  for (const [name, report] of Object.entries(health)) {
    assert.equal(report.corruptLines, 0, `${name} should have no corrupt lines`);
    assert.ok(report.path.startsWith(storageDir), `${name} should live under the storage dir`);
  }
});

test('the run store redacts on write and tolerates a corrupt line on read', () => {
  const storageDir = tempStorageDir();
  const runStore = createRunStore({ storageDir });

  runStore.appendApproval({ approvalId: 'apr_1', status: 'pending', payload: { apiKey: 'sk-leak-me', note: 'ok' } });
  runStore.append('audit', { type: 'decision', headers: { authorization: 'Bearer leak' } });

  const approval = runStore.getApproval('apr_1');
  assert.equal(approval.payload.apiKey, '[REDACTED]');
  assert.equal(approval.payload.note, 'ok');

  fs.appendFileSync(runStore.paths.audit, 'CORRUPT LINE\n', 'utf8');
  const audit = runStore.readAudit();
  assert.equal(audit.records.length, 1);
  assert.equal(audit.errors.length, 1);
  assert.equal(audit.records[0].headers.authorization, '[REDACTED]');

  assert.throws(() => runStore.get('nonexistent'), /unknown collection/);
  assert.throws(() => runStore.append('nonexistent', {}), /unknown collection/);
});
