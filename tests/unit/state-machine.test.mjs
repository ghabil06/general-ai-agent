/**
 * State machine: the transition table, its guards, and the event hook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES,
  STATE_LIST,
  TERMINAL_STATES,
  TRANSITIONS,
  TRANSITION_REJECTION,
  StateTransitionError,
  allowedTransitions,
  canTransition,
  createStateMachine,
  isKnownState,
  isTerminalState,
  transitionGuardReason,
} from '../../src/runtime/state-machine.mjs';
import { fixedClock } from '../helpers/fixtures.mjs';

test('every declared state has a transition-table row and vice versa', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATE_LIST].sort());
  // 13 states, as specified
  assert.equal(STATE_LIST.length, 13);
  for (const state of STATE_LIST) assert.ok(isKnownState(state), `${state} should be known`);
});

test('terminal states have no outgoing transitions', () => {
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(allowedTransitions(state), [], `${state} must be terminal`);
    assert.equal(isTerminalState(state), true);
    for (const target of STATE_LIST) {
      assert.equal(canTransition(state, target), false, `${state} -> ${target} must be refused`);
    }
  }
});

test('non-terminal states all have at least one way out (no dead ends)', () => {
  for (const state of STATE_LIST) {
    if (isTerminalState(state)) continue;
    assert.ok(allowedTransitions(state).length > 0, `${state} must not be a dead end`);
  }
});

test('every non-terminal state can reach a terminal state (bounded execution)', () => {
  for (const state of STATE_LIST) {
    if (isTerminalState(state)) continue; // nothing to reach: it is already there
    const seen = new Set([state]);
    const queue = [state];
    let reachesTerminal = false;
    while (queue.length) {
      const current = queue.shift();
      for (const next of allowedTransitions(current)) {
        if (isTerminalState(next)) reachesTerminal = true;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    assert.equal(reachesTerminal, true, `${state} must reach a terminal state`);
  }
});

test('happy path is legal', () => {
  const path = [
    [STATES.IDLE, STATES.UNDERSTANDING],
    [STATES.UNDERSTANDING, STATES.PLANNING],
    [STATES.PLANNING, STATES.EXECUTING],
    [STATES.EXECUTING, STATES.WAITING_FOR_TOOL],
    [STATES.WAITING_FOR_TOOL, STATES.OBSERVING],
    [STATES.OBSERVING, STATES.VALIDATING],
    [STATES.VALIDATING, STATES.COMPLETED],
  ];
  for (const [from, to] of path) {
    const meta = to === STATES.OBSERVING ? { toolResult: { ok: true } } : to === STATES.COMPLETED ? { valid: true } : {};
    assert.equal(canTransition(from, to, meta), true, `${from} -> ${to} should be legal`);
  }
});

test('illegal transitions are rejected', () => {
  assert.equal(canTransition(STATES.IDLE, STATES.EXECUTING), false);
  assert.equal(canTransition(STATES.IDLE, STATES.COMPLETED), false);
  assert.equal(canTransition(STATES.OBSERVING, STATES.PLANNING), false);
  assert.equal(canTransition(STATES.WAITING_FOR_APPROVAL, STATES.OBSERVING), false);
  assert.equal(canTransition(STATES.UNDERSTANDING, STATES.EXECUTING), false);

  const refusal = transitionGuardReason(STATES.IDLE, STATES.EXECUTING);
  assert.equal(refusal.code, TRANSITION_REJECTION.ILLEGAL_TRANSITION);
  assert.match(refusal.detail, /allowed from IDLE/);
});

test('transition() throws a typed error on an illegal move and leaves state intact', () => {
  const machine = createStateMachine({ now: fixedClock() });
  assert.throws(
    () => machine.transition(STATES.EXECUTING),
    (error) => {
      assert.ok(error instanceof StateTransitionError);
      assert.equal(error.code, TRANSITION_REJECTION.ILLEGAL_TRANSITION);
      assert.equal(error.from, STATES.IDLE);
      assert.equal(error.to, STATES.EXECUTING);
      return true;
    },
  );
  assert.equal(machine.state, STATES.IDLE);
  assert.equal(machine.history.length, 0);
});

test('self transitions and unknown states are refused', () => {
  const machine = createStateMachine({ now: fixedClock() });
  assert.throws(() => machine.transition(STATES.IDLE), /SELF_TRANSITION/);
  assert.equal(canTransition(STATES.IDLE, 'NOT_A_STATE'), false);
  assert.equal(transitionGuardReason(STATES.IDLE, 'NOT_A_STATE').code, TRANSITION_REJECTION.UNKNOWN_STATE);
  assert.throws(() => createStateMachine({ initial: 'NOPE' }), /UNKNOWN_STATE/);
});

test('guards: approval must be granted before execution resumes', () => {
  assert.equal(canTransition(STATES.WAITING_FOR_APPROVAL, STATES.EXECUTING), false);
  assert.equal(canTransition(STATES.WAITING_FOR_APPROVAL, STATES.EXECUTING, { approvalStatus: 'pending' }), false);
  assert.equal(canTransition(STATES.WAITING_FOR_APPROVAL, STATES.EXECUTING, { approvalStatus: 'approved' }), true);
  assert.equal(canTransition(STATES.WAITING_FOR_APPROVAL, STATES.BLOCKED, { approvalStatus: 'rejected' }), true);
  assert.equal(canTransition(STATES.WAITING_FOR_APPROVAL, STATES.BLOCKED), false);
});

test('guards: an observation is required before OBSERVING, validity before COMPLETED', () => {
  assert.equal(canTransition(STATES.WAITING_FOR_TOOL, STATES.OBSERVING), false);
  assert.equal(canTransition(STATES.WAITING_FOR_TOOL, STATES.OBSERVING, { toolResult: { ok: true } }), true);
  assert.equal(canTransition(STATES.VALIDATING, STATES.COMPLETED), false);
  assert.equal(canTransition(STATES.VALIDATING, STATES.COMPLETED, { valid: true }), true);
  assert.equal(canTransition(STATES.VALIDATING, STATES.REPLANNING, { valid: false }), true);
  assert.equal(canTransition(STATES.VALIDATING, STATES.EXECUTING, { valid: true, moreSteps: true }), true);
  assert.equal(canTransition(STATES.VALIDATING, STATES.EXECUTING, { valid: true }), false);
});

test('the emitter sees every transition, in order, with meta', () => {
  const clock = fixedClock();
  const seen = [];
  const machine = createStateMachine({ now: clock, runId: 'run_test', onTransition: (record) => seen.push(record) });

  machine.transition(STATES.UNDERSTANDING, { note: 'a' });
  clock.advance(5);
  machine.transition(STATES.PLANNING);

  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((record) => [record.from, record.to]),
    [
      [STATES.IDLE, STATES.UNDERSTANDING],
      [STATES.UNDERSTANDING, STATES.PLANNING],
    ],
  );
  assert.equal(seen[0].seq, 1);
  assert.equal(seen[1].seq, 2);
  assert.equal(seen[0].runId, 'run_test');
  assert.deepEqual(seen[0].meta, { note: 'a' });
  assert.equal(seen[1].at - seen[0].at, 5);
  assert.equal(machine.seq, 2);
  assert.equal(machine.isTerminal(), false);
  assert.equal(machine.snapshot().state, STATES.PLANNING);
});

test('a throwing observer cannot break the machine', () => {
  const machine = createStateMachine({ now: fixedClock(), onTransition: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => machine.transition(STATES.UNDERSTANDING));
  assert.equal(machine.state, STATES.UNDERSTANDING);

  const unsubscribe = machine.onTransition(() => {});
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});

test('BLOCKED is reachable when an approval is rejected, and is terminal', () => {
  const machine = createStateMachine({ initial: STATES.WAITING_FOR_APPROVAL, now: fixedClock() });
  machine.transition(STATES.BLOCKED, { approvalStatus: 'rejected' });
  assert.equal(machine.state, STATES.BLOCKED);
  assert.equal(machine.isTerminal(), true);
  assert.throws(() => machine.transition(STATES.EXECUTING), /TERMINAL_STATE/);
});
