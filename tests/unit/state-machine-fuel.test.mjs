/**
 * Transition fuel: the state machine's own bound on how many moves a run takes.
 *
 * The guarded table says which moves are LEGAL. It says nothing about how many a
 * run may make, and it has cycles. The fuel is the machine-level answer to "do
 * not run an open-ended loop": after N moves only a terminal move remains.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES,
  STATE_LIST,
  TRANSITIONS,
  TERMINAL_STATES,
  TRANSITION_REJECTION,
  StateTransitionError,
  createStateMachine,
  canTransition,
  isTerminalState,
} from '../../src/runtime/state-machine.mjs';

const NON_TERMINAL = STATE_LIST.filter((state) => !isTerminalState(state));

test('a terminal move is reachable from EVERY non-terminal state — the property the fuel relies on', () => {
  for (const state of NON_TERMINAL) {
    assert.ok(canTransition(state, STATES.FAILED), `${state} cannot reach FAILED`);
  }
  // CANCELLED is what an operator uses: pin it separately, for every state.
  for (const state of NON_TERMINAL) assert.ok(canTransition(state, STATES.CANCELLED), `${state} cannot be cancelled`);
});

test('fuel is opt-in: the default machine is unbounded and reports it', () => {
  const machine = createStateMachine();
  assert.deepEqual({ ...machine.fuel }, { limit: null, used: 0, remaining: null, exhausted: false });
  machine.transition(STATES.UNDERSTANDING);
  assert.equal(machine.fuel.used, 1);
  assert.equal(machine.fuel.exhausted, false);
});

test('once the fuel is spent only a terminal move remains, and the refusal is typed', () => {
  const machine = createStateMachine({ maxTransitions: 2 });
  machine.transition(STATES.UNDERSTANDING);
  machine.transition(STATES.PLANNING);
  assert.equal(machine.fuel.exhausted, true);
  assert.equal(machine.fuel.remaining, 0);

  assert.equal(machine.can(STATES.EXECUTING), false, 'can() reports the fuel, not just the table');
  assert.equal(machine.can(STATES.FAILED), true);
  assert.throws(
    () => machine.transition(STATES.EXECUTING),
    (err) => err instanceof StateTransitionError && err.code === TRANSITION_REJECTION.TRANSITION_LIMIT && err.from === STATES.PLANNING,
  );
  assert.equal(machine.state, STATES.PLANNING, 'a refused move changes nothing');

  machine.transition(STATES.FAILED);
  assert.equal(machine.state, STATES.FAILED);
  assert.equal(machine.seq, 3, 'at most the fuel, plus the one move that closes the run');
});

test('the table is consulted first: an illegal move reports its own reason, not the fuel', () => {
  const machine = createStateMachine({ maxTransitions: 0 });
  assert.throws(() => machine.transition(STATES.COMPLETED), (err) => err.code === TRANSITION_REJECTION.ILLEGAL_TRANSITION);
  assert.throws(() => machine.transition(STATES.UNDERSTANDING), (err) => err.code === TRANSITION_REJECTION.TRANSITION_LIMIT);
  machine.transition(STATES.CANCELLED);
  assert.equal(machine.isTerminal(), true);
});

test('fuel of zero allows exactly one move: the one that closes the run', () => {
  const machine = createStateMachine({ maxTransitions: 0 });
  assert.equal(machine.fuel.exhausted, true);
  machine.transition(STATES.FAILED);
  assert.equal(machine.seq, 1);
});

test('maxTransitions must be null or a non-negative integer', () => {
  for (const bad of [-1, 1.5, '3', Number.NaN, Infinity]) {
    assert.throws(() => createStateMachine({ maxTransitions: bad }), TypeError, String(bad));
  }
  assert.doesNotThrow(() => createStateMachine({ maxTransitions: null }));
  assert.doesNotThrow(() => createStateMachine({ maxTransitions: 0 }));
});

test('every walk over the table is finite under fuel — 500 seeded random walks, none longer than fuel + 1', () => {
  // A tiny deterministic PRNG, so a failure names its seed.
  function rng(seed) {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }
  // The most permissive facts the guards ask for, so the walk can use every edge.
  const meta = { valid: true, moreSteps: true, approvalStatus: 'approved', toolResult: { status: 'ok' } };
  const FUEL = 25;

  let longest = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const next = rng(seed);
    const machine = createStateMachine({ maxTransitions: FUEL });
    // The walk deliberately AVOIDS terminal states until it is forced: it is
    // trying to cycle forever, which is exactly what the fuel must prevent.
    for (let guard = 0; guard < 10_000 && !machine.isTerminal(); guard += 1) {
      const options = machine.allowed().filter((to) => machine.can(to, meta));
      assert.ok(options.length > 0, `seed ${seed}: stranded in ${machine.state}`);
      const preferred = options.filter((to) => !isTerminalState(to));
      const pool = preferred.length ? preferred : options;
      machine.transition(pool[Math.floor(next() * pool.length)], meta);
    }
    assert.ok(machine.isTerminal(), `seed ${seed}: the walk never ended`);
    assert.ok(machine.seq <= FUEL + 1, `seed ${seed}: ${machine.seq} transitions`);
    longest = Math.max(longest, machine.seq);
  }
  assert.equal(longest, FUEL + 1, 'the adversarial walk uses all its fuel and is then forced to close');
});

test('without fuel the same adversarial walk would not be bounded by the machine (why the fuel exists)', () => {
  const meta = { valid: true, moreSteps: true, approvalStatus: 'approved', toolResult: { status: 'ok' } };
  const machine = createStateMachine();
  // Always prefer a non-terminal move: the table lets it go on as long as it likes.
  for (let i = 0; i < 1000; i += 1) {
    const to = machine.allowed().find((candidate) => !isTerminalState(candidate) && machine.can(candidate, meta));
    assert.ok(to, 'a non-terminal move is always available');
    machine.transition(to, meta);
  }
  assert.equal(machine.isTerminal(), false);
  assert.equal(machine.seq, 1000);
  assert.ok(TERMINAL_STATES.length === 4 && Object.keys(TRANSITIONS).length === STATE_LIST.length);
});
