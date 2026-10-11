/**
 * Run handle — one agent execution, wired to the runtime.
 *
 * Real implementation of the parts of the target pipeline that exist in this
 * call: session identity, the state machine, budgets, goal decomposition
 * (planner), model-window assembly (context manager), five-kind memory, the
 * model call, the tool call (through the executor and therefore through policy
 * and the approval gate), events, traces and the audit row.
 *
 * ├─ WHAT IS HERE ───────────────────────────────────────────────────────────┤
 * │ runModel()      router -> provider -> usage accounting -> events/trace   │
 * │ runTool()       executor -> policy -> approval -> execution -> events    │
 * │ recall()        memory read + `memory.retrieved` event (call 1 shape)    │
 * │ memory          the five-kind interface: working / conversation /        │
 * │                 episodic / semantic / user, each write/recall/list,      │
 * │                 emitting `memory.written` / `memory.retrieved`           │
 * │ planner         goal -> validated steps, backed by the tool registry     │
 * │ plan()          convenience: build a plan for this run's agent           │
 * │ context         the context manager bound to this run's profile + policy │
 * │ buildContext()  assemble a window under an explicit budget               │
 * │ loop({mode})    'model'    the act loop: think -> act -> observe -> repeat│
 * │                 'planned'  plan -> step -> observe -> validate -> replan  │
 * │ finish()        run record + trace + audit row written to the store       │
 * │ pause()         a stop at a HUMAN GATE: run record + trace + audit, the   │
 * │                 status left NON-TERMINAL, the machine left in            │
 * │                 WAITING_FOR_APPROVAL (call 3)                            │
 * │ loop({approvalId})  resume a gated call with a granted approval (call 3)  │
 * ├─ WHAT IS NOT HERE YET ───────────────────────────────────────────────────┤
 * │ Multi-agent hand-off. Memory is exact/latest-wins/keyword retrieval —     │
 * │ there is no vector search anywhere in this repository, and that is stated │
 * │ in src/memory/kinds.mjs rather than implied.                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { createEventBus, EVENT_TYPES } from '../observability/events.mjs';
import { createTraceBuilder, SPAN_TYPES, SPAN_STATUS } from '../observability/traces.mjs';
import { createStateMachine, STATES } from './state-machine.mjs';
import { createBudgetTracker, STOP_REASONS, RECOVERABLE_STOP_REASONS } from './budgets.mjs';
import { resolveEnvelope, mergeTightest } from './envelope.mjs';
import { newId } from '../util/ids.mjs';
import { isModelError, ModelError, MODEL_ERROR_CODES } from '../models/provider.mjs';
import {
  createPlanner,
  snapshotPlan,
  summarizePlan,
  stepsFromProposal,
  STEP_STATUS,
  PLAN_STATUS,
  PLAN_ERROR_CODES,
  PlanError,
} from '../planning/planner.mjs';
import { createContextManager } from '../context/manager.mjs';
import { createKindedMemory, MEMORY_KIND } from '../memory/kinds.mjs';

/**
 * Merge runtime budgets with an agent profile's limits, keeping the TIGHTER
 * value for every ceiling. A profile can restrict a run below the runtime
 * default but can never loosen it: `min` in both directions is what makes
 * "the profile is a further restriction" true rather than aspirational.
 *
 * Since call 4 the result is also held under `HARD_CEILINGS`
 * (`src/runtime/envelope.mjs`): a runtime value above a ceiling — an
 * `AGENT_MAX_ITERATIONS` typo, a programmatic `Infinity` — is clamped, not
 * honoured. `createAgentRun()` itself sizes a run through `resolveEnvelope()`,
 * which applies the same rule and also reports what bound each limit.
 */
export function tightestLimits(runtimeLimits = {}, profileLimits = {}) {
  return mergeTightest(runtimeLimits, profileLimits);
}

/** The terminal state a stop reason maps to. */
export function stateForStopReason(stopReason) {
  if (!stopReason) return STATES.COMPLETED;
  return RECOVERABLE_STOP_REASONS.includes(stopReason.code) ? STATES.REPLANNING : STATES.FAILED;
}

/**
 * Turn a provider failure into a structured stop reason. Both loops use it so a
 * timeout, a malformed answer and an auth failure are reported the same way.
 */
export function modelFailureStopReason(err, observed = 0, extra = {}) {
  if (err?.wallClockExceeded === true) return wallClockStopReason(err, observed);
  return {
    code: isModelError(err) ? err.code : 'MODEL_ERROR',
    message: err?.message ?? String(err),
    limit: null,
    observed,
    scope: 'model',
    recoverable: false,
    evidence: { retryable: err?.retryable ?? false, ...extra },
  };
}

/**
 * The stop reason for a model call that was cut off by the run's own wall-clock
 * budget. It carries the budget's vocabulary (`WALL_CLOCK_TIMEOUT`), not the
 * provider's (`TIMEOUT`): the provider did nothing wrong, the run ran out of time.
 */
export function wallClockStopReason(err, observed = 0) {
  return {
    code: STOP_REASONS.WALL_CLOCK_TIMEOUT,
    message: err?.message ?? 'wall-clock budget exhausted while waiting for the model',
    limit: err?.limit ?? null,
    observed: err?.observed ?? observed,
    scope: 'time',
    recoverable: false,
    evidence: { during: 'model_call' },
  };
}

/** How far past the wall-clock budget a tool timeout may land; see `runTool`. */
const DEADLINE_SLACK_MS = 2;

/**
 * Internal control flow, never an error a caller sees: carries a stop reason out
 * of a `try` block to the `catch` that reports it as a stop (rather than as a
 * planning failure). It cannot escape a loop — every throw site is inside a
 * `try` whose `catch` recognises it.
 */
class LoopStop extends Error {
  constructor(stopReason) {
    super(stopReason?.message ?? 'the loop was stopped');
    this.name = 'LoopStop';
    this.stopReason = stopReason;
  }
}

/**
 * Thrown by `runModel()` when `cancel()` lands while the call is in flight. The
 * loops never see it as a failure: they check the cancellation flag first.
 * Anyone calling `run.runModel()` directly gets a typed error instead of a
 * promise that settles whenever the provider happens to answer.
 */
export class RunCancelledError extends Error {
  constructor(reason = 'the run was cancelled') {
    super(reason);
    this.name = 'RunCancelledError';
    this.code = STOP_REASONS.CANCELLATION_REQUESTED;
  }
}

/**
 * @param {object}   deps
 * @param {object}   deps.runtime       the object returned by createRuntime()
 * @param {string}   deps.agentId
 * @param {string}   [deps.taskType]
 * @param {string}   [deps.sessionId]
 * @param {string}   [deps.runId]
 * @param {string}   [deps.complexity]
 * @param {string}   [deps.preference]
 * @param {string}   [deps.provider]    force a provider (tests, pinned deployments)
 */
export function createAgentRun({
  runtime,
  agentId,
  taskType,
  sessionId = newId('ses'),
  runId = newId('run'),
  complexity = 'low',
  preference = null,
  provider = null,
  mode = 'shadow',
  planning = {},
  contextBudget = {},
  /**
   * Added in call 4. Per-run limits a caller asks for. They may only TIGHTEN
   * (the envelope takes the minimum), and nothing may exceed `HARD_CEILINGS`.
   */
  limits = {},
  /** Added in call 4. Tighten the state machine's transition fuel for this run. */
  maxTransitions = null,
} = {}) {
  const profile = runtime.getAgentProfile(agentId);
  const effectiveTaskType = taskType ?? profile.taskType;
  const effectivePreference = preference ?? runtime.config.providers.preference;

  const events = createEventBus({
    runId,
    sessionId,
    agentId,
    sinks: runtime.eventSinks,
    now: runtime.now,
  });
  const trace = createTraceBuilder({ runId, agentId, now: runtime.now });
  /**
   * Every bound on this run, resolved once: runtime budgets, the profile's own
   * limits and the caller's request, each only able to tighten, all under the
   * hard ceilings. The budget tracker, the planner and the state machine below
   * are sized from THIS object, which is also what `run.envelope` reports — so
   * the envelope a caller is shown is the envelope that is enforced.
   */
  const envelope = resolveEnvelope({
    runtimeLimits: runtime.config.budgets,
    profileLimits: profile.limits,
    request: { ...limits, ...(maxTransitions === null ? {} : { maxTransitions }) },
    planning,
  });
  const budget = createBudgetTracker({
    limits: envelope.limits,
    now: runtime.now,
  });
  const stateMachine = createStateMachine({
    initial: STATES.IDLE,
    now: runtime.now,
    runId,
    maxTransitions: envelope.maxTransitions,
    onTransition: (record) => {
      events.emit(EVENT_TYPES.STATE_CHANGED, {
        from: record.from,
        to: record.to,
        seq: record.seq,
        meta: record.meta ?? {},
      });
    },
  });

  const rootSpanId = trace.startSpan({ name: `run:${agentId}`, type: SPAN_TYPES.RUN });
  const modelCalls = [];
  const toolCalls = [];
  /**
   * The run record is written exactly once — either by `finish()` (a terminal
   * outcome) or by `pause()` (a stop at a human approval gate, which is NOT
   * terminal). One flag for both: writing it twice would leave two contradictory
   * rows for one run in `runs.jsonl`, and `listRuns()` reports the latest row.
   */
  let recorded = false;
  let cancelled = false;
  let cancelReason = null;
  const startedAt = runtime.now();

  /**
   * One abort signal for the whole run. `cancel()` fires it; `runModel()` races
   * it against the provider and hands a derived signal to the provider, and
   * `runTool()` hands it to the executor (so a tool that honours `ctx.signal`
   * hears the cancel).
   */
  const runAbort = new AbortController();

  /**
   * Cancellation.
   *
   * `cancel()` marks the run, fires the run's abort signal and moves the state
   * machine to CANCELLED if it can legally do so.
   *
   *  - A MODEL call in flight is abandoned at once: `runModel()` races the
   *    provider against the signal, so a cancel returns promptly even if the
   *    provider never answers, and a real provider's HTTP request is aborted.
   *  - A TOOL call in flight is NOT interrupted — a plain JS function cannot be
   *    cancelled, and a side effect that has started cannot be un-started. It
   *    finishes, is recorded, and nothing after it runs. That is the honest
   *    limit, not an oversight. Tools that do I/O should honour `ctx.signal`.
   *
   * The loops check the flag after EVERY await, before any further transition or
   * side effect (see `cancelStop`). Before call 4 they checked it only between
   * iterations, so a cancel that landed while a model call was in flight made
   * the next `transition()` throw from a terminal state and the run was never
   * recorded.
   *
   * @param {string} [reason]
   */
  function cancel(reason = 'cancelled by the caller') {
    cancelled = true;
    cancelReason = reason;
    if (!runAbort.signal.aborted) runAbort.abort(new RunCancelledError(reason));
    if (!stateMachine.isTerminal() && stateMachine.can(STATES.CANCELLED)) {
      transition(STATES.CANCELLED, { reason });
    }
    return { cancelled, reason, state: stateMachine.state };
  }

  function cancellationStopReason(observed = 0) {
    return {
      code: STOP_REASONS.CANCELLATION_REQUESTED,
      message: cancelReason ?? 'the run was cancelled',
      limit: null,
      observed,
      scope: 'run',
      recoverable: false,
      evidence: { cancelledBy: 'caller' },
    };
  }

  /**
   * The checkpoint every loop runs after an await, before it touches the state
   * machine or starts a side effect. Returns the stop reason (and records the
   * budget event) when the run has been cancelled in the meantime, else null.
   */
  function cancelStop(turn, extra = {}) {
    if (!cancelled) return null;
    const stopReason = cancellationStopReason(turn);
    events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn, ...extra });
    return stopReason;
  }

  /**
   * The gate every model-calling turn passes BEFORE it counts an iteration:
   * the same question the top of each loop asks (`budget.check()` and the loop's
   * own `maxTurns`), asked at the two planned-loop sites that used to skip it —
   * the plan proposal and a replan. Those made a model call and recorded an
   * iteration with no check in front of them, so an odd `maxIterations` was
   * exceeded by one and a model call was made after the budget was spent.
   */
  function budgetGate(turn, maxTurns, extra = {}) {
    const check = budget.check();
    if (check.exceeded) {
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason: check.stopReason, turn, ...extra });
      return check.stopReason;
    }
    if (turn >= maxTurns) {
      const stopReason = {
        code: STOP_REASONS.ITERATION_BUDGET_EXCEEDED,
        message: `loop reached maxTurns=${maxTurns}`,
        limit: maxTurns,
        observed: turn,
        scope: 'iteration',
        recoverable: false,
        evidence: { ...extra },
      };
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn, ...extra });
      return stopReason;
    }
    return null;
  }

  /**
   * What `loop()` returns when a fault escapes a loop AFTER the run has started.
   *
   * The run is not abandoned: the fault becomes a stop reason, a `run.error`
   * event, and a FAILED machine, so the caller's `finish()` persists the run,
   * its trace and its audit row like any other. (Before call 4 such a fault left
   * events on disk and no run record at all.) A cancelled run reports the
   * cancellation instead, because the fault is then the machine refusing to move
   * out of CANCELLED. Nothing is swallowed silently: the message is on the stop
   * reason and the event.
   */
  function faultOutcome(err) {
    const wasCancelled = cancelled;
    const message = err?.message ?? String(err);
    const code = wasCancelled
      ? STOP_REASONS.CANCELLATION_REQUESTED
      : err?.code === 'TRANSITION_LIMIT'
        ? 'TRANSITION_LIMIT'
        : 'INTERNAL_ERROR';
    const stopReason = wasCancelled
      ? cancellationStopReason(budget.iterations)
      : {
          code,
          message,
          limit: code === 'TRANSITION_LIMIT' ? envelope.maxTransitions : null,
          observed: stateMachine.seq,
          scope: 'runtime',
          recoverable: false,
          evidence: { error: err?.name ?? 'Error', state: stateMachine.state },
        };
    events.emit(EVENT_TYPES.RUN_ERROR, { code, name: err?.name ?? 'Error', message, state: stateMachine.state });
    if (!stateMachine.isTerminal() && stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: code });
    return { finalText: '', turns: budget.iterations, steps: [], stopReason, messages: [], plan: null, context: null, fault: true };
  }

  /**
   * The planner for this run. Bound to the real tool registry and to this run's
   * profile, so it cannot write a step whose tool the executor would refuse.
   */
  const planner = createPlanner({
    registry: runtime.registry,
    profile,
    agentId,
    now: runtime.now,
    maxSteps: envelope.planning.maxSteps,
    maxReplans: envelope.planning.maxReplans,
    maxStepAttempts: envelope.planning.maxStepAttempts,
  });

  /** The context manager for this run: this profile's tools, this policy. */
  const contextManager = createContextManager({
    registry: runtime.registry,
    profile,
    policy: runtime.policy,
    boundaries: runtime.boundaries,
    agentId,
    now: runtime.now,
    budget: contextBudget,
  });

  /**
   * The five-kind memory interface, bound to THIS run's event bus so every
   * write and every retrieval lands in this run's stream — and stamped with
   * this run's ids, so a record is always traceable to the run that wrote it.
   */
  const memoryStore = createKindedMemory({
    store: runtime.runStore.redacting('memory'),
    now: runtime.now,
    emit: (type, payload) => events.emit(type, payload),
  });
  const memory = {
    ...memoryStore,
    kinds: memoryStore.kinds,
    spec: memoryStore.spec,
    retrievalModel: memoryStore.retrievalModel,
    path: memoryStore.path,
    stats: memoryStore.stats,
    forKind: (kind) => {
      const handle = memoryStore.forKind(kind);
      return {
        ...handle,
        write: (record = {}, options = {}) => handle.write(stamp(record), options),
        recall: handle.recall,
        list: handle.list,
      };
    },
    write: (record = {}, options = {}) => memoryStore.write(stamp(record), options),
    recall: memoryStore.recall,
    list: memoryStore.list,
    user: () => memoryStore.forKind(MEMORY_KIND.USER),
    working: () => memoryStore.forKind(MEMORY_KIND.WORKING),
    conversation: () => memoryStore.forKind(MEMORY_KIND.CONVERSATION),
    episodic: () => memoryStore.forKind(MEMORY_KIND.EPISODIC),
    semantic: () => memoryStore.forKind(MEMORY_KIND.SEMANTIC),
  };

  /** Default the run's identity onto a record the caller did not scope itself. */
  function stamp(record = {}) {
    return {
      ...record,
      runId: record.runId ?? runId,
      sessionId: record.sessionId ?? sessionId,
      agentId: record.agentId ?? agentId,
    };
  }

  events.emit(EVENT_TYPES.RUN_STARTED, {
    agentId,
    taskType: effectiveTaskType,
    profile: { id: profile.id, name: profile.name, tools: profile.tools },
    budgets: budget.limits,
    mode,
    prompts: { system: profile.promptPath, guardrail: profile.guardrailPromptPath ?? null },
  });

  /** Transition, or throw if the machine forbids it. */
  function transition(to, meta = {}) {
    return stateMachine.transition(to, meta);
  }

  /**
   * Call a provider under three bounds the provider cannot lift, whatever it does.
   *
   *  - the run's REMAINING wall-clock: a model call may not outlive the run's
   *    budget. Before call 4 the clock was read only between iterations, so one
   *    slow call blew straight through it and a provider that never answered hung
   *    the run — and, behind the HTTP API's run queue, every run after it.
   *  - `cancel()`: a call in flight is abandoned the moment the run is cancelled.
   *  - an abort signal handed to the provider, so a real HTTP request is dropped
   *    rather than left running behind a result nobody will read.
   *
   * The provider's own timeout (30 s / 60 s for the real ones) still applies; this
   * is an additional ceiling, never a longer one — no `timeoutMs` is passed, so
   * nothing a provider defaults to is raised.
   *
   * The abandoned provider promise gets a no-op catch: it may still reject later,
   * and an unhandled rejection must not be able to take the process down.
   */
  async function callProvider(providerInstance, callRequest, routing) {
    if (cancelled) throw new RunCancelledError(cancelReason ?? 'the run was cancelled');
    const limit = budget.limits.wallClockMs;
    const remainingMs = budget.remaining().wallClockMs;
    if (remainingMs <= 0) throw wallClockExpired(limit, budget.elapsedMs(), routing);

    const controller = new AbortController();
    let timer = null;
    let onCancel = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = wallClockExpired(limit, budget.elapsedMs(), routing);
        controller.abort(error);
        reject(error);
      }, Math.max(1, Math.ceil(remainingMs)));
      onCancel = () => {
        const error = new RunCancelledError(cancelReason ?? 'the run was cancelled');
        controller.abort(error);
        reject(error);
      };
      runAbort.signal.addEventListener('abort', onCancel, { once: true });
    });

    let call;
    try {
      call = Promise.resolve(providerInstance.complete({ ...callRequest, signal: controller.signal }));
    } catch (err) {
      call = Promise.reject(err);
    }
    call.catch(() => {});

    try {
      return await Promise.race([call, guard]);
    } finally {
      clearTimeout(timer);
      runAbort.signal.removeEventListener('abort', onCancel);
    }
  }

  function wallClockExpired(limit, observed, routing) {
    const error = new ModelError(
      MODEL_ERROR_CODES.TIMEOUT,
      `the run's wall-clock budget (${limit}ms) ran out while waiting for ${routing?.provider ?? 'the model'}`,
      { provider: routing?.provider ?? null, model: routing?.model ?? null, retryable: false },
    );
    error.wallClockExceeded = true;
    error.limit = limit;
    error.observed = observed;
    return error;
  }

  /**
   * Token accounting trusts the provider's usage report — but a provider that
   * reports none (a custom one, a bug) must not make the token budget a no-op.
   * Only a MISSING report is replaced by an estimate; a reported zero is taken
   * at its word, because that is what the deterministic test double says.
   */
  function usageOrEstimate(completion, messages) {
    const usage = completion?.usage;
    const reported =
      usage !== null &&
      typeof usage === 'object' &&
      ['promptTokens', 'completionTokens', 'totalTokens'].some((key) => Number.isFinite(usage[key]));
    if (reported) return usage;
    const promptTokens = estimateTokens(messages);
    const completionTokens = estimateTokens([{ content: completion?.text ?? '', toolCalls: completion?.toolCalls ?? [] }]);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
  }

  /**
   * Route + call the model, accounting tokens and recording the call.
   *
   * @param {object}   request
   * @param {Array}    request.messages
   * @param {Array}    [request.tools]
   * @param {boolean}  [request.requiresTools]
   * @param {string}   [request.responseFormat]
   */
  async function runModel({ messages, tools = [], requiresTools = tools.length > 0, responseFormat = 'text', complexity: override } = {}) {
    const contextTokens = estimateTokens(messages);
    const routing = runtime.route({
      taskType: effectiveTaskType,
      complexity: override ?? complexity,
      preference: effectivePreference,
      contextTokens,
      requiresTools,
      forcedProvider: provider,
    });

    const providerInstance = runtime.providers.get(routing.provider);
    const spanId = trace.startSpan({
      name: `model:${routing.provider}:${routing.model}`,
      type: SPAN_TYPES.MODEL_CALL,
      parentId: rootSpanId,
      input: { messageCount: messages.length, contextTokens, requiresTools },
    });

    events.emit(EVENT_TYPES.MODEL_CALLED, {
      provider: routing.provider,
      model: routing.model,
      routeId: routing.routeId,
      routeReason: routing.reason,
      mock: providerInstance.capabilities().mock === true,
      messageCount: messages.length,
      estimatedContextTokens: contextTokens,
      toolCount: tools.length,
      responseFormat,
    });

    try {
      const completion = await callProvider(providerInstance, { messages, tools, responseFormat }, routing);
      const usage = usageOrEstimate(completion, messages);
      budget.recordTokens(usage);
      modelCalls.push({
        provider: routing.provider,
        model: routing.model,
        routeId: routing.routeId,
        usage,
        toolCalls: completion.toolCalls.map((call) => call.name),
        at: runtime.now(),
      });
      trace.endSpan(spanId, {
        status: SPAN_STATUS.OK,
        output: { text: completion.text, toolCalls: completion.toolCalls, usage },
      });
      return { completion, routing, usage };
    } catch (err) {
      const isTimeout = err?.code === 'TIMEOUT';
      trace.endSpan(spanId, {
        status: isTimeout ? SPAN_STATUS.ERROR : SPAN_STATUS.ERROR,
        error: err,
      });
      events.emit(EVENT_TYPES.MODEL_FAILED, {
        provider: routing.provider,
        model: routing.model,
        code: isModelError(err) ? err.code : 'UNKNOWN',
        message: err?.message ?? String(err),
        retryable: err?.retryable ?? false,
      });
      throw err;
    }
  }

  /**
   * Run one tool call through the executor.
   * The executor owns validation, policy, the approval gate and timing.
   */
  async function runTool(toolName, args = {}, { untrusted = null, evidence = {}, approvalId = null, toolTimeoutMs } = {}) {
    const call = {
      name: toolName,
      args,
      at: runtime.now(),
    };
    toolCalls.push(call);

    // Every ATTEMPT is charged against `maxToolCalls`, not only the calls that get
    // as far as the executor's budget step. A call that fails schema validation, or
    // names a tool that does not exist, never reaches that step — so before call 4 a
    // single completion carrying thousands of invalid calls was ground through in
    // full while the tool-call budget counted zero (measured: 10 000 recorded
    // attempts, budget 0, stopped only by the iteration budget). The attempt ledger
    // is `toolCalls`, which already holds this call; the (N+1)th attempt is refused,
    // recorded, and stops the loop exactly as the executor's own budget refusal does.
    const attemptLimit = budget.limits.maxToolCalls;
    if (toolCalls.length > attemptLimit) {
      const stopReason = {
        code: STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED,
        message: `tool-call budget exhausted: ${toolCalls.length} attempts exceed ${attemptLimit} (a call that fails validation or is refused still counts as an attempt)`,
        limit: attemptLimit,
        observed: toolCalls.length,
        scope: 'tool',
        recoverable: false,
        evidence: { attempts: toolCalls.length, executed: budget.toolCalls, tool: toolName },
      };
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, tool: toolName });
      trace.recordSpan({
        name: `tool:${toolName}`,
        type: SPAN_TYPES.TOOL_CALL,
        parentId: rootSpanId,
        input: args,
        status: SPAN_STATUS.BLOCKED,
        output: { status: 'BUDGET_EXCEEDED', attempts: toolCalls.length },
      });
      return Object.freeze({
        status: 'BUDGET_EXCEEDED',
        ok: false,
        executed: false,
        finishedAt: runtime.now(),
        runId,
        sessionId,
        agentId,
        toolName,
        args,
        startedAt: call.at,
        durationMs: 0,
        tool: toolName,
        policy: null,
        approval: null,
        result: null,
        error: { code: stopReason.code, message: stopReason.message, stopReason },
      });
    }

    // The trace records the whole pipeline for this call: the proposal, the
    // policy verdict that gated it, and the result — so a finished run can be
    // read as "what was asked, what was decided, what happened".
    const spanId = trace.startSpan({
      name: `tool:${toolName}`,
      type: SPAN_TYPES.TOOL_CALL,
      parentId: rootSpanId,
      input: args,
    });

    // A tool is never given longer than the run has left. The executor's own
    // precedence (per-call, then the tool's declaration, then its default) is
    // untouched; a per-call value is only ever passed here when it is TIGHTER
    // than the one that would have applied.
    //
    // The bound is `remaining + DEADLINE_SLACK_MS`, not `remaining`: a Node timer
    // can fire a millisecond EARLY relative to `Date.now()`, which would leave the
    // budget check reading "199 of 200ms used" and let the stop reason depend on
    // a race. With the slack the timeout can only fire once the budget is spent,
    // so it is the budget check that reports the stop, deterministically. The
    // run overruns its budget by at most the slack.
    const effectiveTimeoutMs = toolTimeoutMs ?? runtime.registry.get(toolName)?.timeoutMs ?? runtime.executor.defaultTimeoutMs;
    const boundMs = Math.max(1, Math.ceil(budget.remaining().wallClockMs)) + DEADLINE_SLACK_MS;
    const boundedTimeoutMs = Number.isFinite(effectiveTimeoutMs) && boundMs < effectiveTimeoutMs ? boundMs : toolTimeoutMs;

    const result = await runtime.executor.execute({
      toolName,
      args,
      profile,
      agentId,
      runId,
      sessionId,
      untrusted,
      evidence,
      // The calls made BEFORE this one: the rate-limit rule's contract is "N
      // already recorded, so the next may not run". `toolCalls` already holds the
      // call under evaluation (pushed above, so a denied call is still on the
      // run's record), and handing that over made the rule count it twice —
      // `maxToolCalls: N` executed N-1 calls, and `maxToolCalls: 1` executed none.
      history: { toolCalls: toolCalls.slice(0, -1) },
      limits: budget.limits,
      approvalId,
      budget,
      signal: runAbort.signal,
      toolTimeoutMs: boundedTimeoutMs,
      // The executor is shared by every run, so the run hands in ITS bus: the
      // events of this tool call must land in this run's stream.
      events,
    });

    if (result.policy) {
      trace.recordSpan({
        name: `policy:${result.policy.rule}`,
        type: SPAN_TYPES.POLICY_CHECK,
        parentId: spanId,
        output: { decision: result.policy.decision, reason: result.policy.reason },
        status:
          result.policy.decision === 'DENY'
            ? SPAN_STATUS.BLOCKED
            : result.policy.decision === 'REQUIRE_APPROVAL'
              ? SPAN_STATUS.PENDING
              : SPAN_STATUS.OK,
      });
    }
    trace.recordSpan({
      name: `result:${toolName}`,
      type: SPAN_TYPES.TOOL_RESULT,
      parentId: spanId,
      output: result.ok ? result.result : result.error,
      status: result.ok ? SPAN_STATUS.OK : SPAN_STATUS.ERROR,
      durationMs: result.durationMs,
    });
    trace.endSpan(spanId, {
      status: result.ok ? SPAN_STATUS.OK : result.status === 'APPROVAL_REQUIRED' ? SPAN_STATUS.PENDING : SPAN_STATUS.ERROR,
      output: { status: result.status },
    });

    return result;
  }

  /** Memory read, with the event and trace span the pipeline expects. */
  function recall(query = {}) {
    const spanId = trace.startSpan({
      name: 'memory.retrieve',
      type: SPAN_TYPES.MEMORY_RETRIEVAL,
      parentId: rootSpanId,
      input: query,
    });
    /**
     * A memory read must never take a run down. The call-1 store reads from
     * disk and can throw (a mangled path, a permission problem); if it does, the
     * run records that retrieval was unavailable and carries on with no
     * records — the structured form of the same failure is
     * `run.memory.recall()`, which returns `{ ok: false, error }`.
     */
    let records = [];
    let corruptLines = 0;
    let error = null;
    try {
      const outcome = runtime.memory.recall(query);
      records = outcome.records;
      corruptLines = outcome.corruptLines;
    } catch (err) {
      error = { code: 'MEMORY_STORE_READ_FAILED', message: err?.message ?? String(err), name: err?.name ?? 'Error' };
      events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'memory_retrieval_failed', error });
    }
    events.emit(EVENT_TYPES.MEMORY_RETRIEVED, {
      query,
      count: records.length,
      keys: records.map((record) => record.key),
      corruptLines,
      ok: error === null,
      error,
    });
    trace.endSpan(spanId, {
      status: error ? SPAN_STATUS.ERROR : SPAN_STATUS.OK,
      output: { count: records.length, error },
    });
    return records;
  }

  function remember(input) {
    const record = runtime.memory.remember({ ...input, runId, agentId });
    events.emit(EVENT_TYPES.MEMORY_WRITTEN, { key: record.key, scope: record.scope, memoryId: record.memoryId });
    return record;
  }

  /**
   * Assemble the model window through the context manager.
   *
   * Used by both loops when the caller hands in structured material (`task`,
   * `conversation`, `memory`, `documents`, `plan`, `toolResults`) instead of an
   * already-assembled `systemPrompt`/`userMessage` pair. The tool list is the
   * assembled one — never the caller's — so a caller cannot widen it.
   *
   * @param {object} request  see `createContextManager().build()`
   */
  function buildContext(request = {}) {
    const spanId = trace.startSpan({
      name: 'context.build',
      type: SPAN_TYPES.CONTEXT,
      parentId: rootSpanId,
      input: {
        task: request.task ?? null,
        conversation: request.conversation?.length ?? 0,
        memory: request.memory?.length ?? 0,
        documents: request.documents?.length ?? 0,
        hasPlan: Boolean(request.plan),
        toolResults: request.toolResults?.length ?? 0,
      },
    });
    const assembled = contextManager.build(request);
    trace.endSpan(spanId, {
      status: assembled.budgetReport.overBudget ? SPAN_STATUS.ERROR : SPAN_STATUS.OK,
      output: {
        droppedCount: assembled.droppedCount,
        compressed: assembled.compressed,
        usedTokens: assembled.budgetReport.usedTokens,
        overBudget: assembled.budgetReport.overBudget,
        tools: assembled.budgetReport.tools.accepted,
        droppedForOverflow: assembled.budgetReport.dropped.map((item) => item.id),
      },
    });
    return assembled;
  }

  /**
   * Resolve the window and tool list both loops start from.
   *
   * `userMessage` keeps the call-1 contract byte-for-byte. When it is absent
   * and a `task` is supplied, the window is assembled by the context manager
   * instead, and an over-budget assembly is a refusal (CONTEXT_OVERFLOW) rather
   * than a truncated prompt sent to a model.
   */
  function resolveWindow({ systemPrompt = null, userMessage = null, task = null, context = {}, tools = null }) {
    if (typeof userMessage === 'string' && userMessage.length) {
      return {
        messages: [
          { role: 'system', content: systemPrompt ?? '' },
          { role: 'user', content: userMessage },
        ],
        toolDefinitions: tools ?? runtime.registry.toModelTools({ names: profile.tools }),
        assembled: null,
        overflow: null,
      };
    }

    const assembled = buildContext({ ...context, task: task ?? '', systemPrompt });
    const overflow = assembled.budgetReport.overBudget
      ? {
          code: STOP_REASONS.CONTEXT_OVERFLOW,
          message:
            `context overflow: the assembled window needs ${assembled.budgetReport.usedCharacters} characters but the ` +
            `budget allows ${assembled.budgetReport.budget.maxCharacters} (over by ${assembled.budgetReport.exceededBy})`,
          limit: assembled.budgetReport.budget.maxCharacters,
          observed: assembled.budgetReport.usedCharacters,
          scope: 'context',
          recoverable: false,
          evidence: { overBudget: true, protectedKinds: ['policy_constraints', 'task'] },
        }
      : null;
    return {
      messages: assembled.messages,
      toolDefinitions: tools ?? assembled.tools,
      assembled,
      overflow,
    };
  }

  /** The act loop: think -> act -> observe -> repeat, model-driven. */
  async function modelLoop({
    systemPrompt = null,
    userMessage = null,
    task = null,
    context = {},
    tools = null,
    maxTurns = budget.limits.maxIterations,
    untrusted = null,
    evidence = {},
    responseFormat = 'json',
    /**
     * Added in call 3. A previously granted approval id. The executor checks it
     * against the tool name AND an argument fingerprint, so passing one that
     * does not match the re-proposed call is not an override — the call simply
     * pauses again, bound to the arguments it is actually making. `null` (the
     * default) is byte-for-byte the call-1 behaviour.
     */
    approvalId = null,
  }) {
    const window = resolveWindow({ systemPrompt, userMessage, task, context, tools });
    if (window.overflow) {
      events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'context_overflow', ...window.overflow.evidence });
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason: window.overflow, turn: 0 });
      return { finalText: '', turns: 0, steps: [], stopReason: window.overflow, messages: window.messages, context: window.assembled };
    }
    const toolDefinitions = window.toolDefinitions;
    const messages = window.messages;

    transition(STATES.UNDERSTANDING);
    transition(STATES.PLANNING);

    let turn = 0;
    let finalText = '';
    let stopReason = null;
    const steps = [];

    while (turn < maxTurns) {
      if (cancelled) {
        stopReason = cancellationStopReason(turn);
        events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn });
        break;
      }
      const preCheck = budget.check();
      if (preCheck.exceeded) {
        stopReason = preCheck.stopReason;
        events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn });
        break;
      }

      turn += 1;
      budget.recordIteration({ turn });
      transition(STATES.EXECUTING);

      let modelResult;
      try {
        modelResult = await runModel({
          messages,
          tools: toolDefinitions,
          requiresTools: toolDefinitions.length > 0,
          responseFormat,
        });
      } catch (err) {
        // A cancel that lands during the call is a cancellation, not a model failure.
        if ((stopReason = cancelStop(turn))) break;
        stopReason =
          err?.wallClockExceeded === true
            ? wallClockStopReason(err, turn)
            : {
                code: isModelError(err) ? err.code : 'MODEL_ERROR',
                message: err?.message ?? String(err),
                limit: null,
                observed: turn,
                scope: 'model',
                recoverable: false,
                evidence: { provider: provider ?? 'routed' },
              };
        if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: stopReason.code });
        break;
      }
      // …and an answer that arrives after the cancel is dropped, before it can
      // move the machine or start a tool.
      if ((stopReason = cancelStop(turn))) break;

      const { completion, routing } = modelResult;
      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });

      if (!completion.toolCalls.length) {
        finalText = completion.text;
        steps.push({ turn, kind: 'final', text: completion.text });
        transition(STATES.OBSERVING);
        transition(STATES.VALIDATING, { valid: true });
        break;
      }

      transition(STATES.WAITING_FOR_TOOL);

      let toolBlocked = null;
      let lastObservation = null;
      for (const call of completion.toolCalls) {
        const result = await runTool(call.name, call.arguments, { untrusted, evidence, approvalId });
        lastObservation = observeToolCall({ call, turn, result, messages, steps });
        // The call has finished and is on record. If the run was cancelled while
        // it ran, nothing after it may: not the next call in this turn, and not a
        // transition out of CANCELLED.
        if (cancelled) break;

        if (result.status === 'APPROVAL_REQUIRED') {
          transition(STATES.WAITING_FOR_APPROVAL, { approvalStatus: 'pending' });
          toolBlocked = { kind: 'approval', result };
          break;
        }
        if (result.status === 'POLICY_DENIED') {
          transition(STATES.BLOCKED, { reason: result.error?.rule ?? 'policy_denied' });
          toolBlocked = { kind: 'policy_denied', result };
          break;
        }
        if (result.status === 'BUDGET_EXCEEDED') {
          stopReason = result.error?.stopReason ?? {
            code: STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED,
            message: 'tool budget exceeded',
            recoverable: false,
          };
          events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, tool: call.name });
          break;
        }
      }

      if (stopReason) break;
      if (cancelled) {
        // Cancelled from a synchronous hook during the tool calls above. The
        // machine is already terminal, so no further transition is attempted.
        stopReason = cancellationStopReason(turn);
        events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn });
        break;
      }
      if (toolBlocked) {
        // The run stops here and reports why. Resuming is a new call with an
        // approvalId — never an automatic retry.
        steps.push({
          turn,
          kind: 'blocked',
          blockedBy: toolBlocked.kind,
          detail: toolBlocked.result.error?.message ?? null,
          approvalId: toolBlocked.result.approval?.approvalId ?? null,
        });
        finalText = completion.text;
        break;
      }

      transition(STATES.OBSERVING, { toolResult: lastObservation });
      transition(STATES.REPLANNING);
    }

    if (!stopReason && turn >= maxTurns) {
      stopReason = {
        code: STOP_REASONS.ITERATION_BUDGET_EXCEEDED,
        message: `loop reached maxTurns=${maxTurns}`,
        limit: maxTurns,
        observed: turn,
        scope: 'iteration',
        recoverable: false,
        evidence: {},
      };
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason });
    }

    return { finalText, turns: turn, steps, stopReason, messages, context: window.assembled ?? null };
  }

  /**
   * Shared bookkeeping for one tool call inside a loop iteration.
   *
   * Returns the observation message that belongs in the transcript, and records
   * the step entry. Kept in one place so the model loop and the planned loop
   * cannot drift apart in *what a blocked tool call means*.
   */
  function observeToolCall({ call, turn, result, messages, steps, stepId = null }) {
    messages.push({
      role: 'tool',
      toolCallId: call.id ?? `call_${turn}_${call.name}`,
      name: call.name,
      content: JSON.stringify({
        status: result.status,
        result: result.result,
        error: result.error,
        policy: result.policy ? { decision: result.policy.decision, rule: result.policy.rule } : null,
        approval: result.approval,
      }),
      isError: !result.ok,
    });
    const entry = {
      turn,
      kind: 'tool',
      tool: call.name,
      status: result.status,
      durationMs: result.durationMs,
      policyDecision: result.policy?.decision ?? null,
      approvalId: result.approval?.approvalId ?? null,
    };
    if (stepId) entry.stepId = stepId;
    steps.push(entry);
    return { tool: call.name, status: result.status };
  }

  /** Every legal way back into EXECUTING, kept inside the guarded table. */
  function enterExecuting(meta = {}) {
    if (stateMachine.is(STATES.EXECUTING)) return;
    if (stateMachine.is(STATES.PLANNING)) return void transition(STATES.EXECUTING, meta);
    if (stateMachine.is(STATES.VALIDATING)) {
      return void transition(STATES.EXECUTING, { valid: true, moreSteps: true, ...meta });
    }
    if (stateMachine.is(STATES.OBSERVING)) {
      transition(STATES.VALIDATING, { valid: true });
      return void transition(STATES.EXECUTING, { valid: true, moreSteps: true, ...meta });
    }
    if (stateMachine.is(STATES.REPLANNING)) {
      transition(STATES.PLANNING, meta);
      return void transition(STATES.EXECUTING, meta);
    }
    return void transition(STATES.EXECUTING, meta);
  }

  /**
   * Move to VALIDATING from wherever a plan step finished, along the legal
   * path only: a step that ran no tool is still in EXECUTING, and the table
   * requires OBSERVING in between. Returns true when VALIDATING was reached.
   */
  function enterValidating(meta = {}) {
    if (stateMachine.is(STATES.EXECUTING)) transition(STATES.OBSERVING, { phase: 'step-complete' });
    if (stateMachine.is(STATES.WAITING_FOR_TOOL)) transition(STATES.OBSERVING, { toolResult: { status: 'unknown' } });
    if (stateMachine.is(STATES.OBSERVING)) {
      transition(STATES.VALIDATING, meta);
      return true;
    }
    return stateMachine.is(STATES.VALIDATING);
  }

  /**
   * The planned loop: decompose the goal, then run the plan step by step —
   * execute, observe, validate, replan — until the plan is finished or a budget
   * refuses to continue.
   *
   * Guarantees, all of them enforced rather than assumed:
   *   - every iteration is counted against the iteration budget and checked
   *     against the wall-clock, token and tool budgets BEFORE anything runs;
   *   - every tool call goes through `runTool()`, so the executor's loop
   *     detection, policy gate and approval gate all still apply;
   *   - a replan can only happen `planner.limits.maxReplans` times, and a step
   *     only `maxStepAttempts` times;
   *   - an over-budget context is a refusal, not a truncated prompt.
   */
  async function plannedLoop({
    plan: suppliedPlan = null,
    steps = null,
    goal = null,
    systemPrompt = null,
    userMessage = null,
    task = null,
    context = {},
    tools = null,
    maxTurns = budget.limits.maxIterations,
    untrusted = null,
    evidence = {},
    responseFormat = 'json',
    replanSteps = null,
    contextBudget: budgetOverride = null,
    /** A previously granted approval id; see `modelLoop`. */
    approvalId = null,
  }) {
    const window = resolveWindow({ systemPrompt, userMessage, task, context: budgetOverride ? { ...context, budget: budgetOverride } : context, tools });
    if (window.overflow) {
      events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'context_overflow', ...window.overflow.evidence });
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason: window.overflow, turn: 0 });
      return { finalText: '', turns: 0, steps: [], stopReason: window.overflow, messages: window.messages, plan: null, context: window.assembled };
    }
    const toolDefinitions = window.toolDefinitions;
    const messages = window.messages;

    transition(STATES.UNDERSTANDING);
    transition(STATES.PLANNING);

    const planSpanId = trace.startSpan({ name: 'plan', type: SPAN_TYPES.PLAN, parentId: rootSpanId, input: { goal: goal ?? task ?? null } });

    let turn = 0;
    let finalText = '';
    let stopReason = null;
    const stepsTaken = [];
    let plan = suppliedPlan;
    let planError = null;

    const effectiveGoal = goal ?? task ?? (typeof userMessage === 'string' ? userMessage : null) ?? 'complete the task';

    // --- obtain a plan -----------------------------------------------------
    if (!plan) {
      try {
        if (Array.isArray(steps) && steps.length) {
          plan = planner.plan({ goal: effectiveGoal, steps });
        } else {
          // Ask the model to decompose the goal. Whatever it proposes is
          // validated against the registry and the profile before it becomes a
          // plan, so a proposal naming an unauthorised tool is a refused plan.
          const refused = cancelStop(turn, { phase: 'planning' }) ?? budgetGate(turn, maxTurns, { phase: 'planning' });
          if (refused) throw new LoopStop(refused);
          turn += 1;
          budget.recordIteration({ turn, phase: 'planning' });
          const proposalResult = await runModel({
            messages: [
              ...messages,
              {
                role: 'user',
                content:
                  `Decompose this goal into an ordered plan of at most ${planner.limits.maxSteps} steps. ` +
                  `You may only name these tools: ${(profile.tools ?? []).join(', ') || 'none'}. ` +
                  'Reply with JSON only: {"steps":[{"id":"step-1","description":"...","tool":"tool_name_or_omit","args":{}}]}.',
              },
            ],
            tools: toolDefinitions,
            requiresTools: false,
            responseFormat: 'json',
          });
          messages.push({ role: 'assistant', content: proposalResult.completion.text });
          const proposed = stepsFromProposal(proposalResult.completion.text);
          if (!proposed) {
            planError = new PlanError(PLAN_ERROR_CODES.NO_STEPS, 'the model proposed no parseable plan steps');
          } else {
            plan = planner.plan({ goal: effectiveGoal, steps: proposed });
          }
        }
      } catch (err) {
        planError = err;
      }
    }

    // A budget or a cancel that refused the proposal turn is a stop, not a plan
    // error — and so is a cancel that landed while the proposal was in flight.
    if (planError instanceof LoopStop || (planError && cancelled)) {
      stopReason = planError instanceof LoopStop ? planError.stopReason : cancelStop(turn, { phase: 'planning' });
      trace.endSpan(planSpanId, { status: SPAN_STATUS.BLOCKED, output: { stopReason: stopReason.code } });
      return { finalText: '', turns: turn, steps: stepsTaken, stopReason, messages, plan: null, planSummary: null, context: window.assembled };
    }

    if (planError) {
      const code = planError.code ?? 'PLAN_ERROR';
      const reason = planError.message ?? String(planError);
      events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'plan_rejected', code, message: reason });
      stopReason =
        planError.wallClockExceeded === true
          ? wallClockStopReason(planError, turn)
          : { code, message: reason, limit: null, observed: turn, scope: 'planning', recoverable: false, evidence: {} };
      trace.endSpan(planSpanId, { status: SPAN_STATUS.BLOCKED, error: planError });
      // A rejected plan cannot be validated or revised: it was refused. The
      // machine goes straight to FAILED, which every pre-terminal state allows.
      if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: code });
      return { finalText: '', turns: turn, steps: stepsTaken, stopReason, messages, plan: plan ?? null, planSummary: plan ? summarizePlan(plan) : null, context: window.assembled };
    }

    // --- run the plan ------------------------------------------------------
    while (turn < maxTurns) {
      if (cancelled) {
        stopReason = cancellationStopReason(turn);
        events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn, plan: plan.planId });
        break;
      }
      const preCheck = budget.check();
      if (preCheck.exceeded) {
        stopReason = preCheck.stopReason;
        events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn, plan: plan.planId });
        break;
      }

      const step = planner.nextStep(plan);

      // No step left: the plan has run out of work. A plan with no open steps
      // that is not COMPLETE ended in a failure the caller chose not to revise
      // (see the planner's `recordOutcome`), so it is reported as one.
      if (!step) {
        if (plan.status !== PLAN_STATUS.COMPLETE) {
          const failed = planner.failedSteps(plan).map((candidate) => candidate.id);
          stopReason = {
            code: 'PLAN_FAILED',
            message: `plan ${plan.planId} ended FAILED with unresolved step(s): ${failed.join(', ')}`,
            limit: planner.limits.maxStepAttempts,
            observed: turn,
            scope: 'planning',
            recoverable: false,
            evidence: { failedSteps: failed },
          };
          events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'plan_failed', failedSteps: failed });
          // A plan with unresolved failures is terminal: FAILED is reachable
          // from every pre-terminal state, and VALIDATING is not (PLANNING has
          // no edge to it).
          if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: 'PLAN_FAILED' });
          break;
        }

        turn += 1;
        budget.recordIteration({ turn, phase: 'synthesis' });
        enterExecuting({ phase: 'synthesis' });
        try {
          const synthesis = await runModel({ messages, tools: [], requiresTools: false, responseFormat });
          if (!cancelled) {
            finalText = synthesis.completion.text || finalText;
            if (finalText) messages.push({ role: 'assistant', content: finalText });
          }
        } catch (err) {
          if ((stopReason = cancelStop(turn, { phase: 'synthesis' }))) break;
          stopReason = modelFailureStopReason(err, turn);
          if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: stopReason.code });
          break;
        }
        if ((stopReason = cancelStop(turn, { phase: 'synthesis' }))) break;
        stepsTaken.push({ turn, kind: 'final', text: finalText });
        enterValidating({ valid: true });
        // `VALIDATING -> COMPLETED` is guarded on `meta.valid`: pass the guard
        // it requires rather than relying on `can()` having said yes.
        if (stateMachine.can(STATES.COMPLETED, { valid: true })) {
          transition(STATES.COMPLETED, { reason: 'plan completed', valid: true });
        }
        break;
      }

      turn += 1;
      budget.recordIteration({ turn, stepId: step.id, tool: step.tool ?? null, description: step.description });
      enterExecuting({ turn, stepId: step.id });

      const stepSpanId = trace.startSpan({
        name: `plan.step:${step.id}`,
        type: SPAN_TYPES.PLAN_STEP,
        parentId: planSpanId,
        input: { description: step.description, tool: step.tool, args: step.args, attempt: step.attempts },
      });

      let stepOk = true;
      let stepError = null;
      let blocked = null;

      if (step.tool) {
        transition(STATES.WAITING_FOR_TOOL);
        const result = await runTool(step.tool, step.args ?? {}, { untrusted, evidence, approvalId });
        const observation = observeToolCall({
          call: { id: `plan_${step.id}_${turn}`, name: step.tool },
          turn,
          result,
          messages,
          steps: stepsTaken,
          stepId: step.id,
        });

        if (result.status === 'APPROVAL_REQUIRED') {
          blocked = { kind: 'approval', result };
        } else if (result.status === 'POLICY_DENIED') {
          blocked = { kind: 'policy_denied', result };
        } else if (result.status === 'BUDGET_EXCEEDED') {
          stopReason = result.error?.stopReason ?? {
            code: STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED,
            message: 'tool budget exceeded',
            recoverable: false,
          };
          events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, tool: step.tool });
        } else {
          stepOk = result.ok;
          if (!result.ok) stepError = result.error ?? { message: 'the tool did not succeed' };
        }

        if (!stopReason && !blocked && !cancelled) {
          transition(STATES.OBSERVING, { toolResult: observation });
        }
        if (cancelled) {
          stopReason = cancellationStopReason(turn);
          events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn, stepId: step.id });
        }
      } else {
        // A step with no tool: one model turn against the step's instruction.
        try {
          const stepTurn = await runModel({
            messages: [...messages, { role: 'user', content: `Execute plan step ${step.index + 1}: ${step.description}` }],
            tools: toolDefinitions,
            responseFormat,
          });

          if (cancelled) {
            // The answer arrived after the cancel: it is dropped, and it must not
            // start a tool. The stop is recorded below with the step's outcome.
            stopReason = cancelStop(turn, { stepId: step.id });
          } else {
            messages.push({ role: 'assistant', content: stepTurn.completion.text, toolCalls: stepTurn.completion.toolCalls });

            if (stepTurn.completion.toolCalls.length) {
              transition(STATES.WAITING_FOR_TOOL);
              for (const call of stepTurn.completion.toolCalls) {
                const result = await runTool(call.name, call.arguments, { untrusted, evidence, approvalId });
                const observation = observeToolCall({ call, turn, result, messages, steps: stepsTaken, stepId: step.id });
                if (result.status === 'APPROVAL_REQUIRED') {
                  blocked = { kind: 'approval', result };
                  break;
                }
                if (result.status === 'POLICY_DENIED') {
                  blocked = { kind: 'policy_denied', result };
                  break;
                }
                if (result.status === 'BUDGET_EXCEEDED') {
                  // A budget refusal is a STOP, as it is in the model loop and in a
                  // tool step: the rest of this turn's calls are not processed.
                  stopReason = result.error?.stopReason ?? {
                    code: STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED,
                    message: 'tool budget exceeded',
                    recoverable: false,
                  };
                  events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, tool: call.name });
                  break;
                }
                if (!result.ok) {
                  stepOk = false;
                  stepError = result.error ?? { message: 'a tool call inside the step did not succeed' };
                } else if (!cancelled && stateMachine.is(STATES.WAITING_FOR_TOOL)) {
                  // ONE observation per turn, however many calls it carried.
                  // Before call 4 this transition ran per call, so a second call
                  // asked for OBSERVING -> OBSERVING and failed the whole run
                  // with a misleading MODEL_ERROR after both tools had executed.
                  transition(STATES.OBSERVING, { toolResult: observation });
                }
                if (cancelled) {
                  stopReason = cancellationStopReason(turn);
                  events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, turn, stepId: step.id });
                  break;
                }
              }
            } else if (stepTurn.completion.text) {
              finalText = stepTurn.completion.text;
            }
          }
        } catch (err) {
          // A cancel that lands during the call falls through to the stop handling below.
          if (!(stopReason = cancelStop(turn, { stepId: step.id }))) {
            stopReason = modelFailureStopReason(err, turn);
            trace.endSpan(stepSpanId, { status: SPAN_STATUS.ERROR, error: err });
            if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: stopReason.code });
            break;
          }
        }
      }

      if (stopReason) {
        try {
          planner.recordOutcome(plan, step.id, { status: STEP_STATUS.BLOCKED, outcome: { status: 'budget' }, error: stopReason });
        } catch { /* the plan may already be closed; the stop reason is what matters */ }
        trace.endSpan(stepSpanId, { status: SPAN_STATUS.BLOCKED, output: { status: 'BUDGET_EXCEEDED' } });
        break;
      }

      if (blocked) {
        const blockedStatus = STEP_STATUS.BLOCKED;
        try {
          planner.recordOutcome(plan, step.id, {
            status: blockedStatus,
            outcome: { status: blocked.result.status },
            error: blocked.result.error ?? null,
          });
        } catch { /* already closed */ }
        trace.endSpan(stepSpanId, {
          status: blocked.kind === 'approval' ? SPAN_STATUS.PENDING : SPAN_STATUS.BLOCKED,
          output: { status: blocked.result.status, rule: blocked.result.error?.rule ?? null },
        });
        stepsTaken.push({
          turn,
          kind: 'blocked',
          stepId: step.id,
          blockedBy: blocked.kind,
          detail: blocked.result.error?.message ?? null,
          approvalId: blocked.result.approval?.approvalId ?? null,
        });
        finalText = finalText || '';
        if (blocked.kind === 'approval') {
          transition(STATES.WAITING_FOR_APPROVAL, { approvalStatus: 'pending' });
        } else {
          transition(STATES.BLOCKED, { reason: blocked.result.error?.rule ?? 'policy_denied' });
        }
        break;
      }

      planner.recordOutcome(plan, step.id, {
        status: stepOk ? STEP_STATUS.DONE : STEP_STATUS.FAILED,
        outcome: { status: stepOk ? 'ok' : 'failed' },
        error: stepError,
      });
      trace.endSpan(stepSpanId, {
        status: stepOk ? SPAN_STATUS.OK : SPAN_STATUS.ERROR,
        output: { status: stepOk ? 'done' : 'failed', attempt: step.attempts },
      });

      if (stepOk) {
        const more = planner.nextStep(plan) !== null;
        enterValidating({ valid: true, moreSteps: more, stepId: step.id });
        continue;
      }

      // --- a failed step: replan, or stop ---------------------------------
      const decision = planner.replanDecision(plan, { stepId: step.id, reason: `step "${step.id}" failed` });
      enterValidating({ valid: false, stepId: step.id });
      if (!decision.replan) {
        stopReason = {
          code: 'STEP_FAILED',
          message: `step "${step.id}" (${step.description}) failed and no further revision is allowed: ${decision.reason}`,
          limit: planner.limits.maxReplans,
          observed: turn,
          scope: 'planning',
          recoverable: false,
          evidence: { stepId: step.id, error: stepError },
        };
        events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'step_failed', stepId: step.id, detail: decision.reason });
        transition(STATES.REPLANNING, { reason: decision.reason });
        try {
          planner.complete(plan, { status: PLAN_STATUS.FAILED, outcome: { reason: decision.reason } });
        } catch { /* already terminal */ }
        if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: 'STEP_FAILED' });
        break;
      }

      transition(STATES.REPLANNING, { reason: decision.reason });
      try {
        let replacement = null;
        if (typeof replanSteps === 'function') {
          replacement = replanSteps(plan, step, { turn, reason: decision.reason, error: stepError });
        } else if (Array.isArray(replanSteps) && replanSteps.length) {
          replacement = replanSteps;
        } else {
          // A replan is a model call AND an iteration, so it passes the same gate
          // as every other turn — before it is counted, not after.
          const refused = cancelStop(turn, { phase: 'replan' }) ?? budgetGate(turn, maxTurns, { phase: 'replan', plan: plan.planId });
          if (refused) throw new LoopStop(refused);
          turn += 1;
          budget.recordIteration({ turn, phase: 'replan', failedStepId: step.id });
          const request = await runModel({
            messages: [
              ...messages,
              {
                role: 'user',
                content:
                  `Plan step ${step.index + 1} ("${step.description}") failed: ${stepError?.message ?? 'unknown error'}. ` +
                  `Propose replacement steps to still reach the goal. You may only name these tools: ` +
                  `${(profile.tools ?? []).join(', ') || 'none'}. Reply with JSON only: {"steps":[{"id":"step-x",...}]}.`,
              },
            ],
            tools: toolDefinitions,
            requiresTools: false,
            responseFormat: 'json',
          });
          messages.push({ role: 'assistant', content: request.completion.text });
          replacement = stepsFromProposal(request.completion.text);
          // A cancel that landed during the call: drop the proposal.
          if (cancelled) throw new LoopStop(cancelStop(turn, { phase: 'replan' }));
        }

        if (!replacement || !replacement.length) {
          throw new PlanError(PLAN_ERROR_CODES.NO_STEPS, 'no replacement steps were proposed');
        }
        plan = planner.replan(plan, { steps: replacement, reason: decision.reason });
        transition(STATES.PLANNING, { revision: plan.revision });
        // The next iteration's `enterExecuting()` moves PLANNING -> EXECUTING,
        // so the guarded table stays the only way to change state.
      } catch (err) {
        const stop = err instanceof LoopStop ? err.stopReason : cancelled ? cancelStop(turn, { phase: 'replan' }) : null;
        if (stop) {
          // A budget or a cancel, not a planning failure: report it as itself.
          // The plan is closed out below like any plan left open by a stop, and
          // the machine is left for `finish()` to settle, as at the top of the loop.
          stopReason = stop;
          break;
        }
        const code = err?.code ?? 'REPLAN_FAILED';
        events.emit(EVENT_TYPES.VALIDATION_FAILED, { reason: 'replan_rejected', code, message: err?.message ?? String(err) });
        stopReason =
          err?.wallClockExceeded === true
            ? wallClockStopReason(err, turn)
            : {
                code,
                message: err?.message ?? String(err),
                limit: planner.limits.maxReplans,
                observed: turn,
                scope: 'planning',
                recoverable: false,
                evidence: { stepId: step.id },
              };
        try {
          planner.complete(plan, { status: PLAN_STATUS.FAILED, outcome: { reason: code } });
        } catch { /* already terminal */ }
        if (stateMachine.can(STATES.FAILED)) transition(STATES.FAILED, { reason: code });
        break;
      }
    }

    if (!stopReason && turn >= maxTurns) {
      stopReason = {
        code: STOP_REASONS.ITERATION_BUDGET_EXCEEDED,
        message: `planned loop reached maxTurns=${maxTurns}`,
        limit: maxTurns,
        observed: turn,
        scope: 'iteration',
        recoverable: false,
        evidence: { planId: plan.planId, stepsRemaining: planner.remainingSteps(plan).length },
      };
      events.emit(EVENT_TYPES.BUDGET_STOPPED, { stopReason, plan: plan.planId });
    }

    // A plan left open by a budget stop is closed out, so the persisted plan is
    // never ambiguous about whether it finished.
    if (!planner.isTerminal(plan)) {
      try {
        planner.complete(plan, {
          status: stopReason ? PLAN_STATUS.FAILED : PLAN_STATUS.COMPLETE,
          outcome: { reason: stopReason?.code ?? null },
        });
      } catch { /* already terminal */ }
    }

    const summary = summarizePlan(plan);
    trace.endSpan(planSpanId, {
      status: stopReason ? SPAN_STATUS.BLOCKED : SPAN_STATUS.OK,
      output: summary,
    });

    return {
      finalText,
      turns: turn,
      steps: stepsTaken,
      stopReason,
      messages,
      plan,
      planSummary: summary,
      context: window.assembled,
    };
  }

  /**
   * The arm's-length loop. `mode: 'model'` (default) follows the model's own
   * tool calls; `mode: 'planned'` decomposes the goal first and runs the plan.
   */
  async function loop(request = {}) {
    const mode = request.mode ?? 'model';
    if (mode !== 'planned' && mode !== 'plan' && mode !== 'model') {
      throw new TypeError(`loop: unknown mode "${mode}" (known: model, planned)`);
    }
    try {
      return mode === 'model' ? await modelLoop(request) : await plannedLoop(request);
    } catch (err) {
      // A fault BEFORE the run left IDLE is a caller error — a bad argument, a
      // window that could not be assembled — and is thrown, as it always was.
      // A fault after that is a run fault: contain it, record it, close it.
      if (stateMachine.is(STATES.IDLE)) throw err;
      return faultOutcome(err);
    }
  }

  /**
   * Close the run: terminal state, run record, trace and audit row.
   *
   * @param {object} [options]
   * @param {string} [options.status]   COMPLETED | FAILED | BLOCKED | CANCELLED
   * @param {object} [options.output]
   * @param {string} [options.reason]
   */
  function finish({ status = STATES.COMPLETED, output = null, reason = null } = {}) {
    if (recorded) return runtime.runStore.getRun(runId);
    recorded = true;

    const terminal = [STATES.COMPLETED, STATES.FAILED, STATES.BLOCKED, STATES.CANCELLED].includes(status)
      ? status
      : STATES.COMPLETED;
    if (stateMachine.state !== terminal) {
      // Allow the terminal move from wherever the loop left the machine, but
      // only through the declared table — never by assigning state directly.
      //
      // `VALIDATING -> COMPLETED` is guarded on `meta.valid`, and a run that
      // reaches VALIDATING and then reports itself COMPLETED has, by definition,
      // validated. Passing the guard explicitly is what makes a finished run sit
      // in a terminal state instead of stopping one move short of one.
      const guardMeta = terminal === STATES.COMPLETED ? { reason, valid: true } : { reason };
      if (stateMachine.can(terminal, guardMeta)) transition(terminal, guardMeta);
    }

    const finishedAt = runtime.now();
    const summary = {
      runId,
      sessionId,
      agentId,
      taskType: effectiveTaskType,
      mode,
      status: terminal,
      reason,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      budgets: budget.snapshot(),
      modelCalls,
      toolCalls: toolCalls.map((call) => call.name),
      stateHistory: stateMachine.history.map((entry) => `${entry.from}->${entry.to}`),
      output,
      traceRoot: trace.getSpan(rootSpanId)?.name ?? null,
    };

    trace.endSpan(rootSpanId, {
      status: terminal === STATES.COMPLETED ? SPAN_STATUS.OK : terminal === STATES.BLOCKED ? SPAN_STATUS.BLOCKED : SPAN_STATUS.ERROR,
      output: { status: terminal, reason },
    });

    events.emit(EVENT_TYPES.RUN_FINISHED, summary);

    runtime.runStore.startRun({
      runId,
      sessionId,
      agentId,
      taskType: effectiveTaskType,
      mode,
      startedAt,
      startedIso: new Date(startedAt).toISOString(),
    });
    runtime.runStore.finishRun(summary);
    runtime.runStore.appendTrace({ runId, agentId, trace: trace.toJSON() });
    runtime.audit.write({
      type: 'run.finished',
      runId,
      sessionId,
      agentId,
      ts: finishedAt,
      iso: new Date(finishedAt).toISOString(),
      status: terminal,
      reason,
      durationMs: finishedAt - startedAt,
      toolCalls: summary.toolCalls,
      modelCalls: modelCalls.map((call) => `${call.provider}:${call.model}`),
    });

    return summary;
  }

  /**
   * Record a run that stopped at a HUMAN GATE without finishing.
   *
   * Added in call 3. `finish()` is the wrong writer for this case twice over: it
   * coerces any status outside its terminal list to COMPLETED, and it ends the
   * root span as an error. A run waiting for an approval has neither happened.
   * So `pause()` writes the run row with the NON-TERMINAL status the state
   * machine is actually in, `phase: 'paused'`, the pending approval's id, the
   * trace, and an audit row — and leaves the machine where it is, so a caller can
   * still cancel it (`POST /api/runtime/runs/:id/cancel`) or resume the decision
   * as a new run.
   *
   * A paused run is not a third kind of run. It is the same run record with a
   * non-terminal status, which is exactly what `listRuns()` and
   * `isTerminalRunStatus()` are written to handle.
   *
   * @param {object} [options]
   * @param {string} [options.reason]       why it stopped (a stop reason code)
   * @param {string} [options.approvalId]   the pending approval a human must act on
   * @param {object} [options.output]        whatever was decided before the pause
   * @returns {object} the persisted (non-terminal) run record
   */
  function pause({ reason = null, approvalId = null, output = null } = {}) {
    if (recorded) return runtime.runStore.getRun(runId);
    recorded = true;

    const pausedAt = runtime.now();
    const summary = {
      runId,
      sessionId,
      agentId,
      taskType: effectiveTaskType,
      mode,
      status: stateMachine.state,
      terminal: false,
      reason,
      approvalId,
      startedAt,
      pausedAt,
      pausedIso: new Date(pausedAt).toISOString(),
      durationMs: pausedAt - startedAt,
      budgets: budget.snapshot(),
      modelCalls,
      toolCalls: toolCalls.map((call) => call.name),
      stateHistory: stateMachine.history.map((entry) => `${entry.from}->${entry.to}`),
      output,
      traceRoot: trace.getSpan(rootSpanId)?.name ?? null,
    };

    events.emit(EVENT_TYPES.RUN_PAUSED, summary);
    // PENDING, not OK and not ERROR: the run is waiting, and the span says so.
    trace.endSpan(rootSpanId, {
      status: SPAN_STATUS.PENDING,
      output: { status: summary.status, reason, approvalId },
    });

    runtime.runStore.startRun({
      runId,
      sessionId,
      agentId,
      taskType: effectiveTaskType,
      mode,
      startedAt,
      startedIso: new Date(startedAt).toISOString(),
    });
    runtime.runStore.append('runs', { ...summary, phase: 'paused' });
    runtime.runStore.appendTrace({ runId, agentId, trace: trace.toJSON() });
    runtime.audit.write({
      type: 'run.paused',
      runId,
      sessionId,
      agentId,
      ts: pausedAt,
      iso: new Date(pausedAt).toISOString(),
      status: summary.status,
      reason,
      approvalId,
      durationMs: pausedAt - startedAt,
      toolCalls: summary.toolCalls,
      modelCalls: modelCalls.map((call) => `${call.provider}:${call.model}`),
    });

    return summary;
  }

  return {
    runId,
    sessionId,
    agentId,
    profile,
    taskType: effectiveTaskType,
    events,
    trace,
    budget,
    /**
     * Every bound on this run and what set it (call 4): the budget limits, the
     * planner ceilings and the state machine's transition fuel, each with the
     * layer that bound it. This is the envelope that is ENFORCED — the budget
     * tracker, planner and machine were sized from this very object.
     */
    envelope,
    stateMachine,
    /** Goal decomposition, bound to this run's registry + profile. */
    planner,
    /** Model-window assembly, bound to this run's profile + policy. */
    context: contextManager,
    /** The five-kind memory interface, bound to this run's event bus. */
    memory,
    get state() {
      return stateMachine.state;
    },
    get toolCalls() {
      return [...toolCalls];
    },
    get modelCalls() {
      return [...modelCalls];
    },
    transition,
    runModel,
    runTool,
    recall,
    remember,
    /** Cooperative cancellation: the loops stop at the next iteration. */
    cancel,
    get cancelled() {
      return cancelled;
    },
    /** Build a plan for this agent. Throws a PlanError if a step is not plannable. */
    plan({ goal, steps }) {
      return planner.plan({ goal, steps, agentId });
    },
    /** Assemble a model window under an explicit budget (see src/context/manager.mjs). */
    buildContext,
    loop,
    /** The call-1 model loop, unchanged in behaviour, addressable by name. */
    modelLoop,
    /** The planned loop, addressable without going through `mode`. */
    plannedLoop,
    /** Frozen, JSON-safe copy of a plan — what gets persisted and asserted. */
    snapshotPlan,
    finish,
    /**
     * Record a stop at a human gate WITHOUT ending the run (call 3). The state
     * machine stays in WAITING_FOR_APPROVAL; the run row is non-terminal.
     */
    pause,
    /** Re-derive expected values for a proposed action through the policy kernel. */
    evaluateAction(action, evidence = {}, untrusted = null) {
      const spanId = trace.startSpan({
        name: `policy:action:${action ?? 'none'}`,
        type: SPAN_TYPES.POLICY_CHECK,
        parentId: rootSpanId,
        input: { action, evidence },
      });
      const verdict = runtime.policy.evaluate({
        kind: 'action',
        runId,
        sessionId,
        agentId,
        profile,
        action,
        evidence,
        untrusted,
        history: { toolCalls },
        now: runtime.now(),
      });
      /**
       * An action verdict is a control decision, so it leaves the same record a
       * tool verdict does. Call 1 evaluated actions without emitting anything,
       * which meant the enforcement that matters most — "this disposition was
       * refused" — left no trace in the event stream or the audit.
       */
      events.emit(EVENT_TYPES.POLICY_DECIDED, {
        kind: 'action',
        action,
        decision: verdict.decision,
        rule: verdict.rule,
        kindLabel: verdict.kind,
        reason: verdict.reason,
        evidence: verdict.evidence,
        firedRules: verdict.firedRules,
      });
      trace.endSpan(spanId, {
        status:
          verdict.decision === 'DENY'
            ? SPAN_STATUS.BLOCKED
            : verdict.decision === 'REQUIRE_APPROVAL'
              ? SPAN_STATUS.PENDING
              : SPAN_STATUS.OK,
        output: { decision: verdict.decision, rule: verdict.rule, reason: verdict.reason },
      });
      return verdict;
    },
  };
}

/** Rough token estimate: 4 characters per token. No tokeniser dependency. */
export function estimateTokens(messages) {
  let characters = 0;
  for (const message of messages ?? []) {
    characters += String(message.content ?? '').length;
    for (const call of message.toolCalls ?? []) characters += JSON.stringify(call.arguments ?? {}).length + call.name.length;
  }
  return Math.ceil(characters / 4);
}
