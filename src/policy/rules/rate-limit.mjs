/**
 * RULE: rate limit (priority 40).
 *
 * Two ceilings, both from the agent profile's `limits` (falling back to the
 * runtime budgets):
 *
 *   - total tool calls in the run  (`maxToolCalls`)
 *   - calls to the same tool      (`maxSameTool` / `maxSameToolCalls`)
 *
 * The rule is pure: it counts what the caller passes in `request.history.toolCalls`
 * rather than keeping state of its own. That means the same request always
 * produces the same decision, and the counter cannot silently diverge from the
 * event log — the history *is* the log.
 *
 * The runtime budget tracker (`src/runtime/budgets.mjs`) enforces the same
 * ceilings from the inside. Both exist on purpose: the tracker stops the loop,
 * the rule records a policy verdict on the call.
 */

import { allow, deny } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';

/** Defaults when neither the profile nor the request supplies a limit. */
export const DEFAULT_RATE_LIMITS = Object.freeze({
  maxToolCalls: 24,
  maxSameToolCalls: 12,
});

/**
 * @param {Array<{name: string}>} history
 * @returns {Map<string, number>} calls per tool name
 */
export function countByTool(history = []) {
  const counts = new Map();
  for (const call of history) {
    if (!call?.name) continue;
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  return counts;
}

export const rateLimitRule = defineRule({
  id: 'run.rate_limit',
  kind: RULE_KINDS.RATE_LIMIT,
  priority: 40,
  description:
    'Per-run tool-call ceilings from the agent profile (maxToolCalls, maxSameToolCalls) counted from the ' +
    'run history supplied on the request — the history is the log, so the rule stays pure.',
  appliesTo: (request) => request.kind === 'tool_call' && Boolean(request.tool),
  evaluate(request) {
    const profileLimits = request.profile?.limits ?? {};
    const maxToolCalls = request.limits?.maxToolCalls ?? profileLimits.maxToolCalls ?? DEFAULT_RATE_LIMITS.maxToolCalls;
    const maxSameToolCalls =
      request.limits?.maxSameToolCalls ?? profileLimits.maxSameToolCalls ?? DEFAULT_RATE_LIMITS.maxSameToolCalls;

    const history = request.history?.toolCalls ?? [];
    const total = history.length;
    const perTool = countByTool(history);
    const sameTool = perTool.get(request.tool.name) ?? 0;

    if (total >= maxToolCalls) {
      return deny(
        `run tool-call budget exhausted: ${total} of ${maxToolCalls} calls already recorded, ` +
          `so "${request.tool.name}" may not be called again`,
        { maxToolCalls, observed: total },
      );
    }
    if (sameTool >= maxSameToolCalls) {
      return deny(
        `tool "${request.tool.name}" has already been called ${sameTool} times in this run (limit ${maxSameToolCalls})`,
        { tool: request.tool.name, maxSameToolCalls, observed: sameTool },
      );
    }

    return allow(
      `rate limits satisfied for tool "${request.tool.name}": ${total}/${maxToolCalls} calls in run, ` +
        `${sameTool}/${maxSameToolCalls} call(s) to this tool`,
      { maxToolCalls, maxSameToolCalls, total, sameTool },
    );
  },
});

export default rateLimitRule;
