/**
 * TOOL: create_incident_ticket — open a security incident.
 *
 * Opening an incident is always within the triage agent's authority: escalation
 * is strictly safer than silence, and the SVC_04 boundary rules say so
 * explicitly (`create_incident` -> ALLOW). What this tool must never become is
 * a containment action — directive 2 of the prompt forbids isolating hosts,
 * blocking IPs, disabling accounts or deleting logs, and none of those exists
 * here.
 *
 * The ticket id is deterministic (`INC-<sha256(title|severity|tick>`) so a
 * replay produces the same ids, and every ticket is appended to
 * `data/state/incidents/tickets.jsonl`.
 *
 * `escalation: true` but NOT `requiresConfirmation`: the SVC_04 prompt makes
 * `create_incident` the agent's own disposition at level 12 and above, so the
 * ticket is opened autonomously. The escalation flag is what keeps the
 * prompt-injection rule from denying a ticket opened on the strength of a
 * suspicious payload. Containment is the human-approved step, not the ticket.
 */

import { defineTool } from '../registry.mjs';
import { deterministicId } from '../../util/ids.mjs';

export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

export const CREATE_INCIDENT_TICKET = Object.freeze({
  name: 'create_incident_ticket',
  description:
    'Open an incident ticket for a security alert that requires human attention. Escalation is always ' +
    'permitted. This tool cannot contain anything: it does not isolate hosts, block addresses, disable ' +
    'accounts or delete logs.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short incident title, e.g. "Rules 5710/5712 credential access on dc-01".' },
      severity: { type: 'string', enum: SEVERITIES, description: 'Incident severity as triaged.' },
    },
    required: ['title', 'severity'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ticketId: { type: 'string' },
      title: { type: 'string' },
      severity: { type: 'string' },
      status: { type: 'string' },
      createdAt: { type: 'string' },
      containment: { type: 'string' },
    },
    required: ['ticketId', 'status'],
  },
  riskLevel: 'medium',
  sideEffect: 'write',
  escalation: true,
  permissions: ['incident:write'],
  dataAccess: ['security/incident'],
});

export function createCreateIncidentTicketTool({ store, now = () => Date.now() } = {}) {
  if (!store) throw new TypeError('createCreateIncidentTicketTool: a run store is required');

  return defineTool({
    ...CREATE_INCIDENT_TICKET,
    async execute({ title, severity }, ctx = {}) {
      const createdAt = now();
      // Deterministic per (title, severity, runId): replaying the same case in
      // the same run yields the same ticket id.
      const ticketId = deterministicId('INC', `${title}|${severity}|${ctx.runId ?? 'no-run'}`);
      const record = {
        ticketId,
        runId: ctx.runId ?? null,
        sessionId: ctx.sessionId ?? null,
        agentId: ctx.agentId ?? 'svc_04',
        title,
        severity,
        status: 'open',
        createdAt,
        createdIso: new Date(createdAt).toISOString(),
        containment: 'none — executed by deterministic SOAR playbooks after human approval',
        source: 'create_incident_ticket',
      };
      store.append('incidents', record);
      return {
        ticketId,
        title,
        severity,
        status: 'open',
        createdAt: record.createdIso,
        containment: record.containment,
        recordPath: store.paths.incidents,
      };
    },
  });
}

export default createCreateIncidentTicketTool;
