/**
 * The context manager: window assembly, priority trimming, tool narrowing and
 * the deterministic-truncation "summarizer".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createContextManager,
  CONTEXT_PRIORITY,
  CONTEXT_ITEM_KIND,
  PROTECTED_PRIORITIES,
  SUMMARIZER,
  TRUNCATION_MARKER,
  truncateText,
  DEFAULT_CONTEXT_BUDGET,
} from '../../src/context/manager.mjs';
import { makeTestRuntime } from '../helpers/runtime.mjs';
import { getAgentProfile } from '../../src/config/agents.mjs';

function manager(agentId = 'svc_03', options = {}) {
  const { runtime } = makeTestRuntime();
  return runtime.createContextManager({ profile: getAgentProfile(agentId), agentId, ...options });
}

function richRequest(overrides = {}) {
  return {
    task: 'Reconcile the invoice and report the disposition.',
    conversation: [
      { role: 'user', content: 'The vendor says the invoice is urgent.' },
      { role: 'assistant', content: 'I will verify the PO before deciding.' },
      { role: 'user', content: 'Please continue.' },
    ],
    memory: [
      { memoryId: 'm1', kind: 'semantic', key: 'ceiling', value: 'the ceiling is a hard limit', why: { matchedBy: 'exact_key', score: 1 } },
      { memoryId: 'm2', kind: 'episodic', key: 'vendor-9', value: 'vendor 9 disputed a variance', why: { matchedBy: 'keyword_overlap', score: 0.5 } },
    ],
    documents: [{ name: 'policy.md', content: 'Policy notes. '.repeat(30) }],
    toolResults: [
      { tool: 'query_po_database', status: 'OK', args: { poNumber: '990' }, result: { po: { total: 450 } } },
      { tool: 'calculate_tax_variance', status: 'OK', args: { expectedTax: 36, actualTax: 36 }, result: { variance: 0 } },
    ],
    ...overrides,
  };
}

test('build() returns the documented shape', () => {
  const built = manager().build(richRequest());

  assert.ok(Array.isArray(built.messages));
  assert.ok(Array.isArray(built.tools));
  assert.equal(typeof built.droppedCount, 'number');
  assert.equal(typeof built.compressed, 'boolean');
  assert.ok(built.budgetReport && typeof built.budgetReport === 'object');

  const { budgetReport } = built;
  for (const field of ['budget', 'usedCharacters', 'usedTokens', 'overBudget', 'summarizer', 'itemCount', 'includedCount', 'droppedCount', 'dropped', 'dropOrder', 'admitOrder', 'items', 'tools', 'compressed']) {
    assert.ok(field in budgetReport, `budgetReport.${field} is present`);
  }

  const roles = built.messages.map((message) => message.role);
  assert.equal(roles[0], 'system');
  assert.equal(roles[roles.length - 1], 'user');
  assert.equal(built.messages[built.messages.length - 1].content, richRequest().task, 'the task is the last thing the model reads');
  assert.ok(roles.includes('assistant'), 'conversation turns keep their role');
});

test('the policy constraints are in the system message, labelled and authoritative', () => {
  const built = manager('svc_06').build(richRequest());
  const system = built.messages[0].content;
  assert.match(system, /POLICY CONSTRAINTS \(authoritative\)/);
  assert.match(system, /Permitted tools, and no others/);
  assert.match(system, /maxSingleOrderNotionalUsd=10000/);
  assert.match(system, /Hard limits:/);
  assert.match(system, /Destructive actions are not available/);
});

test('the window carries the plan, the memory records and the tool results', () => {
  const plan = {
    planId: 'pln_x',
    status: 'active',
    revision: 1,
    goal: 'Reconcile invoice #101',
    steps: [
      { id: 's1', index: 0, description: 'Verify the PO', tool: 'query_po_database', args: { poNumber: '990' }, status: 'done', attempts: 1 },
      { id: 's2', index: 1, description: 'Compute the variance', tool: 'calculate_tax_variance', args: null, status: 'pending', attempts: 0 },
    ],
  };
  const built = manager().build(richRequest({ plan }));
  const system = built.messages[0].content;

  assert.match(system, /Plan \(active, revision 1\) — Reconcile invoice #101/);
  assert.match(system, /1\. \(done\) Verify the PO \[tool: query_po_database \{"poNumber":"990"\}\]/);
  assert.match(system, /MEMORY/);
  assert.match(system, /ceiling: the ceiling is a hard limit \(matched by exact_key\)/);
  assert.match(system, /TOOL RESULT/);
  assert.match(system, /query_po_database\(\{"poNumber":"990"\}\) -> OK/);
  assert.match(system, /DOCUMENT/);
});

test('only the agent\'s permitted tools reach the model', () => {
  const built = manager('svc_03').build(richRequest());
  assert.deepEqual(built.tools.map((tool) => tool.name), ['query_po_database', 'calculate_tax_variance', 'request_human_approval']);
  assert.deepEqual(built.budgetReport.tools.accepted, ['query_po_database', 'calculate_tax_variance', 'request_human_approval']);
  assert.deepEqual(built.budgetReport.tools.rejected, []);
});

test('a caller cannot widen the tool list, and the refusal is reported', () => {
  const built = manager('svc_03').build(
    richRequest({ tools: ['query_po_database', 'submit_paper_order', 'no_op', 'ghost_tool'] }),
  );
  assert.deepEqual(built.tools.map((tool) => tool.name), ['query_po_database']);
  assert.deepEqual(built.budgetReport.tools.accepted, ['query_po_database']);
  assert.deepEqual(
    built.budgetReport.tools.rejected.map((entry) => entry.name),
    ['submit_paper_order', 'no_op', 'ghost_tool'],
  );
  for (const rejected of built.budgetReport.tools.rejected) {
    assert.match(rejected.reason, /not in the "svc_03" allowlist/);
  }
});

test('the model projection carries no risk, permission or side-effect field', () => {
  const built = manager('svc_06').build(richRequest());
  for (const tool of built.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name'], 'the model sees name, description, inputSchema — nothing else');
  }
  const raw = JSON.stringify(built.tools);
  for (const leak of ['riskLevel', 'permissions', 'requiresConfirmation', 'dataAccess']) {
    assert.equal(raw.includes(leak), false, `${leak} must not be sent to the model`);
  }
});

test('over-budget assembly drops lowest-priority items first, in a stable order', () => {
  const ctx = manager();
  const tight = { ...DEFAULT_CONTEXT_BUDGET, maxTokens: 220, reserveTokens: 0 };

  const first = ctx.build(richRequest({ budget: tight }));
  const second = ctx.build(richRequest({ budget: tight }));

  assert.ok(first.droppedCount > 0, 'something was dropped');
  assert.deepEqual(first.budgetReport.dropOrder, second.budgetReport.dropOrder, 'the drop order is identical across builds');
  assert.deepEqual(
    first.budgetReport.dropped.map((item) => item.id),
    second.budgetReport.dropped.map((item) => item.id),
  );

  const keptPriorities = new Set(first.budgetReport.items.filter((item) => item.included).map((item) => item.priority));
  for (const dropped of first.budgetReport.items.filter((item) => !item.included)) {
    // Nothing kept may be lower priority than something dropped.
    assert.equal(
      [...keptPriorities].some((priority) => priority < dropped.priority),
      false,
      `priority ${dropped.priority} was dropped while a lower priority was kept`,
    );
  }

  // The lowest-priority kind present (documents) is what goes first.
  const droppedKinds = first.budgetReport.dropped.map((item) => item.kind);
  assert.ok(droppedKinds.includes(CONTEXT_ITEM_KIND.DOCUMENT), 'the lowest-priority material is dropped first');
});

test('within one priority the OLDEST item is dropped first', () => {
  const ctx = manager();
  const turns = Array.from({ length: 8 }, (_, index) => ({ id: `turn-${index}`, role: 'user', content: `turn ${index} ${'x'.repeat(300)}` }));
  const built = ctx.build({
    task: 'short task',
    conversation: turns,
    budget: { maxTokens: 520, reserveTokens: 0 },
  });
  const keptTurns = built.budgetReport.items.filter((item) => item.kind === CONTEXT_ITEM_KIND.CONVERSATION && item.included).map((item) => item.id);
  const droppedTurns = built.budgetReport.dropped.filter((item) => item.kind === CONTEXT_ITEM_KIND.CONVERSATION).map((item) => item.id);
  assert.ok(keptTurns.length > 0);
  assert.ok(droppedTurns.length > 0);
  // Every kept turn is newer (higher index) than every dropped turn.
  const lowestKept = Math.min(...keptTurns.map((id) => Number(id.split('-')[1])));
  const highestDropped = Math.max(...droppedTurns.map((id) => Number(id.split('-')[1])));
  assert.ok(highestDropped < lowestKept, `dropped ${highestDropped} but kept ${lowestKept}`);
});

test('policy constraints and the task are never dropped — only truncated', () => {
  const ctx = manager();
  const built = ctx.build({
    task: 'a task that is itself quite long '.repeat(20),
    conversation: Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `turn ${index} `.repeat(50) })),
    documents: [{ name: 'big.md', content: 'z'.repeat(5_000) }],
    // Small enough that only the protected items could possibly fit.
    budget: { maxTokens: 120, reserveTokens: 0 },
  });

  const policy = built.budgetReport.items.find((item) => item.kind === CONTEXT_ITEM_KIND.POLICY);
  const task = built.budgetReport.items.find((item) => item.kind === CONTEXT_ITEM_KIND.TASK);
  assert.equal(policy.protected, true);
  assert.equal(task.protected, true);
  assert.equal(policy.included, true, 'the policy constraints survive');
  assert.equal(task.included, true, 'the task survives');
  assert.equal(built.budgetReport.dropped.some((item) => item.id === 'policy'), false);
  assert.equal(built.budgetReport.dropped.some((item) => item.id === 'task'), false);
  assert.equal(built.compressed, true, 'fitting them in required truncation');
  assert.match(built.messages[0].content, /POLICY CONSTRAINTS/, 'the policy text is in the window');
  assert.ok(built.messages[0].content.includes(TRUNCATION_MARKER), 'the truncation is marked in the text itself');
});

test('an impossible budget is reported, not hidden', () => {
  const built = manager().build({
    task: 't'.repeat(4_000),
    budget: { maxTokens: 50, reserveTokens: 0 },
  });
  assert.equal(built.budgetReport.overBudget, true);
  assert.ok(built.budgetReport.exceededBy > 0);
  assert.equal(built.budgetReport.items.find((item) => item.id === 'task').included, true, 'still included: truncation, never dropping');
  assert.match(built.messages[built.messages.length - 1].content, /^t+/);
});

test('compression is labelled deterministic truncation, and truncateText says how much went', () => {
  assert.equal(SUMMARIZER.name, 'deterministic-truncation');
  assert.equal(SUMMARIZER.llm, false);
  assert.equal(SUMMARIZER.deterministic, true);

  const short = truncateText('hello', 10);
  assert.deepEqual(short, { text: 'hello', truncated: false, removed: 0 });

  const long = truncateText('abcdefghij', 4);
  assert.equal(long.truncated, true);
  assert.equal(long.removed, 6);
  assert.match(long.text, /^abcd/);
  assert.ok(long.text.includes(TRUNCATION_MARKER));
  assert.ok(long.text.includes('6 characters]'));

  const built = manager().build(richRequest({ budget: { maxTokens: 200, reserveTokens: 0 } }));
  assert.equal(built.budgetReport.summarizer.llm, false);
  for (const trimmed of built.budgetReport.trimmed) {
    assert.equal(trimmed.truncated, true);
    assert.ok(trimmed.removed > 0);
  }
});

test('the reserved answer budget is respected', () => {
  const ctx = manager('svc_03', { budget: { maxTokens: 1_000, reserveTokens: 400 } });
  const built = ctx.build(richRequest());
  assert.equal(built.budgetReport.budget.usableTokens, 600);
  assert.ok(built.budgetReport.usedTokens <= 600);
  // And a request-level override wins over the manager default.
  const overridden = ctx.build(richRequest({ budget: { maxTokens: 2_000, reserveTokens: 0 } }));
  assert.equal(overridden.budgetReport.budget.usableTokens, 2_000);
});

test('a caller-supplied system prompt is prepended, not substituted for the constraints', () => {
  const built = manager().build(richRequest({ systemPrompt: 'You are a careful reviewer.' }));
  const system = built.messages[0].content;
  assert.match(system, /^You are a careful reviewer\./);
  assert.match(system, /POLICY CONSTRAINTS \(authoritative\)/, 'the constraints are still there');
});

test('an empty request still produces a usable window', () => {
  const built = manager().build({});
  assert.equal(built.messages.length, 1);
  assert.match(built.messages[0].content, /POLICY CONSTRAINTS/);
  assert.equal(built.droppedCount, 0);
  assert.equal(built.compressed, false);
  assert.ok(built.budgetReport.items.find((item) => item.kind === CONTEXT_ITEM_KIND.POLICY).included);
});

test('describe() reports the priorities, protections and summarizer honestly', () => {
  const described = manager('svc_04').describe();
  assert.equal(described.agentId, 'svc_04');
  assert.deepEqual(described.toolAllowlist, ['query_alert_context', 'check_ip_allowlist', 'create_incident_ticket', 'request_analyst_review']);
  assert.deepEqual(described.protectedPriorities, [CONTEXT_PRIORITY.POLICY, CONTEXT_PRIORITY.TASK]);
  assert.equal(described.summarizer.llm, false);
  assert.ok(PROTECTED_PRIORITIES.includes(CONTEXT_PRIORITY.POLICY) && PROTECTED_PRIORITIES.includes(CONTEXT_PRIORITY.TASK));
  assert.ok(described.priorities.POLICY > described.priorities.TASK);
  assert.ok(described.priorities.TASK > described.priorities.PLAN);
  assert.ok(described.priorities.PLAN > described.priorities.TOOL_RESULTS);
  assert.ok(described.priorities.TOOL_RESULTS > described.priorities.CONVERSATION);
  assert.ok(described.priorities.CONVERSATION > described.priorities.MEMORY);
  assert.ok(described.priorities.MEMORY > described.priorities.DOCUMENTS);
});

test('the assembled window is inside the budget it reports', () => {
  const built = manager().build(richRequest());
  const characters = built.messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(characters <= built.budgetReport.budget.maxCharacters);
  assert.ok(built.budgetReport.usedCharacters <= built.budgetReport.budget.maxCharacters);
  assert.equal(built.compressed, false, 'a comfortable budget compresses nothing');
});
