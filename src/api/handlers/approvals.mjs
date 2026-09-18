/**
 * Approval endpoints — the human half of the approval gate.
 *
 * An approval is created by the policy kernel (through the executor), never by
 * the model and never by this API. What the API can do is *resolve* one, and
 * resolving one is the only thing that lets the gated call run: the executor
 * re-checks the approval against the tool name AND a fingerprint of the
 * arguments, so approving `request_human_approval(reason A)` does not authorise
 * `request_human_approval(reason B)`.
 *
 * The queue survives a restart because it is a JSONL file, and the manager
 * hydrates from it on first read — an operator who sees an empty queue after a
 * deploy must be able to trust that it is empty.
 */

import { API_ERROR_CODES, apiError } from '../errors.mjs';
import { APPROVAL_STATUS, APPROVAL_ERROR_CODES } from '../../policy/approvals.mjs';
import { serializeApproval } from '../serialize.mjs';

/** `?status=` values accepted by the list endpoint. */
export const APPROVAL_FILTERS = Object.freeze(['all', 'pending', ...Object.values(APPROVAL_STATUS)]);

/** ApprovalError codes -> API error codes. */
const CODE_MAP = Object.freeze({
  [APPROVAL_ERROR_CODES.NOT_FOUND]: API_ERROR_CODES.UNKNOWN_APPROVAL,
  [APPROVAL_ERROR_CODES.EXPIRED]: API_ERROR_CODES.APPROVAL_NOT_PENDING,
  [APPROVAL_ERROR_CODES.ILLEGAL_TRANSITION]: API_ERROR_CODES.APPROVAL_NOT_PENDING,
  [APPROVAL_ERROR_CODES.MISMATCH]: API_ERROR_CODES.APPROVAL_MISMATCH,
});

export function createApprovalsHandler({ runtime, now = () => Date.now() }) {
  /** Translate an approval-domain failure into an HTTP-shaped one. */
  function translate(error) {
    const code = CODE_MAP[error?.code] ?? API_ERROR_CODES.INTERNAL;
    return apiError(code, error?.message ?? String(error), {
      approvalId: error?.approvalId ?? null,
      approvalCode: error?.code ?? null,
    });
  }

  /** `GET /api/runtime/approvals?status=pending|approved|rejected|expired|cancelled|all` */
  function list({ query }) {
    const requested = query.status === undefined || query.status === '' ? 'all' : String(query.status);
    if (!APPROVAL_FILTERS.includes(requested)) {
      throw apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        `unknown \`status\` "${requested}" (known: ${APPROVAL_FILTERS.join(', ')})`,
        { status: requested, known: APPROVAL_FILTERS },
      );
    }

    // Hydrate from the store first: the queue is durable, so `pending` after a
    // restart must mean the same thing it meant before one.
    const all = runtime.approvals.list();
    const pending = runtime.approvals.listPending();
    const rows = requested === 'all' ? all : requested === 'pending' ? pending : all.filter((row) => row.status === requested);

    return {
      status: 200,
      body: {
        filter: requested,
        count: rows.length,
        pendingCount: pending.length,
        total: all.length,
        approvals: rows
          .slice()
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .map(serializeApproval),
        countsByStatus: Object.values(APPROVAL_STATUS).reduce((accumulator, status) => {
          accumulator[status] = all.filter((row) => row.status === status).length;
          return accumulator;
        }, {}),
        pendingNote:
          'A pending approval is created by the policy gate for one tool call, bound to the tool name and a ' +
          'fingerprint of the arguments. Approving it authorises exactly that call; the executor checks both on resume.',
      },
    };
  }

  /**
   * Resolve a pending approval.
   *
   * @param {'approved'|'rejected'} status
   */
  function resolve({ params, body }, status) {
    const approvalId = params.id;
    if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body))) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, 'the request body must be a JSON object');
    }
    const resolvedBy = typeof body?.resolvedBy === 'string' && body.resolvedBy.trim() ? body.resolvedBy.trim() : 'operator';
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null;

    // Presence first, so "unknown" is a 404 rather than a 409 with a confusing
    // message: `resolve()` on an unknown id reports NOT_FOUND, but only after a
    // store read that cannot distinguish the two.
    const existing = runtime.approvals.get(approvalId);
    if (!existing) {
      throw apiError(API_ERROR_CODES.UNKNOWN_APPROVAL, `no approval "${approvalId}"`, { approvalId });
    }

    let record;
    try {
      record = status === APPROVAL_STATUS.APPROVED
        ? runtime.approvals.approve(approvalId, { resolvedBy, note })
        : runtime.approvals.reject(approvalId, { resolvedBy, note });
    } catch (error) {
      throw translate(error);
    }

    return {
      status: 200,
      body: {
        resolved: true,
        approval: serializeApproval(record),
        runId: record.runId ?? null,
        runUrl: record.runId ? `/api/runtime/runs/${record.runId}` : null,
        note:
          'Resolution is recorded in data/state/approvals/approvals.jsonl. The gated call runs only when a run ' +
          're-proposes it with this approval id, at which point the executor emits approval.resolved.',
      },
    };
  }

  return {
    list,
    approve: (context) => resolve(context, APPROVAL_STATUS.APPROVED),
    reject: (context) => resolve(context, APPROVAL_STATUS.REJECTED),
  };
}

export default createApprovalsHandler;
