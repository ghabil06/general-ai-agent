/**
 * Agent execution state machine.
 *
 * Real implementation. The runtime's control flow is an explicit,
 * table-driven machine — not an `if` chain buried in a loop — so every
 * transition is visible, guardable and observable.
 *
 *   IDLE -> UNDERSTANDING -> PLANNING -> EXECUTING <-> WAITING_FOR_TOOL
 *                                       ^         <-> WAITING_FOR_APPROVAL
 *                                       |         -> OBSERVING -> VALIDATING
 *                                       |                          |
 *                                       +-------- REPLANNING <------+
 *   terminal: COMPLETED | FAILED | BLOCKED | CANCELLED
 *
 * Guards are real: a transition table entry can carry a guard predicate over
 * the caller-supplied `meta`. `WAITING_FOR_APPROVAL -> EXECUTING` requires
 * `meta.approvalStatus === 'approved'`; `WAITING_FOR_TOOL -> OBSERVING`
 * requires an observation; `VALIDATING -> COMPLETED` requires `meta.valid`.
 * That is what makes "never execute after a denial" a property of the machine
 * rather than a convention.
 */

export const STATES = Object.freeze({
  IDLE: 'IDLE',
  UNDERSTANDING: 'UNDERSTANDING',
  PLANNING: 'PLANNING',
  EXECUTING: 'EXECUTING',
  WAITING_FOR_TOOL: 'WAITING_FOR_TOOL',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  OBSERVING: 'OBSERVING',
  VALIDATING: 'VALIDATING',
  REPLANNING: 'REPLANNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

export const STATE_LIST = Object.freeze(Object.values(STATES));

/** States with no outgoing transitions. */
export const TERMINAL_STATES = Object.freeze([
  STATES.COMPLETED,
  STATES.FAILED,
  STATES.BLOCKED,
  STATES.CANCELLED,
]);

/**
 * Guarded transition table. Each entry is `[to, guard?]`; `null` guard means
 * unconditionally allowed. Read it as: "from this state, these moves are legal".
 */
export const TRANSITIONS = Object.freeze({
  [STATES.IDLE]: [[STATES.UNDERSTANDING], [STATES.CANCELLED], [STATES.FAILED]],

  [STATES.UNDERSTANDING]: [
    [STATES.PLANNING],
    [STATES.REPLANNING],
    [STATES.BLOCKED],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.PLANNING]: [
    [STATES.EXECUTING],
    [STATES.WAITING_FOR_TOOL],
    [STATES.WAITING_FOR_APPROVAL],
    [STATES.REPLANNING],
    [STATES.COMPLETED], // plan determined no action is required
    [STATES.BLOCKED],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.EXECUTING]: [
    [STATES.WAITING_FOR_TOOL],
    [STATES.WAITING_FOR_APPROVAL],
    [STATES.OBSERVING],
    [STATES.REPLANNING],
    [STATES.COMPLETED],
    [STATES.BLOCKED],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.WAITING_FOR_TOOL]: [
    [STATES.OBSERVING, (meta) => meta?.toolResult !== undefined],
    // A proposed tool call that the policy kernel pauses for a human arrives
    // here without an observation to show for it: the call was gated, not run.
    [STATES.WAITING_FOR_APPROVAL],
    [STATES.EXECUTING], // tool declined/blocked: go back to the plan without an observation
    [STATES.REPLANNING],
    [STATES.BLOCKED],
    [STATES.FAILED], // tool timeout or tool error
    [STATES.CANCELLED],
  ],

  [STATES.WAITING_FOR_APPROVAL]: [
    [STATES.EXECUTING, (meta) => meta?.approvalStatus === 'approved'],
    [STATES.BLOCKED, (meta) => meta?.approvalStatus === 'rejected'],
    [STATES.REPLANNING],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.OBSERVING]: [
    [STATES.VALIDATING],
    [STATES.REPLANNING],
    [STATES.BLOCKED],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.VALIDATING]: [
    [STATES.COMPLETED, (meta) => meta?.valid === true],
    [STATES.EXECUTING, (meta) => meta?.valid === true && meta?.moreSteps === true],
    [STATES.WAITING_FOR_APPROVAL],
    [STATES.REPLANNING, (meta) => meta?.valid !== true],
    [STATES.BLOCKED],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.REPLANNING]: [
    [STATES.PLANNING],
    [STATES.EXECUTING],
    [STATES.WAITING_FOR_TOOL],
    [STATES.WAITING_FOR_APPROVAL],
    [STATES.COMPLETED],
    [STATES.BLOCKED],
    [STATES.FAILED],
    [STATES.CANCELLED],
  ],

  [STATES.COMPLETED]: [],
  [STATES.FAILED]: [],
  [STATES.BLOCKED]: [],
  [STATES.CANCELLED]: [],
});

/** Error thrown by `transition()` on an illegal move. */
export class StateTransitionError extends Error {
  constructor(code, from, to, detail) {
    super(`state transition ${from} -> ${to} rejected (${code})${detail ? `: ${detail}` : ''}`);
    this.name = 'StateTransitionError';
    this.code = code;
    this.from = from;
    this.to = to;
    this.detail = detail ?? null;
  }
}

/** Reasons a transition can be refused. */
export const TRANSITION_REJECTION = Object.freeze({
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  TERMINAL_STATE: 'TERMINAL_STATE',
  GUARD_FAILED: 'GUARD_FAILED',
  SELF_TRANSITION: 'SELF_TRANSITION',
  /**
   * The machine has used its transition fuel (see `createStateMachine`). Only a
   * move into a terminal state is still allowed, so a run can always be closed.
   */
  TRANSITION_LIMIT: 'TRANSITION_LIMIT',
});

/** @returns {boolean} */
export function isKnownState(state) {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, state);
}

/** @returns {boolean} */
export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/** All legal targets from `from`, ignoring guards. */
export function allowedTransitions(from) {
  if (!isKnownState(from)) return [];
  return TRANSITIONS[from].map(([to]) => to);
}

/**
 * Explain a refusal, or return null when the move is legal.
 * @returns {null | { code: string, detail: string | null }}
 */
export function transitionGuardReason(from, to, meta = {}) {
  if (!isKnownState(from)) {
    return { code: TRANSITION_REJECTION.UNKNOWN_STATE, detail: `unknown source state "${from}"` };
  }
  if (!isKnownState(to)) {
    return { code: TRANSITION_REJECTION.UNKNOWN_STATE, detail: `unknown target state "${to}"` };
  }
  if (from === to) {
    return { code: TRANSITION_REJECTION.SELF_TRANSITION, detail: 'self-transitions are not meaningful' };
  }
  if (isTerminalState(from)) {
    return { code: TRANSITION_REJECTION.TERMINAL_STATE, detail: `${from} is terminal` };
  }

  const entry = TRANSITIONS[from].find(([target]) => target === to);
  if (!entry) {
    return {
      code: TRANSITION_REJECTION.ILLEGAL_TRANSITION,
      detail: `allowed from ${from}: ${allowedTransitions(from).join(', ')}`,
    };
  }

  const guard = entry[1];
  if (typeof guard === 'function' && !guard(meta)) {
    return { code: TRANSITION_REJECTION.GUARD_FAILED, detail: `guard refused ${from} -> ${to}` };
  }

  return null;
}

/**
 * Pure predicate over the table. `canTransition('EXECUTING','IDLE')` is false;
 * `canTransition('WAITING_FOR_APPROVAL','EXECUTING',{approvalStatus:'rejected'})`
 * is false.
 */
export function canTransition(from, to, meta = {}) {
  return transitionGuardReason(from, to, meta) === null;
}

/**
 * Stateful machine with an event hook.
 *
 * @param {object}   [options]
 * @param {string}   [options.initial]
 * @param {Function} [options.now]
 * @param {string}   [options.runId]
 * @param {Function} [options.onTransition] receives `{ from, to, at, seq, meta }`
 * @param {number|null} [options.maxTransitions] TRANSITION FUEL. The table says which
 *   moves are legal; it says nothing about how many a run may take, and the table has
 *   cycles (EXECUTING → … → VALIDATING → EXECUTING). With a number here the machine
 *   refuses every non-terminal move once `seq >= maxTransitions` and allows only a move
 *   into a terminal state, so any sequence of calls is finite: at most
 *   `maxTransitions` moves plus the one that ends the run. A terminal move is always
 *   reachable — `FAILED` is a legal target from every non-terminal state, and a unit
 *   test pins that — so exhausting the fuel can never strand a run mid-flight.
 *   `null` (the default) is the original, unbounded behaviour.
 */
export function createStateMachine({
  initial = STATES.IDLE,
  now = () => Date.now(),
  runId = null,
  onTransition,
  maxTransitions = null,
} = {}) {
  if (!isKnownState(initial)) throw new StateTransitionError(TRANSITION_REJECTION.UNKNOWN_STATE, '<init>', initial);
  if (maxTransitions !== null && (!Number.isInteger(maxTransitions) || maxTransitions < 0)) {
    throw new TypeError(`createStateMachine: maxTransitions must be null or a non-negative integer, got ${JSON.stringify(maxTransitions)}`);
  }

  let state = initial;
  let seq = 0;
  const history = [];
  const listeners = new Set();
  if (typeof onTransition === 'function') listeners.add(onTransition);

  /** True when the fuel is spent and `to` is not a way out. */
  const fuelBlocks = (to) => maxTransitions !== null && seq >= maxTransitions && !isTerminalState(to);

  function transition(to, meta = {}) {
    const refusal = transitionGuardReason(state, to, meta);
    if (refusal) throw new StateTransitionError(refusal.code, state, to, refusal.detail);
    if (fuelBlocks(to)) {
      throw new StateTransitionError(
        TRANSITION_REJECTION.TRANSITION_LIMIT,
        state,
        to,
        `the transition fuel (${maxTransitions}) is spent; only a terminal move remains`,
      );
    }

    const from = state;
    state = to;
    seq += 1;
    const record = Object.freeze({ runId, seq, from, to, at: now(), meta });
    history.push(record);

    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // An observer must never break the run.
      }
    }
    return record;
  }

  return {
    get state() {
      return state;
    },
    get seq() {
      return seq;
    },
    history,
    runId,
    transition,
    can: (to, meta = {}) => canTransition(state, to, meta) && !fuelBlocks(to),
    /** `{ limit, used, remaining, exhausted }`; `limit`/`remaining` are null when unbounded. */
    get fuel() {
      return Object.freeze({
        limit: maxTransitions,
        used: seq,
        remaining: maxTransitions === null ? null : Math.max(0, maxTransitions - seq),
        exhausted: maxTransitions !== null && seq >= maxTransitions,
      });
    },
    is: (candidate) => state === candidate,
    isTerminal: () => isTerminalState(state),
    allowed: () => allowedTransitions(state),
    onTransition(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    /** Compact projection for traces and the run store. */
    snapshot() {
      return { runId, state, seq, terminal: isTerminalState(state), history: [...history] };
    },
  };
}
