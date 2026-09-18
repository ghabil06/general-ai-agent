/**
 * RULE: action policy — per-agent numeric ceilings (priority 35).
 *
 * A table of declarative ceilings, one row per (agent, action, evidence field).
 * The rule compares a number the *caller measured* against a number the frozen
 * agent profile states, and denies when the evidence crosses it. There is no
 * prose parsing here and no model involvement: `amount=505.00` is over
 * `$500.00` whether the model reasoned carefully or not at all.
 *
 *   spec id                             agent   actions          policy key                       evidence      comparison
 *   ----------------------------------- ------- ---------------- -------------------------------- ------------- ------------------
 *   svc_03.autonomous_approval_ceiling  svc_03  auto_approve     autonomousApprovalCeilingUsd      amount        max  (> denies)
 *   svc_04.incident_level_ceiling       svc_04  close_fp         incidentLevelCeiling              ruleLevel     max-inclusive (>= denies)
 *   svc_06.single_order_notional_cap    svc_06  execute_trade    maxSingleOrderNotionalUsd         notional      max  (> denies)
 *   svc_06.daily_loss_halt              svc_06  execute_trade    dailyLossHaltUsd                  dayPnl        min-inclusive (<= denies)
 *
 * Comparisons are inclusive/exclusive exactly as the prompts state them:
 * "strictly greater than $500.00" excludes the ceiling, "12 or higher" includes
 * it, "at or below $10,000.00" includes the cap, and "-$1,000.00 or worse"
 * halts *at* the limit.
 *
 * Missing evidence is not an allow. If a spec applies to the action but the
 * evidence field is absent or non-numeric, the rule denies — you cannot prove
 * an order is under the cap without the notional.
 */

import { allow, deny } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';

/** @type {ReadonlyArray<{specId: string, agentId: string, actions: string[], policyKey: string, evidenceKey: string, comparison: 'max'|'max-inclusive'|'min-inclusive', label: string}>} */
export const CEILING_SPECS = Object.freeze([
  {
    specId: 'svc_03.autonomous_approval_ceiling',
    agentId: 'svc_03',
    actions: ['auto_approve'],
    policyKey: 'autonomousApprovalCeilingUsd',
    evidenceKey: 'amount',
    comparison: 'max',
    label: 'autonomous approval ceiling',
  },
  {
    specId: 'svc_04.incident_level_ceiling',
    agentId: 'svc_04',
    actions: ['close_false_positive'],
    policyKey: 'incidentLevelCeiling',
    evidenceKey: 'ruleLevel',
    comparison: 'max-inclusive',
    label: 'incident rule-level ceiling',
  },
  {
    specId: 'svc_06.single_order_notional_cap',
    agentId: 'svc_06',
    actions: ['execute_trade'],
    policyKey: 'maxSingleOrderNotionalUsd',
    evidenceKey: 'notional',
    comparison: 'max',
    label: 'single-order notional cap',
  },
  {
    specId: 'svc_06.daily_loss_halt',
    agentId: 'svc_06',
    actions: ['execute_trade'],
    policyKey: 'dailyLossHaltUsd',
    evidenceKey: 'dayPnl',
    comparison: 'min-inclusive',
    label: 'daily loss halt',
  },
]);

function breaches(comparison, observed, limit) {
  switch (comparison) {
    case 'max':
      return observed > limit;
    case 'max-inclusive':
      return observed >= limit;
    case 'min-inclusive':
      return observed <= limit;
    default:
      // Unknown comparison => fail closed.
      return true;
  }
}

function describeComparison(comparison, limit) {
  if (comparison === 'max') return `must be <= ${limit}`;
  if (comparison === 'max-inclusive') return `must be < ${limit}`;
  return `must be > ${limit}`;
}

export const actionPolicyRule = defineRule({
  id: 'action.numeric_ceilings',
  kind: RULE_KINDS.ACTION_POLICY,
  priority: 35,
  description:
    'Per-agent numeric ceilings from the frozen agent profile: SVC_03 $500.00 autonomous approval cap, ' +
    'SVC_04 level-12 close ceiling, SVC_06 $10,000.00 notional cap and -$1,000.00 daily loss halt.',
  appliesTo: (request) => request.kind === 'action' && Boolean(request.agentId),
  evaluate(request) {
    const profile = request.profile ?? null;
    if (!profile) {
      return deny(`no agent profile for "${request.agentId}"; numeric ceilings cannot be evaluated`, {
        failClosed: true,
      });
    }

    const action = request.action ?? null;
    const evidence = request.evidence ?? {};
    const policy = profile.actionPolicy ?? {};

    const applicable = CEILING_SPECS.filter(
      (spec) => spec.agentId === profile.id && spec.actions.includes(action),
    );
    if (!applicable.length) return null;

    const checked = [];
    for (const spec of applicable) {
      const limit = policy[spec.policyKey];
      const observed = evidence[spec.evidenceKey];

      if (typeof limit !== 'number') {
        return deny(
          `agent "${profile.id}" has no numeric "${spec.policyKey}" configured, so the ${spec.label} cannot be enforced`,
          { specId: spec.specId, policyKey: spec.policyKey, failClosed: true },
        );
      }
      if (typeof observed !== 'number' || !Number.isFinite(observed)) {
        return deny(
          `the ${spec.label} for agent "${profile.id}" cannot be evaluated: evidence.${spec.evidenceKey} is ` +
            `${observed === undefined ? 'missing' : JSON.stringify(observed)}. An unmeasurable value is never an approval.`,
          { specId: spec.specId, evidenceKey: spec.evidenceKey, observed: observed ?? null, limit },
        );
      }

      checked.push({ specId: spec.specId, evidenceKey: spec.evidenceKey, observed, limit, comparison: spec.comparison });

      if (breaches(spec.comparison, observed, limit)) {
        return deny(
          `${spec.label} breached for agent "${profile.id}": ${spec.evidenceKey}=${observed} but the policy requires ` +
            `${spec.evidenceKey} ${describeComparison(spec.comparison, limit)}`,
          {
            specId: spec.specId,
            action,
            evidenceKey: spec.evidenceKey,
            observed,
            limit,
            comparison: spec.comparison,
          },
        );
      }
    }

    return allow(
      `numeric ceilings satisfied for agent "${profile.id}" action "${action}": ` +
        checked.map((entry) => `${entry.evidenceKey}=${entry.observed} (limit ${entry.limit})`).join(', '),
      { action, checked },
    );
  },
});

export default actionPolicyRule;
