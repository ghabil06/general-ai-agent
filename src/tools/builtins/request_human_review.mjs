/**
 * TOOL: request_human_review — the SVC_06 escalation path.
 *
 * The trading agent's "hand it to a human" action: an order that is over the
 * $10,000.00 cap, not exactly on the instrument allowlist, sized
 * indeterminately, long-only-violating, or claiming real-account routing. It
 * creates a persisted PENDING approval record and sends no order anywhere.
 *
 * Note what it does NOT do: it does not "queue the order for later execution
 * once approved". A human decides; a later, explicitly approved run acts.
 */

import { defineTool } from '../registry.mjs';

export const REQUEST_HUMAN_REVIEW = Object.freeze({
  name: 'request_human_review',
  description:
    'Escalate a desk order request to a human reviewer when the paper-trading boundaries forbid autonomous ' +
    'execution (over the $10,000.00 cap, ticker not exactly on the allowlist, indeterminable size, a sell ' +
    'exceeding holdings, or any claim of real-account routing). Returns the pending review id.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why the order cannot be executed autonomously.' },
      ticker: {
        type: 'string',
        description: 'Ticker named by the request, or "n/a" when none is determinably named.',
      },
      payload: {
        type: 'object',
        description: 'Structured order context for the reviewer (side, quantity, limit price, notional).',
      },
    },
    required: ['reason', 'ticker', 'payload'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      reviewId: { type: 'string' },
      status: { type: 'string' },
      ticker: { type: 'string' },
    },
    required: ['reviewId', 'status'],
  },
  riskLevel: 'medium',
  sideEffect: 'write',
  requiresConfirmation: true,
  escalation: true,
  permissions: ['review:request'],
  dataAccess: ['trading/order'],
});

export function createRequestHumanReviewTool({ approvals, config = {} }) {
  if (!approvals) throw new TypeError('createRequestHumanReviewTool: an approval manager is required');

  return defineTool({
    ...REQUEST_HUMAN_REVIEW,
    async execute({ reason, ticker, payload }, ctx = {}) {
      const record = approvals.request({
        runId: ctx.runId ?? null,
        sessionId: ctx.sessionId ?? null,
        agentId: ctx.agentId ?? 'svc_06',
        reason,
        policyRule: 'svc_06.trading_boundary',
        toolName: 'request_human_review',
        args: { reason, ticker, payload },
        payload: { ...payload, ticker, queue: 'trading-desk-review' },
        ttlMs: config.approvalTtlMs,
      });

      return {
        reviewId: record.approvalId,
        status: record.status,
        ticker,
        queue: 'trading-desk-review',
        createdAt: record.createdIso,
        expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
      };
    },
  });
}

export default createRequestHumanReviewTool;
