/**
 * TOOL: request_human_approval — the SVC_03 escalation path.
 *
 * Creates a real, persisted PENDING approval record through
 * `src/policy/approvals.mjs`. It is `escalation: true`, which is what stops the
 * prompt-injection rule from denying the very tool an injected invoice is
 * supposed to trigger — the safe path must stay open. The required-approval
 * rule still pauses it, so the approval record is created by the *gate*, not by
 * this tool guessing.
 *
 * `payload` is passed through redaction before it is persisted (the run store
 * redacts on write), so an invoice fragment containing a key-like string cannot
 * land in the approvals file verbatim.
 */

import { defineTool } from '../registry.mjs';

export const REQUEST_HUMAN_APPROVAL = Object.freeze({
  name: 'request_human_approval',
  description:
    'Open a human approval request for an invoice that cannot be approved autonomously (over the $500.00 ' +
    'ceiling, a non-zero variance, or an unverifiable PO). Returns the pending approval id. This does not ' +
    'approve anything: it queues the decision for a person.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why autonomous approval is not permitted (at least a short sentence).',
      },
      payload: {
        type: 'object',
        description: 'Structured context for the approver (invoice reference, amount, PO number, variance).',
      },
    },
    required: ['reason', 'payload'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      approvalId: { type: 'string' },
      status: { type: 'string' },
      reason: { type: 'string' },
      createdAt: { type: 'string' },
      expiresAt: { type: 'string' },
    },
    required: ['approvalId', 'status'],
  },
  riskLevel: 'medium',
  sideEffect: 'write',
  requiresConfirmation: true,
  escalation: true,
  permissions: ['approval:request'],
  dataAccess: ['agent/approval'],
});

export function createRequestHumanApprovalTool({ approvals, config = {} }) {
  if (!approvals) throw new TypeError('createRequestHumanApprovalTool: an approval manager is required');

  return defineTool({
    ...REQUEST_HUMAN_APPROVAL,
    async execute({ reason, payload }, ctx = {}) {
      const record = approvals.request({
        runId: ctx.runId ?? null,
        sessionId: ctx.sessionId ?? null,
        agentId: ctx.agentId ?? 'svc_03',
        reason,
        toolName: 'request_human_approval',
        args: { reason, payload },
        payload,
        ttlMs: config.approvalTtlMs,
      });

      return {
        approvalId: record.approvalId,
        status: record.status,
        reason: record.reason,
        createdAt: record.createdIso,
        expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
        queuedForHuman: true,
      };
    },
  });
}

export default createRequestHumanApprovalTool;
