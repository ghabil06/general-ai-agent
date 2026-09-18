/**
 * Trace assembly.
 *
 * Real implementation. A trace is the nested run tree described in the target
 * architecture: Model Call / Memory Retrieval / Tool Call / Policy Check /
 * Tool Result / Final Response, all parented under a root run span.
 *
 * Two ways in, both supported:
 *
 *   1. `createTraceBuilder()` — instrument code as it runs (`startSpan` /
 *      `endSpan`). `src/runtime/run.mjs` uses this.
 *   2. `traceFromEvents(events)` — rebuild the same tree from a run's event
 *      stream, which is what the API server will do to render a finished run.
 *
 * A trace is pure data: JSON-serialisable, no class instances, no functions.
 */

import { shortId } from '../util/ids.mjs';
import { EVENT_TYPES } from './events.mjs';

/** Span types. Stable names — they appear in persisted traces. */
export const SPAN_TYPES = Object.freeze({
  RUN: 'run',
  STATE: 'state',
  MODEL_CALL: 'model_call',
  MEMORY_RETRIEVAL: 'memory_retrieval',
  TOOL_CALL: 'tool_call',
  POLICY_CHECK: 'policy_check',
  TOOL_RESULT: 'tool_result',
  APPROVAL: 'approval',
  FINAL_RESPONSE: 'final_response',
  /** Added in call 2: goal decomposition and model-window assembly. */
  PLAN: 'plan',
  PLAN_STEP: 'plan_step',
  CONTEXT: 'context',
});

export const SPAN_STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  BLOCKED: 'blocked',
  PENDING: 'pending',
});

/**
 * @param {object}   options
 * @param {string}   [options.runId]
 * @param {string}   [options.agentId]
 * @param {Function} [options.now]
 */
export function createTraceBuilder({ runId, agentId = 'unknown', now = () => Date.now() } = {}) {
  const startedAt = now();
  /** @type {Map<string, object>} */
  const spans = new Map();

  function startSpan({ name, type = SPAN_TYPES.STATE, parentId = null, attributes = {}, input } = {}) {
    const spanId = shortId('spn');
    spans.set(spanId, {
      spanId,
      parentId,
      name: name ?? type,
      type,
      status: SPAN_STATUS.PENDING,
      startedAt: now(),
      endedAt: null,
      durationMs: null,
      attributes,
      input,
      output: undefined,
      error: null,
      children: [],
    });
    return spanId;
  }

  function endSpan(spanId, { status = SPAN_STATUS.OK, output, error, attributes } = {}) {
    const span = spans.get(spanId);
    if (!span) throw new Error(`endSpan: unknown spanId "${spanId}"`);
    if (span.endedAt !== null) return span; // idempotent; double-end must not corrupt a trace
    span.endedAt = now();
    span.durationMs = span.endedAt - span.startedAt;
    span.status = status;
    if (output !== undefined) span.output = output;
    if (error !== undefined && error !== null) {
      span.error = error instanceof Error ? { name: error.name, message: error.message } : error;
    }
    if (attributes) span.attributes = { ...span.attributes, ...attributes };
    return span;
  }

  /** Convenience for one-shot spans (rule evaluations, validations, …). */
  function recordSpan({ name, type, parentId = null, attributes, input, output, status, error, durationMs } = {}) {
    const spanId = startSpan({ name, type, parentId, attributes, input });
    endSpan(spanId, { status, output, error });
    if (typeof durationMs === 'number') {
      const span = spans.get(spanId);
      span.durationMs = durationMs;
      span.endedAt = span.startedAt + durationMs;
    }
    return spanId;
  }

  function getSpan(spanId) {
    const span = spans.get(spanId);
    return span ? { ...span } : null;
  }

  /** Assemble the nested tree. Orphans are re-parented to the root. */
  function toTree() {
    const nodes = [...spans.values()].map((span) => ({ ...span, children: [] }));
    const byId = new Map(nodes.map((node) => [node.spanId, node]));
    const rootIds = [];

    for (const node of nodes) {
      const parent = node.parentId ? byId.get(node.parentId) : null;
      if (parent) parent.children.push(node);
      else rootIds.push(node);
    }

    for (const node of nodes) {
      node.children.sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
    }

    // A single RUN span is already a proper tree root. Anything else (one
    // orphan tool span, or several roots) gets a synthetic root, so a consumer
    // can always navigate `root.children` without special cases.
    if (rootIds.length === 1 && rootIds[0].type === SPAN_TYPES.RUN) return rootIds[0];

    // No explicit root span: synthesise one so consumers always get a tree.
    return {
      spanId: 'spn_root',
      parentId: null,
      name: 'run',
      type: SPAN_TYPES.RUN,
      status: SPAN_STATUS.OK,
      startedAt,
      endedAt: now(),
      durationMs: now() - startedAt,
      attributes: { synthesized: true },
      input: undefined,
      output: undefined,
      error: null,
      children: rootIds.sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId)),
    };
  }

  function toJSON() {
    return { runId, agentId, builtAt: new Date(now()).toISOString(), root: toTree() };
  }

  return {
    runId,
    agentId,
    startSpan,
    endSpan,
    recordSpan,
    getSpan,
    get size() {
      return spans.size;
    },
    toTree,
    toJSON,
  };
}

/**
 * Rebuild a trace tree from a run's event stream. Tolerates a partial stream
 * (a crashed run still yields whatever spans were started).
 *
 * @param {Array<object>} events events from `createEventBus`
 * @param {object} [options]
 * @param {string} [options.runId]
 */
export function traceFromEvents(events, { runId } = {}) {
  const list = [...events].sort((a, b) => a.seq - b.seq);
  const resolvedRunId = runId ?? list[0]?.runId ?? 'unknown';
  const agentId = list[0]?.agentId ?? 'unknown';
  const builder = createTraceBuilder({ runId: resolvedRunId, agentId });
  const spanIds = new Map(); // eventSpanId -> builder spanId
  let lastSpanId = null;

  for (const event of list) {
    switch (event.type) {
      case EVENT_TYPES.MODEL_CALLED: {
        const id = builder.startSpan({
          name: `model:${event.payload?.model ?? event.payload?.provider ?? 'unknown'}`,
          type: SPAN_TYPES.MODEL_CALL,
          input: event.payload?.messages ?? event.payload?.prompt,
        });
        lastSpanId = id;
        spanIds.set(event.spanId ?? `seq:${event.seq}`, id);
        break;
      }
      case EVENT_TYPES.MEMORY_RETRIEVED: {
        lastSpanId = builder.startSpan({
          name: 'memory.retrieve',
          type: SPAN_TYPES.MEMORY_RETRIEVAL,
          input: event.payload?.query,
        });
        break;
      }
      case EVENT_TYPES.TOOL_PROPOSED: {
        lastSpanId = builder.startSpan({
          name: `tool:${event.payload?.tool ?? 'unknown'}`,
          type: SPAN_TYPES.TOOL_CALL,
          input: event.payload?.args,
        });
        break;
      }
      case EVENT_TYPES.POLICY_DECIDED: {
        builder.recordSpan({
          name: `policy:${event.payload?.rule ?? 'engine'}`,
          type: SPAN_TYPES.POLICY_CHECK,
          parentId: lastSpanId,
          input: event.payload?.request,
          output: { decision: event.payload?.decision },
          status:
            event.payload?.decision === 'DENY'
              ? SPAN_STATUS.BLOCKED
              : event.payload?.decision === 'REQUIRE_APPROVAL'
                ? SPAN_STATUS.PENDING
                : SPAN_STATUS.OK,
        });
        break;
      }
      case EVENT_TYPES.TOOL_EXECUTED:
      case EVENT_TYPES.TOOL_FAILED: {
        const parentId = lastSpanId;
        builder.recordSpan({
          name: `result:${event.payload?.tool ?? 'unknown'}`,
          type: SPAN_TYPES.TOOL_RESULT,
          parentId,
          output: event.payload?.result,
          status: event.type === EVENT_TYPES.TOOL_EXECUTED ? SPAN_STATUS.OK : SPAN_STATUS.ERROR,
          durationMs: event.payload?.durationMs,
        });
        if (parentId) builder.endSpan(parentId, { status: SPAN_STATUS.OK });
        lastSpanId = null;
        break;
      }
      case EVENT_TYPES.APPROVAL_REQUESTED: {
        builder.recordSpan({
          name: `approval:${event.payload?.approvalId ?? 'pending'}`,
          type: SPAN_TYPES.APPROVAL,
          parentId: lastSpanId,
          output: { status: 'pending', reason: event.payload?.reason },
          status: SPAN_STATUS.PENDING,
        });
        break;
      }
      case EVENT_TYPES.APPROVAL_RESOLVED: {
        builder.recordSpan({
          name: `approval:${event.payload?.approvalId ?? 'resolved'}`,
          type: SPAN_TYPES.APPROVAL,
          output: { status: event.payload?.status },
          status: event.payload?.status === 'approved' ? SPAN_STATUS.OK : SPAN_STATUS.BLOCKED,
        });
        break;
      }
      case EVENT_TYPES.VALIDATION_FAILED: {
        builder.recordSpan({
          name: 'validation',
          type: SPAN_TYPES.STATE,
          parentId: lastSpanId,
          output: event.payload,
          status: SPAN_STATUS.ERROR,
        });
        break;
      }
      case EVENT_TYPES.STATE_CHANGED: {
        // state transitions are not spans — they are edges in the tree
        break;
      }
      case EVENT_TYPES.RUN_FINISHED: {
        builder.recordSpan({
          name: 'final-response',
          type: SPAN_TYPES.FINAL_RESPONSE,
          output: event.payload,
          status: event.payload?.status === 'FAILED' ? SPAN_STATUS.ERROR : SPAN_STATUS.OK,
        });
        break;
      }
      default:
        break;
    }
  }

  return builder.toJSON();
}
