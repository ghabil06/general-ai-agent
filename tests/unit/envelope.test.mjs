/**
 * The execution envelope: every bound on a run, resolved in one place.
 *
 * What these tests pin:
 *   - a value can only go DOWN through the layers (runtime → profile → request),
 *     and nothing is above the hard ceiling;
 *   - a default is a default, not a ceiling (an operator may run above it);
 *   - the envelope is pure and reports which layer bound each limit;
 *   - the transition-fuel formula has real headroom over what the loops use.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HARD_CEILINGS,
  BUDGET_KEYS,
  PLANNING_KEYS,
  REQUESTABLE_LIMITS,
  TRANSITIONS_PER_ITERATION,
  EnvelopeError,
  ENVELOPE_ERROR_CODES,
  resolveEnvelope,
  assertRequestedLimits,
  transitionFuel,
  mergeTightest,
} from '../../src/runtime/envelope.mjs';
import { tightestLimits } from '../../src/runtime/run.mjs';
import { DEFAULT_BUDGETS } from '../../src/config/index.mjs';
import { PLANNER_DEFAULTS } from '../../src/planning/planner.mjs';
import { AGENT_PROFILES } from '../../src/config/agents.mjs';
import { buildRuntime, runawayProvider, planTurn } from '../helpers/bounded.mjs';

// ── the ceilings themselves ────────────────────────────────────────────────

test('hard ceilings are frozen, finite, positive integers', () => {
  assert.ok(Object.isFrozen(HARD_CEILINGS));
  for (const [key, value] of Object.entries(HARD_CEILINGS)) {
    assert.ok(Number.isInteger(value) && value > 0, `${key} must be a positive integer, got ${value}`);
  }
  for (const key of [...BUDGET_KEYS, ...PLANNING_KEYS, 'maxTransitions']) {
    assert.ok(key in HARD_CEILINGS, `${key} has no ceiling`);
  }
});

test('the ceilings sit above every default and every shipped profile, so they bind only a misconfiguration', () => {
  for (const key of BUDGET_KEYS) assert.ok(DEFAULT_BUDGETS[key] <= HARD_CEILINGS[key], `default ${key} exceeds its ceiling`);
  for (const key of PLANNING_KEYS) assert.ok(PLANNER_DEFAULTS[key] <= HARD_CEILINGS[key], `planner default ${key} exceeds its ceiling`);
  assert.ok(transitionFuel(DEFAULT_BUDGETS) <= HARD_CEILINGS.maxTransitions);
  for (const profile of Object.values(AGENT_PROFILES)) {
    for (const [key, value] of Object.entries(profile.limits ?? {})) {
      if (key in HARD_CEILINGS) assert.ok(value <= HARD_CEILINGS[key], `${profile.id}.limits.${key}=${value} exceeds its ceiling`);
    }
  }
});

// ── resolution ─────────────────────────────────────────────────────────────

test('with nothing requested the envelope is the runtime defaults, the planner defaults and the derived fuel', () => {
  const envelope = resolveEnvelope();
  for (const key of BUDGET_KEYS) assert.equal(envelope.limits[key], DEFAULT_BUDGETS[key], key);
  assert.deepEqual({ ...envelope.planning }, { ...PLANNER_DEFAULTS });
  assert.equal(envelope.maxTransitions, transitionFuel(DEFAULT_BUDGETS));
  assert.deepEqual([...envelope.clamped], []);
  assert.equal(envelope.bindings.maxIterations.boundBy, 'runtime');
  assert.equal(envelope.bindings.maxSteps.boundBy, 'default');
  assert.equal(envelope.bindings.maxTransitions.boundBy, 'derived');
});

test('a value only goes DOWN through the layers: runtime → profile → request', () => {
  const envelope = resolveEnvelope({
    runtimeLimits: { ...DEFAULT_BUDGETS, maxIterations: 20, maxToolCalls: 30 },
    profileLimits: { maxIterations: 8, maxToolCalls: 40 },
    request: { maxIterations: 5, maxToolCalls: 10 },
  });
  assert.equal(envelope.limits.maxIterations, 5);
  assert.equal(envelope.bindings.maxIterations.boundBy, 'request');
  assert.equal(envelope.limits.maxToolCalls, 10);

  // a request ABOVE the tighter layer cannot raise it, and says so
  const asked = resolveEnvelope({ profileLimits: { maxIterations: 8 }, request: { maxIterations: 20 } });
  assert.equal(asked.limits.maxIterations, 8);
  assert.equal(asked.bindings.maxIterations.boundBy, 'profile');
  assert.equal(asked.bindings.maxIterations.requested, 20);
  assert.deepEqual([...asked.clamped].map((c) => c.key), ['maxIterations']);
});

test('a default is not a ceiling: an operator may run above it, but never above the hard ceiling', () => {
  const above = resolveEnvelope({ runtimeLimits: { ...DEFAULT_BUDGETS, maxIterations: 30 } });
  assert.equal(above.limits.maxIterations, 30, 'an explicit runtime value above the default is honoured');
  assert.equal(above.bindings.maxIterations.boundBy, 'runtime');

  const absurd = resolveEnvelope({ runtimeLimits: { ...DEFAULT_BUDGETS, maxIterations: 1_000_000_000 } });
  assert.equal(absurd.limits.maxIterations, HARD_CEILINGS.maxIterations);
  assert.equal(absurd.bindings.maxIterations.boundBy, 'hard');
});

test('Infinity and NaN in the runtime budgets fall back to a finite value, never to "no limit"', () => {
  const envelope = resolveEnvelope({
    runtimeLimits: { ...DEFAULT_BUDGETS, maxIterations: Infinity, wallClockMs: Number.NaN, maxTokens: Infinity },
  });
  assert.equal(envelope.limits.maxIterations, HARD_CEILINGS.maxIterations);
  assert.equal(envelope.limits.wallClockMs, DEFAULT_BUDGETS.wallClockMs, 'NaN is not a value; the default applies');
  assert.equal(envelope.limits.maxTokens, HARD_CEILINGS.maxTokens);
  for (const key of BUDGET_KEYS) assert.ok(Number.isFinite(envelope.limits[key]), key);
});

test('planner ceilings: request > default, clamped to the hard ceiling, invalid values refused', () => {
  const raised = resolveEnvelope({ planning: { maxSteps: 20, maxReplans: 1 } });
  assert.equal(raised.planning.maxSteps, 20, 'a caller may move a planner default, inside the ceiling');
  assert.equal(raised.planning.maxReplans, 1);
  assert.equal(raised.bindings.maxSteps.boundBy, 'request');

  const clamped = resolveEnvelope({ planning: { maxSteps: 1_000_000, maxReplans: 99 } });
  assert.equal(clamped.planning.maxSteps, HARD_CEILINGS.maxSteps);
  assert.equal(clamped.planning.maxReplans, HARD_CEILINGS.maxReplans);
  assert.equal(clamped.bindings.maxSteps.boundBy, 'hard');
  assert.equal(clamped.clamped.length, 2);

  for (const bad of [0, -1, 1.5, Number.NaN, '12', Infinity]) {
    assert.throws(
      () => resolveEnvelope({ planning: { maxSteps: bad } }),
      (err) => err instanceof EnvelopeError && err.code === ENVELOPE_ERROR_CODES.INVALID_LIMIT,
      `maxSteps=${String(bad)}`,
    );
  }
  assert.throws(() => resolveEnvelope({ request: { maxIterations: 0 } }), EnvelopeError);
});

test('transition fuel: derived from the iteration budget, tightenable by a request, capped by the ceiling', () => {
  const profile = resolveEnvelope({ profileLimits: { maxIterations: 8 } });
  assert.equal(profile.maxTransitions, transitionFuel({ maxIterations: 8 }));
  assert.equal(transitionFuel({ maxIterations: 8 }), TRANSITIONS_PER_ITERATION * 8 + 16);

  assert.equal(resolveEnvelope({ request: { maxTransitions: 10 } }).maxTransitions, 10);
  assert.equal(resolveEnvelope({ request: { maxTransitions: 10 } }).bindings.maxTransitions.boundBy, 'request');
  assert.equal(resolveEnvelope({ request: { maxTransitions: 1_000_000 } }).maxTransitions, resolveEnvelope().maxTransitions);
});

test('limits a profile carries that the budget tracker does not know are kept and min-merged, never raised', () => {
  const envelope = resolveEnvelope({
    runtimeLimits: { ...DEFAULT_BUDGETS, maxSameTool: 9 },
    profileLimits: { maxSameTool: 4, maxThings: 7 },
  });
  assert.equal(envelope.limits.maxSameTool, 4);
  assert.equal(envelope.limits.maxThings, 7);
});

test('the envelope is pure: same inputs give an equal envelope, and the inputs are not mutated', () => {
  const input = { runtimeLimits: { ...DEFAULT_BUDGETS }, profileLimits: { maxIterations: 8 }, request: { maxToolCalls: 3 }, planning: { maxSteps: 6 } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const first = resolveEnvelope(input);
  const second = resolveEnvelope(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.limits) && Object.isFrozen(first.bindings));
});

// ── strict validation at the edges ─────────────────────────────────────────

test('assertRequestedLimits refuses unknown names, non-integers and anything above a ceiling — with a code', () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  };
  assert.equal(codeOf(() => assertRequestedLimits({ maxBananas: 3 })), ENVELOPE_ERROR_CODES.UNKNOWN_LIMIT);
  assert.equal(codeOf(() => assertRequestedLimits({ maxIterations: 0 })), ENVELOPE_ERROR_CODES.INVALID_LIMIT);
  assert.equal(codeOf(() => assertRequestedLimits({ maxIterations: 2.5 })), ENVELOPE_ERROR_CODES.INVALID_LIMIT);
  assert.equal(codeOf(() => assertRequestedLimits({ maxIterations: HARD_CEILINGS.maxIterations + 1 })), ENVELOPE_ERROR_CODES.ABOVE_CEILING);
  assert.equal(codeOf(() => assertRequestedLimits([1, 2])), ENVELOPE_ERROR_CODES.INVALID_LIMIT);
  assert.equal(codeOf(() => assertRequestedLimits({ maxSteps: 5 })), ENVELOPE_ERROR_CODES.UNKNOWN_LIMIT, 'planner keys are not budget limits');

  const ok = assertRequestedLimits({ maxIterations: HARD_CEILINGS.maxIterations, maxToolCalls: 3 });
  assert.deepEqual({ ...ok }, { maxIterations: HARD_CEILINGS.maxIterations, maxToolCalls: 3 });
  assert.ok(Object.isFrozen(ok));
  assert.deepEqual({ ...assertRequestedLimits(undefined) }, {});
  assert.deepEqual({ ...assertRequestedLimits({ maxIterations: null }) }, { maxIterations: null }, 'null means "not requested"');
  assert.deepEqual([...REQUESTABLE_LIMITS].sort(), [...BUDGET_KEYS, 'maxTransitions'].sort());

  const planningOk = assertRequestedLimits({ maxSteps: 4 }, { allowed: PLANNING_KEYS, label: 'planning' });
  assert.equal(planningOk.maxSteps, 4);
  assert.equal(codeOf(() => assertRequestedLimits({ maxSteps: 26 }, { allowed: PLANNING_KEYS, label: 'planning' })), ENVELOPE_ERROR_CODES.ABOVE_CEILING);
});

// ── compatibility ──────────────────────────────────────────────────────────

test('tightestLimits keeps its contract (the tighter value wins) and gains the ceilings', () => {
  assert.deepEqual(tightestLimits({ maxIterations: 12, maxToolCalls: 24 }, { maxIterations: 8 }), { maxIterations: 8, maxToolCalls: 24 });
  assert.deepEqual(tightestLimits({ maxIterations: 12 }, { maxIterations: 99 }), { maxIterations: 12 }, 'a profile cannot loosen');
  assert.equal(tightestLimits({ maxIterations: 1_000_000 }, {}).maxIterations, HARD_CEILINGS.maxIterations);
  assert.equal(tightestLimits({ maxIterations: Infinity }, {}).maxIterations, HARD_CEILINGS.maxIterations);
  assert.deepEqual(mergeTightest({ a: 1 }, { a: 5, b: 2 }, {}), { a: 1, b: 2 });
});

// ── the fuel formula is measured, not guessed ──────────────────────────────

test('the real loops stay inside the transition fuel, and under TRANSITIONS_PER_ITERATION per iteration', async () => {
  const failingStep = { id: 's', description: 'bad', tool: 'get_market_quote', args: { ticker: 7 } }; // schema-invalid on purpose
  const scenarios = [
    {
      name: 'model loop, runaway tool calls',
      providers: { mock: runawayProvider() },
      run: (run) => run.loop({ mode: 'model', systemPrompt: 's', userMessage: 'go', responseFormat: 'text' }),
    },
    {
      name: 'planned loop, every step fails and is replanned',
      mockScript: Array.from({ length: 30 }, (_, i) => planTurn([{ id: `r${i}`, description: 'retry', tool: 'get_market_quote', args: { ticker: 100 + i } }])),
      run: (run) => run.loop({ mode: 'planned', goal: 'x', steps: [failingStep], systemPrompt: 's', userMessage: 'go', responseFormat: 'text' }),
    },
    {
      name: 'planned loop, free-form steps with several tool calls',
      mockScript: [
        planTurn([{ id: 'a', description: 'one' }, { id: 'b', description: 'two' }, { id: 'c', description: 'three' }]),
        ...Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'no_op', arguments: {} }, { name: 'get_portfolio_state', arguments: {} }] })),
        { text: 'done' },
      ],
      run: (run) => run.loop({ mode: 'planned', goal: 'x', systemPrompt: 's', userMessage: 'go', responseFormat: 'text' }),
    },
  ];

  let worst = 0;
  for (const scenario of scenarios) {
    const { runtime } = buildRuntime({ mockScript: scenario.mockScript, providers: scenario.providers });
    const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
    await scenario.run(run);
    const { seq, fuel } = run.stateMachine;
    const perIteration = seq / Math.max(1, run.budget.iterations);
    worst = Math.max(worst, perIteration);
    assert.ok(seq <= fuel.limit, `${scenario.name}: ${seq} transitions exceed the fuel ${fuel.limit}`);
    assert.ok(!fuel.exhausted || seq <= fuel.limit + 1, scenario.name);
    assert.ok(perIteration <= TRANSITIONS_PER_ITERATION, `${scenario.name}: ${perIteration.toFixed(2)} transitions per iteration`);
  }
  assert.ok(worst > 0);
});
