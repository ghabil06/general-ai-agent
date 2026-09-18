/**
 * Structured run events.
 *
 * Real implementation. Every stage of the target pipeline emits here, so a run
 * is reconstructable from its event stream alone. Events are the input to
 * `src/observability/traces.mjs` (nested tree) and
 * `src/observability/audit.mjs` (durable JSONL).
 *
 * Event envelope (stable contract — later calls and the API server depend on
 * these field names):
 *
 *   { type, runId, sessionId, agentId, seq, ts, iso, spanId, payload }
 *
 * - `seq` is a monotonic per-bus counter starting at 1.
 * - `payload` is always deeply redacted (`src/observability/redact.mjs`) before
 *   any sink sees it, including in-memory sinks. A test that inspects events
 *   therefore inspects exactly what a log file would contain.
 */

import { newId } from '../util/ids.mjs';
import { redact } from './redact.mjs';

/** Every event type the runtime emits. Later calls may add; do not rename. */
export const EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'run.started',
  RUN_FINISHED: 'run.finished',
  /**
   * Added in call 3. A run that stops at a human gate is NOT finished: it is
   * paused, in a non-terminal state, with an approval id a person can act on.
   * `run.finished` would be a lie for that case, so it gets its own type.
   */
  RUN_PAUSED: 'run.paused',
  RUN_ERROR: 'run.error',
  STATE_CHANGED: 'state.changed',
  MODEL_CALLED: 'model.called',
  MODEL_FAILED: 'model.failed',
  MEMORY_RETRIEVED: 'memory.retrieved',
  MEMORY_WRITTEN: 'memory.written',
  TOOL_PROPOSED: 'tool.proposed',
  TOOL_EXECUTED: 'tool.executed',
  TOOL_FAILED: 'tool.failed',
  POLICY_DECIDED: 'policy.decided',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',
  VALIDATION_FAILED: 'validation.failed',
  BUDGET_STOPPED: 'budget.stopped',
  TRACE_SPAN_STARTED: 'trace.span_started',
  TRACE_SPAN_ENDED: 'trace.span_ended',
});

export const EVENT_TYPE_LIST = Object.freeze(Object.values(EVENT_TYPES));

/**
 * Collect events in memory. Used by tests and by the eventual `/api/run`
 * streaming endpoint.
 */
export function createMemorySink() {
  const events = [];
  return {
    name: 'memory',
    write(event) {
      events.push(event);
    },
    events,
    byType(type) {
      return events.filter((event) => event.type === type);
    },
    last(type) {
      const filtered = type === undefined ? events : events.filter((event) => event.type === type);
      return filtered[filtered.length - 1];
    },
    clear() {
      events.length = 0;
    },
  };
}

/** Adapt a JSONL store (see src/store/jsonl-store.mjs) into an event sink. */
export function createJsonlSink(store) {
  return {
    name: 'jsonl',
    write(event) {
      store.append(event);
    },
  };
}

/** Write readable lines to stdout. Off by default (`AGENT_ECHO_EVENTS=1`). */
export function createConsoleSink({ stream = process.stdout } = {}) {
  return {
    name: 'console',
    write(event) {
      stream.write(`${event.iso} ${event.type} run=${event.runId} seq=${event.seq}\n`);
    },
  };
}

/**
 * Create the per-run event bus.
 *
 * @param {object}   options
 * @param {string}   [options.runId]
 * @param {string}   [options.sessionId]
 * @param {string}   [options.agentId]
 * @param {Array}    [options.sinks]    array of `{ write(event) }`
 * @param {Function} [options.now]      clock injection for tests
 * @param {Function} [options.redactFn] redaction function (default `redact`)
 */
export function createEventBus({
  runId = newId('run'),
  sessionId = newId('ses'),
  agentId = 'unknown',
  sinks = [],
  now = () => Date.now(),
  redactFn = redact,
} = {}) {
  let seq = 0;
  const sinkErrors = [];
  const listeners = new Set();

  function emit(type, payload = {}, meta = {}) {
    if (typeof type !== 'string' || !type) throw new TypeError('event type must be a non-empty string');

    seq += 1;
    const ts = now();
    const event = Object.freeze({
      type,
      runId,
      sessionId,
      agentId,
      seq,
      ts,
      iso: new Date(ts).toISOString(),
      spanId: meta.spanId ?? null,
      payload: redactFn(payload),
    });

    for (const sink of sinks) {
      try {
        sink.write(event);
      } catch (err) {
        // An observability sink must never take a run down.
        sinkErrors.push({ sink: sink?.name ?? 'unknown', message: err?.message ?? String(err) });
      }
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        sinkErrors.push({ sink: 'listener', message: err?.message ?? String(err) });
      }
    }

    return event;
  }

  return {
    runId,
    sessionId,
    agentId,
    emit,
    /** Subscribe for streaming consumers. Returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    on(type, listener) {
      return this.subscribe((event) => {
        if (event.type === type) listener(event);
      });
    },
    get seq() {
      return seq;
    },
    sinkErrors,
  };
}
