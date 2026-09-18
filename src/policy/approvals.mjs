/**
 * Approval records and their lifecycle.
 *
 * Real implementation. An approval is the ONLY thing that can move a
 * REQUIRE_APPROVAL verdict to execution, so it is deliberately awkward to fake:
 *
 *   - it is created by the policy kernel's verdict, not by the model;
 *   - it binds to the exact tool name AND a fingerprint of the exact arguments
 *     (`requestFingerprint`), so an approval for `submit_paper_order(AAPL, 50)`
 *     does not authorise `submit_paper_order(BTC-USD, 500)`;
 *   - it expires, and expiry is enforced on read as well as on
 *     `expireOverdue()` — an approval cannot be "resurrected" by not sweeping;
 *   - resolution is single-shot: a second resolve of a resolved approval fails.
 *
 * States: `pending | approved | rejected | expired | cancelled`
 *   pending -> approved | rejected | expired | cancelled
 *   everything else is terminal.
 *
 * The clock is injected (`now`), so expiry is testable without sleeping.
 */

import { newId, fingerprint } from '../util/ids.mjs';
import { createJsonlStore } from '../store/jsonl-store.mjs';

export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

export const TERMINAL_APPROVAL_STATUSES = Object.freeze([
  APPROVAL_STATUS.APPROVED,
  APPROVAL_STATUS.REJECTED,
  APPROVAL_STATUS.EXPIRED,
  APPROVAL_STATUS.CANCELLED,
]);

const LEGAL_TRANSITIONS = Object.freeze({
  [APPROVAL_STATUS.PENDING]: [
    APPROVAL_STATUS.APPROVED,
    APPROVAL_STATUS.REJECTED,
    APPROVAL_STATUS.EXPIRED,
    APPROVAL_STATUS.CANCELLED,
  ],
  [APPROVAL_STATUS.APPROVED]: [],
  [APPROVAL_STATUS.REJECTED]: [],
  [APPROVAL_STATUS.EXPIRED]: [],
  [APPROVAL_STATUS.CANCELLED]: [],
});

export class ApprovalError extends Error {
  constructor(code, message, { approvalId } = {}) {
    super(`${code}: ${message}`);
    this.name = 'ApprovalError';
    this.code = code;
    this.approvalId = approvalId ?? null;
  }
}

export const APPROVAL_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'APPROVAL_NOT_FOUND',
  ILLEGAL_TRANSITION: 'APPROVAL_ILLEGAL_TRANSITION',
  EXPIRED: 'APPROVAL_EXPIRED',
  MISMATCH: 'APPROVAL_MISMATCH',
});

/** The fingerprint an approval binds to: tool name + canonical arguments. */
export function approvalFingerprint(toolName, args) {
  return fingerprint({ tool: toolName, args: args ?? null });
}

/** Is this status terminal? */
export function isTerminalApproval(status) {
  return TERMINAL_APPROVAL_STATUSES.includes(status);
}

export function canResolveApproval(from, to) {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * @param {object}   options
 * @param {object}   [options.store]        JSONL store; omit for in-memory only
 * @param {Function} [options.now]          clock injection (epoch ms)
 * @param {number}   [options.defaultTtlMs]
 * @param {Function} [options.onEvent]      called with every lifecycle row
 */
export function createApprovalManager({
  store = null,
  now = () => Date.now(),
  defaultTtlMs = 24 * 60 * 60 * 1000,
  onEvent,
} = {}) {
  /** approvalId -> current record */
  const live = new Map();

  function emitEvent(row, type) {
    if (store) store.append(row);
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type, row });
      } catch {
        // never let an observer break the lifecycle
      }
    }
    return row;
  }

  /**
   * Create a pending approval.
   *
   * @param {object} request
   * @param {string} request.runId
   * @param {string} request.agentId
   * @param {string} request.reason
   * @param {string} [request.toolName]
   * @param {unknown} [request.args]
   * @param {object} [request.payload]
   * @param {number} [request.ttlMs]
   * @param {string|null} [request.policyRule]
   * @returns {object} the frozen approval record
   */
  function request({
    runId = null,
    sessionId = null,
    agentId,
    reason,
    toolName = null,
    args = null,
    payload = {},
    ttlMs = defaultTtlMs,
    policyRule = null,
  } = {}) {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ApprovalError(APPROVAL_ERROR_CODES.MISMATCH, 'an approval needs a non-empty reason');
    }
    const createdAt = now();
    const record = Object.freeze({
      approvalId: newId('apr'),
      status: APPROVAL_STATUS.PENDING,
      runId,
      sessionId,
      agentId: agentId ?? 'unknown',
      reason,
      policyRule,
      toolName,
      requestFingerprint: toolName ? approvalFingerprint(toolName, args) : null,
      args: args ?? null,
      payload,
      createdAt,
      createdIso: new Date(createdAt).toISOString(),
      expiresAt: ttlMs > 0 ? createdAt + ttlMs : null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
    });

    live.set(record.approvalId, record);
    emitEvent(record, 'approval.created');
    return record;
  }

  /** Read, enforcing expiry lazily so a stale pending approval cannot be used. */
  function get(approvalId) {
    const record = live.get(approvalId) ?? (store ? store.latestById(approvalId, 'approvalId') : null);
    if (!record) return null;
    if (record.status === APPROVAL_STATUS.PENDING && record.expiresAt !== null && now() >= record.expiresAt) {
      return expireOne(record, 'expired: read after TTL') ?? record;
    }
    return record;
  }

  function expireOne(record, note = 'expired') {
    if (record.status !== APPROVAL_STATUS.PENDING) return record;
    const resolvedAt = now();
    const next = Object.freeze({
      ...record,
      status: APPROVAL_STATUS.EXPIRED,
      resolvedAt,
      resolvedIso: new Date(resolvedAt).toISOString(),
      resolvedBy: 'system',
      resolutionNote: note,
    });
    live.set(next.approvalId, next);
    emitEvent(next, 'approval.expired');
    return next;
  }

  /** Sweep every overdue pending approval. @returns {object[]} the expired ones */
  function expireOverdue() {
    const expired = [];
    for (const record of [...live.values()]) {
      if (record.status !== APPROVAL_STATUS.PENDING) continue;
      if (record.expiresAt !== null && now() >= record.expiresAt) {
        expired.push(expireOne(record, 'expired: TTL elapsed'));
      }
    }
    return expired;
  }

  /**
   * Resolve a pending approval.
   *
   * @param {string} approvalId
   * @param {object} resolution
   * @param {'approved'|'rejected'|'cancelled'} resolution.status
   * @param {string} [resolution.resolvedBy]
   * @param {string} [resolution.note]
   * @param {string} [resolution.toolName]  when given, must match the record
   * @param {unknown} [resolution.args]     when given, must match the fingerprint
   */
  function resolve(approvalId, { status, resolvedBy = 'unknown', note = null, toolName, args } = {}) {
    const record = get(approvalId);
    if (!record) throw new ApprovalError(APPROVAL_ERROR_CODES.NOT_FOUND, `no approval "${approvalId}"`, { approvalId });

    if (record.status === APPROVAL_STATUS.EXPIRED) {
      throw new ApprovalError(APPROVAL_ERROR_CODES.EXPIRED, `approval "${approvalId}" has expired and cannot be resolved`, {
        approvalId,
      });
    }
    if (!canResolveApproval(record.status, status)) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.ILLEGAL_TRANSITION,
        `approval "${approvalId}" is ${record.status} and cannot become ${status}`,
        { approvalId },
      );
    }
    if (toolName !== undefined && record.toolName !== toolName) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.MISMATCH,
        `approval "${approvalId}" is bound to tool "${record.toolName}", not "${toolName}"`,
        { approvalId },
      );
    }
    if (args !== undefined && record.requestFingerprint && record.requestFingerprint !== approvalFingerprint(record.toolName, args)) {
      throw new ApprovalError(
        APPROVAL_ERROR_CODES.MISMATCH,
        `approval "${approvalId}" was granted for different arguments (fingerprint mismatch)`,
        { approvalId },
      );
    }

    const resolvedAt = now();
    const next = Object.freeze({
      ...record,
      status,
      resolvedAt,
      resolvedIso: new Date(resolvedAt).toISOString(),
      resolvedBy,
      resolutionNote: note,
    });
    live.set(next.approvalId, next);
    emitEvent(next, `approval.${status}`);
    return next;
  }

  const approve = (approvalId, resolution = {}) =>
    resolve(approvalId, { ...resolution, status: APPROVAL_STATUS.APPROVED });
  const reject = (approvalId, resolution = {}) =>
    resolve(approvalId, { ...resolution, status: APPROVAL_STATUS.REJECTED });
  const cancel = (approvalId, resolution = {}) =>
    resolve(approvalId, { ...resolution, status: APPROVAL_STATUS.CANCELLED });

  /**
   * May this be executed? Checks state, expiry and that the approval was
   * granted for THIS tool and THESE arguments.
   *
   * @returns {{approved: boolean, reason: string, approval: object|null}}
   */
  function check(approvalId, { toolName, args } = {}) {
    const record = get(approvalId);
    if (!record) return { approved: false, reason: `unknown approval "${approvalId}"`, approval: null };
    if (record.status !== APPROVAL_STATUS.APPROVED) {
      return { approved: false, reason: `approval "${approvalId}" is ${record.status}`, approval: record };
    }
    if (toolName !== undefined && record.toolName !== toolName) {
      return { approved: false, reason: `approval "${approvalId}" is bound to tool "${record.toolName}"`, approval: record };
    }
    if (args !== undefined && record.requestFingerprint && record.requestFingerprint !== approvalFingerprint(record.toolName, args)) {
      return { approved: false, reason: `approval "${approvalId}" was granted for different arguments`, approval: record };
    }
    return { approved: true, reason: `approval "${approvalId}" granted by ${record.resolvedBy}`, approval: record };
  }

  /**
   * Pending approvals, oldest first.
   *
   * Hydrates from the store first, exactly as `list()` does: an approval queue
   * that shows nothing after a restart is worse than no queue, because an
   * operator reads an empty queue as "nothing is waiting for me".
   */
  function listPending() {
    if (store && live.size === 0) hydrate();
    expireOverdue();
    return [...live.values()]
      .filter((record) => record.status === APPROVAL_STATUS.PENDING)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Every known approval, newest first. Hydrates from the store on first call. */
  function list() {
    if (store && live.size === 0) hydrate();
    return [...live.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Load persisted approvals (used after a restart). */
  function hydrate() {
    if (!store) return 0;
    const latest = store.reduceLatest('approvalId');
    for (const [approvalId, record] of latest.entries()) {
      if (!live.has(approvalId)) live.set(approvalId, record);
    }
    return latest.size;
  }

  return {
    request,
    get,
    resolve,
    approve,
    reject,
    cancel,
    expireOverdue,
    check,
    list,
    listPending,
    hydrate,
    get size() {
      return live.size;
    },
  };
}

/** Approval store under `<storageDir>/approvals/approvals.jsonl`. */
export function createApprovalStore(storageDir) {
  return createJsonlStore({ dir: `${storageDir}/approvals`, name: 'approvals' });
}
