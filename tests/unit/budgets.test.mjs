/**
 * Budgets and loop detection: every stop reason, and the counting contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBudgetTracker, STOP_REASONS, RECOVERABLE_STOP_REASONS } from '../../src/runtime/budgets.mjs';
import { fixedClock } from '../helpers/fixtures.mjs';

test('a fresh tracker is within budget and reports what remains', () => {
  const budget = createBudgetTracker({ limits: { maxIterations: 3, wallClockMs: 1000, maxTokens: 100, maxToolCalls: 2 }, now: fixedClock() });
  const check = budget.check();
  assert.equal(check.exceeded, false);
  assert.equal(check.stopReason, null);
  assert.deepEqual(budget.remaining(), { iterations: 3, toolCalls: 2, tokens: 100, wallClockMs: 1000 });
});

test('iteration budget: the limit is permitted, the next check stops', () => {
  const clock = fixedClock();
  const budget = createBudgetTracker({ limits: { maxIterations: 2 }, now: clock });

  budget.recordIteration();
  assert.equal(budget.check().exceeded, false);
  budget.recordIteration();
  const stop = budget.check();
  assert.equal(stop.exceeded, true);
  assert.equal(stop.stopReason.code, STOP_REASONS.ITERATION_BUDGET_EXCEEDED);
  assert.equal(stop.stopReason.observed, 2);
  assert.equal(stop.stopReason.limit, 2);
  assert.equal(stop.stopReason.recoverable, false);
  assert.match(stop.stopReason.message, /iteration budget exhausted/);
});

test('wall-clock timeout is driven by the injected clock, not by sleeping', () => {
  const clock = fixedClock();
  const budget = createBudgetTracker({ limits: { wallClockMs: 500 }, now: clock });
  assert.equal(budget.check().exceeded, false);
  clock.advance(499);
  assert.equal(budget.check().exceeded, false);
  clock.advance(1);
  const stop = budget.check();
  assert.equal(stop.stopReason.code, STOP_REASONS.WALL_CLOCK_TIMEOUT);
  assert.equal(stop.stopReason.observed, 500);
});

test('token budget counts prompt and completion tokens', () => {
  const budget = createBudgetTracker({ limits: { maxTokens: 100 }, now: fixedClock() });
  budget.recordTokens({ promptTokens: 60, completionTokens: 20 });
  assert.equal(budget.tokens, 80);
  assert.equal(budget.check().exceeded, false);
  budget.recordTokens({ totalTokens: 20 });
  assert.equal(budget.tokens, 100);
  const stop = budget.check();
  assert.equal(stop.stopReason.code, STOP_REASONS.TOKEN_BUDGET_EXCEEDED);
  assert.equal(stop.snapshot.promptTokens, 80);
});

test('tool-call budget: check() refuses before execution, recordToolCall only flags overflow', () => {
  const budget = createBudgetTracker({ limits: { maxToolCalls: 2, maxSameToolCalls: 9, maxRepeatedToolCalls: 9 }, now: fixedClock() });

  const first = budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '990' } });
  assert.equal(first.allowed, true);
  assert.equal(budget.check().exceeded, false);

  const second = budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '991' } });
  assert.equal(second.allowed, true, 'the 2nd of 2 permitted calls is allowed');

  const stop = budget.check();
  assert.equal(stop.stopReason.code, STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED);
  assert.equal(stop.snapshot.toolCalls, 2);
});

test('loop detection fires on the Nth identical (tool, args) call, not on different args', () => {
  const budget = createBudgetTracker({ limits: { maxToolCalls: 50, maxRepeatedToolCalls: 3, maxSameToolCalls: 50 }, now: fixedClock() });

  assert.equal(budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '990' } }).allowed, true);
  // same arguments, different order -> same fingerprint -> counted as a repeat
  assert.equal(budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '990' } }).allowed, true);
  const third = budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '990' } });
  assert.equal(third.allowed, false, 'the 3rd identical call must be refused before it executes');
  assert.equal(third.repeats, 3);
  assert.equal(third.stopReason.code, STOP_REASONS.LOOP_DETECTED);
  assert.equal(third.stopReason.recoverable, true);
  assert.match(third.stopReason.message, /loop detected/);
  assert.equal(third.stopReason.evidence.tool, 'query_po_database');

  // a different argument is not a repeat
  const different = budget.recordToolCall({ name: 'query_po_database', args: { poNumber: '991' } });
  assert.equal(different.allowed, true);
  assert.equal(different.repeats, 1);

  // and the loop is still visible to check()
  const stop = budget.check();
  assert.equal(stop.stopReason.code, STOP_REASONS.LOOP_DETECTED);
});

test('fingerprints are order-insensitive and value-sensitive', () => {
  const budget = createBudgetTracker({ limits: { maxRepeatedToolCalls: 3 }, now: fixedClock() });
  const a = budget.recordToolCall({ name: 'calculate_tax_variance', args: { expectedTax: 12, actualTax: 15 } });
  const b = budget.recordToolCall({ name: 'calculate_tax_variance', args: { actualTax: 15, expectedTax: 12 } });
  assert.equal(a.fingerprint, b.fingerprint, 'key order must not change the fingerprint');
  assert.equal(b.repeats, 2);
  const c = budget.recordToolCall({ name: 'calculate_tax_variance', args: { expectedTax: 12, actualTax: 15.01 } });
  assert.notEqual(c.fingerprint, a.fingerprint);
  assert.equal(c.repeats, 1);
});

test('same-tool ceiling stops a tool that is called with endlessly varied arguments', () => {
  const budget = createBudgetTracker({ limits: { maxToolCalls: 100, maxSameToolCalls: 3, maxRepeatedToolCalls: 100 }, now: fixedClock() });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(budget.recordToolCall({ name: 'query_alert_context', args: { alertId: String(1000 + i) } }).allowed, true);
  }
  const fourth = budget.recordToolCall({ name: 'query_alert_context', args: { alertId: '9999' } });
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.stopReason.code, STOP_REASONS.TOOL_REPEAT_LIMIT);
  assert.equal(budget.check().stopReason.code, STOP_REASONS.TOOL_REPEAT_LIMIT);
});

test('only LOOP_DETECTED and TOOL_REPEAT_LIMIT are recoverable', () => {
  assert.deepEqual([...RECOVERABLE_STOP_REASONS].sort(), [STOP_REASONS.LOOP_DETECTED, STOP_REASONS.TOOL_REPEAT_LIMIT].sort());

  const budget = createBudgetTracker({ limits: { maxIterations: 1 }, now: fixedClock() });
  budget.recordIteration();
  const stop = budget.check().stopReason;
  assert.equal(stop.recoverable, false);
  assert.equal(typeof stop.code, 'string');
  assert.equal(typeof stop.message, 'string');
});

test('check() reports a single, deterministic stop reason when several budgets break at once', () => {
  const clock = fixedClock();
  const budget = createBudgetTracker({ limits: { maxIterations: 1, maxToolCalls: 1, maxTokens: 1, wallClockMs: 1 }, now: clock });
  budget.recordIteration();
  budget.recordTokens({ promptTokens: 10 });
  budget.recordToolCall({ name: 'no_op', args: {} });
  clock.advance(10);

  const stop = budget.check();
  // wall-clock is first in the documented evaluation order
  assert.equal(stop.stopReason.code, STOP_REASONS.WALL_CLOCK_TIMEOUT);
});

test('recordToolCall validates its input and never fabricates a fingerprint', () => {
  const budget = createBudgetTracker({ now: fixedClock() });
  assert.throws(() => budget.recordToolCall({}), /name/);
  assert.throws(() => budget.recordToolCall({ name: '' }), /name/);
});

test('the snapshot is stable and exposes the limits it enforced', () => {
  const budget = createBudgetTracker({ limits: { maxIterations: 7 }, now: fixedClock() });
  budget.recordIteration();
  const snapshot = budget.snapshot();
  assert.equal(snapshot.iterations, 1);
  assert.equal(snapshot.limits.maxIterations, 7);
  assert.equal(typeof budget.fingerprint(), 'string');
  assert.equal(budget.fingerprint(), budget.fingerprint());
  assert.equal(budget.timeline().length, 1);
});
