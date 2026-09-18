/**
 * RULE: data-access policy (priority 22).
 *
 * The agent profiles in `src/config/agents.mjs` declare, as exact-match tags,
 * which data an agent may touch:
 *
 *   svc_03  finance/po, finance/invoice, agent/approval
 *   svc_04  security/alert, security/allowlist, security/incident
 *   svc_06  trading/portfolio, trading/market, trading/order
 *
 * Every tag a tool declares must be granted to the calling agent. There is no
 * wildcard and no prefix matching: `finance/*` does not grant `finance/po`, and
 * an unknown tag is never granted by default. Cross-service reads — the
 * trading agent reading invoices, the AP agent reading alerts — are DENY.
 */

import { allow, deny } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';

export const dataAccessRule = defineRule({
  id: 'data.access',
  kind: RULE_KINDS.DATA_ACCESS,
  priority: 22,
  description:
    'Every data tag a tool declares must be granted to the calling agent profile by exact match. ' +
    'No wildcards, no prefix matching, unknown tag => DENY.',
  appliesTo: (request) => request.kind === 'tool_call' && Boolean(request.tool),
  evaluate(request) {
    const { tool, profile } = request;
    const required = tool.dataAccess ?? [];
    if (!required.length) {
      return allow(`tool "${tool.name}" declares no data access`, { tool: tool.name, required: [] });
    }

    if (!profile) {
      return deny(`no agent profile resolved; data access for tool "${tool.name}" cannot be evaluated`, {
        tool: tool.name,
        required,
        failClosed: true,
      });
    }

    const granted = new Set(profile.dataAccess ?? []);
    const denied = required.filter((tag) => !granted.has(tag));

    if (denied.length) {
      return deny(
        `agent "${profile.id}" is not granted data access ${denied.join(', ')} required by tool "${tool.name}"`,
        { tool: tool.name, agentId: profile.id, required, denied, granted: [...granted] },
      );
    }

    return allow(`agent "${profile.id}" holds data access ${required.join(', ')} for tool "${tool.name}"`, {
      tool: tool.name,
      agentId: profile.id,
      required,
    });
  },
});

export default dataAccessRule;
