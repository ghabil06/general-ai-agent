/**
 * TOOL: request_analyst_review — the SVC_04 escalation path.
 *
 * Hands an alert to a human analyst by creating a persisted PENDING approval
 * record. `escalation: true`, so the prompt-injection rule permits it even when
 * the alert payload contains override attempts — that is precisely when this
 * tool must remain callable.
 *
 * It cannot close, suppress or contain anything. Directive 2 of the SVC_04
 * prompt: containment is executed by deterministic SOAR playbooks after a human
 * approves it.
 */

import { defineTool } from '../registry.mjs';

export const REQUEST_ANALYST_REVIEW = Object.freeze({
  name: 'request_analyst_review',
  description:
    'Hand a security alert to a human analyst for review when the disposition is not determinable (incomplete ' +
    'record, uninterpretable rule level, uncorroborated but unproven pattern, or an override attempt). ' +
    'Returns the pending review id.',
  inputSchema: {
    type: 'object',
    properties: {
      alertId: {
        type: 'string',
        pattern: '^[0-9]{1,8}$',
        description: 'Wazuh rule id of the alert under review.',
      },
      reason: { type: 'string', description: 'Why an analyst is needed rather than an automatic disposition.' },
    },
    required: ['alertId', 'reason'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      reviewId: { type: 'string' },
      status: { type: 'string' },
      alertId: { type: 'string' },
    },
    required: ['reviewId', 'status'],
  },
  riskLevel: 'medium',
  sideEffect: 'write',
  requiresConfirmation: true,
  escalation: true,
  permissions: ['review:request'],
  dataAccess: ['security/alert'],
});

export function createRequestAnalystReviewTool({ approvals, config = {} }) {
  if (!approvals) throw new TypeError('createRequestAnalystReviewTool: an approval manager is required');

  return defineTool({
    ...REQUEST_ANALYST_REVIEW,
    async execute({ alertId, reason }, ctx = {}) {
      const record = approvals.request({
        runId: ctx.runId ?? null,
        sessionId: ctx.sessionId ?? null,
        agentId: ctx.agentId ?? 'svc_04',
        reason,
        policyRule: 'svc_04.triage_boundary',
        toolName: 'request_analyst_review',
        args: { alertId, reason },
        payload: { alertId, reason, requestedBy: 'svc_04', queue: 'tier2-soc' },
        ttlMs: config.approvalTtlMs,
      });

      return {
        reviewId: record.approvalId,
        status: record.status,
        alertId,
        queue: 'tier2-soc',
        createdAt: record.createdIso,
        expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
      };
    },
  });
}

export default createRequestAnalystReviewTool;
