/**
 * RULE: destructive-action restriction (priority 12).
 *
 * No SVC agent has a destructive tool — not one of the four security-triage
 * tools, not the trading tools, not the invoice tools. This rule is the
 * enforcement of that sentence, and it fails closed: a destructive side effect
 * is a DENY, an elevated risk level pauses for a human, and the only escape
 * hatch is an explicit profile grant that none of the three profiles carries.
 */

import { allow, deny, requireApproval } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';
import { ELEVATED_RISK_LEVELS } from '../../tools/registry.mjs';

export const destructiveActionRule = defineRule({
  id: 'action.destructive_restriction',
  kind: RULE_KINDS.DESTRUCTIVE_ACTION,
  priority: 12,
  description:
    'No autonomous destructive action: sideEffect "destructive" is denied outright, "high"/"critical" risk ' +
    'requires a human, and no SVC profile grants a destructive exemption.',
  appliesTo: (request) => request.kind === 'tool_call',
  evaluate(request) {
    const tool = request.tool;
    if (!tool) return null;

    const profile = request.profile ?? null;
    const destructiveAllowed = Boolean(profile?.allowDestructiveActions);

    if (tool.sideEffect === 'destructive' && !destructiveAllowed) {
      return deny(
        `tool "${tool.name}" has a destructive side effect and agent "${profile?.id ?? request.agentId ?? 'unknown'}" ` +
          'has no destructive-action grant',
        { tool: tool.name, sideEffect: tool.sideEffect, profile: profile?.id ?? null },
      );
    }

    if (ELEVATED_RISK_LEVELS.includes(tool.riskLevel)) {
      // Escalation tools are the sanctioned way to involve a human; they are
      // already gated by the required-approval rule and must not be double-blocked.
      if (tool.escalation === true) return null;
      return requireApproval(
        `tool "${tool.name}" is risk level "${tool.riskLevel}"; it may only run with a recorded human approval`,
        { tool: tool.name, riskLevel: tool.riskLevel },
      );
    }

    return allow(`tool "${tool.name}" has no destructive side effect (sideEffect=${tool.sideEffect}, risk=${tool.riskLevel})`, {
      tool: tool.name,
      sideEffect: tool.sideEffect,
      riskLevel: tool.riskLevel,
    });
  },
});

export default destructiveActionRule;
