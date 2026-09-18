/**
 * Tool executor — where selection ends and execution begins.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ORDER OF OPERATIONS IS THE SAFETY PROPERTY. For every call, in this order:
 *
 *   (a) resolve the tool from the registry      unknown  -> TOOL_NOT_FOUND (no throw)
 *   (b) validate args against inputSchema       invalid  -> TOOL_ARGUMENT_INVALID (no throw)
 *   (c) ask the policy kernel for a verdict                -> ALLOW/DENY/REQUIRE_APPROVAL
 *   (d) block on DENY, or pause on REQUIRE_APPROVAL and create a real approval
 *   (e) check the run budget, then run `execute(args, ctx)`
 *   (f) time the execution out (`tool.timeoutMs` or the executor default)
 *   (g) capture result, duration and error into one structured record
 *
 * `execute()` is NEVER called when (a), (b), (c) or (d) fails. That is asserted
 * by `tests/unit/executor.test.mjs`, which registers a tool that records being
 * called and then proves it is not called for an unknown tool, a bad argument,
 * a policy denial, a missing approval, and an exhausted budget.
 *
 * "Pausing" is real: on REQUIRE_APPROVAL the executor writes an approval record
 * (via `src/policy/approvals.mjs`) bound to the tool name AND a fingerprint of
 * the arguments, and returns APPROVAL_REQUIRED. Resuming means calling again
 * with `approvalId` — the approval must have been resolved as `approved` for
 * the same tool and the same arguments, or the call stays paused.
 *
 * A timeout aborts the *wait*, not the underlying promise: a plain JS function
 * cannot be cancelled. Tools that do I/O should honour `ctx.signal`. This is a
 * documented limitation, not a hidden one.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { DECISIONS } from '../policy/decisions.mjs';
import { approvalFingerprint } from '../policy/approvals.mjs';
import { EVENT_TYPES } from '../observability/events.mjs';
import { validate, formatViolations } from './schema.mjs';

/** Structured outcomes. Nothing here is thrown for an expected failure. */
export const EXECUTION_STATUS = Object.freeze({
  OK: 'OK',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_ARGUMENT_INVALID: 'TOOL_ARGUMENT_INVALID',
  POLICY_DENIED: 'POLICY_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_ERROR: 'TOOL_ERROR',
});

/** Statuses that mean "the tool did not run". */
export const NON_EXECUTION_STATUSES = Object.freeze([
  EXECUTION_STATUS.TOOL_NOT_FOUND,
  EXECUTION_STATUS.TOOL_ARGUMENT_INVALID,
  EXECUTION_STATUS.POLICY_DENIED,
  EXECUTION_STATUS.APPROVAL_REQUIRED,
  EXECUTION_STATUS.BUDGET_EXCEEDED,
  EXECUTION_STATUS.TOOL_TIMEOUT,
]);

class ToolTimeoutError extends Error {
  constructor(toolName, ms) {
    super(`tool "${toolName}" exceeded its ${ms}ms timeout`);
    this.name = 'ToolTimeoutError';
    this.code = 'TOOL_TIMEOUT';
  }
}

/**
 * @param {object}   options
 * @param {object}   options.registry        from createToolRegistry()
 * @param {object}   options.policy          from createPolicyKernel()
 * @param {object}   [options.approvals]     from createApprovalManager()
 * @param {object}   [options.events]        event bus (optional)
 * @param {Function} [options.now]
 * @param {number}   [options.defaultTimeoutMs]
 */
export function createToolExecutor({
  registry,
  policy,
  approvals = null,
  events = null,
  now = () => Date.now(),
  defaultTimeoutMs = 10_000,
} = {}) {
  if (!registry || typeof registry.get !== 'function') {
    throw new TypeError('createToolExecutor: a tool registry is required');
  }
  if (!policy || typeof policy.evaluate !== 'function') {
    throw new TypeError('createToolExecutor: a policy kernel is required');
  }

  /** Default bus (usually null: the executor is shared, so runs pass theirs). */
  const defaultEvents = events;

  function result(status, fields = {}) {
    const finishedAt = now();
    return Object.freeze({
      status,
      ok: status === EXECUTION_STATUS.OK,
      executed: status === EXECUTION_STATUS.OK || status === EXECUTION_STATUS.TOOL_ERROR,
      finishedAt,
      ...fields,
    });
  }

  /**
   * @param {object} request
   * @param {string} request.toolName
   * @param {object} [request.args]
   * @param {object} [request.profile]      agent profile
   * @param {string} [request.agentId]
   * @param {string} [request.runId]
   * @param {string} [request.sessionId]
   * @param {object} [request.untrusted]    { text, source } for the injection scan
   * @param {object} [request.evidence]     structured facts for the boundary rules
   * @param {object} [request.history]      { toolCalls: [...] } for rate limiting
   * @param {object} [request.limits]       overrides for the rate-limit rule
   * @param {string} [request.approvalId]   a previously granted approval
   * @param {object} [request.budget]       createBudgetTracker() instance
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<object>} structured execution record
   */
  async function execute(request = {}) {
    const {
      toolName,
      args = {},
      profile = null,
      agentId = profile?.id ?? 'unknown',
      runId = null,
      sessionId = null,
      untrusted = null,
      evidence = {},
      history = { toolCalls: [] },
      limits = null,
      approvalId = null,
      budget = null,
      signal,
      toolTimeoutMs = null,
      events: callEvents = defaultEvents,
    } = request;

    // One bus per call: a shared executor must emit into the calling run's
    // stream, never into whichever bus happened to be configured first.
    const emit = (type, payload, meta) => {
      if (callEvents) callEvents.emit(type, payload, meta);
    };

    const startedAt = now();
    const base = { runId, sessionId, agentId, toolName, args, startedAt };

    // (a) resolve -----------------------------------------------------------
    const tool = registry.get(toolName);
    if (!tool) {
      const record = result(EXECUTION_STATUS.TOOL_NOT_FOUND, {
        ...base,
        durationMs: 0,
        error: { code: EXECUTION_STATUS.TOOL_NOT_FOUND, message: `tool "${toolName}" is not registered` },
        policy: null,
        approval: null,
        result: null,
      });
      emit(EVENT_TYPES.TOOL_FAILED, { tool: toolName, status: record.status, error: record.error });
      return record;
    }

    emit(EVENT_TYPES.TOOL_PROPOSED, {
      tool: tool.name,
      args,
      riskLevel: tool.riskLevel,
      sideEffect: tool.sideEffect,
      requiresConfirmation: tool.requiresConfirmation,
    });

    // (b) validate ----------------------------------------------------------
    const violations = validate(args, tool.inputSchema);
    if (violations.length) {
      const record = result(EXECUTION_STATUS.TOOL_ARGUMENT_INVALID, {
        ...base,
        durationMs: now() - startedAt,
        tool: tool.name,
        riskLevel: tool.riskLevel,
        sideEffect: tool.sideEffect,
        policy: null,
        approval: null,
        result: null,
        error: {
          code: EXECUTION_STATUS.TOOL_ARGUMENT_INVALID,
          message: `arguments for "${tool.name}" failed schema validation`,
          violations,
          formatted: formatViolations(violations),
        },
      });
      emit(EVENT_TYPES.TOOL_FAILED, { tool: tool.name, status: record.status, error: record.error });
      return record;
    }

    // (c) policy ------------------------------------------------------------
    const policyOutcome = policy.evaluate({
      kind: 'tool_call',
      runId,
      sessionId,
      agentId,
      profile,
      tool,
      args,
      evidence,
      untrusted,
      history,
      limits,
      now: now(),
    });

    emit(EVENT_TYPES.POLICY_DECIDED, {
      kind: 'tool_call',
      tool: tool.name,
      decision: policyOutcome.decision,
      rule: policyOutcome.rule,
      kindLabel: policyOutcome.kind,
      reason: policyOutcome.reason,
      evidence: policyOutcome.evidence,
      firedRules: policyOutcome.firedRules,
    });

    const policySummary = {
      decision: policyOutcome.decision,
      rule: policyOutcome.rule,
      reason: policyOutcome.reason,
      evidence: policyOutcome.evidence,
      checks: policyOutcome.checks,
    };

    // (d) block or pause ----------------------------------------------------
    if (policyOutcome.decision === DECISIONS.DENY) {
      const record = result(EXECUTION_STATUS.POLICY_DENIED, {
        ...base,
        durationMs: now() - startedAt,
        tool: tool.name,
        riskLevel: tool.riskLevel,
        sideEffect: tool.sideEffect,
        policy: policySummary,
        approval: null,
        result: null,
        error: {
          code: EXECUTION_STATUS.POLICY_DENIED,
          message: policyOutcome.reason,
          rule: policyOutcome.rule,
        },
      });
      emit(EVENT_TYPES.TOOL_FAILED, {
        tool: tool.name,
        status: record.status,
        error: record.error,
        policy: { decision: policyOutcome.decision, rule: policyOutcome.rule },
      });
      return record;
    }

    let approval = null;
    if (policyOutcome.decision === DECISIONS.REQUIRE_APPROVAL) {
      if (!approvals) {
        const record = result(EXECUTION_STATUS.APPROVAL_REQUIRED, {
          ...base,
          durationMs: now() - startedAt,
          tool: tool.name,
          policy: policySummary,
          approval: null,
          result: null,
          error: {
            code: EXECUTION_STATUS.APPROVAL_REQUIRED,
            message: `${policyOutcome.reason} — no approval store is configured, so the call cannot proceed`,
            rule: policyOutcome.rule,
          },
        });
        emit(EVENT_TYPES.TOOL_FAILED, { tool: tool.name, status: record.status, error: record.error });
        return record;
      }

      const verdict = approvalId ? approvals.check(approvalId, { toolName: tool.name, args }) : null;

      if (!verdict?.approved) {
        /**
         * What to report as the pending approval, and when to mint one.
         *
         *   - the verdict's approval is BOUND TO THESE ARGUMENTS (same
         *     fingerprint) and is `pending`, `rejected` or `expired` -> reuse it.
         *     Reuse is what keeps two properties: a repeated identical call does
         *     not mint a duplicate request, and a human decision is FINAL for
         *     exactly these arguments, so retrying cannot silently re-queue it.
         *   - it was granted for DIFFERENT arguments -> mint a new one. Reporting
         *     the old approval id here was wrong: the caller saw an approval next
         *     to a call that did not run, and the changed request had no pending
         *     record for a human to act on.
         *   - there is no verdict at all (no id, or an unknown id) -> mint one.
         */
        const boundToTheseArgs =
          Boolean(verdict?.approval) && verdict.approval.requestFingerprint === approvalFingerprint(tool.name, args);
        const resumable = boundToTheseArgs ? verdict.approval : null;
        const pending =
          resumable ??
          approvals.request({
            runId,
            sessionId,
            agentId,
            reason: policyOutcome.reason,
            policyRule: policyOutcome.rule,
            toolName: tool.name,
            args,
            // The approver needs to see WHAT was proposed, not just why it
            // paused: the tool arguments are the proposal. Redacted on write.
            payload: { evidence, proposedTool: tool.name, proposedArgs: args },
          });

        emit(EVENT_TYPES.APPROVAL_REQUESTED, {
          approvalId: pending.approvalId,
          tool: tool.name,
          reason: policyOutcome.reason,
          policyRule: policyOutcome.rule,
          status: pending.status,
        });

        const record = result(EXECUTION_STATUS.APPROVAL_REQUIRED, {
          ...base,
          durationMs: now() - startedAt,
          tool: tool.name,
          riskLevel: tool.riskLevel,
          sideEffect: tool.sideEffect,
          policy: policySummary,
          approval: { approvalId: pending.approvalId, status: pending.status, reason: verdict?.reason ?? null },
          result: null,
          error: {
            code: EXECUTION_STATUS.APPROVAL_REQUIRED,
            message: policyOutcome.reason,
            rule: policyOutcome.rule,
            approvalId: pending.approvalId,
          },
        });
        emit(EVENT_TYPES.TOOL_FAILED, {
          tool: tool.name,
          status: record.status,
          error: record.error,
          approvalId: pending.approvalId,
        });
        return record;
      }

      approval = verdict.approval;
    }

    // (e) budget then execute ----------------------------------------------
    if (budget) {
      const preCheck = budget.check();
      // The loop owns the iteration budget: refusing to run a tool because the
      // 12th iteration has been spent is not the executor's call, and doing it
      // here would strand a tool call the loop deliberately allowed. Time and
      // tool-call ceilings (including loop detection) are the executor's own
      // business and still apply.
      const executorScopes = ['time', 'tool'];
      if (preCheck.exceeded && executorScopes.includes(preCheck.stopReason.scope)) {
        const record = result(EXECUTION_STATUS.BUDGET_EXCEEDED, {
          ...base,
          durationMs: now() - startedAt,
          tool: tool.name,
          policy: policySummary,
          approval: approval ? { approvalId: approval.approvalId, status: approval.status } : null,
          result: null,
          error: {
            code: preCheck.stopReason.code,
            message: preCheck.stopReason.message,
            stopReason: preCheck.stopReason,
          },
        });
        emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason: preCheck.stopReason, tool: tool.name });
        return record;
      }
      const call = budget.recordToolCall({ name: tool.name, args });
      if (!call.allowed) {
        const record = result(EXECUTION_STATUS.BUDGET_EXCEEDED, {
          ...base,
          durationMs: now() - startedAt,
          tool: tool.name,
          policy: policySummary,
          approval: approval ? { approvalId: approval.approvalId, status: approval.status } : null,
          result: null,
          error: {
            code: call.stopReason.code,
            message: call.stopReason.message,
            stopReason: call.stopReason,
          },
        });
        emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason: call.stopReason, tool: tool.name });
        return record;
      }
    }

    /**
     * Timeout precedence: an explicit per-CALL timeout wins (that is the caller
     * saying "wait no longer than this"), then the tool's own declaration, then
     * the executor default. `toolTimeoutMs` was documented on the run handle in
     * call 1 but never read here; call 2 wired it up, and this is the only place
     * the effective value is decided.
     */
    const timeoutMs = toolTimeoutMs ?? tool.timeoutMs ?? defaultTimeoutMs;
    const ctx = Object.freeze({
      runId,
      sessionId,
      agentId,
      toolName: tool.name,
      approvalId: approval?.approvalId ?? null,
      signal,
      now,
    });

    // (f) + (g) run, time out, capture --------------------------------------
    const executionStartedAt = now();
    let timer = null;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => tool.execute(args, ctx)),
        new Promise((_, reject) => {
          // Deliberately NOT unref'd. A pending tool call must keep the process
          // alive until its timeout fires; an unref'd timer would let the event
          // loop drain and the timeout would never be observed, so a hung tool
          // would silently hang the whole run instead of stopping it.
          timer = setTimeout(() => reject(new ToolTimeoutError(tool.name, timeoutMs)), timeoutMs);
        }),
      ]);

      const durationMs = now() - executionStartedAt;
      const record = result(EXECUTION_STATUS.OK, {
        ...base,
        durationMs,
        tool: tool.name,
        riskLevel: tool.riskLevel,
        sideEffect: tool.sideEffect,
        policy: policySummary,
        approval: approval ? { approvalId: approval.approvalId, status: approval.status } : null,
        result: value,
        error: null,
      });
      emit(EVENT_TYPES.TOOL_EXECUTED, {
        tool: tool.name,
        args,
        result: value,
        durationMs,
        approvalId: approval?.approvalId ?? null,
      });
      if (approval) {
        emit(EVENT_TYPES.APPROVAL_RESOLVED, {
          approvalId: approval.approvalId,
          status: approval.status,
          tool: tool.name,
          consumedBy: runId,
        });
      }
      return record;
    } catch (err) {
      const durationMs = now() - executionStartedAt;
      const isTimeout = err?.name === 'ToolTimeoutError' || err?.code === 'TOOL_TIMEOUT';
      const status = isTimeout ? EXECUTION_STATUS.TOOL_TIMEOUT : EXECUTION_STATUS.TOOL_ERROR;
      const record = result(status, {
        ...base,
        durationMs,
        tool: tool.name,
        riskLevel: tool.riskLevel,
        sideEffect: tool.sideEffect,
        policy: policySummary,
        approval: approval ? { approvalId: approval.approvalId, status: approval.status } : null,
        result: null,
        error: {
          code: err?.code ?? status,
          message: err?.message ?? String(err),
          name: err?.name ?? 'Error',
        },
      });
      emit(EVENT_TYPES.TOOL_FAILED, { tool: tool.name, status: record.status, error: record.error, durationMs });
      return record;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    registry,
    policy,
    approvals,
    defaultTimeoutMs,
    execute,
    /** Introspection for `verify:runtime` and the docs. */
    describe: () => ({
      tools: registry.describe?.() ?? [],
      policyRules: policy.describe?.() ?? [],
      approvalsConfigured: Boolean(approvals),
      defaultTimeoutMs,
    }),
  };
}
