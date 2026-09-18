/**
 * Tool executor: the order of operations, and the proof that a tool is never
 * called when resolution, validation, policy, approval or budget says no.
 *
 * Every test here counts invocations of a canary tool. If any counter is
 * non-zero where it must be zero, the executor has executed something it was
 * forbidden to execute — the one failure this component exists to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry, defineTool } from '../../src/tools/registry.mjs';
import { createToolExecutor, EXECUTION_STATUS, NON_EXECUTION_STATUSES } from '../../src/tools/executor.mjs';
import { createPolicyKernel, DECISIONS } from '../../src/policy/engine.mjs';
import { DEFAULT_RULES } from '../../src/policy/rules/index.mjs';
import { createApprovalManager } from '../../src/policy/approvals.mjs';
import { createBudgetTracker } from '../../src/runtime/budgets.mjs';
import { createEventBus, createMemorySink } from '../../src/observability/events.mjs';
import { AGENT_PROFILES } from '../../src/config/agents.mjs';
import { fixedClock } from '../helpers/fixtures.mjs';

/**
 * A canary tool: records every invocation so a test can prove non-execution.
 * `optionalDetail` has no constraints at all, so a `null` passed there satisfies
 * the schema and reaches the policy kernel's explicit-null rule.
 */
function makeCanary({
  name = 'query_po_database',
  behaviour = 'ok',
  timeoutMs = null,
  sideEffect = 'read',
  riskLevel = 'low',
  requiresConfirmation = false,
  permissions = ['po:read'],
  dataAccess = ['finance/po'],
  escalation = false,
} = {}) {
  const calls = [];
  const tool = defineTool({
    name,
    description: `Canary tool "${name}" used to prove whether the executor ran it.`,
    inputSchema: {
      type: 'object',
      properties: {
        poNumber: { type: 'string' },
        amount: { type: 'number' },
        optionalDetail: {},
      },
      required: ['poNumber'],
    },
    riskLevel,
    sideEffect,
    requiresConfirmation,
    escalation,
    permissions,
    dataAccess,
    timeoutMs,
    async execute(args) {
      calls.push(args);
      if (behaviour === 'throw') throw new Error('tool blew up');
      if (behaviour === 'hang') await new Promise(() => {});
      return { ok: true, echoed: args };
    },
  });
  return { tool, calls };
}

/**
 * The SVC_03 escalation tool: in the profile, permissioned, and marked
 * `escalation: true` + `requiresConfirmation: true` — the shape that produces
 * the REQUIRE_APPROVAL verdict the executor must honour.
 */
function makeEscalationCanary() {
  return makeCanary({
    name: 'request_human_approval',
    permissions: ['approval:request'],
    dataAccess: ['agent/approval'],
    sideEffect: 'write',
    riskLevel: 'medium',
    requiresConfirmation: true,
    escalation: true,
  });
}

function makeExecutor({ tools, policy, approvals = null, budget = null, events = null, now = fixedClock(), defaultTimeoutMs = 1_000 } = {}) {
  const registry = createToolRegistry({ tools });
  const executor = createToolExecutor({
    registry,
    policy: policy ?? createPolicyKernel({ rules: DEFAULT_RULES }),
    approvals,
    events,
    now,
    defaultTimeoutMs,
  });
  return { registry, executor };
}

const svc03 = AGENT_PROFILES.svc_03;

test('a permitted call runs once and reports status, result and duration', async () => {
  const { tool, calls } = makeCanary();
  const { executor } = makeExecutor({ tools: [tool] });

  const result = await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });

  assert.equal(result.status, EXECUTION_STATUS.OK);
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { poNumber: '990' });
  assert.deepEqual(result.result.echoed, { poNumber: '990' });
  assert.equal(result.policy.decision, DECISIONS.ALLOW);
  assert.equal(result.policy.rule, 'input.validation');
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(result.approval, null);
  assert.equal(result.error, null);
});

test('(a) an unknown tool is TOOL_NOT_FOUND and nothing runs', async () => {
  const { tool, calls } = makeCanary();
  const { executor } = makeExecutor({ tools: [tool] });

  const result = await executor.execute({ toolName: 'drop_database', args: {}, profile: svc03, agentId: 'svc_03' });

  assert.equal(result.status, EXECUTION_STATUS.TOOL_NOT_FOUND);
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.match(result.error.message, /not registered/);
  assert.equal(calls.length, 0);
});

test('(b) invalid arguments are TOOL_ARGUMENT_INVALID — returned, never thrown — and nothing runs', async () => {
  const { tool, calls } = makeCanary();
  const { executor } = makeExecutor({ tools: [tool] });

  const missing = await executor.execute({ toolName: 'query_po_database', args: {}, profile: svc03, agentId: 'svc_03' });
  assert.equal(missing.status, EXECUTION_STATUS.TOOL_ARGUMENT_INVALID);
  assert.equal(missing.error.violations.length, 1);
  assert.equal(missing.error.violations[0].keyword, 'required');
  assert.match(missing.error.formatted[0], /poNumber is required/);

  const wrongType = await executor.execute({ toolName: 'query_po_database', args: { poNumber: 990 }, profile: svc03, agentId: 'svc_03' });
  assert.equal(wrongType.status, EXECUTION_STATUS.TOOL_ARGUMENT_INVALID);
  assert.equal(wrongType.error.violations[0].keyword, 'type');

  const explicitNull = await executor.execute({ toolName: 'query_po_database', args: { poNumber: null }, profile: svc03, agentId: 'svc_03' });
  assert.equal(explicitNull.status, EXECUTION_STATUS.TOOL_ARGUMENT_INVALID, 'null fails the string type check');

  // A field the schema permits to be null is still refused by policy: "I do not
  // know this value" must never be silently treated as a value.
  const nullableField = await executor.execute({
    toolName: 'query_po_database',
    args: { poNumber: '990', optionalDetail: null },
    profile: svc03,
    agentId: 'svc_03',
  });
  assert.equal(nullableField.status, EXECUTION_STATUS.POLICY_DENIED);
  assert.equal(nullableField.policy.rule, 'input.validation');
  assert.match(nullableField.error.message, /explicit null/);

  assert.equal(calls.length, 0, 'no invalid call may reach execute()');
  assert.ok(NON_EXECUTION_STATUSES.includes(missing.status));
});

test('(c)+(d) a policy DENY blocks execution and reports the deciding rule', async () => {
  // An order tool is real, registered and writes state — but SVC_03 has no
  // business calling it, so tool.authorization denies the call.
  const canary = makeCanary({ name: 'submit_paper_order', permissions: ['order:paper:write'], dataAccess: ['trading/order'], sideEffect: 'write' });
  const { executor } = makeExecutor({ tools: [canary.tool] });

  const result = await executor.execute({ toolName: 'submit_paper_order', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });

  assert.equal(result.status, EXECUTION_STATUS.POLICY_DENIED);
  assert.equal(result.policy.decision, DECISIONS.DENY);
  assert.equal(result.policy.rule, 'tool.authorization');
  assert.match(result.error.message, /not authorised/);
  assert.equal(canary.calls.length, 0);
  assert.equal(result.executed, false);
});

test('(c)+(d) REQUIRE_APPROVAL pauses the call, persists an approval, and executes nothing', async () => {
  const approvals = createApprovalManager({ now: fixedClock() });
  const canary = makeEscalationCanary();
  const { executor } = makeExecutor({ tools: [canary.tool], approvals });

  const result = await executor.execute({
    toolName: 'request_human_approval',
    args: { poNumber: '990' },
    profile: svc03,
    agentId: 'svc_03',
  });

  assert.equal(result.status, EXECUTION_STATUS.APPROVAL_REQUIRED);
  assert.equal(result.executed, false);
  assert.equal(result.approval.status, 'pending');
  assert.match(result.approval.approvalId, /^apr_/);
  assert.equal(canary.calls.length, 0);
  assert.equal(approvals.listPending().length, 1);
  assert.equal(approvals.get(result.approval.approvalId).toolName, 'request_human_approval');
  assert.equal(approvals.get(result.approval.approvalId).policyRule, 'action.required_approval');
});

test('an approved approval lets the call through — once, and only for the same arguments', async () => {
  const approvals = createApprovalManager({ now: fixedClock() });
  const canary = makeEscalationCanary();
  const { executor } = makeExecutor({ tools: [canary.tool], approvals });

  const first = await executor.execute({ toolName: 'request_human_approval', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  const approvalId = first.approval.approvalId;
  approvals.approve(approvalId, { resolvedBy: 'desk' });

  const resumed = await executor.execute({
    toolName: 'request_human_approval',
    args: { poNumber: '990' },
    profile: svc03,
    agentId: 'svc_03',
    approvalId,
  });
  assert.equal(resumed.status, EXECUTION_STATUS.OK);
  assert.equal(resumed.approval.status, 'approved');
  assert.equal(canary.calls.length, 1);

  // a different argument set is NOT covered by the same approval
  const different = await executor.execute({
    toolName: 'request_human_approval',
    args: { poNumber: '991' },
    profile: svc03,
    agentId: 'svc_03',
    approvalId,
  });
  assert.equal(different.status, EXECUTION_STATUS.APPROVAL_REQUIRED);
  assert.match(different.approval.reason, /different arguments/);
  assert.equal(canary.calls.length, 1, 'the mismatched call did not run');
});

test('a REJECTED approval does not execute, and does not silently create a new request', async () => {
  const approvals = createApprovalManager({ now: fixedClock() });
  const canary = makeEscalationCanary();
  const { executor } = makeExecutor({ tools: [canary.tool], approvals });

  const first = await executor.execute({ toolName: 'request_human_approval', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  approvals.reject(first.approval.approvalId, { resolvedBy: 'desk', note: 'not justified' });

  const retry = await executor.execute({
    toolName: 'request_human_approval',
    args: { poNumber: '990' },
    profile: svc03,
    agentId: 'svc_03',
    approvalId: first.approval.approvalId,
  });
  assert.equal(retry.status, EXECUTION_STATUS.APPROVAL_REQUIRED);
  assert.match(retry.approval.reason, /is rejected/);
  assert.equal(retry.approval.approvalId, first.approval.approvalId, 'the rejected approval is reused, not replaced');
  assert.equal(canary.calls.length, 0);
});

test('without an approval store a REQUIRE_APPROVAL verdict cannot be satisfied by accident', async () => {
  const canary = makeEscalationCanary();
  const { executor } = makeExecutor({ tools: [canary.tool], approvals: null });

  const result = await executor.execute({ toolName: 'request_human_approval', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  assert.equal(result.status, EXECUTION_STATUS.APPROVAL_REQUIRED);
  assert.equal(result.approval, null);
  assert.match(result.error.message, /no approval store is configured/);
  assert.equal(canary.calls.length, 0);
});

test('(e) an exhausted budget stops the call before it executes', async () => {
  const canary = makeCanary();
  const budget = createBudgetTracker({ limits: { maxToolCalls: 1 }, now: fixedClock() });
  budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '000' } });

  const { executor } = makeExecutor({ tools: [canary.tool], budget });
  const result = await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03', budget });

  assert.equal(result.status, EXECUTION_STATUS.BUDGET_EXCEEDED);
  assert.equal(result.error.code, 'TOOL_CALL_BUDGET_EXCEEDED');
  assert.equal(canary.calls.length, 0, 'a budget stop must not execute');
});

test('loop detection inside the budget stops the repeated call before it executes', async () => {
  const canary = makeCanary();
  const budget = createBudgetTracker({ limits: { maxRepeatedToolCalls: 3, maxToolCalls: 50 }, now: fixedClock() });
  const { executor } = makeExecutor({ tools: [canary.tool], budget });

  const request = { toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03', budget };
  assert.equal((await executor.execute(request)).status, EXECUTION_STATUS.OK);
  assert.equal((await executor.execute(request)).status, EXECUTION_STATUS.OK);
  const third = await executor.execute(request);

  assert.equal(third.status, EXECUTION_STATUS.BUDGET_EXCEEDED);
  assert.equal(third.error.code, 'LOOP_DETECTED');
  assert.equal(canary.calls.length, 2, 'the third identical call never ran');
});

test('(f) a slow tool times out with TOOL_TIMEOUT and a duration', async () => {
  const canary = makeCanary({ behaviour: 'hang' });
  const { executor } = makeExecutor({ tools: [canary.tool], defaultTimeoutMs: 15 });

  const result = await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  assert.equal(result.status, EXECUTION_STATUS.TOOL_TIMEOUT);
  assert.equal(result.executed, false);
  assert.match(result.error.message, /exceeded its 15ms timeout/);
  assert.equal(canary.calls.length, 1, 'the tool did start; a JS function cannot be cancelled mid-flight');
});

test('a tool-level timeout overrides the executor default', async () => {
  const canary = makeCanary({ behaviour: 'hang', timeoutMs: 5 });
  const { executor } = makeExecutor({ tools: [canary.tool], defaultTimeoutMs: 5_000 });

  const started = Date.now();
  const result = await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  assert.equal(result.status, EXECUTION_STATUS.TOOL_TIMEOUT);
  assert.ok(Date.now() - started < 1_000, 'the tool-level timeout applied, not the 5s default');
});

test('(g) a throwing tool becomes TOOL_ERROR with the error captured, not propagated', async () => {
  const canary = makeCanary({ behaviour: 'throw' });
  const { executor } = makeExecutor({ tools: [canary.tool] });

  const result = await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  assert.equal(result.status, EXECUTION_STATUS.TOOL_ERROR);
  assert.equal(result.executed, true, 'it ran, and it failed: that is different from being blocked');
  assert.equal(result.error.message, 'tool blew up');
  assert.equal(result.result, null);
  assert.equal(canary.calls.length, 1);
});

test('the rate-limit rule can deny a call that the executor would otherwise run', async () => {
  const canary = makeCanary();
  const { executor } = makeExecutor({ tools: [canary.tool] });

  const history = { toolCalls: Array.from({ length: 24 }, () => ({ name: 'query_po_database' })) };
  const result = await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03', history });

  assert.equal(result.status, EXECUTION_STATUS.POLICY_DENIED);
  assert.equal(result.policy.rule, 'run.rate_limit');
  assert.equal(canary.calls.length, 0);
});

test('every stage emits an event, in order', async () => {
  const sink = createMemorySink();
  const events = createEventBus({ runId: 'run_ev', agentId: 'svc_03', sinks: [sink], now: () => 1 });
  const canary = makeCanary();
  const { executor } = makeExecutor({ tools: [canary.tool], events });

  await executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });

  assert.deepEqual(
    sink.events.map((event) => event.type),
    ['tool.proposed', 'policy.decided', 'tool.executed'],
  );
  assert.equal(sink.last('tool.proposed').payload.tool, 'query_po_database');
  assert.equal(sink.last('policy.decided').payload.decision, 'ALLOW');
  assert.notEqual(sink.last('tool.executed').payload.durationMs, undefined);
});

test('a blocked call emits tool.proposed, policy.decided and tool.failed', async () => {
  const sink = createMemorySink();
  const events = createEventBus({ runId: 'run_ev', agentId: 'svc_03', sinks: [sink], now: () => 1 });
  const canary = makeCanary({ name: 'submit_paper_order', permissions: ['order:paper:write'], dataAccess: ['trading/order'], sideEffect: 'write' });
  const { executor } = makeExecutor({ tools: [canary.tool], events });

  await executor.execute({ toolName: 'submit_paper_order', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });

  assert.deepEqual(
    sink.events.map((event) => event.type),
    ['tool.proposed', 'policy.decided', 'tool.failed'],
  );
  assert.equal(sink.last('policy.decided').payload.decision, 'DENY');
});

test('approval.requested and approval.resolved are emitted around the pause and the resume', async () => {
  const sink = createMemorySink();
  const events = createEventBus({ runId: 'run_ev', agentId: 'svc_03', sinks: [sink], now: () => 1 });
  const approvals = createApprovalManager({ now: fixedClock() });
  const canary = makeEscalationCanary();
  const { executor } = makeExecutor({ tools: [canary.tool], approvals, events });

  const paused = await executor.execute({ toolName: 'request_human_approval', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' });
  assert.equal(sink.byType('approval.requested').length, 1);
  assert.equal(sink.last('approval.requested').payload.approvalId, paused.approval.approvalId);

  approvals.approve(paused.approval.approvalId, { resolvedBy: 'desk' });
  await executor.execute({
    toolName: 'request_human_approval',
    args: { poNumber: '990' },
    profile: svc03,
    agentId: 'svc_03',
    approvalId: paused.approval.approvalId,
  });
  assert.equal(sink.byType('approval.resolved').length, 1);
  assert.equal(sink.last('approval.resolved').payload.status, 'approved');
});

test('execute() never throws for an expected failure — only for a broken wiring', async () => {
  const canary = makeCanary({ behaviour: 'throw' });
  const { executor } = makeExecutor({ tools: [canary.tool] });
  await assert.doesNotReject(() => executor.execute({ toolName: 'query_po_database', args: { poNumber: '990' }, profile: svc03, agentId: 'svc_03' }));
  await assert.doesNotReject(() => executor.execute({ toolName: 'nope', args: {}, profile: svc03, agentId: 'svc_03' }));
  await assert.doesNotReject(() => executor.execute({}));

  assert.throws(() => createToolExecutor({ registry: null, policy: createPolicyKernel({}) }), /registry is required/);
  assert.throws(() => createToolExecutor({ registry: createToolRegistry({}), policy: null }), /policy kernel is required/);
});

test('describe() reports the wiring for verification', () => {
  const canary = makeCanary();
  const { executor } = makeExecutor({ tools: [canary.tool] });
  const described = executor.describe();
  assert.equal(described.approvalsConfigured, false);
  assert.equal(described.policyRules.length, DEFAULT_RULES.length);
  assert.equal(described.tools[0].name, 'query_po_database');
  assert.equal(described.tools[0].riskLevel, 'low');
});
