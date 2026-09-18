/**
 * Budget enforcement and loop detection.
 *
 * Real implementation. An agent run is only useful if it is guaranteed to stop,
 * so every dimension of cost is bounded here and `check()` answers a single
 * question: *may the run continue, and if not, why not?*
 *
 * The stop reason is structured — never a bare boolean — because the caller has
 * to decide between REPLANNING (recoverable: try a different approach) and
 * FAILED (terminal: the budget is gone), and the audit row has to say which.
 *
 * Counting semantics (documented because they are the contract tests pin):
 *
 *   limit reached  <=>  observed >= limit  <=>  stop
 *
 * So `maxIterations: 12` permits 12 iterations and the 13th `check()` refuses;
 * `maxToolCalls: 24` permits 24 tool calls and the 25th is refused **before**
 * it executes. Budgets are checked before acting, never after.
 *
 * `recordToolCall()` is the one place that refuses *the call it is recording*,
 * because loop detection is about the call in hand: the
 * `maxRepeatedToolCalls`-th identical (tool, args) call and the
 * `maxSameToolCalls + 1`-th call to the same tool return `allowed: false` and
 * must not be executed.
 */

import { DEFAULT_BUDGETS } from '../config/index.mjs';
import { canonicalStringify } from '../util/canonical.mjs';
import { fingerprint } from '../util/ids.mjs';

/** Stop-reason codes. Stable strings — they are persisted in run records. */
export const STOP_REASONS = Object.freeze({
  ITERATION_BUDGET_EXCEEDED: 'ITERATION_BUDGET_EXCEEDED',
  WALL_CLOCK_TIMEOUT: 'WALL_CLOCK_TIMEOUT',
  TOKEN_BUDGET_EXCEEDED: 'TOKEN_BUDGET_EXCEEDED',
  TOOL_CALL_BUDGET_EXCEEDED: 'TOOL_CALL_BUDGET_EXCEEDED',
  LOOP_DETECTED: 'LOOP_DETECTED',
  TOOL_REPEAT_LIMIT: 'TOOL_REPEAT_LIMIT',
  /**
   * Added in call 2. NOT produced by `check()` — the budget tracker cannot see
   * the model window. It is produced by the run loop when the context manager
   * reports that even the protected sections do not fit the window
   * (`budgetReport.overBudget`), because sending an oversized window to a model
   * is not a smaller version of the task, it is a different failure.
   */
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
  /**
   * Added in call 2. Produced by the loops when `run.cancel()` has been called,
   * checked between iterations. The tool in flight is not interrupted (a plain
   * JS function cannot be cancelled) — the next iteration is what refuses to
   * start. Stated here rather than implied.
   */
  CANCELLATION_REQUESTED: 'CANCELLATION_REQUESTED',
});

/**
 * Evaluation order for `check()`. Deterministic on purpose: a run that breaks
 * two budgets at once always reports the same one, so tests and audit rows are
 * reproducible.
 */
export const STOP_REASON_ORDER = Object.freeze([
  STOP_REASONS.WALL_CLOCK_TIMEOUT,
  STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED,
  STOP_REASONS.TOKEN_BUDGET_EXCEEDED,
  STOP_REASONS.ITERATION_BUDGET_EXCEEDED,
  STOP_REASONS.LOOP_DETECTED,
  STOP_REASONS.TOOL_REPEAT_LIMIT,
]);

/** Recoverable reasons can be answered with REPLANNING; the rest end the run. */
export const RECOVERABLE_STOP_REASONS = Object.freeze([
  STOP_REASONS.LOOP_DETECTED,
  STOP_REASONS.TOOL_REPEAT_LIMIT,
]);

function makeStopReason(code, { limit, observed, message, scope = 'run', evidence = {} }) {
  return Object.freeze({
    code,
    limit,
    observed,
    scope,
    message: message ?? `${code}: observed ${observed}, limit ${limit}`,
    recoverable: RECOVERABLE_STOP_REASONS.includes(code),
    evidence,
  });
}

/**
 * @param {object}   [options]
 * @param {object}   [options.limits]   defaults to DEFAULT_BUDGETS
 * @param {Function} [options.now]      clock injection for tests
 * @param {number}   [options.startAt]  epoch ms the run began
 */
export function createBudgetTracker({ limits = DEFAULT_BUDGETS, now = () => Date.now(), startAt } = {}) {
  const start = typeof startAt === 'number' ? startAt : now();
  const effective = { ...DEFAULT_BUDGETS, ...limits };

  let iterations = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const toolFingerprints = new Map(); // fingerprint -> count
  const toolNames = new Map(); // name -> count
  const timeline = []; // { kind, at, detail } — used in the run record

  const totalTokens = () => promptTokens + completionTokens;

  function elapsedMs() {
    return Math.max(0, now() - start);
  }

  /** Record one planner/act iteration. */
  function recordIteration(detail = {}) {
    iterations += 1;
    timeline.push({ kind: 'iteration', at: now(), detail });
    return iterations;
  }

  /**
   * Record model token usage. Accepts either a number or the `usage` object a
   * provider returned.
   */
  function recordTokens(usage) {
    if (typeof usage === 'number') {
      completionTokens += Math.max(0, usage);
    } else if (usage && typeof usage === 'object') {
      promptTokens += Math.max(0, Number(usage.promptTokens) || 0);
      completionTokens += Math.max(0, Number(usage.completionTokens) || 0);
      // Providers that only report a total: attribute the remainder to prompt.
      if (usage.promptTokens === undefined && usage.completionTokens === undefined && usage.totalTokens) {
        promptTokens += Math.max(0, Number(usage.totalTokens) || 0);
      }
    }
    timeline.push({ kind: 'tokens', at: now(), detail: { promptTokens, completionTokens } });
    return totalTokens();
  }

  /**
   * Record a tool call attempt and fingerprint it for loop detection.
   *
   * @param {{name: string, args?: unknown}} call
   * @returns {{allowed: boolean, fingerprint: string, repeats: number, nameCount: number, stopReason: object|null}}
   */
  function recordToolCall({ name, args } = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('recordToolCall: `name` must be a non-empty string');
    }
    toolCalls += 1;

    const fp = fingerprint({ name, args: args ?? null });
    const repeats = (toolFingerprints.get(fp) ?? 0) + 1;
    toolFingerprints.set(fp, repeats);
    const nameCount = (toolNames.get(name) ?? 0) + 1;
    toolNames.set(name, nameCount);

    timeline.push({ kind: 'tool_call', at: now(), detail: { name, fingerprint: fp, repeats } });

    let stopReason = null;
    if (toolCalls > effective.maxToolCalls) {
      stopReason = makeStopReason(STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED, {
        limit: effective.maxToolCalls,
        observed: toolCalls,
        scope: 'tool',
        message: `tool-call budget exhausted: ${toolCalls} exceeds ${effective.maxToolCalls} calls`,
      });
    } else if (repeats >= effective.maxRepeatedToolCalls) {
      stopReason = makeStopReason(STOP_REASONS.LOOP_DETECTED, {
        limit: effective.maxRepeatedToolCalls,
        observed: repeats,
        scope: 'tool',
        message:
          `loop detected: tool "${name}" called ${repeats} times with identical arguments ` +
          `(limit ${effective.maxRepeatedToolCalls})`,
        evidence: { tool: name, fingerprint: fp, args: args ?? null },
      });
    } else if (nameCount > effective.maxSameToolCalls) {
      stopReason = makeStopReason(STOP_REASONS.TOOL_REPEAT_LIMIT, {
        limit: effective.maxSameToolCalls,
        observed: nameCount,
        scope: 'tool',
        message: `tool "${name}" called ${nameCount} times (limit ${effective.maxSameToolCalls})`,
        evidence: { tool: name },
      });
    }

    return { allowed: stopReason === null, fingerprint: fp, repeats, nameCount, stopReason };
  }

  /**
   * @returns {{exceeded: boolean, stopReason: object|null, snapshot: object}}
   */
  function check() {
    const snapshot = snapshotOf();
    let stopReason = null;

    if (snapshot.elapsedMs >= effective.wallClockMs) {
      stopReason = makeStopReason(STOP_REASONS.WALL_CLOCK_TIMEOUT, {
        limit: effective.wallClockMs,
        observed: snapshot.elapsedMs,
        scope: 'time',
        message: `wall-clock timeout: ${snapshot.elapsedMs}ms of ${effective.wallClockMs}ms elapsed`,
      });
    } else if (snapshot.toolCalls >= effective.maxToolCalls) {
      stopReason = makeStopReason(STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED, {
        limit: effective.maxToolCalls,
        observed: snapshot.toolCalls,
        scope: 'tool',
        message: `tool-call budget exhausted: ${snapshot.toolCalls} of ${effective.maxToolCalls} calls used`,
      });
    } else if (snapshot.tokens >= effective.maxTokens) {
      stopReason = makeStopReason(STOP_REASONS.TOKEN_BUDGET_EXCEEDED, {
        limit: effective.maxTokens,
        observed: snapshot.tokens,
        scope: 'token',
        message: `token budget exhausted: ${snapshot.tokens} of ${effective.maxTokens} tokens used`,
      });
    } else if (snapshot.iterations >= effective.maxIterations) {
      stopReason = makeStopReason(STOP_REASONS.ITERATION_BUDGET_EXCEEDED, {
        limit: effective.maxIterations,
        observed: snapshot.iterations,
        scope: 'iteration',
        message: `iteration budget exhausted: ${snapshot.iterations} of ${effective.maxIterations} iterations used`,
      });
    }

    if (!stopReason) {
      // Loop detection survives across checks: a repeated fingerprint is a
      // reason to stop even if the counters were reset by a replan.
      const worst = worstLoop();
      if (worst && worst.repeats >= effective.maxRepeatedToolCalls) {
        stopReason = makeStopReason(STOP_REASONS.LOOP_DETECTED, {
          limit: effective.maxRepeatedToolCalls,
          observed: worst.repeats,
          scope: 'tool',
          message:
            `loop detected: tool "${worst.name}" called ${worst.repeats} times with identical arguments ` +
            `(limit ${effective.maxRepeatedToolCalls})`,
          evidence: { fingerprint: worst.fingerprint },
        });
      } else {
        const worstName = worstToolName();
        if (worstName && worstName.count >= effective.maxSameToolCalls) {
          stopReason = makeStopReason(STOP_REASONS.TOOL_REPEAT_LIMIT, {
            limit: effective.maxSameToolCalls,
            observed: worstName.count,
            scope: 'tool',
            message: `tool "${worstName.name}" called ${worstName.count} times (limit ${effective.maxSameToolCalls})`,
            evidence: { tool: worstName.name },
          });
        }
      }
    }

    return { exceeded: stopReason !== null, stopReason, snapshot };
  }

  function worstLoop() {
    let worst = null;
    for (const [fp, count] of toolFingerprints.entries()) {
      if (!worst || count > worst.repeats) worst = { fingerprint: fp, repeats: count, name: null };
    }
    if (!worst) return null;
    // Recover the tool name for the message from the timeline.
    const entry = [...timeline].reverse().find((item) => item.detail?.fingerprint === worst.fingerprint);
    return { ...worst, name: entry?.detail?.name ?? 'unknown' };
  }

  function worstToolName() {
    let worst = null;
    for (const [name, count] of toolNames.entries()) {
      if (!worst || count > worst.count) worst = { name, count };
    }
    return worst;
  }

  function snapshotOf() {
    return Object.freeze({
      iterations,
      toolCalls,
      promptTokens,
      completionTokens,
      tokens: totalTokens(),
      elapsedMs: elapsedMs(),
      limits: effective,
      distinctTools: toolNames.size,
      repeatedCallMax: worstLoop()?.repeats ?? 0,
      startedAt: start,
    });
  }

  function remaining() {
    return Object.freeze({
      iterations: Math.max(0, effective.maxIterations - iterations),
      toolCalls: Math.max(0, effective.maxToolCalls - toolCalls),
      tokens: Math.max(0, effective.maxTokens - totalTokens()),
      wallClockMs: Math.max(0, effective.wallClockMs - elapsedMs()),
    });
  }

  return {
    limits: effective,
    recordIteration,
    recordTokens,
    recordToolCall,
    check,
    remaining,
    elapsedMs,
    get iterations() {
      return iterations;
    },
    get toolCalls() {
      return toolCalls;
    },
    get tokens() {
      return totalTokens();
    },
    timeline: () => [...timeline],
    snapshot: snapshotOf,
    /** Canonical form of the counters — handy in assertions and run records. */
    fingerprint() {
      return fingerprint(canonicalStringify(snapshotOf()));
    },
  };
}
