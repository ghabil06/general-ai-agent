/**
 * Policy kernel: rule ordering, most-restrictive resolution and fail-closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISIONS,
  DECISION_SEVERITY,
  PolicyDefinitionError,
  RULE_KINDS,
  createPolicyKernel,
  defineRule,
  orderRules,
} from '../../src/policy/engine.mjs';
import { fixedClock } from '../helpers/fixtures.mjs';

const allowRule = (id, priority, extra = {}) =>
  defineRule({
    id,
    kind: RULE_KINDS.ACTION_POLICY,
    priority,
    description: `test rule ${id}`,
    appliesTo: extra.appliesTo ?? (() => true),
    evaluate: extra.evaluate ?? (() => ({ decision: DECISIONS.ALLOW, reason: `${id} allows` })),
  });

test('DECISIONS has exactly the three specified values, ranked by strictness', () => {
  assert.deepEqual(Object.values(DECISIONS).sort(), ['ALLOW', 'DENY', 'REQUIRE_APPROVAL']);
  assert.ok(DECISION_SEVERITY.ALLOW < DECISION_SEVERITY.REQUIRE_APPROVAL);
  assert.ok(DECISION_SEVERITY.REQUIRE_APPROVAL < DECISION_SEVERITY.DENY);
});

test('rules are ordered by priority then id, deterministically', () => {
  const unordered = [allowRule('b.rule', 30), allowRule('a.rule', 10), allowRule('a.first', 10)];
  assert.deepEqual(
    orderRules(unordered).map((rule) => rule.id),
    ['a.first', 'a.rule', 'b.rule'],
  );
  // sorting is stable across shuffles of the input
  assert.deepEqual(
    orderRules([...unordered].reverse()).map((rule) => rule.id),
    ['a.first', 'a.rule', 'b.rule'],
  );
});

test('the most restrictive firing rule wins, and the reporting rule is the first at that severity', () => {
  const kernel = createPolicyKernel({
    rules: [
      allowRule('z.allow', 10),
      defineRule({
        id: 'm.require',
        kind: RULE_KINDS.REQUIRED_APPROVAL,
        priority: 20,
        description: 'requires approval',
        evaluate: () => ({ decision: DECISIONS.REQUIRE_APPROVAL, reason: 'needs a human' }),
      }),
      defineRule({
        id: 'n.deny',
        kind: RULE_KINDS.DESTRUCTIVE_ACTION,
        priority: 30,
        description: 'denies',
        evaluate: () => ({ decision: DECISIONS.DENY, reason: 'never' }),
      }),
      defineRule({
        id: 'o.deny_later',
        kind: RULE_KINDS.DATA_ACCESS,
        priority: 40,
        description: 'also denies',
        evaluate: () => ({ decision: DECISIONS.DENY, reason: 'also never' }),
      }),
    ],
  });

  const outcome = kernel.evaluate({ kind: 'action' });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.equal(outcome.rule, 'n.deny', 'the first DENY in priority order is reported');
  assert.deepEqual(
    outcome.firedRules.map((firing) => firing.rule),
    ['z.allow', 'm.require', 'n.deny', 'o.deny_later'],
  );
  assert.equal(outcome.checks.length, 4);
  assert.equal(typeof outcome.decidedAt, 'number');
  assert.equal(outcome.request.kind, 'action');
});

test('fail-closed: no matching rule means DENY with an explicit reason', () => {
  const kernel = createPolicyKernel({ rules: [allowRule('only.actions', 10, { appliesTo: (request) => request.kind === 'action' })] });
  const outcome = kernel.evaluate({ kind: 'tool_call' });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.equal(outcome.rule, 'engine.default');
  assert.match(outcome.reason, /no policy rule matched/);
  assert.equal(outcome.evidence.failClosed, true);
});

test('fail-closed: a throwing rule is a DENY, never an allow', () => {
  const kernel = createPolicyKernel({
    rules: [
      allowRule('good.allow', 10),
      defineRule({
        id: 'bad.rule',
        kind: RULE_KINDS.INPUT_VALIDATION,
        priority: 20,
        description: 'throws',
        evaluate: () => {
          throw new Error('un-evaluable');
        },
      }),
    ],
  });
  const outcome = kernel.evaluate({ kind: 'tool_call' });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.equal(outcome.rule, 'bad.rule');
  assert.match(outcome.reason, /threw: un-evaluable/);
  assert.equal(outcome.evidence.failClosed, true);
});

test('fail-closed: a rule returning an invalid decision becomes a DENY', () => {
  const kernel = createPolicyKernel({
    rules: [
      defineRule({
        id: 'sloppy.rule',
        kind: RULE_KINDS.ACTION_POLICY,
        priority: 10,
        description: 'returns nonsense',
        evaluate: () => ({ decision: 'MAYBE', reason: 'unclear' }),
      }),
    ],
  });
  const outcome = kernel.evaluate({ kind: 'action' });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.match(outcome.reason, /invalid decision/);
});

test('a rule can abstain with null without affecting the outcome', () => {
  const kernel = createPolicyKernel({
    rules: [allowRule('silent.rule', 5, { evaluate: () => null }), allowRule('loud.rule', 10)],
  });
  const outcome = kernel.evaluate({ kind: 'action' });
  assert.equal(outcome.decision, DECISIONS.ALLOW);
  assert.equal(outcome.rule, 'loud.rule');
  assert.equal(outcome.checks.filter((check) => check.decision === null).length, 1);
});

test('appliesTo decides which requests a rule sees', () => {
  const kernel = createPolicyKernel({
    rules: [
      allowRule('tool.only', 10, { appliesTo: (request) => request.kind === 'tool_call' }),
      allowRule('action.only', 20, { appliesTo: (request) => request.kind === 'action' }),
    ],
  });
  assert.equal(kernel.evaluate({ kind: 'tool_call' }).rule, 'tool.only');
  assert.equal(kernel.evaluate({ kind: 'action' }).rule, 'action.only');
});

test('an appliesTo that throws is treated as DENY, not as "not applicable"', () => {
  const kernel = createPolicyKernel({
    rules: [
      defineRule({
        id: 'broken.applies',
        kind: RULE_KINDS.RATE_LIMIT,
        priority: 10,
        description: 'appliesTo throws',
        appliesTo: () => {
          throw new Error('nope');
        },
        evaluate: () => ({ decision: DECISIONS.ALLOW, reason: 'should never run' }),
      }),
    ],
  });
  const outcome = kernel.evaluate({ kind: 'tool_call' });
  assert.equal(outcome.decision, DECISIONS.DENY);
  assert.match(outcome.reason, /appliesTo threw/);
});

test('the kernel injects a clock so injected rules stay pure', () => {
  const clock = fixedClock(1_700_000_000_999);
  const kernel = createPolicyKernel({ rules: [allowRule('clock.rule', 10)], now: clock });
  assert.equal(kernel.evaluate({ kind: 'action' }).decidedAt, 1_700_000_000_999);
  assert.equal(kernel.evaluate({ kind: 'action', now: 42 }).decidedAt, 42, 'an explicit request.now wins');
});

test('rules cannot be defined malformed', () => {
  const base = { kind: RULE_KINDS.ACTION_POLICY, priority: 10, description: 'x', evaluate: () => null };
  assert.throws(() => defineRule({ ...base, id: 'bad id!' }), PolicyDefinitionError);
  assert.throws(() => defineRule({ ...base, id: 'ok', kind: 'nonsense' }), /unknown kind/);
  assert.throws(() => defineRule({ ...base, id: 'ok', priority: 1.5 }), /integer priority/);
  assert.throws(() => defineRule({ ...base, id: 'ok', description: '' }), /needs a description/);
  assert.throws(() => defineRule({ ...base, id: 'ok', evaluate: null }), /evaluate/);
  assert.throws(() => defineRule({ ...base, id: 'ok', appliesTo: 'yes' }), /appliesTo/);
  assert.throws(() => createPolicyKernel({ defaultDecision: 'MAYBE' }), /defaultDecision/);
});

test('kernel.describe() exposes rule metadata without the evaluators', () => {
  const kernel = createPolicyKernel({ rules: [allowRule('described.rule', 10)] });
  const [description] = kernel.describe();
  assert.deepEqual(Object.keys(description).sort(), ['description', 'id', 'kind', 'priority']);
  assert.equal(typeof description.evaluate, 'undefined');
});

test('the decision hook fires and cannot break the kernel', () => {
  const seen = [];
  const kernel = createPolicyKernel({
    rules: [allowRule('hook.rule', 10)],
    onDecision: (outcome) => {
      seen.push(outcome.decision);
      throw new Error('observer exploded');
    },
  });
  assert.doesNotThrow(() => kernel.evaluate({ kind: 'action' }));
  assert.deepEqual(seen, [DECISIONS.ALLOW]);
});

test('decide() is sugar for evaluate().decision', () => {
  const kernel = createPolicyKernel({ rules: [allowRule('sugar.rule', 10)] });
  assert.equal(kernel.decide({ kind: 'action' }), DECISIONS.ALLOW);
});
