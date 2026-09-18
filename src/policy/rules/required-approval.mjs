/**
 * RULE: required approval (priority 50).
 *
 * The last word, and deliberately the most conservative one. A call is paused
 * for a human when:
 *
 *   - the tool declares `requiresConfirmation: true` (a declaration the policy
 *     kernel cannot talk its way out of), or
 *   - the action is the prompt's own "hand it to a human" disposition
 *     (`request_human_approval` / `request_analyst_review` /
 *     `escalate_to_human`).
 *
 * `escalation: true` is NOT an approval gate. It marks the tool that hands a
 * decision to a human, which is what the prompt-injection rule needs to know so
 * it cannot deny the very path an injection is meant to trigger. The three
 * "request a human" tools carry `requiresConfirmation: true` as well, so they
 * do pause; `create_incident_ticket` does not, because the SVC_04 prompt makes
 * opening an incident the agent's own disposition at level 12 and above.
 * Containment — the dangerous direction — is a separate, human-approved step
 * executed by SOAR playbooks.
 *
 * REQUIRE_APPROVAL is not a soft DENY: `src/tools/executor.mjs` creates a real,
 * persisted approval record and does not call `execute()` until a matching
 * approval has been resolved as `approved` for the same tool *and* the same
 * arguments. Nothing here can be satisfied by the model asserting approval.
 */

import { allow, deny, requireApproval } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';

/** Dispositions that hand control to a human by definition. */
export const HUMAN_DISPOSITIONS = Object.freeze([
  'request_human_approval',
  'request_analyst_review',
  'escalate_to_human',
]);

export const requiredApprovalRule = defineRule({
  id: 'action.required_approval',
  kind: RULE_KINDS.REQUIRED_APPROVAL,
  priority: 50,
  description:
    'Tools marked requiresConfirmation, and the "hand it to a human" dispositions, always require a ' +
    'persisted human approval before execution. `escalation: true` is not itself a gate — see the docstring.',
  appliesTo: (request) =>
    (request.kind === 'tool_call' && Boolean(request.tool)) || (request.kind === 'action' && Boolean(request.action)),
  evaluate(request) {
    if (request.kind === 'action') {
      if (HUMAN_DISPOSITIONS.includes(request.action)) {
        return requireApproval(
          `disposition "${request.action}" hands the decision to a human and must be recorded as a pending approval`,
          { action: request.action, dispositionRequiresHuman: true },
        );
      }
      return null;
    }

    const tool = request.tool;
    const profile = request.profile;

    if (tool.requiresConfirmation === true) {
      if (!profile) {
        return deny(`tool "${tool.name}" requires confirmation but no agent profile was resolved`, {
          tool: tool.name,
          failClosed: true,
        });
      }
      return requireApproval(
        `tool "${tool.name}" declares requiresConfirmation and may only execute with a recorded human approval`,
        { tool: tool.name, requiresConfirmation: true, agentId: profile.id },
      );
    }

    return allow(`tool "${tool.name}" does not require human confirmation`, {
      tool: tool.name,
      escalation: tool.escalation === true,
    });
  },
});

export default requiredApprovalRule;
