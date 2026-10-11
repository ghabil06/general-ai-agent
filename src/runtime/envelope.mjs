/**
 * The execution envelope — every bound on one run, resolved in one place.
 *
 * ┌─ why this exists ─────────────────────────────────────────────────────────┐
 * │ A bounded agent is only bounded if there is no way to ask for "more". The │
 * │ runtime already had budgets (config), per-agent limits (profile) and      │
 * │ planner ceilings, but each was merged somewhere different and NONE of     │
 * │ them had a ceiling of its own: `AGENT_MAX_ITERATIONS=1000000000`, a       │
 * │ programmatic `Infinity`, or `planning: { maxSteps: 1e9 }` were all        │
 * │ honoured. This module is the missing top of the stack.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Precedence, loosest to tightest — a value can only go DOWN as it passes
 * through the layers, never up:
 *
 *   HARD_CEILINGS      frozen code constants. No env var, profile or request can
 *                      raise a run past these.            (this file)
 *   runtime budgets    `config.budgets`, env-overridable.   (src/config/index.mjs)
 *   profile limits     one agent's own restriction.         (src/config/agents.mjs)
 *   request limits     what one caller asks for, for one run.
 *
 * `resolveEnvelope()` is PURE: same inputs, same envelope, no clock, no I/O. It
 * is also the ONLY thing `createAgentRun()` uses to size a run's budget tracker,
 * planner and state machine, so the envelope a caller is *shown* is by
 * construction the envelope that is *enforced*.
 *
 * Planner ceilings (`maxSteps`, `maxReplans`, `maxStepAttempts`) are different
 * in one respect: the planner's own numbers are DEFAULTS that a caller may move
 * (up or down), but only inside the hard ceiling. `maxStepAttempts` is reported
 * for completeness and is NOT an independent bound — a failed step is never
 * re-run in place, so its only retry path is a replan, which `maxReplans`
 * bounds. That is stated here instead of implied.
 */

import { DEFAULT_BUDGETS } from '../config/index.mjs';
import { PLANNER_DEFAULTS } from '../planning/planner.mjs';

/** The six budget dimensions the budget tracker enforces. */
export const BUDGET_KEYS = Object.freeze(Object.keys(DEFAULT_BUDGETS));

/** The three planner ceilings. */
export const PLANNING_KEYS = Object.freeze(['maxSteps', 'maxReplans', 'maxStepAttempts']);

/**
 * State-machine transitions allowed per budgeted iteration.
 *
 * Derived by hand, then measured. By hand: the heaviest iteration either loop
 * can produce is a planned-loop step that fails and is replanned — EXECUTING,
 * WAITING_FOR_TOOL, OBSERVING, VALIDATING, REPLANNING, PLANNING, i.e. 6 moves
 * (a path that re-enters EXECUTING from OBSERVING or REPLANNING spends one more).
 * Measured: across a runaway model loop, a planned loop whose every step fails and
 * is replanned, free-form steps with parallel tool calls and a normal task, the
 * worst is 4.3 moves per iteration, with at least 46 of an 80-move fuel to spare.
 * 8 leaves headroom over both, and `tests/unit/envelope.test.mjs` fails if a real
 * loop ever exceeds it — so the number cannot silently go stale.
 */
export const TRANSITIONS_PER_ITERATION = 8;
/** Opening (IDLE→UNDERSTANDING→PLANNING), closing and slack. */
export const TRANSITION_OVERHEAD = 16;

/**
 * How many transitions a run's state machine may take before only a terminal
 * move remains. A second, independent bound behind the iteration budget: even a
 * loop path that forgot to count an iteration cannot cycle the machine forever.
 *
 * @param {{maxIterations: number}} limits
 */
export function transitionFuel(limits) {
  const iterations = Number.isFinite(limits?.maxIterations) ? Math.max(0, limits.maxIterations) : 0;
  return TRANSITIONS_PER_ITERATION * iterations + TRANSITION_OVERHEAD;
}

/**
 * Frozen code constants. Deliberately above every default and every shipped
 * profile (a unit test pins both), and deliberately finite for every dimension.
 * Boundaries are code, not configuration — the same rule as `BOUNDARIES`.
 */
export const HARD_CEILINGS = Object.freeze({
  maxIterations: 50,
  wallClockMs: 600_000,
  maxTokens: 500_000,
  maxToolCalls: 100,
  maxRepeatedToolCalls: 10,
  maxSameToolCalls: 100,
  maxSteps: 25,
  maxReplans: 5,
  maxStepAttempts: 3,
  maxTransitions: transitionFuel({ maxIterations: 50 }),
});

/** Every limit name a request may tighten. */
export const REQUESTABLE_LIMITS = Object.freeze([...BUDGET_KEYS, 'maxTransitions']);

export const ENVELOPE_ERROR_CODES = Object.freeze({
  INVALID_LIMIT: 'INVALID_LIMIT',
  UNKNOWN_LIMIT: 'UNKNOWN_LIMIT',
  ABOVE_CEILING: 'ABOVE_CEILING',
});

export class EnvelopeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
    this.detail = detail;
  }
}

const isLimit = (value) => typeof value === 'number' && Number.isFinite(value);
/** A number that can take part in a min(): not NaN, and not "+Infinity" (which is "no limit"). */
const isBinding = (value) => typeof value === 'number' && !Number.isNaN(value) && value !== Infinity;

/**
 * Strict validation of what a CALLER asks for. Used at the edges (the bounded
 * agent, the HTTP API) where a refusal with a reason is more honest than a
 * silent clamp. `resolveEnvelope()` itself clamps rather than throws on an
 * above-ceiling value, because it also sizes runs from configuration, where
 * failing closed means "run, but no larger than the ceiling".
 *
 * @param {object} requested   `{ maxIterations: 4, ... }`
 * @param {object} [options]
 * @param {readonly string[]} [options.allowed]  names a caller may set
 * @param {string} [options.label]               for messages: `limits` | `planning`
 * @returns {object} the same values, frozen
 * @throws {EnvelopeError}
 */
export function assertRequestedLimits(requested, { allowed = REQUESTABLE_LIMITS, label = 'limits' } = {}) {
  if (requested === undefined || requested === null) return Object.freeze({});
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.INVALID_LIMIT, `\`${label}\` must be an object of positive integers`, { label });
  }
  for (const [key, value] of Object.entries(requested)) {
    if (value === undefined || value === null) continue;
    if (!allowed.includes(key)) {
      throw new EnvelopeError(
        ENVELOPE_ERROR_CODES.UNKNOWN_LIMIT,
        `\`${label}.${key}\` is not a limit this runtime enforces (known: ${allowed.join(', ')})`,
        { label, key, allowed },
      );
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new EnvelopeError(ENVELOPE_ERROR_CODES.INVALID_LIMIT, `\`${label}.${key}\` must be a positive integer, got ${JSON.stringify(value)}`, {
        label,
        key,
        value,
      });
    }
    if (value > HARD_CEILINGS[key]) {
      throw new EnvelopeError(
        ENVELOPE_ERROR_CODES.ABOVE_CEILING,
        `\`${label}.${key}\` is ${value}, above the hard ceiling of ${HARD_CEILINGS[key]}; a request may lower a limit, never raise it past the ceiling`,
        { label, key, value, ceiling: HARD_CEILINGS[key] },
      );
    }
  }
  return Object.freeze({ ...requested });
}

/** Report order for ties: the most specific source that equals the winning value. */
const SOURCE_PRIORITY = Object.freeze(['request', 'profile', 'runtime', 'default', 'hard']);

function smallest(candidates) {
  let best = null;
  for (const source of SOURCE_PRIORITY) {
    const value = candidates[source];
    // `+Infinity` ("no limit") binds nothing, so the ceiling wins by default:
    // an operator who asked for unlimited gets as much as is ALLOWED. A negative
    // or zero value binds, and fails closed — the run simply cannot start.
    if (!isBinding(value)) continue;
    if (best === null || value < best.value) best = { source, value };
  }
  return best;
}

/**
 * Resolve every bound for one run.
 *
 * @param {object} [input]
 * @param {object} [input.runtimeLimits]  `config.budgets`
 * @param {object} [input.profileLimits]  the agent profile's `limits`
 * @param {object} [input.request]        per-run budget requests (and `maxTransitions`)
 * @param {object} [input.planning]       per-run planner ceilings
 * @param {object} [input.ceilings]       defaults to HARD_CEILINGS
 * @returns {Readonly<{
 *   limits: object, planning: object, maxTransitions: number,
 *   bindings: object, clamped: Array<object>
 * }>}
 * @throws {EnvelopeError} when a requested value is not a positive integer
 */
export function resolveEnvelope({
  runtimeLimits = DEFAULT_BUDGETS,
  profileLimits = {},
  request = {},
  planning = {},
  ceilings = HARD_CEILINGS,
} = {}) {
  for (const [label, bag] of [['request', request], ['planning', planning]]) {
    for (const [key, value] of Object.entries(bag ?? {})) {
      if (value === undefined || value === null) continue;
      if (!Number.isInteger(value) || value < 1) {
        throw new EnvelopeError(ENVELOPE_ERROR_CODES.INVALID_LIMIT, `\`${label}.${key}\` must be a positive integer, got ${JSON.stringify(value)}`, {
          label,
          key,
          value,
        });
      }
    }
  }

  const limits = {};
  const bindings = {};
  const clamped = [];

  function note(key, requested, effective, boundBy) {
    bindings[key] = Object.freeze({ effective, requested: isLimit(requested) ? requested : null, boundBy });
    if (isLimit(requested) && requested > effective) clamped.push(Object.freeze({ key, requested, effective, boundBy }));
  }

  // --- budgets: the tightest of runtime, profile, request, ceiling ---------
  for (const key of BUDGET_KEYS) {
    const win = smallest({
      request: request?.[key],
      profile: profileLimits?.[key],
      // A default is not a ceiling: it fills in only when the runtime config
      // carries no usable value (absent, or NaN), so an operator may
      // legitimately run above the default — but never above the hard ceiling
      // below. `Infinity` is a usable value that binds nothing: it resolves to
      // the ceiling.
      runtime: typeof runtimeLimits?.[key] === 'number' && !Number.isNaN(runtimeLimits[key]) ? runtimeLimits[key] : DEFAULT_BUDGETS[key],
      hard: ceilings[key],
    });
    // The ceiling is finite for every known dimension, so `win` is never null.
    limits[key] = win.value;
    note(key, request?.[key], win.value, win.source);
  }

  // --- limits a profile carries that the budget tracker does not know ------
  // Kept, min-merged with the runtime value, exactly as before. Never raised.
  for (const [key, value] of Object.entries(profileLimits ?? {})) {
    if (BUDGET_KEYS.includes(key) || !isLimit(value)) continue;
    limits[key] = isLimit(runtimeLimits?.[key]) ? Math.min(runtimeLimits[key], value) : value;
  }

  // --- planner ceilings: request > profile > default, then the hard ceiling -
  const plan = {};
  for (const key of PLANNING_KEYS) {
    const wanted = isLimit(planning?.[key]) ? planning[key] : isLimit(profileLimits?.[key]) ? profileLimits[key] : PLANNER_DEFAULTS[key];
    const source = isLimit(planning?.[key]) ? 'request' : isLimit(profileLimits?.[key]) ? 'profile' : 'default';
    const effective = Math.min(wanted, ceilings[key]);
    plan[key] = effective;
    note(key, planning?.[key], effective, effective < wanted ? 'hard' : source);
  }

  // --- transition fuel: derived from the iteration budget, tightenable -----
  const derived = Math.min(transitionFuel(limits), ceilings.maxTransitions);
  const fuel = smallest({ request: request?.maxTransitions, default: derived, hard: ceilings.maxTransitions });
  note('maxTransitions', request?.maxTransitions, fuel.value, fuel.source === 'default' ? 'derived' : fuel.source);

  return Object.freeze({
    limits: Object.freeze(limits),
    planning: Object.freeze(plan),
    maxTransitions: fuel.value,
    bindings: Object.freeze(bindings),
    clamped: Object.freeze(clamped),
  });
}

/**
 * Min-merge helper kept for `tightestLimits()` in `run.mjs`: the tighter value
 * for every ceiling, now also under the hard ceilings.
 */
export function mergeTightest(runtimeLimits = {}, profileLimits = {}, ceilings = HARD_CEILINGS) {
  const merged = { ...runtimeLimits };
  for (const [key, value] of Object.entries(profileLimits)) {
    if (!isLimit(value)) continue;
    merged[key] = isLimit(merged[key]) ? Math.min(merged[key], value) : value;
  }
  for (const [key, ceiling] of Object.entries(ceilings)) {
    if (!(key in merged)) continue;
    merged[key] = isLimit(merged[key]) ? Math.min(merged[key], ceiling) : ceiling;
  }
  return merged;
}
