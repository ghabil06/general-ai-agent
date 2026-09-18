/**
 * TOOL: query_alert_context — thin SIEM context for one Wazuh rule.
 *
 * Reads `data/fixtures/alert_context.json`, which is keyed by rule id and
 * derived from `evals/security_alerts_dataset.json`. It returns metadata the
 * dataset already states (description, category, hosts, whether the rule is a
 * known scanner signature). It deliberately contains nothing that could let the
 * agent "enrich" an alert into a decision: the mandatory dispositions come from
 * the policy kernel, not from context.
 *
 * Read-only: riskLevel 'low', sideEffect 'read'.
 */

import { defineTool } from '../registry.mjs';

export const QUERY_ALERT_CONTEXT = Object.freeze({
  name: 'query_alert_context',
  description:
    'Look up context for a Wazuh rule id: what the rule detects, its category, the severity hint and the ' +
    'hosts it has been seen on. Returns { found: false } when the rule is unknown. Never returns a ' +
    'disposition — disposition is decided by policy, not by context.',
  inputSchema: {
    type: 'object',
    properties: {
      alertId: {
        type: 'string',
        pattern: '^[0-9]{1,8}$',
        description: 'Wazuh rule id as a string, e.g. "31103" or "5710".',
      },
    },
    required: ['alertId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      ruleId: { type: 'number' },
      description: { type: 'string' },
      alertCategory: { type: 'string' },
      hosts: { type: 'array' },
    },
    required: ['found', 'ruleId'],
  },
  riskLevel: 'low',
  sideEffect: 'read',
  permissions: ['alert:read'],
  dataAccess: ['security/alert'],
});

export function createQueryAlertContextTool({ fixtures }) {
  return defineTool({
    ...QUERY_ALERT_CONTEXT,
    async execute({ alertId }) {
      const fixture = fixtures.load('alert_context');
      const key = String(alertId).trim();
      const record = fixture.records?.[key];

      if (!record) {
        return {
          found: false,
          ruleId: Number(key),
          reason: 'rule id is not present in the alert-context fixture',
          escalationPolicy: fixture.escalationPolicy,
          source: 'data/fixtures/alert_context.json',
        };
      }

      return {
        found: true,
        ...record,
        escalationPolicy: fixture.escalationPolicy,
        source: 'data/fixtures/alert_context.json',
      };
    },
  });
}

export default createQueryAlertContextTool;
