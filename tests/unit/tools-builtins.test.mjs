/**
 * Built-in tools, and the fixtures they read.
 *
 * The fixture half of this file is a consistency gate: the fixtures in
 * `data/fixtures/` are derived from the eval datasets, so the numbers in them
 * must still reproduce the dataset's own `case_*` values. If someone edits a
 * fixture and breaks that correspondence, these tests go red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createToolRegistry } from '../../src/tools/registry.mjs';
import { createToolExecutor, EXECUTION_STATUS } from '../../src/tools/executor.mjs';
import { createPolicyKernel } from '../../src/policy/engine.mjs';
import { DEFAULT_RULES } from '../../src/policy/rules/index.mjs';
import { createApprovalManager } from '../../src/policy/approvals.mjs';
import { createRunStore } from '../../src/store/run-store.mjs';
import { createBuiltinTools, BUILTIN_TOOL_NAMES, createFixtureLoader } from '../../src/tools/builtins/index.mjs';
import { computeTaxVariance, roundCents } from '../../src/tools/builtins/calculate_tax_variance.mjs';
import { isRealAccountRequest } from '../../src/tools/builtins/submit_paper_order.mjs';
import { subnetOf } from '../../src/tools/builtins/check_ip_allowlist.mjs';
import { normalizePoNumber } from '../../src/tools/builtins/query_po_database.mjs';
import { AGENT_PROFILES } from '../../src/config/agents.mjs';
import { FIXTURES_DIR, fixedClock, loadDataset, tempStorageDir } from '../helpers/fixtures.mjs';

const fixtures = createFixtureLoader({ fixturesDir: FIXTURES_DIR });

function makeRuntimeStore() {
  return createRunStore({ storageDir: tempStorageDir(), now: fixedClock() });
}

function makeExecutor({ store = makeRuntimeStore(), approvals = createApprovalManager({ now: fixedClock() }) } = {}) {
  const tools = createBuiltinTools({ store, approvals, fixturesDir: FIXTURES_DIR, config: { approvalTtlMs: 3_600_000 }, now: fixedClock() });
  const registry = createToolRegistry({ tools });
  const executor = createToolExecutor({ registry, policy: createPolicyKernel({ rules: DEFAULT_RULES }), approvals, now: fixedClock() });
  return { store, approvals, registry, executor };
}

// ── the tool set ───────────────────────────────────────────────────────────

test('the built-in tool set is complete and every tool is well described', () => {
  const { registry } = makeExecutor();
  assert.deepEqual(registry.names(), [...BUILTIN_TOOL_NAMES]);
  for (const tool of registry.list()) {
    assert.ok(tool.description.length > 30, `${tool.name} needs a usable description`);
    assert.equal(Object.isFrozen(tool), true);
  }
  const names = new Set(registry.names());
  for (const required of [
    'query_po_database',
    'calculate_tax_variance',
    'request_human_approval',
    'check_ip_allowlist',
    'query_alert_context',
    'create_incident_ticket',
    'get_market_quote',
    'get_portfolio_state',
    'submit_paper_order',
    'request_analyst_review',
    'request_human_review',
    'no_op',
  ]) {
    assert.equal(names.has(required), true, `${required} must be registered`);
  }
});

test('every tool an agent profile lists is actually registered, and vice versa', () => {
  const { registry } = makeExecutor();
  for (const profile of Object.values(AGENT_PROFILES)) {
    for (const name of profile.tools) {
      assert.equal(registry.has(name), true, `${profile.id} lists unregistered tool ${name}`);
    }
    const registered = registry.list().filter((tool) => profile.tools.includes(tool.name));
    assert.deepEqual(
      registered.map((tool) => tool.name).sort(),
      [...profile.tools].sort(),
      `${profile.id}: every listed tool is registered, and no extra tool is`,
    );
  }
  // no_op is unreachable from every SVC agent: none of the three lists it.
  // (Call 2 granted it to the generic `general` agent, which has no boundary of
  // its own and no write path — so the SVC invariant is what still matters.)
  for (const profile of Object.values(AGENT_PROFILES)) {
    if (profile.id === 'general') continue;
    assert.equal(profile.tools.includes('no_op'), false, `${profile.id} is an SVC agent and must not hold no_op`);
  }
  assert.equal(AGENT_PROFILES.general.tools.includes('no_op'), true, 'the general agent holds the no-op reference tool');
});

test('no built-in tool has a destructive side effect, and none requires a permission its agent lacks', () => {
  const { registry } = makeExecutor();
  for (const tool of registry.list()) {
    assert.notEqual(tool.sideEffect, 'destructive', `${tool.name} must not be destructive`);
    assert.notEqual(tool.riskLevel, 'critical', `${tool.name} must not be critical-risk`);
  }
  for (const profile of Object.values(AGENT_PROFILES)) {
    for (const name of profile.tools) {
      const tool = registry.get(name);
      for (const permission of tool.permissions) {
        assert.equal(profile.permissions.includes(permission), true, `${profile.id} lacks ${permission} for ${name}`);
      }
      for (const tag of tool.dataAccess) {
        assert.equal(profile.dataAccess.includes(tag), true, `${profile.id} lacks ${tag} for ${name}`);
      }
    }
  }
});

// ── query_po_database ──────────────────────────────────────────────────────

test('query_po_database normalises the PO number and returns the record', async () => {
  const { registry } = makeExecutor();
  const tool = registry.get('query_po_database');

  for (const input of ['990', '#990', 'PO #990']) {
    const result = await tool.execute({ poNumber: input });
    assert.equal(result.found, true, input);
    assert.equal(result.poNumber, '990');
    assert.equal(result.po.total, 450);
    assert.equal(result.po.expectedTax, 36);
  }
  assert.equal(normalizePoNumber('PO #990'), '990');
  assert.equal(normalizePoNumber('#'), null);
});

test('query_po_database returns found:false for PO #777 — the dataset\'s unknown PO — without throwing', async () => {
  const { registry } = makeExecutor();
  const result = await registry.get('query_po_database').execute({ poNumber: '777' });
  assert.equal(result.found, false);
  assert.equal(result.poNumber, '777');
  assert.match(result.reason, /no matching purchase order/);
  assert.equal(result.po, undefined);
});

test('the PO fixture reproduces every amount, expected tax and variance in the SVC_03 dataset', async () => {
  const cases = loadDataset('invoices_dataset.json');
  const tool = createToolRegistry({ tools: createBuiltinTools({ store: makeRuntimeStore(), approvals: createApprovalManager({ now: fixedClock() }), fixturesDir: FIXTURES_DIR }) }).get('query_po_database');

  for (const testCase of cases) {
    const vars = testCase.vars;
    const poNumber = /PO #(\d+)/.exec(vars.invoice_data)?.[1] ?? null;
    if (!poNumber) continue; // case 07 has no PO at all

    const lookup = await tool.execute({ poNumber });
    // Presence in the fixture must match the dataset's verification flag: case
    // 08's PO #777 is the case that proves "present on the invoice" is not the
    // same as "verified in the database", and it is deliberately absent here.
    assert.equal(lookup.found, vars.case_po_verified === true, `PO #${poNumber} presence for ${testCase.description}`);

    if (vars.case_po_verified === true) {
      // For a LINE-ITEM variance the invoice total differs from the PO total:
      // case 06 bills 429.00 against a 390.00 PO, which is the 39.00 variance.
      // A tax variance (case 03, case 12) is a difference in tax on the same
      // total and is checked separately below.
      if (vars.case_category === 'line_item_variance') {
        const expectedPoTotal = roundCents(vars.case_amount - vars.case_variance);
        assert.equal(lookup.po.total, expectedPoTotal, `PO #${poNumber} total must reproduce case 06's 39.00 variance`);
      }
      if (typeof vars.case_amount === 'number' && vars.case_category !== 'line_item_variance') {
        assert.equal(lookup.po.total, roundCents(vars.case_amount), `PO #${poNumber} total is the invoiced amount`);
      }
    }
  }
});

test('the PO fixture reproduces the tax variances the dataset states', async () => {
  const cases = loadDataset('invoices_dataset.json');
  const tool = createToolRegistry({ tools: createBuiltinTools({ store: makeRuntimeStore(), approvals: createApprovalManager({ now: fixedClock() }), fixturesDir: FIXTURES_DIR }) }).get('query_po_database');

  for (const testCase of cases) {
    const vars = testCase.vars;
    if (!vars.case_category?.includes('variance')) continue;
    const poNumber = /PO #(\d+)/.exec(vars.invoice_data)[1];
    const invoiceTax = Number(/\$([0-9.]+)\s*;/i.exec(vars.invoice_data)?.[1] ?? NaN);
    if (!Number.isFinite(invoiceTax)) continue;

    const { po } = await tool.execute({ poNumber });
    const variance = computeTaxVariance({ expectedTax: po.expectedTax, actualTax: invoiceTax });
    assert.equal(variance.variance, vars.case_variance, `tax variance for PO #${poNumber} (${testCase.vars.case_category})`);
  }
});

// ── calculate_tax_variance ─────────────────────────────────────────────────

test('calculate_tax_variance is real arithmetic with no tolerance applied', async () => {
  const { registry } = makeExecutor();
  const tool = registry.get('calculate_tax_variance');

  assert.deepEqual(await tool.execute({ expectedTax: 12, actualTax: 15 }), {
    variance: 3,
    expectedTax: 12,
    actualTax: 15,
    absVariance: 3,
    varianceIsZero: false,
    direction: 'overbilled',
    toleranceApplied: 0,
  });
  assert.equal((await tool.execute({ expectedTax: 7, actualTax: 7.01 })).variance, 0.01);
  assert.equal((await tool.execute({ expectedTax: 7, actualTax: 7.01 })).varianceIsZero, false, 'one cent is a variance');
  assert.equal((await tool.execute({ expectedTax: 36, actualTax: 36 })).varianceIsZero, true);
  assert.equal((await tool.execute({ expectedTax: 10, actualTax: 8 })).direction, 'underbilled');
  assert.equal((await tool.execute({ expectedTax: 0.1, actualTax: 0.3 })).variance, 0.2, 'no binary-float drift');
});

// ── check_ip_allowlist ─────────────────────────────────────────────────────

test('check_ip_allowlist matches exactly, and reports same-subnet near misses', async () => {
  const { registry } = makeExecutor();
  const tool = registry.get('check_ip_allowlist');

  const allowed = await tool.execute({ ip: '10.20.0.31' });
  assert.equal(allowed.allowlisted, true);
  assert.equal(allowed.matchMode, 'exact');
  assert.equal(allowed.entry.label, 'approved vulnerability scanner');

  const nearMiss = await tool.execute({ ip: '10.20.0.130' });
  assert.equal(nearMiss.allowlisted, false);
  assert.equal(nearMiss.nearMisses.length, 1, 'the same-subnet neighbour is surfaced, not hidden');
  assert.equal(nearMiss.nearMisses[0].ip, '10.20.0.31');
  assert.equal(nearMiss.nearMisses[0].allowlisted, false);
  assert.match(nearMiss.reason, /same-subnet address is present and does not count/);

  const unrelated = await tool.execute({ ip: '203.0.113.77' });
  assert.equal(unrelated.allowlisted, false);
  assert.deepEqual(unrelated.nearMisses, []);
  assert.equal(subnetOf('10.20.0.31'), '10.20.0');
  assert.equal(subnetOf('nonsense'), null);
});

test('the allowlist fixture contains exactly the IP the dataset calls allowlisted', async () => {
  const cases = loadDataset('security_alerts_dataset.json');
  const datasetAllowlisted = new Set();
  for (const testCase of cases) {
    const matches = testCase.vars.alert_data.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
    for (const ip of matches) {
      if (testCase.vars.case_allowlisted === true && /approved scanner/.test(testCase.vars.alert_data)) datasetAllowlisted.add(ip);
    }
  }
  assert.ok(datasetAllowlisted.has('10.20.0.31'));

  const fixture = fixtures.load('ip_allowlist');
  const fixtureIps = fixture.records.map((entry) => entry.ip);
  assert.deepEqual(fixtureIps, ['10.20.0.31'], 'the dataset says the allowlist contains 10.20.0.31 only');
  assert.equal(fixture.matchMode, 'exact');
});

// ── query_alert_context ────────────────────────────────────────────────────

test('query_alert_context knows every rule id in the SVC_04 dataset and no others', async () => {
  const cases = loadDataset('security_alerts_dataset.json');
  const fixture = fixtures.load('alert_context');
  const datasetRuleIds = new Set(
    cases.map((testCase) => /rule id (\d+)/.exec(testCase.vars.alert_data)?.[1]).filter(Boolean),
  );

  for (const ruleId of datasetRuleIds) {
    assert.ok(fixture.records[ruleId], `rule id ${ruleId} from the dataset is missing from the fixture`);
  }
  for (const ruleId of Object.keys(fixture.records)) {
    assert.equal(datasetRuleIds.has(ruleId), true, `fixture rule id ${ruleId} appears in no dataset case`);
  }
});

test('query_alert_context returns context, never a disposition', async () => {
  const { registry } = makeExecutor();
  const tool = registry.get('query_alert_context');

  const found = await tool.execute({ alertId: '31103' });
  assert.equal(found.found, true);
  assert.equal(found.knownScannerSignature, true);
  assert.equal(found.disposition, undefined, 'context must not decide anything');
  assert.ok(found.escalationPolicy.ruleLevels.includes('12'));

  const missing = await tool.execute({ alertId: '999999' });
  assert.equal(missing.found, false);
  assert.equal(missing.ruleId, 999999);
});

// ── create_incident_ticket ─────────────────────────────────────────────────

test('create_incident_ticket is deterministic per run and appends to the ledger', async () => {
  const store = makeRuntimeStore();
  const { registry } = makeExecutor({ store });
  const tool = registry.get('create_incident_ticket');

  const first = await tool.execute({ title: 'Credential access on dc-01', severity: 'critical' }, { runId: 'run_a', agentId: 'svc_04' });
  const again = await tool.execute({ title: 'Credential access on dc-01', severity: 'critical' }, { runId: 'run_a', agentId: 'svc_04' });
  const otherRun = await tool.execute({ title: 'Credential access on dc-01', severity: 'critical' }, { runId: 'run_b', agentId: 'svc_04' });

  assert.match(first.ticketId, /^INC-[0-9A-F]{10}$/);
  assert.equal(first.ticketId, again.ticketId, 'the same ticket in the same run is the same id');
  assert.notEqual(first.ticketId, otherRun.ticketId, 'a different run is a different ticket');

  assert.equal(store.listIncidents().length, 3);
  assert.equal(store.getIncident(first.ticketId).severity, 'critical');
  assert.match(store.getIncident(first.ticketId).containment, /none — executed by deterministic SOAR playbooks/);
  assert.equal(fs.existsSync(store.paths.incidents), true);
});

// ── market quote + portfolio ───────────────────────────────────────────────

test('get_market_quote reports the dataset prices and both AAPL snapshots', async () => {
  const { registry } = makeExecutor();
  const tool = registry.get('get_market_quote');

  const aapl = await tool.execute({ ticker: 'AAPL' });
  assert.equal(aapl.last, 188.97);
  assert.equal(aapl.halted, false);
  assert.equal(aapl.allowlisted, true);
  assert.equal(aapl.asOf, '2026-01-15T15:30:00Z');

  const halted = await tool.execute({ ticker: 'AAPL', state: 'halted' });
  assert.equal(halted.halted, true);
  assert.match(halted.haltReason, /LULD volatility circuit breaker/);

  const goog = await tool.execute({ ticker: 'GOOG' });
  assert.equal(goog.last, 239.71);
  assert.equal(goog.allowlisted, false, 'a quote exists for a ticker that must not be traded');
  assert.equal((await tool.execute({ ticker: 'BTC-USD' })).last, 62_995);

  const unknown = await tool.execute({ ticker: 'TSLA' });
  assert.equal(unknown.found, false);
  assert.equal(unknown.halted, false);
});

test('the market fixture prices match the dataset feed lines, and the allowlist matches the prompt', () => {
  const cases = loadDataset('trading_dataset.json');
  const fixture = fixtures.load('market_quotes');

  for (const testCase of cases) {
    for (const [, ticker, price] of testCase.vars.market_data.matchAll(/([A-Z][A-Z0-9-]{0,9}) last \$([0-9,.]+)/g)) {
      const expected = Number(price.replace(/,/g, ''));
      const record = fixture.records[ticker];
      assert.ok(record, `${ticker} is quoted in the dataset but absent from the fixture`);

      // A ticker may have more than one print in the dataset (GOOGL is quoted
      // at both 168.20 and 159.90). Every print must be accounted for — either
      // as the default snapshot or as a documented alternate.
      const known = new Set([
        record.snapshots.default.last,
        ...(record.alternatePrints ?? []).map((print) => print.last),
        ...Object.values(record.snapshots).map((snapshot) => snapshot.last),
      ]);
      assert.equal(known.has(expected), true, `${ticker} last price ${expected} is not recorded in the fixture`);
    }
    assert.deepEqual(Object.keys(fixture.records).sort(), ['AAPL', 'AMZN', 'BTC-USD', 'GOOG', 'GOOGL', 'MSFT', 'SPY']);
  }

  assert.deepEqual(fixture.instrumentAllowlist, ['AAPL', 'AMZN', 'GOOGL', 'MSFT', 'SPY']);
  assert.equal(fixture.instrumentAllowlist.includes('GOOG'), false, 'GOOG is not GOOGL');
  assert.equal(fixture.instrumentAllowlist.includes('BTC-USD'), false);
});

test('get_portfolio_state returns the paper account and refuses to invent one', async () => {
  const { registry } = makeExecutor();
  const tool = registry.get('get_portfolio_state');

  const state = await tool.execute();
  assert.equal(state.accountId, 'PT-001');
  assert.equal(state.accountType, 'paper');
  assert.equal(state.realMoney, false);
  assert.equal(state.longOnly, true);
  assert.equal(state.realizedDayPnl, 120.5);
  assert.equal(state.positions.GOOGL, 60, 'case 08 holds 60 GOOGL; case 12 holding 20 is the sell-too-much case');
  assert.equal(state.positions.AAPL, 120);
  assert.equal(state.boundaries.maxSingleOrderNotionalUsd, 10_000);

  const scoped = createToolRegistry({
    tools: createBuiltinTools({
      store: makeRuntimeStore(),
      approvals: createApprovalManager({ now: fixedClock() }),
      fixturesDir: FIXTURES_DIR,
    }),
  });
  assert.equal(scoped.get('get_portfolio_state').name, 'get_portfolio_state');
});

test('a missing fixture fails loudly instead of yielding an empty portfolio', async () => {
  const emptyDir = tempStorageDir();
  const store = makeRuntimeStore();
  const tools = createBuiltinTools({ store, approvals: createApprovalManager({ now: fixedClock() }), fixturesDir: emptyDir });
  const registry = createToolRegistry({ tools });
  const executor = createToolExecutor({ registry, policy: createPolicyKernel({ rules: DEFAULT_RULES }), now: fixedClock() });

  const result = await executor.execute({ toolName: 'get_portfolio_state', args: {}, profile: AGENT_PROFILES.svc_06, agentId: 'svc_06' });
  assert.equal(result.status, EXECUTION_STATUS.TOOL_ERROR);
  assert.match(result.error.message, /FIXTURE_NOT_FOUND/);
});

// ── submit_paper_order ─────────────────────────────────────────────────────

test('submit_paper_order records an in-bounds order against the paper account', async () => {
  const store = makeRuntimeStore();
  const { executor } = makeExecutor({ store });

  const result = await executor.execute({
    toolName: 'submit_paper_order',
    args: { ticker: 'AAPL', quantity: 50, limitPrice: 189 },
    profile: AGENT_PROFILES.svc_06,
    agentId: 'svc_06',
    evidence: { portfolio: { positions: { AAPL: 120 }, realizedDayPnl: 120.5 } },
  });

  assert.equal(result.status, EXECUTION_STATUS.OK);
  assert.equal(result.result.ok, true);
  assert.equal(result.result.notional, 9450);
  assert.equal(result.result.accountType, 'paper');
  assert.equal(result.result.realMoney, false);
  assert.match(result.result.orderId, /^ord_/);

  const orders = store.listOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].mode, 'paper');
  assert.match(orders[0].venue, /no broker|paper ledger only/);
});

test('submit_paper_order refuses real-account routing with a structured error and writes nothing', async () => {
  const store = makeRuntimeStore();
  const { executor } = makeExecutor({ store });

  for (const args of [
    { ticker: 'AAPL', quantity: 50, limitPrice: 189, realAccount: true },
    { ticker: 'AAPL', quantity: 50, limitPrice: 189, account: 'production' },
    { ticker: 'AAPL', quantity: 50, limitPrice: 189, account: 'MARGIN' },
  ]) {
    const result = await executor.execute({
      toolName: 'submit_paper_order',
      args,
      profile: AGENT_PROFILES.svc_06,
      agentId: 'svc_06',
      evidence: { portfolio: { positions: { AAPL: 120 }, realizedDayPnl: 120.5 } },
    });
    // The policy kernel blocks it before the tool body runs, and the result
    // records the real-account reason either way.
    assert.equal(result.status, EXECUTION_STATUS.POLICY_DENIED, JSON.stringify(args));
    assert.match(result.error.message, /real-account/i);
  }

  assert.equal(store.listOrders().length, 0, 'no paper order may be recorded for a real-account request');
  assert.equal(isRealAccountRequest({ realAccount: true }), true);
  assert.equal(isRealAccountRequest({ account: 'LIVE' }), true);
  assert.equal(isRealAccountRequest({ account: 'PT-001' }), false);
  assert.equal(isRealAccountRequest({}), false);
});

test('a halted symbol is refused by the trading boundary and nothing is written', async () => {
  const store = makeRuntimeStore();
  const { executor } = makeExecutor({ store });

  const result = await executor.execute({
    toolName: 'submit_paper_order',
    args: { ticker: 'AAPL', quantity: 50, limitPrice: 189, halted: true },
    profile: AGENT_PROFILES.svc_06,
    agentId: 'svc_06',
    evidence: { portfolio: { positions: { AAPL: 120 }, realizedDayPnl: 120.5 } },
  });
  assert.equal(result.status, EXECUTION_STATUS.POLICY_DENIED);
  assert.match(result.error.message, /no_trade/);
  assert.equal(store.listOrders().length, 0);
});

// ── escalation tools ───────────────────────────────────────────────────────

test('the three escalation tools create pending approval records', async () => {
  const store = makeRuntimeStore();
  const approvals = createApprovalManager({ now: fixedClock() });
  const { executor } = makeExecutor({ store, approvals });

  const humanApproval = await executor.execute({
    toolName: 'request_human_approval',
    args: { reason: 'invoice #109 is 850.00, over the 500.00 ceiling', payload: { invoice: '#109', amount: 850 } },
    profile: AGENT_PROFILES.svc_03,
    agentId: 'svc_03',
  });
  const analyst = await executor.execute({
    toolName: 'request_analyst_review',
    args: { alertId: '31103', reason: 'override attempt inside the alert payload' },
    profile: AGENT_PROFILES.svc_04,
    agentId: 'svc_04',
  });
  const tradingReview = await executor.execute({
    toolName: 'request_human_review',
    args: { reason: 'notional 25000.00 over the 10000.00 cap', ticker: 'AMZN', payload: { side: 'buy' } },
    profile: AGENT_PROFILES.svc_06,
    agentId: 'svc_06',
  });

  for (const result of [humanApproval, analyst, tradingReview]) {
    assert.equal(result.status, EXECUTION_STATUS.APPROVAL_REQUIRED);
    assert.equal(result.approval.status, 'pending');
  }

  const pending = approvals.listPending();
  assert.equal(pending.length, 3);
  assert.deepEqual(
    pending.map((record) => record.toolName).sort(),
    ['request_analyst_review', 'request_human_approval', 'request_human_review'],
  );
  // The approver sees the proposal, not just the reason.
  const invoiceApproval = pending.find((record) => record.toolName === 'request_human_approval');
  assert.equal(invoiceApproval.payload.proposedArgs.payload.amount, 850);

  // and resolving one lets its tool body run, producing the richer payload
  approvals.approve(invoiceApproval.approvalId, { resolvedBy: 'controller' });
  const executed = await executor.execute({
    toolName: 'request_human_approval',
    args: { reason: 'invoice #109 is 850.00, over the 500.00 ceiling', payload: { invoice: '#109', amount: 850 } },
    profile: AGENT_PROFILES.svc_03,
    agentId: 'svc_03',
    approvalId: invoiceApproval.approvalId,
  });
  assert.equal(executed.status, EXECUTION_STATUS.OK);
  assert.equal(executed.result.queuedForHuman, true);
});

// ── no_op ──────────────────────────────────────────────────────────────────

test('no_op does nothing, requires nothing, and is unreachable from the SVC profiles', async () => {
  const { registry, executor } = makeExecutor();
  const tool = registry.get('no_op');
  assert.equal(tool.sideEffect, 'none');
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual([...tool.permissions], []);
  assert.deepEqual([...tool.dataAccess], []);

  // With no profile, tool authorisation is fail-closed: an agent that is not
  // identified cannot be authorised, whatever the default decision is.
  const permissive = createPolicyKernel({ rules: DEFAULT_RULES, defaultDecision: 'ALLOW' });
  const directExecutor = createToolExecutor({ registry, policy: permissive, now: fixedClock() });
  const result = await directExecutor.execute({ toolName: 'no_op', args: { note: 'hello' }, profile: null, agentId: 'nobody' });

  assert.equal(result.status, EXECUTION_STATUS.POLICY_DENIED);
  assert.equal(result.policy.rule, 'tool.authorization');
  assert.match(result.error.message, /no agent profile resolved/);

  const unknown = await executor.execute({ toolName: 'no_op', args: {}, profile: null, agentId: 'nobody' });
  assert.equal(unknown.status, EXECUTION_STATUS.POLICY_DENIED);

  const body = await registry.get('no_op').execute({ note: 'hello' });
  assert.deepEqual({ ok: body.ok, noOp: body.noOp, note: body.note }, { ok: true, noOp: true, note: 'hello' });
});

// ── fixtures on disk ───────────────────────────────────────────────────────

test('every fixture file declares its provenance', () => {
  for (const name of ['po_database', 'ip_allowlist', 'alert_context', 'market_quotes', 'paper_portfolio']) {
    const file = path.join(FIXTURES_DIR, `${name}.json`);
    assert.equal(fs.existsSync(file), true, `${name}.json must exist`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(parsed._provenance, `${name}.json needs a _provenance block`);
    assert.match(parsed._provenance.derivedFrom, /^evals\//, `${name}.json must name its source dataset`);
  }
});
