/**
 * Planner — goal decomposition into an ordered plan of typed steps.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A plan is data. A step is:
 *
 *   { id, index, description, tool?, args?, status, attempts, outcome }
 *
 * `createPlanner()` gives the planner six operations, which are the whole
 * lifecycle of a plan:
 *
 *   plan({ goal, steps })              decompose a goal into validated steps
 *   nextStep(plan)                     the next actionable step, marked in-flight
 *   recordOutcome(plan, id, outcome)   what happened when it ran
 *   shouldReplan(plan, detail)         is a failed step worth another attempt?
 *   replan(plan, { steps, reason })    supersede the remaining steps
 *   complete(plan, { status, outcome }) close the plan out
 *
 * ── WHAT THE PLANNER MAY PLAN ───────────────────────────────────────────────
 * It plans against the runtime's real tool registry, and it will not write a
 * step for a tool that does not exist (`PLAN_UNKNOWN_TOOL`), is not in the
 * agent profile's allowlist, or needs a permission or data tag the profile does
 * not hold (`PLAN_TOOL_NOT_PERMITTED`). The permission check mirrors
 * `src/policy/rules/tool-authorization.mjs` + `data-access.mjs`; it is a mirror
 * so a bad plan is refused *before* it becomes a run, not the control itself.
 * The control remains the executor, which re-evaluates every call through the
 * policy kernel — an unauthorised step that somehow reached it would still be
 * DENIED there, so planning cannot widen anything.
 *
 * ── WHY IT CANNOT RUN FOREVER ──────────────────────────────────────────────
 * Two independent ceilings, both enforced here rather than trusted:
 *   - `maxReplans` — the number of times the remaining steps may be superseded;
 *   - `maxStepAttempts` — how many times one step may be retried inside the
 *     same plan revision.
 * Both throw (`PLAN_REPLAN_LIMIT`, `PLAN_TERMINAL`) or return false rather than
 * looping. The run loop adds the third and final ceiling: the iteration budget
 * in `src/runtime/budgets.mjs`, which stops the plan *whatever* the planner
 * wants — see `tests/integration/planner-loop.test.mjs`, which drives a plan
 * that never completes until the iteration budget ends the run.
 *
 * ── MUTABILITY, STATED PLAINLY ─────────────────────────────────────────────
 * A plan is a mutable aggregate (statuses and attempts change as it runs), and
 * `snapshotPlan(plan)` returns a deep-frozen copy for persistence, tests and
 * the event stream. Steps are never deleted: a superseded step is `skipped`
 * with an outcome explaining why, so the plan's history stays readable.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { newId } from '../util/ids.mjs';

/** Step statuses. Stable strings — they are persisted in the run record. */
export const STEP_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
});

/** Step statuses that still have work in them. */
export const OPEN_STEP_STATUSES = Object.freeze([STEP_STATUS.PENDING, STEP_STATUS.IN_PROGRESS]);

/**
 * Terminal step statuses: a step in one of these will not be run again.
 *
 * `failed` is terminal because a failed attempt happened — it is history, and a
 * retry is a *revision*, not a replay. Keeping the failure on the step is what
 * lets a plan show "we tried this, it failed, and here is what we did instead",
 * which is the whole reason a plan is persisted rather than recomputed.
 */
export const TERMINAL_STEP_STATUSES = Object.freeze([
  STEP_STATUS.DONE,
  STEP_STATUS.FAILED,
  STEP_STATUS.SKIPPED,
  STEP_STATUS.BLOCKED,
]);

export const PLAN_STATUS = Object.freeze({
  ACTIVE: 'active',
  COMPLETE: 'complete',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
});

export const TERMINAL_PLAN_STATUSES = Object.freeze([
  PLAN_STATUS.COMPLETE,
  PLAN_STATUS.FAILED,
  PLAN_STATUS.ABANDONED,
]);

export const PLAN_ERROR_CODES = Object.freeze({
  NO_STEPS: 'PLAN_NO_STEPS',
  INVALID_STEP: 'PLAN_INVALID_STEP',
  DUPLICATE_STEP: 'PLAN_DUPLICATE_STEP',
  TOO_MANY_STEPS: 'PLAN_TOO_MANY_STEPS',
  UNKNOWN_TOOL: 'PLAN_UNKNOWN_TOOL',
  TOOL_NOT_PERMITTED: 'PLAN_TOOL_NOT_PERMITTED',
  NO_PROFILE: 'PLAN_NO_PROFILE',
  STEP_NOT_FOUND: 'PLAN_STEP_NOT_FOUND',
  PLAN_TERMINAL: 'PLAN_TERMINAL',
  REPLAN_LIMIT: 'PLAN_REPLAN_LIMIT',
  INVALID_OUTCOME: 'PLAN_INVALID_OUTCOME',
});

export class PlanError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`);
    this.name = 'PlanError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Defaults. All are ceilings; a caller may lower them, never raise them silently. */
export const PLANNER_DEFAULTS = Object.freeze({
  maxSteps: 12,
  maxReplans: 3,
  maxStepAttempts: 2,
});

function normaliseStep(step, index) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, `step ${index + 1} must be an object`, { index });
  }
  const { id = null, description, tool = null, args = null } = step;
  if (typeof description !== 'string' || !description.trim()) {
    throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, `step ${index + 1} needs a non-empty \`description\``, { index });
  }
  if (tool !== null && (typeof tool !== 'string' || !tool.trim())) {
    throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, `step ${index + 1} \`tool\` must be a string when present`, { index });
  }
  if (args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, `step ${index + 1} \`args\` must be an object when present`, { index });
  }
  return {
    id: id ?? `step-${index + 1}`,
    index,
    description: description.trim(),
    tool: tool ?? null,
    args: args ?? null,
    status: STEP_STATUS.PENDING,
    attempts: 0,
    outcome: null,
  };
}

/**
 * @param {object}   options
 * @param {object}   options.registry      tool registry (`src/tools/registry.mjs`)
 * @param {object}   [options.profile]     agent profile; when absent, no plan may use tools
 * @param {string}   [options.agentId]
 * @param {number}   [options.maxSteps]
 * @param {number}   [options.maxReplans]
 * @param {number}   [options.maxStepAttempts]
 * @param {Function} [options.now]
 */
export function createPlanner({
  registry,
  profile = null,
  agentId = profile?.id ?? null,
  maxSteps = PLANNER_DEFAULTS.maxSteps,
  maxReplans = PLANNER_DEFAULTS.maxReplans,
  maxStepAttempts = PLANNER_DEFAULTS.maxStepAttempts,
  now = () => Date.now(),
} = {}) {
  if (!registry || typeof registry.has !== 'function') {
    throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, 'createPlanner: a tool registry is required');
  }

  /**
   * Is this tool one the agent may call? Mirrors the allowlist + permission +
   * data-access checks the policy kernel applies, so a plan cannot contain a
   * step the executor will refuse.
   */
  function authorizeTool(toolName, { index } = {}) {
    if (!registry.has(toolName)) {
      throw new PlanError(
        PLAN_ERROR_CODES.UNKNOWN_TOOL,
        `step ${index + 1} plans tool "${toolName}", which is not registered (known: ${registry.names().join(', ')})`,
        { tool: toolName, index },
      );
    }
    if (!profile) {
      throw new PlanError(
        PLAN_ERROR_CODES.NO_PROFILE,
        `step ${index + 1} plans tool "${toolName}" but no agent profile was resolved, so no tool may be planned`,
        { tool: toolName, index, failClosed: true },
      );
    }
    const allowed = profile.tools ?? [];
    if (!allowed.includes(toolName)) {
      throw new PlanError(
        PLAN_ERROR_CODES.TOOL_NOT_PERMITTED,
        `agent "${profile.id}" is not authorised to plan tool "${toolName}" (allowed: ${allowed.join(', ') || 'none'})`,
        { tool: toolName, index, allowedTools: allowed },
      );
    }
    const tool = registry.get(toolName);
    const missingPermissions = (tool.permissions ?? []).filter((permission) => !(profile.permissions ?? []).includes(permission));
    const missingData = (tool.dataAccess ?? []).filter((tag) => !(profile.dataAccess ?? []).includes(tag));
    if (missingPermissions.length || missingData.length) {
      throw new PlanError(
        PLAN_ERROR_CODES.TOOL_NOT_PERMITTED,
        `agent "${profile.id}" cannot plan tool "${toolName}": missing permissions ` +
          `[${missingPermissions.join(', ')}], missing data access [${missingData.join(', ')}]`,
        { tool: toolName, index, missingPermissions, missingData },
      );
    }
    return tool;
  }

  /** Validate a list of raw steps. Throws; never returns a partial plan. */
  function validateSteps(steps, { offset = 0 } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new PlanError(PLAN_ERROR_CODES.NO_STEPS, 'a plan needs at least one step');
    }
    if (steps.length + offset > maxSteps) {
      throw new PlanError(
        PLAN_ERROR_CODES.TOO_MANY_STEPS,
        `a plan may hold at most ${maxSteps} steps; ${steps.length + offset} were proposed`,
        { maxSteps, proposed: steps.length + offset },
      );
    }
    const normalised = steps.map((step, index) => normaliseStep(step, offset + index));
    const ids = new Set();
    for (const step of normalised) {
      if (ids.has(step.id)) {
        throw new PlanError(PLAN_ERROR_CODES.DUPLICATE_STEP, `duplicate step id "${step.id}"`, { stepId: step.id });
      }
      ids.add(step.id);
      if (step.tool) authorizeTool(step.tool, { index: step.index });
    }
    return normalised;
  }

  function plan({ goal, steps, agentId: plannedFor = agentId } = {}) {
    if (typeof goal !== 'string' || !goal.trim()) {
      throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, 'a plan needs a non-empty `goal`');
    }
    const normalised = validateSteps(steps, { offset: 0 });
    const createdAt = now();
    return {
      planId: newId('pln'),
      agentId: plannedFor,
      goal: goal.trim(),
      status: PLAN_STATUS.ACTIVE,
      revision: 1,
      replans: 0,
      steps: normalised,
      history: [
        { at: createdAt, type: 'plan.created', detail: { steps: normalised.length, goal: goal.trim() } },
        ...normalised
          .filter((step) => step.tool)
          .map((step) => ({ at: createdAt, type: 'plan.step.planned', detail: { stepId: step.id, tool: step.tool } })),
      ],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      outcome: null,
    };
  }

  function isTerminal(plan_) {
    return TERMINAL_PLAN_STATUSES.includes(plan_?.status);
  }

  function requirePlan(plan_) {
    if (!plan_ || !Array.isArray(plan_.steps)) {
      throw new PlanError(PLAN_ERROR_CODES.INVALID_STEP, 'not a plan object');
    }
    return plan_;
  }

  function findStep(plan_, stepId) {
    const step = requirePlan(plan_).steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new PlanError(PLAN_ERROR_CODES.STEP_NOT_FOUND, `plan "${plan_.planId}" has no step "${stepId}"`, { stepId });
    }
    return step;
  }

  /** The next actionable step, or null when none remain. Marks it in-flight. */
  function nextStep(plan_) {
    const p = requirePlan(plan_);
    if (isTerminal(p)) return null;
    const step = p.steps.find((candidate) => OPEN_STEP_STATUSES.includes(candidate.status));
    if (!step) return null;
    if (step.status === STEP_STATUS.PENDING) {
      step.status = STEP_STATUS.IN_PROGRESS;
      step.attempts += 1;
      p.updatedAt = now();
      p.history.push({ at: p.updatedAt, type: 'plan.step.started', detail: { stepId: step.id, attempt: step.attempts } });
    }
    return step;
  }

  /** Steps that could still be run. A failed or skipped step is not one. */
  function openSteps(plan_) {
    return requirePlan(plan_).steps.filter((step) => OPEN_STEP_STATUSES.includes(step.status));
  }

  /** Alias kept for callers that read "remaining" as "still to do". */
  const remainingSteps = openSteps;

  /** Every step that failed, in order. */
  function failedSteps(plan_) {
    return requirePlan(plan_).steps.filter((step) => step.status === STEP_STATUS.FAILED);
  }

  function recordOutcome(plan_, stepId, { status, outcome = null, error = null } = {}) {
    const p = requirePlan(plan_);
    if (isTerminal(p)) {
      throw new PlanError(PLAN_ERROR_CODES.PLAN_TERMINAL, `plan "${p.planId}" is ${p.status}; its steps are frozen`, { stepId });
    }
    const allowed = [STEP_STATUS.DONE, STEP_STATUS.FAILED, STEP_STATUS.SKIPPED, STEP_STATUS.BLOCKED];
    if (!allowed.includes(status)) {
      throw new PlanError(
        PLAN_ERROR_CODES.INVALID_OUTCOME,
        `step outcome status must be one of ${allowed.join(', ')}, got ${JSON.stringify(status)}`,
        { stepId },
      );
    }
    const step = findStep(p, stepId);
    const at = now();
    step.status = status;
    // The revision is recorded WITH the outcome: it is how "this failure was
    // later resolved by a revision" is decided, without deleting the failure.
    step.outcome = { status, outcome, error, at, attempt: step.attempts, revision: p.revision };
    p.updatedAt = at;
    p.history.push({ at, type: `plan.step.${status}`, detail: { stepId, attempt: step.attempts, error: error ?? null } });

    // No open steps left: the plan has run out of work.
    if (!openSteps(p).length) {
      const unresolved = unresolvedFailures(p);
      if (unresolved.length) {
        /**
         * A failure in the CURRENT revision, with nothing left to run. The plan
         * is NOT closed here: closing it would make the failure final before the
         * caller has had the chance to revise — and revising is exactly what a
         * failure is for. It stays ACTIVE and awaiting revision; `complete()` is
         * the explicit decision to stop, and the run loop makes it.
         *
         * A failure from an EARLIER revision is resolved: the caller already
         * revised in response to it, so it is history, not an open problem.
         */
        p.history.push({ at, type: 'plan.awaiting_revision', detail: { failedSteps: unresolved.map((candidate) => candidate.id) } });
      } else {
        p.status = PLAN_STATUS.COMPLETE;
        p.completedAt = at;
        p.outcome = { status: p.status, failedSteps: failedSteps(p).map((candidate) => candidate.id), revisions: p.revision - 1 };
        p.history.push({ at, type: 'plan.complete', detail: { steps: p.steps.length, revisions: p.revision - 1 } });
      }
    }
    return step;
  }

  /**
   * Failures this revision did not answer. A step that failed in revision 1 and
   * was superseded by revision 2 is resolved; one that failed in the current
   * revision is not.
   */
  function unresolvedFailures(plan_) {
    const p = requirePlan(plan_);
    return failedSteps(p).filter((step) => (step.outcome?.revision ?? p.revision) >= p.revision);
  }

  /**
   * Should the plan be revised?
   *
   * @returns {{replan: boolean, reason: string}}
   */
  function replanDecision(plan_, detail = {}) {
    const p = requirePlan(plan_);
    if (isTerminal(p)) return { replan: false, reason: `plan is ${p.status}` };
    const failed = failedSteps(p);
    if (!failed.length && !detail.failed) return { replan: false, reason: 'no step has failed' };
    const step = detail.stepId ? p.steps.find((candidate) => candidate.id === detail.stepId) : failed[failed.length - 1];
    if (p.replans >= maxReplans) {
      return { replan: false, reason: `replan budget spent: ${p.replans} of ${maxReplans}` };
    }
    return {
      replan: true,
      reason:
        detail.reason ??
        `step "${step?.id ?? 'unknown'}" failed on attempt ${step?.attempts ?? 0} of ${maxStepAttempts}, and the ` +
          `replan budget allows ${maxReplans - p.replans} more revision(s)`,
    };
  }

  function shouldReplan(plan_, detail = {}) {
    return replanDecision(plan_, detail).replan;
  }

  /**
   * Supersede the remaining steps with a new list. The old ones are marked
   * `skipped` with the reason, never deleted.
   */
  function replan(plan_, { steps, reason = 'replanned', goal = null } = {}) {
    const p = requirePlan(plan_);
    if (isTerminal(p)) {
      throw new PlanError(PLAN_ERROR_CODES.PLAN_TERMINAL, `plan "${p.planId}" is ${p.status} and cannot be revised`, {});
    }
    if (p.replans >= maxReplans) {
      throw new PlanError(
        PLAN_ERROR_CODES.REPLAN_LIMIT,
        `plan "${p.planId}" has already been revised ${p.replans} time(s); the ceiling is ${maxReplans}`,
        { replans: p.replans, maxReplans },
      );
    }

    const offset = p.steps.length;
    const replacement = validateSteps(steps, { offset });
    const at = now();

    for (const step of openSteps(p)) {
      step.status = STEP_STATUS.SKIPPED;
      step.outcome = { status: STEP_STATUS.SKIPPED, reason: `superseded by plan revision ${p.revision + 1}: ${reason}`, at };
      p.history.push({ at, type: 'plan.step.skipped', detail: { stepId: step.id, reason } });
    }

    p.steps.push(...replacement);
    p.revision += 1;
    p.replans += 1;
    p.updatedAt = at;
    if (typeof goal === 'string' && goal.trim()) p.goal = goal.trim();
    p.status = PLAN_STATUS.ACTIVE;
    p.outcome = null;
    p.history.push({
      at,
      type: 'plan.replanned',
      detail: { revision: p.revision, reason, newSteps: replacement.map((step) => step.id) },
    });
    return p;
  }

  function complete(plan_, { status = PLAN_STATUS.COMPLETE, outcome = null } = {}) {
    const p = requirePlan(plan_);
    if (isTerminal(p)) {
      throw new PlanError(PLAN_ERROR_CODES.PLAN_TERMINAL, `plan "${p.planId}" is already ${p.status}`, {});
    }
    if (!TERMINAL_PLAN_STATUSES.includes(status)) {
      throw new PlanError(
        PLAN_ERROR_CODES.INVALID_OUTCOME,
        `complete() takes a terminal plan status (${TERMINAL_PLAN_STATUSES.join(', ')}), got ${JSON.stringify(status)}`,
        {},
      );
    }
    const at = now();
    for (const step of openSteps(p)) {
      step.status = STEP_STATUS.SKIPPED;
      step.outcome = { status: STEP_STATUS.SKIPPED, reason: `plan closed as ${status}`, at };
    }
    p.status = status;
    p.completedAt = at;
    p.updatedAt = at;
    p.outcome = { status, outcome, failedSteps: failedSteps(p).map((step) => step.id) };
    p.history.push({ at, type: `plan.${status}`, detail: { outcome } });
    return p;
  }

  function validateStepsOnly(steps) {
    return validateSteps(steps, { offset: 0 });
  }

  return {
    agentId,
    profile,
    limits: { maxSteps, maxReplans, maxStepAttempts },
    plan,
    nextStep,
    remainingSteps,
    openSteps,
    failedSteps,
    unresolvedFailures,
    recordOutcome,
    shouldReplan,
    replanDecision,
    replan,
    complete,
    isTerminal,
    validateSteps: validateStepsOnly,
    /** Tools this planner may ever write into a plan. */
    planableTools: () => (profile?.tools ?? []).filter((name) => registry.has(name)),
    describe: () => ({
      agentId,
      planableTools: (profile?.tools ?? []).filter((name) => registry.has(name)),
      limits: { maxSteps, maxReplans, maxStepAttempts },
      stepStatuses: Object.values(STEP_STATUS),
      openStepStatuses: [...OPEN_STEP_STATUSES],
      planStatuses: Object.values(PLAN_STATUS),
    }),
  };
}

/** Deep-frozen copy — what gets persisted, traced and asserted against. */
export function snapshotPlan(plan) {
  return deepFreeze(JSON.parse(JSON.stringify(plan)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Compact, human-readable one-liner pair used in traces and reports. */
export function summarizePlan(plan) {
  const steps = plan?.steps ?? [];
  const byStatus = {};
  for (const step of steps) byStatus[step.status] = (byStatus[step.status] ?? 0) + 1;
  return {
    planId: plan?.planId ?? null,
    goal: plan?.goal ?? null,
    status: plan?.status ?? null,
    revision: plan?.revision ?? 0,
    replans: plan?.replans ?? 0,
    steps: steps.length,
    byStatus,
    tools: steps.filter((step) => step.tool).map((step) => step.tool),
  };
}

/** How much of a model reply is scanned for an embedded plan, and how many candidates are tried. */
const PROPOSAL_SCAN = Object.freeze({ maxChars: 200_000, maxBlocks: 16 });

/**
 * Every top-level balanced `{…}` / `[…]` block in `text`, in order, at most
 * `PROPOSAL_SCAN.maxBlocks` of them. One linear pass: string literals and their
 * escapes are skipped, so a brace inside a `"description"` does not end a block,
 * and a mismatched closer abandons the block rather than backtracking.
 */
function* jsonBlocks(text) {
  const closers = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  let yielded = 0;
  for (let i = 0; i < text.length && yielded < PROPOSAL_SCAN.maxBlocks; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && closers.length) {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      if (!closers.length) start = i;
      closers.push(ch === '{' ? '}' : ']');
    } else if ((ch === '}' || ch === ']') && closers.length) {
      if (closers[closers.length - 1] !== ch) {
        closers.length = 0;
        start = -1;
        continue;
      }
      closers.pop();
      if (!closers.length && start >= 0) {
        yielded += 1;
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

/** A value that is recognisably a plan, not merely JSON — used only when scanning prose. */
function isPlanShaped(value) {
  const stepLike = (step) => step !== null && typeof step === 'object' && typeof step.description === 'string';
  if (Array.isArray(value)) return value.length > 0 && value.every(stepLike);
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value.steps)) return value.steps.length > 0 && value.steps.every(stepLike);
    return stepLike(value);
  }
  return false;
}

/** The first plan-shaped JSON block inside prose or a markdown fence, or null. */
function stepsFromText(text) {
  const source = text.length > PROPOSAL_SCAN.maxChars ? text.slice(0, PROPOSAL_SCAN.maxChars) : text;
  for (const block of jsonBlocks(source)) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue; // `[see below]`, `{a plan}` — balanced, but not JSON
    }
    if (isPlanShaped(parsed)) return stepsFromProposal(parsed);
  }
  return null;
}

/**
 * Parse a plan proposal a model produced, tolerating the shapes a model
 * actually emits: `{steps:[...]}`, `[...]`, or a single step object — bare, or
 * (since call 4) wrapped in a markdown fence or a sentence, which is how real
 * models usually answer even when told "reply with JSON only".
 *
 * Returns raw step data for `planner.plan()` to validate — never a plan. That
 * is the whole safety argument for being lenient here: this function only
 * decides what text to LOOK at. Whatever it returns still goes through the
 * planner, which checks every tool against the registry and the agent's
 * allowlist and enforces the step ceiling, so a tolerant parse cannot widen
 * what the agent may do. The scan is one linear pass over at most
 * `PROPOSAL_SCAN.maxChars` characters and tries at most `maxBlocks` candidates.
 */
export function stepsFromProposal(proposal) {
  if (proposal === null || proposal === undefined) return null;
  if (typeof proposal === 'string') {
    try {
      return stepsFromProposal(JSON.parse(proposal));
    } catch {
      return stepsFromText(proposal);
    }
  }
  if (Array.isArray(proposal)) return proposal;
  if (Array.isArray(proposal.steps)) return proposal.steps;
  if (typeof proposal.description === 'string') return [proposal];
  return null;
}
