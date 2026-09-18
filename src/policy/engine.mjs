/**
 * Policy / guardrail kernel.
 *
 * Real implementation. Deterministic, pure, fail-closed. This is the component
 * that makes "a prompt is a policy statement; it is not a control" true in
 * code: the SVC boundaries are enforced here against structured facts, whatever
 * the model said and whatever the prompt contains.
 *
 * ── Rule contract ───────────────────────────────────────────────────────────
 * A rule is `{ id, kind, priority, description, appliesTo(request), evaluate(request) }`.
 *   - `evaluate` is PURE: no I/O, no clock (read `request.now`), no mutation of
 *     `request`, no randomness. Same request in, same decision out.
 *   - `evaluate` returns `null` ("not applicable, no opinion") or
 *     `{ decision, reason, evidence }`.
 *   - `decision` is exactly one of `ALLOW` / `DENY` / `REQUIRE_APPROVAL`.
 *
 * ── Evaluation ──────────────────────────────────────────────────────────────
 *   1. Rules are ordered by `priority` ascending, ties broken by `id`
 *      ascending — a stable, total order.
 *   2. Every applicable rule is evaluated; a throwing rule is treated as a
 *      DENY (`rule.evaluate_threw`), never as an allow.
 *   3. The kernel returns the most restrictive decision fired. The reporting
 *      rule is the first firing, in priority order, at that restrictiveness.
 *   4. If no rule fires, the decision is `defaultDecision`, which defaults to
 *      DENY with reason "no rule matched; failing closed". Unknown tool,
 *      unknown agent, un-evaluable rule => DENY.
 *
 * ── Request shape ───────────────────────────────────────────────────────────
 *   {
 *     kind: 'tool_call' | 'action' | 'input',
 *     runId, sessionId, agentId,
 *     profile,                    // agent profile (src/config/agents.mjs)
 *     tool,                       // tool definition, for kind 'tool_call'
 *     args,                       // proposed tool arguments
 *     action,                     // proposed agent action, for kind 'action'
 *     evidence,                   // structured facts the rules decide on
 *     untrusted,                  // { text, source } attacker-controlled data
 *     history,                    // { toolCalls: [{ name, args, at }] }
 *     now,                        // epoch ms; injected so rules stay pure
 *   }
 */

import { DECISIONS } from './decisions.mjs';

export { DECISIONS };

/** Strictness ranking. Higher wins when rules disagree. */
export const DECISION_SEVERITY = Object.freeze({
  ALLOW: 0,
  REQUIRE_APPROVAL: 1,
  DENY: 2,
});

/** Rule kinds. Stable strings — used in traces, tests and docs. */
export const RULE_KINDS = Object.freeze({
  INPUT_VALIDATION: 'input_validation',
  PROMPT_INJECTION: 'prompt_injection',
  TOOL_AUTHORIZATION: 'tool_authorization',
  DATA_ACCESS: 'data_access',
  ACTION_POLICY: 'action_policy',
  SVC_BOUNDARY: 'svc_boundary',
  RATE_LIMIT: 'rate_limit',
  DESTRUCTIVE_ACTION: 'destructive_action',
  REQUIRED_APPROVAL: 'required_approval',
});

/** Kinds whose `evaluate` must never touch the outside world. Enforced at define time. */
const REQUEST_KINDS = Object.freeze(['tool_call', 'action', 'input']);

export class PolicyDefinitionError extends Error {
  constructor(message, { rule } = {}) {
    super(message);
    this.name = 'PolicyDefinitionError';
    this.rule = rule ?? null;
  }
}

/**
 * Validate, order-check and freeze a rule.
 * @param {object} rule
 * @returns {object} frozen rule
 */
export function defineRule(rule) {
  if (rule === null || typeof rule !== 'object') throw new PolicyDefinitionError('defineRule: rule must be an object');

  const { id, kind, priority, description, appliesTo, evaluate } = rule;

  if (typeof id !== 'string' || !/^[a-z0-9_.:-]+$/i.test(id)) {
    throw new PolicyDefinitionError(`defineRule: invalid rule id ${JSON.stringify(id)}`, { rule: id });
  }
  if (!Object.values(RULE_KINDS).includes(kind)) {
    throw new PolicyDefinitionError(
      `defineRule: rule "${id}" has unknown kind "${kind}" (known: ${Object.values(RULE_KINDS).join(', ')})`,
      { rule: id },
    );
  }
  if (!Number.isInteger(priority)) {
    throw new PolicyDefinitionError(`defineRule: rule "${id}" needs an integer priority`, { rule: id });
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new PolicyDefinitionError(`defineRule: rule "${id}" needs a description`, { rule: id });
  }
  if (typeof evaluate !== 'function') {
    throw new PolicyDefinitionError(`defineRule: rule "${id}" needs an evaluate(request) function`, { rule: id });
  }
  if (appliesTo !== undefined && typeof appliesTo !== 'function') {
    throw new PolicyDefinitionError(`defineRule: rule "${id}" appliesTo must be a function when present`, { rule: id });
  }

  return Object.freeze({
    id,
    kind,
    priority,
    description,
    appliesTo: appliesTo ?? ((request) => REQUEST_KINDS.includes(request?.kind)),
    evaluate,
  });
}

/** Sort by priority ascending, then id ascending. Total order, no randomness. */
export function orderRules(rules) {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function makeDecision(decision, rule, reason, evidence = {}) {
  return Object.freeze({ decision, rule, reason, evidence });
}

/**
 * @param {object}   [options]
 * @param {Array}    [options.rules]
 * @param {string}   [options.defaultDecision]  defaults to DENY — fail closed
 * @param {Function} [options.now]
 * @param {Function} [options.onDecision]       observability hook
 */
export function createPolicyKernel({
  rules = [],
  defaultDecision = DECISIONS.DENY,
  now = () => Date.now(),
  onDecision,
} = {}) {
  if (!Object.values(DECISIONS).includes(defaultDecision)) {
    throw new PolicyDefinitionError(`createPolicyKernel: defaultDecision must be one of ${Object.values(DECISIONS).join(', ')}`);
  }
  const ordered = orderRules(rules.map((rule) => (Object.isFrozen(rule) ? rule : defineRule(rule))));

  /**
   * @param {object} request see module docstring
   * @returns {{decision: string, rule: string, kind: string|null, reason: string,
   *            evidence: object, checks: Array, decidedAt: number}}
   */
  function evaluate(request = {}) {
    const enriched = { now: request.now ?? now(), ...request };
    const checks = [];
    const firings = [];

    for (const rule of ordered) {
      let applies;
      try {
        applies = Boolean(rule.appliesTo(enriched));
      } catch (err) {
        checks.push({
          rule: rule.id,
          kind: rule.kind,
          priority: rule.priority,
          applied: true,
          decision: DECISIONS.DENY,
          reason: `rule.appliesTo threw: ${err.message}`,
          evidence: { error: err.message, failClosed: true },
        });
        firings.push(makeDecision(DECISIONS.DENY, rule.id, `rule.appliesTo threw: ${err.message}`, { failClosed: true }));
        continue;
      }
      if (!applies) continue;

      let outcome;
      try {
        outcome = rule.evaluate(enriched);
      } catch (err) {
        outcome = {
          decision: DECISIONS.DENY,
          reason: `rule "${rule.id}" threw: ${err.message}`,
          evidence: { error: err.message, failClosed: true },
        };
      }
      if (outcome === null || outcome === undefined) {
        checks.push({ rule: rule.id, kind: rule.kind, priority: rule.priority, applied: true, decision: null });
        continue;
      }
      if (!Object.values(DECISIONS).includes(outcome.decision)) {
        checks.push({
          rule: rule.id,
          kind: rule.kind,
          priority: rule.priority,
          applied: true,
          decision: DECISIONS.DENY,
          reason: `rule "${rule.id}" returned an invalid decision ${JSON.stringify(outcome.decision)}`,
        });
        firings.push(
          makeDecision(DECISIONS.DENY, rule.id, `rule returned an invalid decision ${JSON.stringify(outcome.decision)}`, {
            failClosed: true,
          }),
        );
        continue;
      }

      const check = {
        rule: rule.id,
        kind: rule.kind,
        priority: rule.priority,
        applied: true,
        decision: outcome.decision,
        reason: outcome.reason ?? rule.description,
        evidence: outcome.evidence ?? {},
      };
      checks.push(check);
      firings.push(makeDecision(outcome.decision, rule.id, check.reason, check.evidence));
    }

    let result;
    if (!firings.length) {
      result = makeDecision(
        defaultDecision,
        'engine.default',
        `no policy rule matched this request; failing closed with ${defaultDecision}`,
        { failClosed: true, requestKind: enriched.kind ?? null },
      );
    } else {
      const worst = firings.reduce(
        (acc, firing) => (DECISION_SEVERITY[firing.decision] > DECISION_SEVERITY[acc.decision] ? firing : acc),
        firings[0],
      );
      result = worst;
    }

    const outcome = Object.freeze({
      decision: result.decision,
      rule: result.rule,
      kind: compareKind(result.rule, ordered),
      reason: result.reason,
      evidence: result.evidence,
      checks,
      firedRules: firings.map((f) => ({ rule: f.rule, decision: f.decision })),
      decidedAt: enriched.now,
      request: {
        kind: enriched.kind ?? null,
        agentId: enriched.agentId ?? null,
        tool: enriched.tool?.name ?? null,
        action: enriched.action ?? null,
      },
    });

    if (typeof onDecision === 'function') {
      try {
        onDecision(outcome, enriched);
      } catch {
        // observability must not break the kernel
      }
    }
    return outcome;
  }

  function compareKind(ruleId, rulesList) {
    return rulesList.find((rule) => rule.id === ruleId)?.kind ?? null;
  }

  /** Sugar for callers that only need the verdict. */
  function decide(request) {
    return evaluate(request).decision;
  }

  return {
    rules: ordered,
    defaultDecision,
    evaluate,
    decide,
    /** What the model may NOT see: the rules' existence is not negotiable. */
    describe() {
      return ordered.map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        priority: rule.priority,
        description: rule.description,
      }));
    },
  };
}
