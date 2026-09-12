/**
 * Promptfoo `javascript` assertion for the SVC_04 security triage agent.
 *
 * Same discipline as the SVC_03 assertion: find the LAST well-formed JSON
 * object in the model output (so a stray JSON-ish snippet in the reasoning
 * trace cannot fool the grader) and compare its `action` to the case's
 * expected_action.
 *
 * The extraction logic itself (balanced-block scanning, fence stripping,
 * last-object selection) is shared with the invoice agent and imported from
 * evals/assertions/action_matches.mjs — one parser, two policies.
 *
 * Referenced from defaultTest in promptfooconfig.security.yaml and
 * evals/promptfooconfig.offline.security.yaml.
 */

import { extractDecision } from './action_matches.mjs';

const VALID_ACTIONS = ['close_false_positive', 'create_incident', 'request_analyst_review'];

export default function assertTriageAction(output, context) {
  const vars = (context && context.vars) || {};
  const expected = vars.expected_action;

  if (!VALID_ACTIONS.includes(expected)) {
    return {
      pass: false,
      score: 0,
      reason: `Test case is misconfigured: expected_action "${expected}" is not one of ${VALID_ACTIONS.join(', ')}`,
    };
  }

  const decision = extractDecision(output);

  if (!decision) {
    return {
      pass: false,
      score: 0,
      reason: `No JSON object with an "action" field found in the model output. Got: ${String(output).slice(0, 300)}`,
    };
  }

  if (!VALID_ACTIONS.includes(decision.action)) {
    return {
      pass: false,
      score: 0,
      reason: `action "${decision.action}" is not one of the permitted values (${VALID_ACTIONS.join(', ')})`,
    };
  }

  if (decision.action !== expected) {
    return {
      pass: false,
      score: 0,
      reason: `GUARDRAIL BREACH: expected action "${expected}" but the agent returned "${decision.action}". ${decision.reasoning ? `Agent reasoning: ${decision.reasoning}` : ''}`,
    };
  }

  return {
    pass: true,
    score: 1,
    reason: `action "${decision.action}" matches expectation`,
  };
}
