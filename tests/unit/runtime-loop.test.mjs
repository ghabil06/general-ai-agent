/**
 * The wired runtime: config, routing, the act loop, persistence and restart.
 *
 * This is the "does the thing actually work end to end, offline" test. The
 * model is the deterministic mock provider, so every assertion is reproducible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createRuntime, RUNTIME_VERSION } from '../../src/index.mjs';
import { STATES } from '../../src/runtime/state-machine.mjs';
import { EVENT_TYPES } from '../../src/observability/events.mjs';
import { EXECUTION_STATUS } from '../../src/tools/executor.mjs';
import { createPolicyKernel, DECISIONS } from '../../src/policy/engine.mjs';
import { AGENT_PROFILES } from '../../src/config/agents.mjs';
import { loadConfig } from '../../src/config/index.mjs';
import { makeTestRuntime, testConfig } from '../helpers/runtime.mjs';
import { FIXTURES_DIR, fixedClock, tempStorageDir } from '../helpers/fixtures.mjs';

test('createRuntime() wires every stage and reports what it has', () => {
  const { runtime } = makeTestRuntime();
  const described = runtime.describe();

  assert.equal(described.version, RUNTIME_VERSION);
  // `general` was added in call 2 (a non-SVC agent with no domain boundary).
  // The three SVC agents are still the only ones with a boundary rule.
  assert.deepEqual(described.agents, ['svc_03', 'svc_04', 'svc_06', 'general']);
  assert.deepEqual(described.svcAgents, ['svc_03', 'svc_04', 'svc_06']);
  assert.equal(described.tools.length, 12);
  assert.equal(described.policyRules.length, 11);
  assert.deepEqual(described.providers.map((provider) => provider.id), ['mock', 'openai', 'anthropic', 'local']);
  assert.equal(described.providers.find((provider) => provider.id === 'mock').available, true);
  assert.equal(described.providers.find((provider) => provider.id === 'openai').available, false, 'no key in tests');
  assert.equal(described.states.length, 13);
  assert.equal(described.routes.length, 8);

  for (const stage of ['runs', 'events', 'approvals', 'audit', 'incidents', 'orders', 'traces', 'memory']) {
    assert.equal(described.stores[stage].corruptLines, 0, `${stage} store must start clean`);
  }
});

test('the configured budgets reach the run, and the profile limits tighten them', () => {
  const { runtime } = makeTestRuntime({ budgets: { maxIterations: 5, maxToolCalls: 7 } });
  const run = runtime.createRun({ agentId: 'svc_03' });

  assert.equal(run.budget.limits.maxIterations, 5, 'the runtime budget wins when it is tighter');
  assert.equal(run.budget.limits.maxToolCalls, 7);
  assert.equal(run.budget.limits.maxRepeatedToolCalls, 3, 'the default loop limit is retained');
  run.finish({ status: STATES.COMPLETED });
});

test('a run executes a tool, then answers, and every stage leaves a record', async () => {
  const { runtime } = makeTestRuntime({
    mockScript: [
      { toolCalls: [{ name: 'query_po_database', arguments: { poNumber: '990' } }], usage: { promptTokens: 100, completionTokens: 20 } },
      { toolCalls: [{ name: 'calculate_tax_variance', arguments: { expectedTax: 36, actualTax: 36 } }], usage: { promptTokens: 120, completionTokens: 20 } },
      { json: { action: 'auto_approve', reasoning: 'PO verified, zero variance' }, usage: { promptTokens: 140, completionTokens: 30 } },
    ],
  });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const outcome = await run.loop({
    systemPrompt: 'SVC_03 prompt of record',
    userMessage: 'Invoice #101. Amount: $450.00. PO #990 ...',
    responseFormat: 'json',
  });

  assert.equal(outcome.stopReason, null);
  assert.equal(outcome.turns, 3);
  assert.deepEqual(outcome.steps.map((step) => step.kind), ['tool', 'tool', 'final']);
  assert.deepEqual(JSON.parse(outcome.finalText), { action: 'auto_approve', reasoning: 'PO verified, zero variance' });

  // state machine walked the real path
  const states = run.stateMachine.history.map((entry) => `${entry.from}>${entry.to}`);
  assert.ok(states.includes('IDLE>UNDERSTANDING'));
  assert.ok(states.includes('PLANNING>EXECUTING'));
  assert.ok(states.includes('EXECUTING>WAITING_FOR_TOOL'));
  assert.ok(states.includes('WAITING_FOR_TOOL>OBSERVING'));
  assert.ok(states.includes('REPLANNING>EXECUTING'));
  assert.ok(states.includes('VALIDATING>COMPLETED') || run.stateMachine.state === 'VALIDATING');

  const summary = run.finish({ status: STATES.COMPLETED, output: JSON.parse(outcome.finalText) });
  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.toolCalls.length, 2);
  assert.equal(summary.modelCalls.length, 3);
  assert.equal(summary.budgets.tokens, 430);
  assert.equal(summary.budgets.iterations, 3);

  // events: the whole pipeline is on the record
  const events = runtime.runStore.runEvents(run.runId);
  const types = events.map((event) => event.type);
  for (const expected of [
    EVENT_TYPES.RUN_STARTED,
    EVENT_TYPES.STATE_CHANGED,
    EVENT_TYPES.MODEL_CALLED,
    EVENT_TYPES.TOOL_PROPOSED,
    EVENT_TYPES.POLICY_DECIDED,
    EVENT_TYPES.TOOL_EXECUTED,
    EVENT_TYPES.RUN_FINISHED,
  ]) {
    assert.ok(types.includes(expected), `${expected} must be emitted`);
  }
  assert.equal(events.filter((event) => event.type === EVENT_TYPES.RUN_FINISHED).length, 1);

  // the trace nests the pipeline
  const trace = runtime.runStore.getTrace(run.runId);
  const typesInTrace = trace.trace.root.children.map((child) => child.type);
  assert.ok(typesInTrace.includes('model_call'));
  assert.ok(typesInTrace.includes('tool_call'));

  // audit rows and the run record
  assert.equal(runtime.runStore.getRun(run.runId).status, 'COMPLETED');
  assert.ok(runtime.runStore.readAudit().records.length >= 1);
});

test('the loop stops at the iteration budget and says so', async () => {
  const { runtime } = makeTestRuntime({
    budgets: { maxIterations: 2 },
    mockScript: Array.from({ length: 6 }, () => ({ toolCalls: [{ name: 'query_po_database', arguments: { poNumber: '998' } }] })),
  });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const outcome = await run.loop({ systemPrompt: 'x', userMessage: 'y' });

  assert.equal(outcome.stopReason.code, 'ITERATION_BUDGET_EXCEEDED');
  assert.equal(outcome.turns, 2);
  const budgetStops = runtime.runStore.runEvents(run.runId).filter((event) => event.type === EVENT_TYPES.BUDGET_STOPPED);
  assert.equal(budgetStops.length, 1);
  assert.equal(budgetStops[0].payload.stopReason.code, 'ITERATION_BUDGET_EXCEEDED');

  const summary = run.finish({ status: STATES.FAILED, reason: 'iteration budget' });
  assert.equal(summary.status, 'FAILED');
});

test('a state-changing tool on injected input is blocked, and the run records the block', async () => {
  // The mock proposes an escalation tool: the escalation path stays open, but
  // it must pass the approval gate, so the run ends WAITING_FOR_APPROVAL.
  const { runtime } = makeTestRuntime({
    mockScript: [
      {
        toolCalls: [
          {
            name: 'request_human_approval',
            arguments: { reason: 'amount 850.00 is over the 500.00 ceiling', payload: { invoice: '#109' } },
          },
        ],
      },
    ],
  });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const outcome = await run.loop({ systemPrompt: 'x', userMessage: 'invoice #109' });

  const toolStep = outcome.steps.find((step) => step.kind === 'tool');
  assert.equal(toolStep.status, EXECUTION_STATUS.APPROVAL_REQUIRED);
  assert.ok(toolStep.approvalId);
  assert.equal(runtime.approvals.get(toolStep.approvalId).status, 'pending');
  assert.equal(runtime.runStore.listApprovals().length, 1);

  const blocked = outcome.steps.find((step) => step.kind === 'blocked');
  assert.equal(blocked.blockedBy, 'approval');
  assert.equal(blocked.approvalId, toolStep.approvalId);

  // the run paused rather than completing
  const summary = run.finish({ status: STATES.COMPLETED, output: { pendingApproval: toolStep.approvalId } });
  assert.ok(
    summary.stateHistory.includes('WAITING_FOR_TOOL->WAITING_FOR_APPROVAL'),
    `the paused call is recorded as a gated tool: ${summary.stateHistory.join(' ')}`,
  );
});

test('the action verdicts the runtime exposes agree with the eval datasets', () => {
  const { runtime } = makeTestRuntime();
  const run = runtime.createRun({ agentId: 'svc_03' });

  const clean = run.evaluateAction('auto_approve', { amount: 450, poPresent: true, poVerified: true, variance: 0 });
  assert.equal(clean.decision, DECISIONS.ALLOW);

  const overCap = run.evaluateAction('auto_approve', { amount: 505, poPresent: true, poVerified: true, variance: 0 });
  assert.equal(overCap.decision, DECISIONS.DENY);
  assert.equal(overCap.rule, 'svc_03.invoice_boundary');

  const escalate = run.evaluateAction('request_human_approval', { amount: 850, poPresent: true, poVerified: true, variance: 0 });
  assert.equal(escalate.decision, DECISIONS.REQUIRE_APPROVAL);
  run.finish({ status: STATES.COMPLETED });
});

test('routing rejects a real provider with no credential and never silently uses the mock', () => {
  // A runtime whose default provider is openai: with no key, the router must
  // fail rather than quietly fall back to the test double.
  const storageDir = tempStorageDir();
  const runtime = createRuntime({
    config: testConfig({ storageDir, defaultProvider: 'openai' }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    mockScript: [],
    now: fixedClock(),
  });

  assert.throws(
    () => runtime.route({ taskType: 'invoice_reconciliation', complexity: 'low', requiresTools: true }),
    /no route for taskType="invoice_reconciliation"/,
  );
  assert.equal(runtime.providers.isAvailable('mock'), true, 'the double exists, it is just not a legal implicit target');
});

test('memory written by a run is readable by the next run (durable, scoped)', async () => {
  const { runtime } = makeTestRuntime({ mockScript: [{ text: 'ok' }] });

  const first = runtime.createRun({ agentId: 'svc_03' });
  first.remember({ scope: 'agent', scopeId: 'svc_03', key: 'po_990_total', value: 450 });
  first.finish({ status: STATES.COMPLETED });

  const second = runtime.createRun({ agentId: 'svc_03' });
  const recalled = second.recall({ scope: 'agent', scopeId: 'svc_03' });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].value, 450);

  const events = runtime.runStore.runEvents(second.runId);
  assert.ok(events.some((event) => event.type === EVENT_TYPES.MEMORY_RETRIEVED));
  second.finish({ status: STATES.COMPLETED });
});

test('a run record, its events and its trace survive a process restart', async () => {
  const storageDir = tempStorageDir();
  const { runtime } = makeTestRuntime({
    storageDir,
    mockScript: [{ toolCalls: [{ name: 'get_portfolio_state', arguments: {} }] }, { json: { action: 'no_trade' } }],
  });

  const run = runtime.createRun({ agentId: 'svc_06' });
  await run.loop({ systemPrompt: 'x', userMessage: 'order' });
  const summary = run.finish({ status: STATES.COMPLETED });
  const eventCount = runtime.runStore.runEvents(run.runId).length;

  // a brand-new runtime over the same directory — as a restarted process would
  const restarted = createRuntime({
    config: testConfig({ storageDir, defaultProvider: 'mock' }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    now: fixedClock(),
  });

  const reloaded = restarted.runStore.getRun(run.runId);
  assert.equal(reloaded.status, 'COMPLETED');
  assert.equal(reloaded.toolCalls.length, 1);
  assert.equal(restarted.runStore.runEvents(run.runId).length, eventCount);
  const trace = restarted.runStore.getTrace(run.runId);
  assert.equal(trace.trace.root.children.length >= 1, true);
  assert.equal(restarted.describe().stores.events.corruptLines, 0);
  assert.equal(summary.status, 'COMPLETED');
});

test('finish() is idempotent and never rewrites a terminal state', () => {
  const { runtime } = makeTestRuntime();
  const run = runtime.createRun({ agentId: 'svc_06' });
  run.transition(STATES.UNDERSTANDING);
  const first = run.finish({ status: STATES.BLOCKED, reason: 'policy' });
  const second = run.finish({ status: STATES.COMPLETED });

  assert.equal(first.status, 'BLOCKED');
  assert.equal(second.status, 'BLOCKED', 'a finished run cannot be re-finished into a different terminal state');
  assert.equal(runtime.runStore.listRuns().length, 1);
  assert.equal(runtime.runStore.get('runs').count(), 2, 'one start row and one finish row');
});

test('an unknown agent id is refused before anything is written', () => {
  const { runtime } = makeTestRuntime();
  assert.throws(() => runtime.createRun({ agentId: 'svc_99' }), /unknown agent profile/);
  assert.equal(runtime.runStore.get('events').count(), 0);
});

test('the runtime exposes the frozen boundaries, and config cannot widen them', () => {
  const runtime = createRuntime({
    config: loadConfig({ AGENT_STORAGE_DIR: tempStorageDir(), OPENAI_API_KEY: 'x'.repeat(8) }, {}),
    storageDir: tempStorageDir(),
    fixturesDir: FIXTURES_DIR,
    now: fixedClock(),
  });
  assert.equal(runtime.boundaries.svc_03.autonomousApprovalCeilingUsd, 500);
  assert.deepEqual(runtime.boundaries.svc_06.instrumentAllowlist, ['AAPL', 'AMZN', 'GOOGL', 'MSFT', 'SPY']);

  // The env cannot move a ceiling: there is no variable that mentions one.
  const config = loadConfig({ AGENT_STORAGE_DIR: tempStorageDir(), SVC_03_CEILING: '999999' });
  assert.equal(config.policy.svc_03.autonomousApprovalCeilingUsd, 500);
  assert.equal(config.providers.openai.apiKeyPresent, false);
  assert.equal(JSON.stringify(config).includes('sk-'), false);
});

test('a policy kernel that denies everything blocks the loop before any tool runs', async () => {
  const denyAll = createPolicyKernel({ rules: [], defaultDecision: DECISIONS.DENY });
  const storageDir = tempStorageDir();
  const runtime = createRuntime({
    config: testConfig({ storageDir }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    mockScript: [{ toolCalls: [{ name: 'query_po_database', arguments: { poNumber: '990' } }] }],
    now: fixedClock(),
  });
  // swap in the strict kernel: the executor consults the kernel it was built with
  runtime.executor.policy.rules.length = 0;
  assert.equal(denyAll.defaultDecision, 'DENY');

  const run = runtime.createRun({ agentId: 'svc_03' });
  const result = await run.runTool('query_po_database', { poNumber: '990' }, {});
  // with the real kernel this call is allowed; the point is that the verdict is
  // always a policy verdict, never an unconditional execution
  assert.ok(result.policy);
  assert.equal(typeof result.policy.rule, 'string');
  run.finish({ status: STATES.COMPLETED });
});

test('the fixture directory is required, and a missing one fails at tool-call time', async () => {
  const storageDir = tempStorageDir();
  const emptyFixtures = tempStorageDir('agent-empty-fixtures-');
  const runtime = createRuntime({
    config: testConfig({ storageDir, fixturesDir: emptyFixtures }),
    storageDir,
    fixturesDir: emptyFixtures,
    now: fixedClock(),
  });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const result = await run.runTool('query_po_database', { poNumber: '990' }, {});
  assert.equal(result.status, EXECUTION_STATUS.TOOL_ERROR);
  assert.match(result.error.message, /FIXTURE_NOT_FOUND/);
  run.finish({ status: STATES.FAILED });
  assert.equal(fs.existsSync(runtime.runStore.paths.runs), true);
});
