/**
 * Integration: the call-2 stages running through the real runtime.
 *
 * The planner, the context manager, the five-kind memory and the agent
 * definitions are each unit-tested in isolation; this file proves they are
 * wired into a real run — real state machine, real executor, real policy
 * kernel, real stores — and that the run still cannot loop forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createRuntime } from '../../src/index.mjs';
import { STATES } from '../../src/runtime/state-machine.mjs';
import { STOP_REASONS } from '../../src/runtime/budgets.mjs';
import { EVENT_TYPES } from '../../src/observability/events.mjs';
import { EXECUTION_STATUS } from '../../src/tools/executor.mjs';
import { PlanError, PLAN_STATUS, STEP_STATUS } from '../../src/planning/planner.mjs';
import { MEMORY_KINDS, MEMORY_KIND } from '../../src/memory/kinds.mjs';
import { loadAgent } from '../../src/agents/index.mjs';
import { testConfig } from '../helpers/runtime.mjs';
import { FIXTURES_DIR, fixedClock, tempStorageDir, loadDataset } from '../helpers/fixtures.mjs';

/** One isolated runtime per scenario. */
function scenario(options = {}) {
  const storageDir = tempStorageDir('agent-call2-');
  const runtime = createRuntime({
    config: testConfig({ storageDir, defaultProvider: 'mock', ...options }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    mockScript: options.mockScript ?? [],
    now: options.now ?? fixedClock(),
    tools: options.tools ?? [],
    profiles: options.profiles ?? null,
  });
  return { runtime, storageDir };
}

// ── the planner inside the run loop ─────────────────────────────────────────

test('a planned run executes a real plan through the executor and completes', async () => {
  const { runtime } = scenario();
  const agent = loadAgent('general');
  const scenarioInput = agent.offlineScenario('market_and_portfolio');

  const run = runtime.createRun({ agentId: 'general' });
  // In planned mode the tool steps are executed by the loop, so the only model
  // call is the final synthesis — which is what this script supplies.
  runtime.mockProvider.reset({ script: [{ text: 'AAPL quoted as reported by the fixture; portfolio PT-001 is paper only.' }] });

  const outcome = await run.loop({
    mode: 'planned',
    goal: scenarioInput.task,
    systemPrompt: scenarioInput.systemPrompt,
    userMessage: scenarioInput.userMessage,
    steps: [
      { id: 's1', description: 'Read the AAPL quote', tool: 'get_market_quote', args: { ticker: 'AAPL' } },
      { id: 's2', description: 'Read the portfolio state', tool: 'get_portfolio_state', args: {} },
    ],
  });

  assert.equal(outcome.stopReason, null);
  assert.equal(outcome.plan.status, PLAN_STATUS.COMPLETE);
  assert.equal(outcome.planSummary.steps, 2);
  assert.deepEqual(outcome.plan.steps.map((step) => step.status), [STEP_STATUS.DONE, STEP_STATUS.DONE]);
  assert.deepEqual(outcome.plan.steps.map((step) => step.tool), ['get_market_quote', 'get_portfolio_state']);
  assert.equal(outcome.steps.filter((entry) => entry.kind === 'tool').length, 2);
  assert.equal(run.state, STATES.COMPLETED, 'the planned loop reaches a terminal state itself');
  assert.match(outcome.finalText, /AAPL/);

  const summary = run.finish({ status: STATES.COMPLETED });
  assert.equal(summary.status, 'COMPLETED');
  assert.deepEqual(summary.toolCalls, ['get_market_quote', 'get_portfolio_state']);

  const events = runtime.runStore.runEvents(run.runId);
  assert.ok(events.some((event) => event.type === EVENT_TYPES.TOOL_EXECUTED));
  assert.ok(events.some((event) => event.type === EVENT_TYPES.STATE_CHANGED && event.payload.to === 'PLANNING'));
  const trace = runtime.runStore.getTrace(run.runId).trace;
  const collect = (span) => [span, ...(span.children ?? []).flatMap(collect)];
  const spans = collect(trace.root);
  assert.ok(spans.some((span) => span.type === 'plan'), 'the trace records the plan span');
  assert.ok(spans.some((span) => span.type === 'plan_step'), 'the trace records each plan step');
});

test('a model-proposed plan naming an unauthorised tool is refused, not executed', async () => {
  const { runtime } = scenario({
    mockScript: [
      { json: { steps: [{ id: 's1', description: 'place an order', tool: 'submit_paper_order', args: { ticker: 'AAPL', quantity: 1, limitPrice: 1 } }] } },
    ],
  });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const outcome = await run.loop({ mode: 'planned', goal: 'Reconcile invoice #101 and pay it', systemPrompt: 'x', userMessage: 'Invoice #101. Amount: $10.00. PO #990.' });

  assert.ok(outcome.stopReason, 'the run stopped');
  assert.equal(outcome.stopReason.code, 'PLAN_TOOL_NOT_PERMITTED');
  assert.match(outcome.stopReason.message, /not authorised to plan tool "submit_paper_order"/);
  assert.equal(outcome.plan, null, 'no plan was created from a refused proposal');
  assert.deepEqual(run.toolCalls, [], 'nothing was executed');
  assert.equal(run.state, STATES.FAILED);

  run.finish({ status: STATES.FAILED, reason: outcome.stopReason.code });
  assert.equal(runtime.runStore.listOrders().length, 0, 'the refused plan wrote nothing');
});

test('a failed step triggers a replan, and the revised plan completes', async () => {
  const { runtime } = scenario({
    mockScript: [
      // The replacement plan the model proposes after the failure.
      { json: { steps: [{ id: 's2', description: 'Re-read the PO with the corrected number', tool: 'query_po_database', args: { poNumber: '991' } }] } },
      { json: { action: 'request_human_approval', reasoning: 'the second lookup still needs a human' } },
    ],
  });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const outcome = await run.loop({
    mode: 'planned',
    goal: 'Reconcile invoice #102',
    systemPrompt: 'x',
    userMessage: 'Invoice #102. Amount: $505.00. PO #991.',
    steps: [
      // An argument that cannot satisfy the schema: the step fails for real.
      { id: 's1', description: 'Look up the PO with a malformed number', tool: 'query_po_database', args: { poNumber: 'not-a-number' } },
    ],
  });

  assert.equal(outcome.plan.replans, 1, 'the plan was revised once');
  assert.equal(outcome.plan.revision, 2);
  assert.equal(outcome.plan.status, PLAN_STATUS.COMPLETE);
  assert.equal(outcome.plan.steps.find((step) => step.id === 's1').status, STEP_STATUS.FAILED, 'the failure is kept as history');
  assert.equal(outcome.plan.steps[0].outcome.status, STEP_STATUS.FAILED);
  assert.match(outcome.plan.steps[0].outcome.error.message, /schema validation/);
  const replacement = outcome.plan.steps.find((step) => step.id === 's2');
  assert.equal(replacement.status, STEP_STATUS.DONE);
  assert.equal(outcome.stopReason, null);
  assert.ok(outcome.plan.history.some((entry) => entry.type === 'plan.replanned'));
  assert.ok(outcome.plan.history.some((entry) => entry.type === 'plan.awaiting_revision'));

  run.finish({ status: STATES.COMPLETED });
});

test('a plan that never completes is stopped by the iteration budget', async () => {
  // The plan is a chain of steps that always fail, and every replan proposal
  // names the same doomed step. The tool-call budget is raised out of the way so
  // that the ONLY thing that can stop this is the iteration budget — which is
  // the property being tested.
  const storageDir = tempStorageDir('agent-loop-');
  const runtime2 = createRuntime({
    config: testConfig({ storageDir, defaultProvider: 'mock', budgets: { maxIterations: 4, maxToolCalls: 50 } }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    mockScript: [
      // Four identical replan proposals: more than the iteration budget can
      // consume, so the budget is what stops the run.
      { json: { steps: [{ id: 'again', description: 'Retry the doomed lookup', tool: 'query_po_database', args: { poNumber: '!!' } }] } },
      { json: { steps: [{ id: 'again2', description: 'Retry the doomed lookup', tool: 'query_po_database', args: { poNumber: '??' } }] } },
      { json: { steps: [{ id: 'again3', description: 'Retry the doomed lookup', tool: 'query_po_database', args: { poNumber: '**' } }] } },
      { json: { steps: [{ id: 'again4', description: 'Retry the doomed lookup', tool: 'query_po_database', args: { poNumber: '++' } }] } },
    ],
    now: fixedClock(),
  });

  const run = runtime2.createRun({ agentId: 'svc_03' });
  const outcome = await run.loop({
    mode: 'planned',
    goal: 'Reconcile an invoice that can never be reconciled',
    systemPrompt: 'x',
    userMessage: 'Invoice #999. Amount: $1.00.',
    steps: [{ id: 's1', description: 'Look up a PO with a malformed number', tool: 'query_po_database', args: { poNumber: '!!' } }],
    maxTurns: 4,
  });

  assert.ok(outcome.stopReason, 'the run stopped');
  assert.equal(outcome.stopReason.code, STOP_REASONS.ITERATION_BUDGET_EXCEEDED, `stopped for ${outcome.stopReason.code}: ${outcome.stopReason.message}`);
  assert.ok(outcome.turns <= 4, 'the iteration budget was the ceiling');
  assert.equal(outcome.plan.status, PLAN_STATUS.FAILED, 'the plan is closed out, not left ambiguous');

  const events = runtime2.runStore.runEvents(run.runId);
  assert.ok(events.some((event) => event.type === EVENT_TYPES.BUDGET_STOPPED));

  // The loop reports the stop; `finish()` is what moves the machine to the
  // terminal state it names, exactly as the call-1 loop behaves.
  const summary = run.finish({ status: STATES.FAILED, reason: outcome.stopReason.code });
  assert.equal(summary.status, 'FAILED');
  assert.equal(run.state, STATES.FAILED);
  assert.equal(runtime2.runStore.getRun(run.runId).status, 'FAILED');
  // The runtime also refuses to plan more steps than its ceiling allows.
  assert.throws(
    () => run.plan({ goal: 'too many', steps: Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, description: 'x' })) }),
    (error) => error instanceof PlanError && error.code === 'PLAN_TOO_MANY_STEPS',
  );
});

test('run.plan() builds a plan for the run\'s own agent and anchors it to the run', () => {
  const { runtime } = scenario();
  const run = runtime.createRun({ agentId: 'svc_04' });
  const plan = run.plan({ goal: 'Triage alert 5710', steps: [{ description: 'Read the alert context', tool: 'query_alert_context', args: { alertId: '5710' } }] });
  assert.equal(plan.agentId, 'svc_04');
  assert.equal(run.planner.agentId, 'svc_04');
  assert.deepEqual(run.planner.planableTools(), ['query_alert_context', 'check_ip_allowlist', 'create_incident_ticket', 'request_analyst_review']);
  assert.equal(run.snapshotPlan(plan).steps.length, 1);
  run.finish({ status: STATES.COMPLETED });
});

// ── the context manager inside the run loop ─────────────────────────────────

test('a run assembled from structured material builds its window through the context manager', async () => {
  const { runtime } = scenario({
    mockScript: [{ json: { action: 'auto_approve', reasoning: 'within the ceiling' } }],
  });
  const run = runtime.createRun({ agentId: 'svc_03' });

  const outcome = await run.loop({
    task: 'Reconcile the invoice and return the decision JSON.',
    context: {
      conversation: [{ role: 'user', content: 'Here is the invoice.' }],
      memory: [{ memoryId: 'm1', kind: 'semantic', key: 'ceiling', value: 'the ceiling is 500', why: { matchedBy: 'exact_key', score: 1 } }],
      documents: [{ name: 'notes.md', content: 'vendor notes' }],
      toolResults: [{ tool: 'query_po_database', status: 'OK', args: { poNumber: '990' }, result: { found: true } }],
    },
    responseFormat: 'json',
  });

  assert.equal(outcome.stopReason, null);
  assert.equal(outcome.context.budgetReport.tools.accepted.length, 3, 'the window carried the permitted tools');
  assert.equal(outcome.context.budgetReport.items.find((item) => item.kind === 'policy_constraints').included, true);
  assert.equal(outcome.context.messages[0].role, 'system');
  assert.match(outcome.context.messages[0].content, /POLICY CONSTRAINTS/);
  // The loop's transcript starts with the assembled window and ends with the
  // model's own turn; the task is the last thing the MODEL was given.
  assert.ok(outcome.messages.some((message) => message.role === 'user' && message.content.includes('Reconcile the invoice')));
  // The model's own view confirms what it was given.
  const modelCall = runtime.mockProvider.calls[0];
  assert.match(modelCall.messages[0].content, /POLICY CONSTRAINTS/);
  assert.deepEqual(modelCall.tools.map((tool) => tool.name), ['query_po_database', 'calculate_tax_variance', 'request_human_approval']);
  assert.equal(modelCall.messages.some((message) => message.content.includes('the ceiling is 500')), true, 'memory reached the model');

  run.finish({ status: STATES.COMPLETED });
});

test('an impossible context budget is a refusal: the model is never called', async () => {
  const { runtime } = scenario({
    mockScript: [{ json: { action: 'auto_approve' } }],
  });
  const run = runtime.createRun({ agentId: 'svc_03' });

  const outcome = await run.loop({
    task: 't'.repeat(4_000),
    context: { budget: { maxTokens: 30, reserveTokens: 0 } },
  });

  assert.ok(outcome.stopReason);
  assert.equal(outcome.stopReason.code, STOP_REASONS.CONTEXT_OVERFLOW);
  assert.equal(outcome.stopReason.scope, 'context');
  assert.match(outcome.stopReason.message, /context overflow/);
  assert.equal(runtime.mockProvider.callCount, 0, 'an over-budget window is not sent to a model');
  assert.equal(outcome.turns, 0);
  assert.equal(run.state, STATES.IDLE, 'the run never left IDLE');

  const events = runtime.runStore.runEvents(run.runId);
  assert.ok(events.some((event) => event.type === EVENT_TYPES.VALIDATION_FAILED && event.payload.reason === 'context_overflow'));
  assert.ok(events.some((event) => event.type === EVENT_TYPES.BUDGET_STOPPED));

  run.finish({ status: STATES.FAILED, reason: STOP_REASONS.CONTEXT_OVERFLOW });
  assert.equal(runtime.runStore.getRun(run.runId).status, 'FAILED');
});

test('the context manager refuses to widen the run\'s tool list even when the caller asks', async () => {
  const { runtime } = scenario();
  const run = runtime.createRun({ agentId: 'svc_03' });
  const built = run.buildContext({ task: 'do the thing', tools: ['submit_paper_order', 'no_op', 'query_po_database'] });
  assert.deepEqual(built.tools.map((tool) => tool.name), ['query_po_database']);
  assert.deepEqual(built.budgetReport.tools.rejected.map((entry) => entry.name), ['submit_paper_order', 'no_op']);
  run.finish({ status: STATES.COMPLETED });
});

// ── the five memory kinds through a run ─────────────────────────────────────

test('all five memory kinds write and recall through the run, with events and reasons', async () => {
  const { runtime } = scenario();
  const run = runtime.createRun({ agentId: 'svc_06' });

  const scopeIds = {
    working: run.runId,
    conversation: run.sessionId,
    episodic: 'svc_06',
    semantic: 'svc_06',
    user: 'operator-1',
  };
  for (const kind of MEMORY_KINDS) {
    const written = run.memory.forKind(kind).write({
      key: `${kind}-record`,
      value: `a ${kind} record about the paper account`,
      tags: [kind],
      scopeId: scopeIds[kind],
    });
    assert.equal(written.ok, true, `${kind} was written`);
    assert.equal(written.record.runId, run.runId, 'the run facade stamps its own run id');
    assert.equal(written.record.sessionId, run.sessionId);
    assert.equal(written.record.agentId, 'svc_06');
  }

  const episodic = run.memory.forKind(MEMORY_KIND.EPISODIC).recall({ text: 'paper account' });
  assert.equal(episodic.ok, true);
  assert.equal(episodic.count, 1);
  assert.equal(episodic.records[0].why.matchedBy, 'keyword_overlap');
  assert.equal(episodic.matcher.vectorSearch, false);

  const byKey = run.memory.recall({ keys: ['semantic-record'] }, { kind: MEMORY_KIND.SEMANTIC });
  assert.equal(byKey.records[0].key, 'semantic-record');
  assert.equal(byKey.records[0].why.matchedBy, 'exact_key');

  const listed = run.memory.list({ kind: MEMORY_KIND.WORKING });
  assert.equal(listed.count, 1);

  const events = runtime.runStore.runEvents(run.runId);
  assert.equal(events.filter((event) => event.type === EVENT_TYPES.MEMORY_WRITTEN).length, MEMORY_KINDS.length);
  // Two retrievals: the kinded recall and the direct recall. `list()` is the
  // inspection read and does not claim a retrieval.
  assert.equal(events.filter((event) => event.type === EVENT_TYPES.MEMORY_RETRIEVED).length, 2);
  assert.equal(runtime.memoryKinds.stats().byKind.episodic, 1, 'the runtime-level view sees the same records');

  run.finish({ status: STATES.COMPLETED });
});

test('a memory record a model proposed is redacted on the way to disk', () => {
  const { runtime } = scenario();
  const run = runtime.createRun({ agentId: 'svc_03' });
  run.memory.write({ kind: MEMORY_KIND.EPISODIC, key: 'from-model', value: { apiKey: 'sk-abcdefghijklmnop', note: 'kept' }, scopeId: run.runId });
  const raw = fs.readFileSync(runtime.runStore.paths.memory, 'utf8');
  assert.equal(/sk-abcdefghijklmnop/.test(raw), false);
  assert.match(raw, /"note":"kept"/);
  run.finish({ status: STATES.COMPLETED });
});

test('a memory store that cannot be read does not crash the run', () => {
  const { runtime, storageDir } = scenario();
  // Make the memory collection unreadable by putting a directory where the file
  // belongs: a real, reproducible storage fault.
  fs.mkdirSync(path.join(storageDir, 'memory', 'memory.jsonl'), { recursive: true });

  const run = runtime.createRun({ agentId: 'svc_03' });
  const records = run.recall({ scope: 'run', scopeId: run.runId });
  assert.deepEqual(records, [], 'the call-1 read returns nothing rather than throwing');

  const structured = run.memory.recall({ kind: MEMORY_KIND.EPISODIC });
  assert.equal(structured.ok, false);
  assert.equal(structured.error.code, 'MEMORY_STORE_READ_FAILED');
  assert.match(structured.error.message, /EISDIR|illegal operation|directory/);

  const write = run.memory.write({ kind: MEMORY_KIND.EPISODIC, key: 'k', value: 1 });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'MEMORY_STORE_WRITE_FAILED');

  const events = runtime.runStore.runEvents(run.runId);
  assert.ok(events.some((event) => event.type === EVENT_TYPES.MEMORY_RETRIEVED && event.payload.ok === false));
  assert.ok(events.some((event) => event.type === EVENT_TYPES.VALIDATION_FAILED && event.payload.reason === 'memory_retrieval_failed'));

  const summary = run.finish({ status: STATES.COMPLETED, reason: 'memory was unavailable' });
  assert.equal(summary.status, 'COMPLETED', 'the run completes with a recorded degradation');
  const health = runtime.runStore.health();
  assert.equal(health.runs.corruptLines, 0, 'the run record itself is intact');
  assert.equal(health.memory.readable, false, 'the health report names the collection it could not read');
  assert.match(health.memory.error.message, /EISDIR|illegal operation|directory/);
});

// ── prompts and agents through the runtime ──────────────────────────────────

test('every SVC agent renders its prompt of record through the runtime and runs the planned loop', async () => {
  const caseIndex = { svc_03: 'invoices_dataset.json', svc_04: 'security_alerts_dataset.json', svc_06: 'trading_dataset.json' };
  const plans = {
    svc_03: [
      { id: 's1', description: 'Verify the PO', tool: 'query_po_database', args: { poNumber: '990' } },
      { id: 's2', description: 'Compute the variance', tool: 'calculate_tax_variance', args: { expectedTax: 36, actualTax: 36 } },
    ],
    svc_04: [
      { id: 's1', description: 'Read the alert context', tool: 'query_alert_context', args: { alertId: '31103' } },
      { id: 's2', description: 'Check the allowlist', tool: 'check_ip_allowlist', args: { ip: '10.20.0.31' } },
    ],
    svc_06: [
      { id: 's1', description: 'Read the portfolio', tool: 'get_portfolio_state', args: {} },
      { id: 's2', description: 'Read the quote', tool: 'get_market_quote', args: { ticker: 'AAPL' } },
    ],
  };

  for (const [agentId, datasetFile] of Object.entries(caseIndex)) {
    const [firstCase] = loadDataset(datasetFile);
    const agent = loadAgent(agentId);
    const { runtime } = scenario({
      mockScript: [{ json: { reasoning: 'offline planned run', action: firstCase.vars.expected_action } }, { json: { reasoning: 'offline planned run', action: firstCase.vars.expected_action } }],
    });
    const run = runtime.createRun({ agentId });
    const adapted = agent.caseAdapter(firstCase.vars);
    const outcome = await run.loop({
      mode: 'planned',
      goal: adapted.task,
      systemPrompt: adapted.systemPrompt,
      userMessage: adapted.userMessage,
      steps: plans[agentId],
      evidence: adapted.evidence,
      untrusted: adapted.untrusted,
      responseFormat: 'json',
    });

    assert.equal(outcome.stopReason, null, `${agentId}: ${outcome.stopReason?.message ?? ''}`);
    assert.equal(outcome.plan.status, PLAN_STATUS.COMPLETE, `${agentId} plan completed`);
    assert.match(adapted.systemPrompt, /INVOICE UNDER REVIEW|ALERT UNDER REVIEW|ORDER REQUEST AND ACCOUNT STATE/, `${agentId} rendered its prompt of record`);
    assert.equal(JSON.parse(outcome.finalText).action, firstCase.vars.expected_action, `${agentId} reached its documented disposition`);
    assert.equal(run.state, STATES.COMPLETED);
    run.finish({ status: STATES.COMPLETED });
  }
});

test('an agent whose prompt is missing a value cannot be run: the render refuses', () => {
  // The refusal happens in the agent definition, before any run exists.
  const agent = loadAgent('svc_03');
  assert.throws(() => agent.prompts.systemFor({}), /PLACEHOLDER_VALUE_EMPTY/);
  assert.throws(() => agent.prompts.systemFor({ invoice_data: '' }), /PLACEHOLDER_VALUE_EMPTY/);
  assert.equal(typeof agent.prompts.systemFor({ invoice_data: 'Invoice #1. Amount: $1.00.' }), 'string');
});
