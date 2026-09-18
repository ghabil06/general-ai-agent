/**
 * Durable audit writer.
 *
 * Real implementation. Persists one JSONL row per auditable decision under
 * `<storageDir>/audit/audit.jsonl`, append-only, so the file can be tailed,
 * shipped and verified without a database.
 *
 * Relationship to the existing audit artefacts in this repo:
 *   - `n8n_exports/audit_log.sql` defines the SVC_03 `agents.audit_log` table
 *     (Postgres, shadow-mode parity review). This module is the runtime-side
 *     analogue for ALL agents, in this repo, with no database.
 *   - `n8n_exports/replay_sample.jsonl` is the shadow-week replay input format.
 *   - Neither existing artefact is modified or replaced.
 *
 * Every row is redacted before it is written. A row is JSON-serialisable and
 * carries `runId` / `agentId` / `type` / `ts` so it can be joined against
 * `data/state/runs/runs.jsonl` and the event stream.
 */

import { createJsonlStore } from '../store/jsonl-store.mjs';
import { redact } from './redact.mjs';

/** Audit row kinds. Stable strings — they end up in persisted files. */
export const AUDIT_TYPES = Object.freeze({
  RUN_STARTED: 'run.started',
  RUN_FINISHED: 'run.finished',
  /** Added in call 3: a run that stopped at a human gate, in a non-terminal state. */
  RUN_PAUSED: 'run.paused',
  /** Added in call 3: an operator cancelled a paused (or in-flight) run. */
  RUN_CANCELLED: 'run.cancelled',
  DECISION: 'decision',
  POLICY_DECISION: 'policy.decision',
  TOOL_EXECUTION: 'tool.execution',
  TOOL_BLOCKED: 'tool.blocked',
  APPROVAL: 'approval',
  GUARDRAIL_BREACH: 'guardrail.breach',
  INJECTION_DETECTED: 'injection.detected',
  INCIDENT_TICKET: 'incident.ticket',
  PAPER_ORDER: 'paper.order',
  ERROR: 'error',
});

/** Map a run event onto an audit row type, or null when it is not auditable. */
export function auditTypeForEvent(eventType) {
  switch (eventType) {
    case 'run.started':
      return AUDIT_TYPES.RUN_STARTED;
    case 'run.finished':
      return AUDIT_TYPES.RUN_FINISHED;
    case 'run.paused':
      return AUDIT_TYPES.RUN_PAUSED;
    case 'policy.decided':
      return AUDIT_TYPES.POLICY_DECISION;
    case 'tool.executed':
      return AUDIT_TYPES.TOOL_EXECUTION;
    case 'tool.failed':
      return AUDIT_TYPES.TOOL_BLOCKED;
    case 'approval.requested':
    case 'approval.resolved':
      return AUDIT_TYPES.APPROVAL;
    case 'run.error':
      return AUDIT_TYPES.ERROR;
    default:
      return null;
  }
}

/** Build an audit row from a run event. Returns null when not auditable. */
export function auditRecordFromEvent(event) {
  const type = auditTypeForEvent(event.type);
  if (!type) return null;
  return {
    type,
    runId: event.runId,
    sessionId: event.sessionId,
    agentId: event.agentId,
    seq: event.seq,
    ts: event.ts,
    iso: event.iso,
    payload: event.payload,
  };
}

/**
 * @param {object}   options
 * @param {object}   options.store   a JSONL store (or anything with `append`)
 * @param {Function} [options.now]
 * @param {Function} [options.redactFn]
 */
export function createAuditWriter({ store, now = () => Date.now(), redactFn = redact } = {}) {
  if (!store || typeof store.append !== 'function') {
    throw new TypeError('createAuditWriter: a store with append(record) is required');
  }

  function write(row) {
    const record = {
      ...redactFn(row),
      recordedAt: now(),
      recordedIso: new Date(now()).toISOString(),
    };
    store.append(record);
    return record;
  }

  /** Write the explicit audit of an agent decision. */
  function writeDecision({ runId, sessionId, agentId, action, reasoning, evidence = {}, mode = 'shadow' }) {
    return write({
      type: AUDIT_TYPES.DECISION,
      runId,
      sessionId,
      agentId,
      ts: now(),
      iso: new Date(now()).toISOString(),
      action,
      reasoning,
      evidence,
      mode,
    });
  }

  /** Write a deterministic guardrail breach (policy DENY against a boundary). */
  function writeBreach({ runId, sessionId, agentId, rule, reason, evidence = {} }) {
    return write({
      type: AUDIT_TYPES.GUARDRAIL_BREACH,
      runId,
      sessionId,
      agentId,
      ts: now(),
      iso: new Date(now()).toISOString(),
      rule,
      reason,
      evidence,
    });
  }

  /** Forward an auditable event. Returns the row, or null if not auditable. */
  function writeEvent(event) {
    const row = auditRecordFromEvent(event);
    return row ? write(row) : null;
  }

  return {
    write,
    writeDecision,
    writeBreach,
    writeEvent,
    readAll: () => store.readAll(),
    path: store.path,
  };
}

/** Default audit store under `<storageDir>/audit/audit.jsonl`. */
export function createDefaultAuditStore(storageDir) {
  return createJsonlStore({ dir: `${storageDir}/audit`, name: 'audit' });
}
