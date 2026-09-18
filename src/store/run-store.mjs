/**
 * Run store — the named JSONL collections that make a run durable.
 *
 * Real implementation. Layout under `<storageDir>` (default `data/state`):
 *
 *   runs/runs.jsonl                one record per run: start row, then finish row
 *   runs/run-events.jsonl          the full redacted event stream, all runs
 *   approvals/approvals.jsonl      approval lifecycle rows (append-only)
 *   audit/audit.jsonl              audit rows (see src/observability/audit.mjs)
 *   incidents/tickets.jsonl        tickets opened by create_incident_ticket
 *   orders/paper_orders.jsonl      paper orders submitted by submit_paper_order
 *   traces/traces.jsonl            finished trace trees, one row per run
 *   memory/memory.jsonl            agent memory records (src/memory/store.mjs)
 *
 * Read methods are tolerant: a corrupt line shows up in the returned
 * `errors[]`, and the valid rows around it are still returned.
 */

import { createJsonlStore } from './jsonl-store.mjs';
import { redact } from '../observability/redact.mjs';

/** Collection name -> relative directory/file stem. */
export const COLLECTIONS = Object.freeze({
  runs: 'runs/runs',
  events: 'runs/run-events',
  approvals: 'approvals/approvals',
  audit: 'audit/audit',
  incidents: 'incidents/tickets',
  orders: 'orders/paper_orders',
  traces: 'traces/traces',
  memory: 'memory/memory',
});

/**
 * @param {object}   options
 * @param {string}   options.storageDir
 * @param {Function} [options.now]
 * @param {Function} [options.redactFn]
 */
export function createRunStore({ storageDir, now = () => Date.now(), redactFn = redact } = {}) {
  if (!storageDir) throw new TypeError('createRunStore: `storageDir` is required');

  const stores = {};
  const paths = {};
  for (const [key, relative] of Object.entries(COLLECTIONS)) {
    const parts = relative.split('/');
    const file = parts.pop();
    stores[key] = createJsonlStore({ dir: `${storageDir}/${parts.join('/')}`, name: file });
    paths[key] = stores[key].path;
  }

  function append(key, record) {
    if (!stores[key]) throw new Error(`unknown collection "${key}"`);
    return stores[key].append(redactFn(record));
  }

  return {
    storageDir,
    paths,
    stores,
    get(key) {
      if (!stores[key]) throw new Error(`unknown collection "${key}"`);
      return stores[key];
    },
    /**
     * A read/write view of one collection whose writes are redacted. Use this
     * (rather than `get`) for anything an actor other than the runtime writes
     * into — approvals are created from model-proposed payloads, so their
     * payloads must be scrubbed on the way to disk.
     */
    redacting(key) {
      if (!stores[key]) throw new Error(`unknown collection "${key}"`);
      const store = stores[key];
      return {
        name: store.name,
        path: store.path,
        append: (record) => append(key, record),
        readAll: () => store.readAll(),
        readRecords: () => store.readRecords(),
        listById: (id, field) => store.listById(id, field),
        latestById: (id, field) => store.latestById(id, field),
        reduceLatest: (field) => store.reduceLatest(field),
        count: () => store.count(),
      };
    },
    append,

    // --- runs ---------------------------------------------------------------
    startRun(record) {
      return append('runs', { ...record, phase: 'started' });
    },
    finishRun(record) {
      return append('runs', { ...record, phase: 'finished' });
    },
    /** Latest row wins; a finished run therefore reports its finish summary. */
    getRun(runId) {
      return stores.runs.latestById(runId, 'runId');
    },
    listRuns({ limit } = {}) {
      const records = stores.runs.readRecords();
      const latest = new Map();
      for (const record of records) latest.set(record.runId, record);
      const runs = [...latest.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      return typeof limit === 'number' ? runs.slice(0, limit) : runs;
    },
    runEvents(runId) {
      return stores.events.listById(runId, 'runId');
    },
    appendEvent(event) {
      return append('events', event);
    },

    // --- approvals ----------------------------------------------------------
    appendApproval(record) {
      return append('approvals', record);
    },
    getApproval(approvalId) {
      return stores.approvals.latestById(approvalId, 'approvalId');
    },
    /** Latest state per approvalId, newest first. */
    listApprovals({ status, limit } = {}) {
      const latest = stores.approvals.reduceLatest('approvalId');
      let list = [...latest.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      if (status) list = list.filter((record) => record.status === status);
      return typeof limit === 'number' ? list.slice(0, limit) : list;
    },
    approvalHistory(approvalId) {
      return stores.approvals.listById(approvalId, 'approvalId');
    },

    // --- audit --------------------------------------------------------------
    appendAudit(record) {
      return append('audit', record);
    },
    readAudit() {
      return stores.audit.readAll();
    },

    // --- incidents ----------------------------------------------------------
    appendIncident(record) {
      return append('incidents', record);
    },
    getIncident(ticketId) {
      return stores.incidents.latestById(ticketId, 'ticketId');
    },
    listIncidents({ limit } = {}) {
      const records = stores.incidents.readRecords();
      return typeof limit === 'number' ? records.slice(-limit) : records;
    },

    // --- paper orders -------------------------------------------------------
    appendOrder(record) {
      return append('orders', record);
    },
    listOrders({ limit } = {}) {
      const records = stores.orders.readRecords();
      return typeof limit === 'number' ? records.slice(-limit) : records;
    },

    // --- traces -------------------------------------------------------------
    appendTrace(record) {
      return append('traces', record);
    },
    getTrace(runId) {
      return stores.traces.latestById(runId, 'runId');
    },

    // --- memory -------------------------------------------------------------
    appendMemory(record) {
      return append('memory', record);
    },
    readMemory() {
      return stores.memory.readAll();
    },

    /**
     * Tolerant read used by `verify:runtime` and the tests.
     *
     * Tolerant of BOTH failure modes: a corrupt line (reported per line in
     * `errors[]`), and a collection that cannot be read at all — a mangled path,
     * a permission problem. An unreadable collection reports `error` instead of
     * throwing, because a health check that explodes on the condition it exists
     * to report is not a health check.
     */
    health() {
      const report = {};
      for (const [key, store] of Object.entries(stores)) {
        try {
          const { records, errors, lineCount } = store.readAll();
          report[key] = { path: store.path, records: records.length, corruptLines: errors.length, errors, lineCount, readable: true, error: null };
        } catch (err) {
          report[key] = {
            path: store.path,
            records: 0,
            corruptLines: 0,
            errors: [],
            lineCount: 0,
            readable: false,
            error: { code: err?.code ?? 'STORE_READ_FAILED', message: err?.message ?? String(err) },
          };
        }
      }
      return report;
    },
  };
}
