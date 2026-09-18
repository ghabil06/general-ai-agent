/**
 * RULES: the SVC boundaries, enforced in code (priority 30-32).
 *
 * These three rules are the reason this repository does not rely on a prompt
 * for its guardrails. They read *structured facts* — never prose, never the
 * model's own summary of events — and they are the executable form of the
 * DECISION PRECEDENCE sections of the three prompts.
 *
 * The disposition logic lives in `src/policy/boundaries.mjs` (`decideSvc03` /
 * `decideSvc04` / `decideSvc06`), which is a tested mirror of the `decide()`
 * functions in the three eval validators. These rules add the mapping from a
 * disposition to an engine verdict:
 *
 *   agent id | disposition                 | verdict
 *   ---------|-----------------------------|------------------
 *   svc_03   | auto_approve                | ALLOW if the mirror agrees, else DENY
 *   svc_03   | request_human_approval      | REQUIRE_APPROVAL
 *   svc_03   | reject_and_flag             | ALLOW  (moves nothing; flags for a human)
 *   svc_03   | anything else ('unparseable')| DENY
 *   svc_04   | close_false_positive        | ALLOW if the mirror agrees, else DENY
 *   svc_04   | create_incident             | ALLOW  (escalation is always permitted)
 *   svc_04   | request_analyst_review      | REQUIRE_APPROVAL
 *   svc_04   | anything else               | DENY
 *   svc_06   | execute_trade               | ALLOW if the mirror agrees, else DENY
 *   svc_06   | no_trade                    | ALLOW
 *   svc_06   | escalate_to_human           | REQUIRE_APPROVAL
 *   svc_06   | anything else               | DENY
 *
 * Each rule also handles the *tool call* form of the boundary it owns, because
 * a model can try to reach the boundary through a tool instead of through its
 * declared action:
 *   - svc_06: `submit_paper_order` is re-checked against the order cap,
 *     instrument allowlist (exact match), long-only, real-account refusal and
 *     the daily-loss halt before it can write anything.
 *   - svc_03: `request_human_approval` is the escalation path and is allowed
 *     for a human to pick up; every other invoice tool is read-only.
 *   - svc_04: `create_incident_ticket` and `request_analyst_review` are the
 *     escalation paths; nothing here may close, block or isolate.
 */

import { allow, deny, requireApproval } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';
import { BOUNDARIES, isRealAccountRequest } from '../../config/agents.mjs';
import { decideSvc03, decideSvc04, decideSvc06, UNPARSEABLE } from '../boundaries.mjs';

/** Disposition -> verdict maps, one per agent. Exported so tests pin them. */
export const DISPOSITION_VERDICTS = Object.freeze({
  svc_03: Object.freeze({
    auto_approve: 'ALLOW_IF_MIRROR_AGREES',
    request_human_approval: 'REQUIRE_APPROVAL',
    reject_and_flag: 'ALLOW',
  }),
  svc_04: Object.freeze({
    close_false_positive: 'ALLOW_IF_MIRROR_AGREES',
    create_incident: 'ALLOW',
    request_analyst_review: 'REQUIRE_APPROVAL',
  }),
  svc_06: Object.freeze({
    execute_trade: 'ALLOW_IF_MIRROR_AGREES',
    no_trade: 'ALLOW',
    escalate_to_human: 'REQUIRE_APPROVAL',
  }),
});

function dispositionReasonLabel(agentId, disposition) {
  const mapping = DISPOSITION_VERDICTS[agentId][disposition];
  return mapping ?? 'DENY (unknown disposition)';
}

/** Shared shape: read the agent id, ignore requests for other agents. */
function appliesToAgent(agentId) {
  return (request) => request.agentId === agentId || request.profile?.id === agentId;
}

// ───────────────────────────────────────────────────────────────────────────
// SVC_03 — accounts payable: $500.00 autonomous approval ceiling, verified PO,
// zero variance. Anything else escalates or is rejected.
// ───────────────────────────────────────────────────────────────────────────
export const svc03BoundaryRule = defineRule({
  id: 'svc_03.invoice_boundary',
  kind: RULE_KINDS.SVC_BOUNDARY,
  priority: 30,
  description:
    'SVC_03: autonomous approval only when the amount is determinable and <= $500.00, the PO is verified ' +
    'and the variance is exactly zero. Missing/unverified PO or un-determinable amount is rejected.',
  appliesTo: (request) =>
    appliesToAgent('svc_03')(request) && (request.kind === 'action' || (request.kind === 'tool_call' && Boolean(request.tool))),
  evaluate(request) {
    if (request.kind === 'tool_call') return evaluateSvc03ToolCall(request);
    return evaluateSvc03Action(request);
  },
});

function evaluateSvc03Action(request) {
  const action = request.action ?? UNPARSEABLE;
  const evidence = request.evidence ?? {};

  const facts = {
    amount: evidence.amount ?? null,
    poPresent: evidence.poPresent ?? false,
    poVerified: evidence.poVerified ?? false,
    variance: evidence.variance ?? null,
  };
  const mirror = decideSvc03(facts);
  const base = {
    action,
    mirrorDisposition: mirror,
    facts,
    boundary: BOUNDARIES.svc_03,
    mappedVerdict: dispositionReasonLabel('svc_03', action),
  };

  if (!Object.prototype.hasOwnProperty.call(DISPOSITION_VERDICTS.svc_03, action)) {
    return deny(
      `SVC_03 produced disposition "${action}", which is not one of ` +
        `${Object.keys(DISPOSITION_VERDICTS.svc_03).join(', ')}; an unparseable or unknown disposition is never an approval`,
      base,
    );
  }

  if (action === 'request_human_approval') {
    return requireApproval('SVC_03 invoice escalated to a human approver (boundary or variance reached)', base);
  }
  if (action === 'reject_and_flag') {
    if (mirror !== 'reject_and_flag') {
      // The agent is refusing an invoice the rules would have escalated or even
      // approved. Refusing to pay moves no money, so it is never blocked, but
      // the disagreement goes to a human rather than being silently accepted.
      return requireApproval(
        `SVC_03 rejected an invoice the boundary rules would have dispositioned "${mirror}"; ` +
          'refusing to pay is safe, but the invoice is flagged for human review of the disagreement',
        { ...base, disagreement: true },
      );
    }
    return allow('SVC_03 rejected and flagged the invoice; no payment is authorised by this action', base);
  }

  // action === 'auto_approve'
  if (mirror !== 'auto_approve') {
    return deny(
      `SVC_03 proposed auto_approve but the boundary rules require "${mirror}" ` +
        `(amount=${facts.amount}, po_verified=${facts.poVerified}, variance=${facts.variance}, ` +
        `ceiling=$${BOUNDARIES.svc_03.autonomousApprovalCeilingUsd.toFixed(2)})`,
      base,
    );
  }

  return allow(
    `SVC_03 autonomous approval within boundary: $${Number(facts.amount).toFixed(2)} <= ` +
      `$${BOUNDARIES.svc_03.autonomousApprovalCeilingUsd.toFixed(2)}, PO verified, zero variance`,
    base,
  );
}

function evaluateSvc03ToolCall(request) {
  const tool = request.tool;
  const base = { tool: tool.name, sideEffect: tool.sideEffect };

  if (tool.escalation === true) {
    return allow(`SVC_03 escalation tool "${tool.name}" is the sanctioned path to a human approver`, base);
  }
  if (tool.sideEffect === 'read' || tool.sideEffect === 'none') {
    return allow(`SVC_03 read-only tool "${tool.name}" cannot move money`, base);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// SVC_04 — security triage: level-12 ceiling, exact-match IP allowlist,
// corroboration escalation. Never close above the ceiling.
// ───────────────────────────────────────────────────────────────────────────
export const svc04BoundaryRule = defineRule({
  id: 'svc_04.triage_boundary',
  kind: RULE_KINDS.SVC_BOUNDARY,
  priority: 31,
  description:
    'SVC_04: rule level >= 12 always creates an incident, corroboration always escalates, allowlist is an ' +
    'exact-string match, and an incomplete or non-numeric level escalates. Never auto-close above the ceiling.',
  appliesTo: (request) =>
    appliesToAgent('svc_04')(request) && (request.kind === 'action' || (request.kind === 'tool_call' && Boolean(request.tool))),
  evaluate(request) {
    if (request.kind === 'tool_call') return evaluateSvc04ToolCall(request);
    return evaluateSvc04Action(request);
  },
});

function evaluateSvc04Action(request) {
  const action = request.action ?? UNPARSEABLE;
  const evidence = request.evidence ?? {};
  const facts = {
    complete: evidence.complete,
    ruleLevel: evidence.ruleLevel,
    injection: evidence.injection,
    corroboration: evidence.corroboration,
    allowlisted: evidence.allowlisted,
    fpPattern: evidence.fpPattern,
  };
  const mirror = decideSvc04(facts);
  const base = {
    action,
    mirrorDisposition: mirror,
    facts,
    boundary: BOUNDARIES.svc_04,
    mappedVerdict: dispositionReasonLabel('svc_04', action),
  };

  if (!Object.prototype.hasOwnProperty.call(DISPOSITION_VERDICTS.svc_04, action)) {
    return deny(`SVC_04 produced unknown disposition "${action}"; only an explicit disposition may act`, base);
  }

  if (action === 'create_incident') {
    return allow('SVC_04 opened an incident ticket; escalation is always permitted and freer than closing', base);
  }
  if (action === 'request_analyst_review') {
    return requireApproval('SVC_04 handed the alert to an analyst for review', base);
  }

  // action === 'close_false_positive'
  if (mirror !== 'close_false_positive') {
    const ceiling = BOUNDARIES.svc_04.incidentLevelCeiling;
    const detail =
      typeof facts.ruleLevel === 'number' && facts.ruleLevel >= ceiling
        ? `rule level ${facts.ruleLevel} is at or above the level-${ceiling} ceiling: it can never be auto-closed`
        : `the boundary rules require "${mirror}" for complete=${facts.complete}, rule_level=${facts.ruleLevel}, ` +
          `allowlisted=${facts.allowlisted}, fp_pattern=${facts.fpPattern}, corroboration=${facts.corroboration}`;
    return deny(`SVC_04 proposed close_false_positive but ${detail}`, base);
  }

  return allow(
    `SVC_04 auto-close authorised: rule level ${facts.ruleLevel} < ${BOUNDARIES.svc_04.incidentLevelCeiling}, ` +
      'source IP exactly on the allowlist, documented FP pattern verified, no corroboration',
    base,
  );
}

function evaluateSvc04ToolCall(request) {
  const tool = request.tool;
  const base = { tool: tool.name, sideEffect: tool.sideEffect };
  const level = request.evidence?.ruleLevel;

  if (tool.name === 'create_incident_ticket') {
    if (typeof level === 'number' && level < 0) {
      return deny(`SVC_04 incident ticket has an impossible rule level ${level}`, base);
    }
    return allow(`SVC_04 tool "${tool.name}" opens an incident; opening is always within authority`, base);
  }
  if (tool.escalation === true) {
    return allow(`SVC_04 escalation tool "${tool.name}" routes to a human analyst`, base);
  }
  if (tool.sideEffect === 'read' || tool.sideEffect === 'none') {
    return allow(`SVC_04 read-only tool "${tool.name}" cannot contain or close anything`, base);
  }
  // A state-changing SVC_04 tool that is neither an incident nor an escalation
  // would be a containment action, which directive 2 forbids.
  return deny(
    `SVC_04 tool "${tool.name}" changes state but is neither an incident ticket nor an escalation; ` +
      'containment is executed by deterministic SOAR playbooks after human approval, never by this agent',
    base,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// SVC_06 — paper trading: $10,000 notional cap, instrument allowlist exact
// match, long-only, daily-loss halt, symbol halt, no real-account routing.
// ───────────────────────────────────────────────────────────────────────────
export const svc06BoundaryRule = defineRule({
  id: 'svc_06.trading_boundary',
  kind: RULE_KINDS.SVC_BOUNDARY,
  priority: 32,
  description:
    'SVC_06: real-account routing refused outright, exact-ticker allowlist, determinable size, notional <= ' +
    '$10,000.00, long-only, daily-loss halt at -$1,000.00 and exchange halts stop trading. Paper only.',
  appliesTo: (request) =>
    appliesToAgent('svc_06')(request) && (request.kind === 'action' || (request.kind === 'tool_call' && Boolean(request.tool))),
  evaluate(request) {
    if (request.kind === 'tool_call') return evaluateSvc06ToolCall(request);
    return evaluateSvc06Action(request);
  },
});

function evaluateSvc06Action(request) {
  const action = request.action ?? UNPARSEABLE;
  const evidence = request.evidence ?? {};
  const facts = {
    realAccount: evidence.realAccount,
    ticker: evidence.ticker,
    notionalDeterminable: evidence.notionalDeterminable,
    notional: evidence.notional,
    injection: evidence.injection,
    sellExceedsHoldings: evidence.sellExceedsHoldings,
    dayPnl: evidence.dayPnl,
    symbolHalted: evidence.symbolHalted,
  };
  const mirror = decideSvc06(facts);
  const base = {
    action,
    mirrorDisposition: mirror,
    facts,
    boundary: BOUNDARIES.svc_06,
    mappedVerdict: dispositionReasonLabel('svc_06', action),
  };

  if (!Object.prototype.hasOwnProperty.call(DISPOSITION_VERDICTS.svc_06, action)) {
    return deny(`SVC_06 produced unknown disposition "${action}"; only an explicit disposition may act`, base);
  }

  if (action === 'no_trade') {
    return allow('SVC_06 declined to trade (halt, loss limit or market close); no order will be sent', base);
  }
  if (action === 'escalate_to_human') {
    return requireApproval('SVC_06 escalated the order to a human reviewer', base);
  }

  // action === 'execute_trade'
  if (mirror !== 'execute_trade') {
    return deny(
      `SVC_06 proposed execute_trade but the boundary rules require "${mirror}" ` +
        `(ticker=${facts.ticker}, notional=${facts.notional}, real_account=${facts.realAccount}, ` +
        `day_pnl=${facts.dayPnl}, halted=${facts.symbolHalted}, sell_exceeds_holdings=${facts.sellExceedsHoldings})`,
      base,
    );
  }

  return allow(
    `SVC_06 paper order authorised: ${facts.ticker} notional $${Number(facts.notional).toFixed(2)} <= ` +
      `$${BOUNDARIES.svc_06.maxSingleOrderNotionalUsd.toFixed(2)}, on the instrument allowlist, long-only satisfied, ` +
      `day P&L $${Number(facts.dayPnl).toFixed(2)} above the $${Math.abs(BOUNDARIES.svc_06.dailyLossHaltUsd).toFixed(2)} halt`,
    base,
  );
}

function evaluateSvc06ToolCall(request) {
  const tool = request.tool;
  const args = request.args ?? {};
  const base = { tool: tool.name, sideEffect: tool.sideEffect };

  if (tool.name !== 'submit_paper_order') {
    if (tool.escalation === true) {
      return allow(`SVC_06 escalation tool "${tool.name}" routes the order to a human`, base);
    }
    if (tool.sideEffect === 'read' || tool.sideEffect === 'none') {
      return allow(`SVC_06 read-only tool "${tool.name}" cannot place an order`, base);
    }
    return deny(
      `SVC_06 tool "${tool.name}" writes state but is not the single sanctioned order path (submit_paper_order); ` +
        'refusing to guess what it does',
      base,
    );
  }

  // The order path. Re-derive every boundary from the arguments, because the
  // model — not the fixture — supplied them.
  const quantity = typeof args.quantity === 'number' ? args.quantity : null;
  const limitPrice = typeof args.limitPrice === 'number' ? args.limitPrice : null;
  const hasNotional = typeof args.notional === 'number';
  const notional = hasNotional
    ? args.notional
    : quantity !== null && limitPrice !== null
      ? Math.round(quantity * limitPrice * 100) / 100
      : null;

  const portfolio = request.evidence?.portfolio ?? {};
  const held = typeof portfolio.positions?.[args.ticker] === 'number' ? portfolio.positions[args.ticker] : null;
  const side = String(args.side ?? (quantity !== null && quantity < 0 ? 'sell' : 'buy')).toLowerCase();
  const shares = quantity === null ? null : Math.abs(quantity);
  const sellExceedsHoldings = side === 'sell' && (held === null || shares === null || shares > held);

  const orderFacts = {
    // Shared with the tool itself, so policy and tool cannot disagree about
    // what "real", "live", "production", "prod" or "margin" means.
    realAccount: isRealAccountRequest(args),
    ticker: args.ticker,
    notionalDeterminable: notional !== null && Number.isFinite(notional),
    notional: notional ?? 0,
    injection: request.evidence?.injection === true,
    sellExceedsHoldings,
    dayPnl: typeof portfolio.realizedDayPnl === 'number' ? portfolio.realizedDayPnl : 0,
    symbolHalted: typeof args.halted === 'boolean' ? args.halted : request.evidence?.symbolHalted === true,
  };

  const mirror = decideSvc06(orderFacts);
  const evidence = {
    ...base,
    order: { ticker: args.ticker ?? null, side, quantity, limitPrice, notional },
    facts: orderFacts,
    mirrorDisposition: mirror,
    boundary: BOUNDARIES.svc_06,
  };

  if (orderFacts.realAccount) {
    return deny(
      'SVC_06 order requests real-account routing; there is no real-money path in this agent, ' +
        'and no desk message or configuration can create one',
      evidence,
    );
  }

  if (mirror !== 'execute_trade') {
    return deny(
      `SVC_06 order refused by the trading boundary rules, which require "${mirror}" ` +
        `(ticker=${orderFacts.ticker}, notional=${orderFacts.notional}, allowlist=${BOUNDARIES.svc_06.instrumentAllowlist.join('/')}, ` +
        `day_pnl=${orderFacts.dayPnl}, halted=${orderFacts.symbolHalted}, sell_exceeds_holdings=${sellExceedsHoldings})`,
      evidence,
    );
  }

  return allow(
    `SVC_06 paper order authorised before submission: ${orderFacts.ticker} notional ` +
      `$${orderFacts.notional.toFixed(2)} within the $${BOUNDARIES.svc_06.maxSingleOrderNotionalUsd.toFixed(2)} cap`,
    evidence,
  );
}

export const svcBoundaryRules = Object.freeze([svc03BoundaryRule, svc04BoundaryRule, svc06BoundaryRule]);

export default svcBoundaryRules;
