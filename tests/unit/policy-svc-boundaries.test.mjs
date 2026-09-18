/**
 * The SVC boundaries: the dataset replay, and the ALLOW / DENY /
 * REQUIRE_APPROVAL verdicts the policy kernel derives from them.
 *
 * The replay half of this file is the most important test in the repository
 * after the eval gates themselves: it takes all 36 cases from the three real
 * datasets in `evals/`, feeds each case's structured `case_*` variables through
 * `src/policy/boundaries.mjs`, and requires the answer to equal the dataset's
 * own `expected_action`. If the written policy and the enforced policy ever
 * drift, this goes red.
 *
 * It reads the datasets. It never writes them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideSvc03, decideSvc04, decideSvc06 } from '../../src/policy/boundaries.mjs';
import { AGENT_PROFILES, BOUNDARIES } from '../../src/config/agents.mjs';
import { svcBoundaryRules } from '../../src/policy/rules/svc-boundaries.mjs';
import { createPolicyKernel, DECISIONS } from '../../src/policy/engine.mjs';
import { DEFAULT_RULES } from '../../src/policy/rules/index.mjs';
import { loadDataset } from '../helpers/fixtures.mjs';

const kernel = createPolicyKernel({ rules: svcBoundaryRules });

const svc03Facts = (vars) => ({
  amount: vars.case_amount ?? null,
  poPresent: vars.case_po_present ?? false,
  poVerified: vars.case_po_verified ?? false,
  variance: vars.case_variance ?? null,
});

const svc04Facts = (vars) => ({
  complete: vars.case_complete,
  ruleLevel: vars.case_rule_level,
  injection: vars.case_injection,
  corroboration: vars.case_corroboration,
  allowlisted: vars.case_allowlisted,
  fpPattern: vars.case_fp_pattern,
});

const svc06Facts = (vars) => ({
  realAccount: vars.case_real_account,
  ticker: vars.case_ticker,
  notionalDeterminable: vars.case_notional_determinable,
  notional: vars.case_notional,
  injection: vars.case_injection,
  sellExceedsHoldings: vars.case_sell_exceeds_holdings,
  dayPnl: vars.case_day_pnl,
  symbolHalted: vars.case_symbol_halted,
});

// ── the replay ─────────────────────────────────────────────────────────────

test('SVC_03: all 12 dataset cases reproduce the expected disposition', () => {
  const cases = loadDataset('invoices_dataset.json');
  assert.equal(cases.length, 12);
  for (const [index, testCase] of cases.entries()) {
    const { expected_action: expected } = testCase.vars;
    const actual = decideSvc03(svc03Facts(testCase.vars));
    assert.equal(actual, expected, `case ${index + 1} (${testCase.vars.case_category}): ${testCase.description}`);
  }
});

test('SVC_04: all 12 dataset cases reproduce the expected disposition', () => {
  const cases = loadDataset('security_alerts_dataset.json');
  assert.equal(cases.length, 12);
  for (const [index, testCase] of cases.entries()) {
    const { expected_action: expected } = testCase.vars;
    const actual = decideSvc04(svc04Facts(testCase.vars));
    assert.equal(actual, expected, `case ${index + 1} (${testCase.vars.case_category}): ${testCase.description}`);
  }
});

test('SVC_06: all 12 dataset cases reproduce the expected disposition', () => {
  const cases = loadDataset('trading_dataset.json');
  assert.equal(cases.length, 12);
  for (const [index, testCase] of cases.entries()) {
    const { expected_action: expected } = testCase.vars;
    const actual = decideSvc06(svc06Facts(testCase.vars));
    assert.equal(actual, expected, `case ${index + 1} (${testCase.vars.case_category}): ${testCase.description}`);
  }
});

// ── SVC_03: $500.00 ceiling, verified PO, zero variance ─────────────────────

test('SVC_03 boundary: ALLOW at and below $500.00 with a verified PO and zero variance', () => {
  for (const amount of [0, 200, 499.99, 500]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_03',
      profile: AGENT_PROFILES.svc_03,
      action: 'auto_approve',
      evidence: { amount, poPresent: true, poVerified: true, variance: 0 },
    });
    assert.equal(outcome.decision, DECISIONS.ALLOW, `amount ${amount} should be autonomously approvable`);
    assert.equal(outcome.rule, 'svc_03.invoice_boundary');
  }
});

test('SVC_03 boundary: DENY above the ceiling, one cent included', () => {
  for (const amount of [500.01, 505, 850, 900]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_03',
      profile: AGENT_PROFILES.svc_03,
      action: 'auto_approve',
      evidence: { amount, poPresent: true, poVerified: true, variance: 0 },
    });
    assert.equal(outcome.decision, DECISIONS.DENY, `amount ${amount} must not be auto-approved`);
    assert.match(outcome.reason, /require|ceiling/);
  }
});

test('SVC_03 boundary: DENY on an unverified or absent PO, and on any non-zero variance', () => {
  const unverified = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_03',
    profile: AGENT_PROFILES.svc_03,
    action: 'auto_approve',
    evidence: { amount: 310, poPresent: true, poVerified: false, variance: 0 },
  });
  assert.equal(unverified.decision, DECISIONS.DENY);
  assert.match(unverified.reason, /reject_and_flag/);

  const noPo = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_03',
    profile: AGENT_PROFILES.svc_03,
    action: 'auto_approve',
    evidence: { amount: 120, poPresent: false, poVerified: false, variance: 0 },
  });
  assert.equal(noPo.decision, DECISIONS.DENY);

  for (const variance of [0.01, 3, 39]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_03',
      profile: AGENT_PROFILES.svc_03,
      action: 'auto_approve',
      evidence: { amount: 429, poPresent: true, poVerified: true, variance },
    });
    assert.equal(outcome.decision, DECISIONS.DENY, `variance ${variance} must not be rounded away`);
  }
});

test('SVC_03 boundary: an undeterminable amount is DENY, never an approval', () => {
  const outcome = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_03',
    profile: AGENT_PROFILES.svc_03,
    action: 'auto_approve',
    evidence: { amount: null, poPresent: true, poVerified: true, variance: null },
  });
  assert.equal(outcome.decision, DECISIONS.DENY);
});

test('SVC_03 boundary: escalation requires approval; rejection is allowed; junk is denied', () => {
  const escalate = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_03',
    profile: AGENT_PROFILES.svc_03,
    action: 'request_human_approval',
    evidence: { amount: 850, poPresent: true, poVerified: true, variance: 0 },
  });
  assert.equal(escalate.decision, DECISIONS.REQUIRE_APPROVAL);

  const reject = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_03',
    profile: AGENT_PROFILES.svc_03,
    action: 'reject_and_flag',
    evidence: { amount: null, poPresent: false, poVerified: false, variance: 0 },
  });
  assert.equal(reject.decision, DECISIONS.ALLOW);

  const junk = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_03',
    profile: AGENT_PROFILES.svc_03,
    action: 'unparseable',
    evidence: { amount: 100, poPresent: true, poVerified: true, variance: 0 },
  });
  assert.equal(junk.decision, DECISIONS.DENY);
  assert.match(junk.reason, /not one of auto_approve, request_human_approval, reject_and_flag/);
});

// ── SVC_04: level-12 ceiling, exact allowlist, corroboration ────────────────

test('SVC_04 boundary: DENY auto-close at or above level 12, ALLOW below it with a complete FP pattern', () => {
  for (const ruleLevel of [12, 13, 14, 15]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_04',
      profile: AGENT_PROFILES.svc_04,
      action: 'close_false_positive',
      evidence: { complete: true, ruleLevel, allowlisted: true, fpPattern: true, corroboration: false, injection: false },
    });
    assert.equal(outcome.decision, DECISIONS.DENY, `level ${ruleLevel} must never be auto-closed`);
    assert.match(outcome.reason, /level 1[2-5] is at or above the level-12 ceiling|never be auto-closed/);
  }

  for (const ruleLevel of [6, 11]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_04',
      profile: AGENT_PROFILES.svc_04,
      action: 'close_false_positive',
      evidence: { complete: true, ruleLevel, allowlisted: true, fpPattern: true, corroboration: false, injection: false },
    });
    assert.equal(outcome.decision, DECISIONS.ALLOW, `level ${ruleLevel} with a verified pattern may close`);
  }
});

test('SVC_04 boundary: DENY when the allowlist match, the pattern or completeness is missing', () => {
  const base = { complete: true, ruleLevel: 5, allowlisted: true, fpPattern: true, corroboration: false, injection: false };
  for (const mutation of [
    { allowlisted: false, note: 'near miss IP' },
    { fpPattern: false, note: 'no documented pattern' },
    { complete: false, note: 'incomplete alert record' },
    { corroboration: true, note: 'corroborating signals' },
    { injection: true, note: 'override attempt' },
    { ruleLevel: 'HIGH', note: 'non-numeric level' },
    { ruleLevel: 42, note: 'out-of-range level' },
  ]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_04',
      profile: AGENT_PROFILES.svc_04,
      action: 'close_false_positive',
      evidence: { ...base, ...mutation },
    });
    assert.equal(outcome.decision, DECISIONS.DENY, `${mutation.note} must block auto-close`);
  }
});

test('SVC_04 boundary: corroboration escalates to an incident, review requires approval', () => {
  const incident = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_04',
    profile: AGENT_PROFILES.svc_04,
    action: 'create_incident',
    evidence: { complete: true, ruleLevel: 7, allowlisted: true, fpPattern: true, corroboration: true, injection: false },
  });
  assert.equal(incident.decision, DECISIONS.ALLOW, 'opening an incident is always permitted');

  const review = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_04',
    profile: AGENT_PROFILES.svc_04,
    action: 'request_analyst_review',
    evidence: { complete: false, ruleLevel: 7 },
  });
  assert.equal(review.decision, DECISIONS.REQUIRE_APPROVAL);
});

test('SVC_04 boundary: a non-triage tool that changes state is denied', () => {
  const isolate = {
    name: 'isolate_host',
    riskLevel: 'high',
    sideEffect: 'external',
    escalation: false,
    permissions: [],
    dataAccess: [],
    inputSchema: { type: 'object' },
  };
  const outcome = kernel.evaluate({
    kind: 'tool_call',
    agentId: 'svc_04',
    profile: AGENT_PROFILES.svc_04,
    tool: isolate,
    args: { host: 'prod-db-01' },
  });
  assert.equal(outcome.decision, DECISIONS.DENY);
  const reasons = outcome.checks.filter((check) => check.decision === DECISIONS.DENY).map((check) => check.reason);
  assert.ok(
    reasons.some((reason) => /containment is executed by deterministic SOAR playbooks/.test(reason)),
    reasons.join(' | '),
  );

  // With the full default rule set the same call is denied three times over:
  // the triage boundary refuses containment, tool authorisation refuses an
  // unlisted tool, and the destructive-action rule pauses anything high-risk.
  // Independent rules, all fail-closed.
  const fullKernel = createPolicyKernel({ rules: DEFAULT_RULES });
  const fullOutcome = fullKernel.evaluate({
    kind: 'tool_call',
    agentId: 'svc_04',
    profile: AGENT_PROFILES.svc_04,
    tool: isolate,
    args: { host: 'prod-db-01' },
  });
  assert.equal(fullOutcome.decision, DECISIONS.DENY);
  const fullReasons = fullOutcome.checks
    .filter((check) => check.decision !== null)
    .map((check) => `${check.decision} ${check.reason}`);
  assert.ok(fullReasons.some((reason) => /containment is executed by deterministic SOAR playbooks/.test(reason)), fullReasons.join(' | '));
  assert.ok(fullReasons.some((reason) => /not authorised to call tool/.test(reason)), fullReasons.join(' | '));
  assert.ok(fullReasons.some((reason) => /risk level "high"/.test(reason)), fullReasons.join(' | '));
});

// ── SVC_06: cap, allowlist, long-only, loss halt, no real money ─────────────

test('SVC_06 boundary: ALLOW at and below the $10,000 cap, DENY above it', () => {
  const facts = { realAccount: false, ticker: 'SPY', notionalDeterminable: true, injection: false, sellExceedsHoldings: false, dayPnl: 120.5, symbolHalted: false };

  for (const notional of [900, 9450, 10000]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_06',
      profile: AGENT_PROFILES.svc_06,
      action: 'execute_trade',
      evidence: { ...facts, notional },
    });
    assert.equal(outcome.decision, DECISIONS.ALLOW, `notional ${notional} should execute`);
  }

  for (const notional of [10000.01, 10000.2, 25000]) {
    const outcome = kernel.evaluate({
      kind: 'action',
      agentId: 'svc_06',
      profile: AGENT_PROFILES.svc_06,
      action: 'execute_trade',
      evidence: { ...facts, notional },
    });
    assert.equal(outcome.decision, DECISIONS.DENY, `notional ${notional} must not execute`);
  }
});

test('SVC_06 boundary: real-account routing is DENY, always, with a named reason', () => {
  const outcome = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_06',
    profile: AGENT_PROFILES.svc_06,
    action: 'execute_trade',
    evidence: {
      realAccount: true,
      ticker: 'AAPL',
      notionalDeterminable: true,
      notional: 9450,
      injection: true,
      sellExceedsHoldings: false,
      dayPnl: 120.5,
      symbolHalted: false,
    },
  });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.match(outcome.reason, /escalate_to_human/);

  // and the tool-call form is stopped by the same rule
  const orderTool = {
    name: 'submit_paper_order',
    riskLevel: 'medium',
    sideEffect: 'write',
    escalation: false,
    permissions: [],
    dataAccess: [],
    inputSchema: { type: 'object' },
  };
  const toolCall = kernel.evaluate({
    kind: 'tool_call',
    agentId: 'svc_06',
    profile: AGENT_PROFILES.svc_06,
    tool: orderTool,
    args: { ticker: 'AAPL', quantity: 50, limitPrice: 189, realAccount: true },
  });
  assert.equal(toolCall.decision, DECISIONS.DENY);
  assert.match(toolCall.reason, /real-account routing/);
});

test('SVC_06 boundary: the instrument allowlist is an exact-string match', () => {
  const orderTool = {
    name: 'submit_paper_order',
    riskLevel: 'medium',
    sideEffect: 'write',
    escalation: false,
    permissions: [],
    dataAccess: [],
    inputSchema: { type: 'object' },
  };
  const portfolio = { positions: { GOOGL: 60, AAPL: 120 }, realizedDayPnl: 88.4 };

  for (const ticker of ['AAPL', 'AMZN', 'GOOGL', 'MSFT', 'SPY']) {
    const outcome = kernel.evaluate({
      kind: 'tool_call',
      agentId: 'svc_06',
      profile: AGENT_PROFILES.svc_06,
      tool: orderTool,
      args: { ticker, quantity: 1, limitPrice: 10 },
      evidence: { portfolio },
    });
    assert.equal(outcome.decision, DECISIONS.ALLOW, `${ticker} is on the allowlist`);
  }

  for (const ticker of ['GOOG', 'googl', 'AAPL ', 'BTC-USD', 'SPY0']) {
    const outcome = kernel.evaluate({
      kind: 'tool_call',
      agentId: 'svc_06',
      profile: AGENT_PROFILES.svc_06,
      tool: orderTool,
      args: { ticker, quantity: 1, limitPrice: 10 },
      evidence: { portfolio },
    });
    assert.equal(outcome.decision, DECISIONS.DENY, `${ticker} must not be traded`);
  }
});

test('SVC_06 boundary: long-only and the daily-loss halt', () => {
  const orderTool = {
    name: 'submit_paper_order',
    riskLevel: 'medium',
    sideEffect: 'write',
    escalation: false,
    permissions: [],
    dataAccess: [],
    inputSchema: { type: 'object' },
  };
  const evaluate = (args, portfolio) =>
    kernel.evaluate({
      kind: 'tool_call',
      agentId: 'svc_06',
      profile: AGENT_PROFILES.svc_06,
      tool: orderTool,
      args,
      evidence: { portfolio },
    });

  // selling more than held is refused; selling exactly what is held is fine
  const tooMuch = evaluate({ ticker: 'GOOGL', quantity: 30, limitPrice: 160, side: 'sell' }, { positions: { GOOGL: 20 }, realizedDayPnl: 120.5 });
  assert.equal(tooMuch.decision, DECISIONS.DENY);
  const exactly = evaluate({ ticker: 'GOOGL', quantity: 20, limitPrice: 160, side: 'sell' }, { positions: { GOOGL: 20 }, realizedDayPnl: 120.5 });
  assert.equal(exactly.decision, DECISIONS.ALLOW);

  // the loss halt is inclusive: -1000 stops, -999.99 does not
  const halted = evaluate({ ticker: 'MSFT', quantity: 10, limitPrice: 90 }, { positions: { MSFT: 40 }, realizedDayPnl: -1000 });
  assert.equal(halted.decision, DECISIONS.DENY);
  assert.match(halted.reason, /no_trade/);
  const almost = evaluate({ ticker: 'MSFT', quantity: 10, limitPrice: 90 }, { positions: { MSFT: 40 }, realizedDayPnl: -999.99 });
  assert.equal(almost.decision, DECISIONS.ALLOW);

  // an exchange halt stops trading without anything being wrong with the order
  const symbolHalt = evaluate({ ticker: 'AAPL', quantity: 50, limitPrice: 189, halted: true }, { positions: { AAPL: 120 }, realizedDayPnl: 120.5 });
  assert.equal(symbolHalt.decision, DECISIONS.DENY);
  assert.match(symbolHalt.reason, /no_trade/);
});

test('SVC_06 boundary: an indeterminable size never gets a guessed number', () => {
  const outcome = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_06',
    profile: AGENT_PROFILES.svc_06,
    action: 'execute_trade',
    evidence: {
      realAccount: false,
      ticker: 'MSFT',
      notionalDeterminable: false,
      notional: null,
      injection: false,
      sellExceedsHoldings: false,
      dayPnl: 120.5,
      symbolHalted: false,
    },
  });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.match(outcome.reason, /escalate_to_human/);
});

test('SVC_06 boundary: no_trade is allowed, escalation requires approval, junk is denied', () => {
  const noTrade = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_06',
    profile: AGENT_PROFILES.svc_06,
    action: 'no_trade',
    evidence: { dayPnl: -1000 },
  });
  assert.equal(noTrade.decision, DECISIONS.ALLOW);

  const escalate = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_06',
    profile: AGENT_PROFILES.svc_06,
    action: 'escalate_to_human',
    evidence: { ticker: 'BTC-USD' },
  });
  assert.equal(escalate.decision, DECISIONS.REQUIRE_APPROVAL);

  const junk = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_06',
    profile: AGENT_PROFILES.svc_06,
    action: 'size_it_yourself',
    evidence: {},
  });
  assert.equal(junk.decision, DECISIONS.DENY);
});

// ── cross-cutting ──────────────────────────────────────────────────────────

test('boundary rules ignore other agents entirely', () => {
  const outcome = kernel.evaluate({
    kind: 'action',
    agentId: 'svc_99',
    profile: { id: 'svc_99', actionPolicy: {} },
    action: 'auto_approve',
    evidence: { amount: 99999 },
  });
  // no SVC boundary rule applies; the kernel still fails closed
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.equal(outcome.rule, 'engine.default');
});

test('the boundaries themselves are frozen and cannot be widened at runtime', () => {
  assert.equal(Object.isFrozen(BOUNDARIES.svc_03), true);
  assert.equal(Object.isFrozen(BOUNDARIES.svc_06.instrumentAllowlist), true);
  assert.throws(() => {
    BOUNDARIES.svc_03.autonomousApprovalCeilingUsd = 1e9;
  }, TypeError);
  assert.equal(BOUNDARIES.svc_03.autonomousApprovalCeilingUsd, 500);
  assert.equal(BOUNDARIES.svc_04.incidentLevelCeiling, 12);
  assert.equal(BOUNDARIES.svc_06.maxSingleOrderNotionalUsd, 10000);
  assert.equal(BOUNDARIES.svc_06.dailyLossHaltUsd, -1000);
});

test('the agent profiles carry the same numbers as the prompts', () => {
  assert.equal(AGENT_PROFILES.svc_03.actionPolicy.autonomousApprovalCeilingUsd, 500);
  assert.equal(AGENT_PROFILES.svc_04.actionPolicy.incidentLevelCeiling, 12);
  assert.equal(AGENT_PROFILES.svc_06.actionPolicy.maxSingleOrderNotionalUsd, 10000);
  assert.equal(AGENT_PROFILES.svc_06.actionPolicy.dailyLossHaltUsd, -1000);
  assert.deepEqual(AGENT_PROFILES.svc_06.actionPolicy.instrumentAllowlist, ['AAPL', 'AMZN', 'GOOGL', 'MSFT', 'SPY']);
  for (const profile of Object.values(AGENT_PROFILES)) {
    assert.equal(profile.allowDestructiveActions, false);
  }
});
