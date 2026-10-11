/**
 * Run endpoints — the only place a run is started, listed, cancelled and read.
 *
 * ┌─ what makes a run started here REAL ──────────────────────────────────────┐
 * │ The provider is the deterministic double (or a configured live one).      │
 * │ Everything around it is the runtime: the state machine, the budget        │
 * │ tracker, the tool registry, the executor (validation -> policy -> gate -> │
 * │ execute), the approval manager, the JSONL stores, the event stream, the   │
 * │ trace and the audit writer. The API does not shortcut any of it, and it   │
 * │ does not synthesise a decision: it reports the one the run reached.       │
 * │                                                                            │
 * │ Where the *proposal* comes from when the provider is the mock is stated   │
 * │ where it is decided (`src/api/offline.mjs`) and repeated in every response │
 * │ as `scriptedBy`.                                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Two properties worth knowing before reading the code:
 *
 * 1. **Runs are serialised.** The mock provider is a single shared double whose
 *    script is instance state, so two runs in flight would overwrite each
 *    other's script. Every run start therefore goes through one queue. A live
 *    provider has no such constraint, but the queue is kept for both: it also
 *    makes the audit trail of an operator console strictly sequential.
 * 2. **A run that pauses is not finished.** `run.pause()` records it with a
 *    non-terminal status, so `GET /runs/:id` can show it waiting and
 *    `POST /runs/:id/cancel` has something to cancel. Resuming means a NEW run
 *    that carries the granted `approvalId` back into the same tool call.
 */

import { API_ERROR_CODES, apiError } from '../errors.mjs';
import { PROVIDER_IDS } from '../../config/index.mjs';
import { HARD_CEILINGS } from '../../runtime/envelope.mjs';
import { STATES } from '../../runtime/state-machine.mjs';
import { parseDecision, terminalStatusFor } from '../../agents/index.mjs';
import { buildOfflinePlan, validateScriptAgainstSchemas } from '../offline.mjs';
import {
  serializeApproval,
  serializeRunSummary,
  serializeTrace,
  stateTimelineFrom,
  policyDecisionsFrom,
  toolCallsFrom,
  pendingApprovalIdFrom,
  isTerminalRunStatus,
} from '../serialize.mjs';

/** Longest accepted `input`, characters. The body limit is the real ceiling. */
export const MAX_INPUT_CHARS = 60_000;
/** Default page size for `GET /runs`. */
export const DEFAULT_RUN_LIMIT = 50;
export const MAX_RUN_LIMIT = 500;

/** Where a provider's credential comes from, for a clear failure message. */
const PROVIDER_ENV = Object.freeze({
  mock: null,
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'LOCAL_MODEL_BASE_URL',
});

export function createRunsHandler({ runtime, now = () => Date.now() }) {
  /**
   * Runs that are currently executing in this process, keyed by run id.
   *
   * A run is addressable here for the whole time its loop is in flight, before
   * its first row is persisted. That is what makes `POST /runs/:id/cancel`
   * meaningful: the loops check the cancellation flag between iterations, so a
   * cancel raised while a run is in flight stops it at the next step. It cannot
   * interrupt a model or tool call already dispatched — plain JS functions are
   * not cancellable — which is stated in `src/runtime/run.mjs` and in the
   * handover, not hidden.
   */
  const active = new Map();

  /** One queue for the whole process: see the module docstring, point 1. */
  let tail = Promise.resolve();
  function exclusive(work) {
    const result = tail.then(work, work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function requireAgent(agentId) {
    if (typeof agentId !== 'string' || !agentId) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, 'an agent id is required');
    }
    if (!runtime.listAgents().includes(agentId)) {
      throw apiError(
        API_ERROR_CODES.UNKNOWN_AGENT,
        `unknown agent "${agentId}" (known: ${runtime.listAgents().join(', ')})`,
        { agentId, known: runtime.listAgents() },
      );
    }
    return agentId;
  }

  /**
   * Resolve `body.provider`.
   *
   * A provider id that is known but has no credential/endpoint is a hard
   * failure with a structured error: this API never substitutes a mock for a
   * real provider, because a caller who asked for a live model and silently got
   * a scripted double would draw confident conclusions from a fixture.
   */
  function resolveProvider(requested) {
    const fallback = runtime.config.providers.defaultProvider;
    if (requested === undefined || requested === null || requested === '') return fallback;
    if (typeof requested !== 'string') {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`provider` must be a string');
    }
    if (!PROVIDER_IDS.includes(requested)) {
      throw apiError(
        API_ERROR_CODES.UNKNOWN_PROVIDER,
        `unknown provider "${requested}" (known: ${PROVIDER_IDS.join(', ')})`,
        { provider: requested, known: PROVIDER_IDS },
      );
    }
    if (!runtime.providers.isAvailable(requested)) {
      throw apiError(
        API_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        `provider "${requested}" is registered but not configured, so this run cannot use it. ` +
          `Set ${PROVIDER_ENV[requested] ?? 'the provider configuration'} and restart the server; ` +
          'this API will not substitute a mock for a live provider.',
        {
          provider: requested,
          envVar: PROVIDER_ENV[requested] ?? null,
          // Constants are safe here: the value of a field named `somethingKey`
          // would be blanked by redact(), so the credential names live in
          // `envVar` and the booleans are keyed by provider id.
          configured: {
            openai: runtime.config.providers.openai.apiKeyPresent,
            anthropic: runtime.config.providers.anthropic.apiKeyPresent,
            local: runtime.config.providers.local.configured,
          },
        },
      );
    }
    return requested;
  }

  /** `planning` accepts 'model' | 'planned' | an object; see the handover. */
  function planningOptions(planning) {
    if (planning === undefined || planning === null) return { mode: 'model', steps: null, limits: {} };
    if (typeof planning === 'string') {
      if (!['model', 'planned'].includes(planning)) {
        throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`planning` string must be "model" or "planned"');
      }
      return { mode: planning, steps: null, limits: {} };
    }
    if (typeof planning !== 'object' || Array.isArray(planning)) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`planning` must be "model", "planned" or an object');
    }
    const mode = planning.mode ?? 'model';
    if (!['model', 'planned'].includes(mode)) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`planning.mode` must be "model" or "planned"');
    }
    if (planning.steps !== undefined && planning.steps !== null && !Array.isArray(planning.steps)) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`planning.steps` must be an array of steps');
    }
    const limits = {};
    for (const key of ['maxSteps', 'maxReplans', 'maxStepAttempts']) {
      if (planning[key] !== undefined && planning[key] !== null) {
        if (!Number.isInteger(planning[key]) || planning[key] < 1) {
          throw apiError(API_ERROR_CODES.INVALID_REQUEST, `\`planning.${key}\` must be a positive integer`);
        }
        // A ceiling a caller can set to a billion is not a ceiling. The hard
        // ceiling is a code constant; a request may lower a planner ceiling or
        // move it inside that, never past it.
        if (planning[key] > HARD_CEILINGS[key]) {
          throw apiError(
            API_ERROR_CODES.INVALID_REQUEST,
            `\`planning.${key}\` is ${planning[key]}, above the hard ceiling of ${HARD_CEILINGS[key]}`,
            { key, value: planning[key], ceiling: HARD_CEILINGS[key] },
          );
        }
        limits[key] = planning[key];
      }
    }
    return { mode, steps: planning.steps ?? null, limits };
  }

  function validateStartBody(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, 'the request body must be a JSON object');
    }
    const { input } = body;
    if (typeof input !== 'string' || !input.trim()) {
      throw apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        '`input` is required and must be a non-empty string: it is the payload or task the agent runs against',
      );
    }
    if (input.length > MAX_INPUT_CHARS) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, `\`input\` exceeds ${MAX_INPUT_CHARS} characters`, {
        length: input.length,
        limit: MAX_INPUT_CHARS,
      });
    }
    return input;
  }

  /** `GET /api/runtime/runs` */
  function list({ query }) {
    const limit = readLimit(query);
    const persisted = runtime.runStore.listRuns().map(serializeRunSummary);
    const inFlight = [...active.values()].map((entry) => ({
      runId: entry.run.runId,
      sessionId: entry.run.sessionId,
      agentId: entry.run.agentId,
      taskType: entry.run.taskType,
      mode: null,
      phase: 'running',
      status: entry.run.state,
      terminal: false,
      reason: null,
      startedAt: entry.startedAt,
      startedIso: new Date(entry.startedAt).toISOString(),
      finishedAt: null,
      finishedIso: null,
      durationMs: now() - entry.startedAt,
      toolCalls: entry.run.toolCalls.map((call) => call.name),
      modelCalls: [],
      traceRoot: null,
      budgets: entry.run.budget.snapshot(),
      live: true,
    }));
    let runs = [...inFlight, ...persisted].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (typeof query.agentId === 'string' && query.agentId) {
      runs = runs.filter((run) => run.agentId === query.agentId);
    }
    const total = runs.length;
    if (limit !== null) runs = runs.slice(0, limit);
    return {
      status: 200,
      body: {
        count: runs.length,
        total,
        limit,
        storageDir: runtime.storageDir,
        runs,
        note:
          'A run is persisted when it finishes or pauses. `phase: "running"` means it is in flight in this ' +
          'process right now; a paused run reports its non-terminal status and is cancellable.',
      },
    };
  }

  function readLimit(query) {
    if (query.limit === undefined || query.limit === '') return DEFAULT_RUN_LIMIT;
    const parsed = Number.parseInt(String(query.limit), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_RUN_LIMIT) {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, `\`limit\` must be an integer between 1 and ${MAX_RUN_LIMIT}`, {
        limit: query.limit,
      });
    }
    return parsed;
  }

  /** Everything known about one run: the row, the events, the verdicts, the trace. */
  function detail({ params }) {
    const runId = params.id;
    const record = runtime.runStore.getRun(runId);
    const live = active.get(runId);
    if (!record && !live) {
      throw apiError(API_ERROR_CODES.UNKNOWN_RUN, `no run "${runId}" has been persisted`, { runId });
    }

    const events = runtime.runStore.runEvents(runId);
    const approvals = runtime.runStore
      .listApprovals()
      .filter((approval) => approval.runId === runId)
      .map(serializeApproval);
    const traceRecord = runtime.runStore.getTrace(runId);
    const auditRows = runtime.runStore
      .readAudit()
      .records.filter((row) => row.runId === runId)
      .map((row) => ({ type: row.type, ts: row.ts, iso: row.iso, reason: row.reason ?? null, status: row.status ?? null }));

    const summary = record ? serializeRunSummary(record) : serializeRunSummary(liveRunRow(live));
    const output = record?.output ?? null;
    const decision = output && typeof output === 'object' && typeof output.action === 'string' ? output : null;

    return {
      status: 200,
      body: {
        run: summary,
        live: Boolean(live && !record),
        decision,
        output: decision ? null : output,
        stateHistory: record?.stateHistory ?? [],
        stateTimeline: stateTimelineFrom(events),
        policyDecisions: policyDecisionsFrom(events),
        toolCalls: toolCallsFrom(events),
        approvals,
        approvalsHistory: approvals.length
          ? runtime.runStore
              .approvalHistory(approvals[0].approvalId)
              .map((row) => ({ status: row.status, resolvedAt: row.resolvedAt ?? null, resolvedBy: row.resolvedBy ?? null, resolutionNote: row.resolutionNote ?? null }))
          : [],
        pendingApprovalId: record?.approvalId ?? pendingApprovalIdFrom(events, approvals),
        audit: auditRows,
        trace: serializeTrace(traceRecord, { full: true }),
        eventCount: events.length,
      },
    };
  }

  /** A live run, shaped like a persisted row so one projection serves both. */
  function liveRunRow(entry) {
    if (!entry) return null;
    return {
      runId: entry.run.runId,
      sessionId: entry.run.sessionId,
      agentId: entry.run.agentId,
      taskType: entry.run.taskType,
      phase: 'running',
      status: entry.run.state,
      startedAt: entry.startedAt,
    };
  }

  /** `GET /api/runtime/runs/:id/events` */
  function events({ params }) {
    const runId = params.id;
    if (!runtime.runStore.getRun(runId) && !active.has(runId)) {
      throw apiError(API_ERROR_CODES.UNKNOWN_RUN, `no run "${runId}" has been persisted`, { runId });
    }
    const rows = runtime.runStore.runEvents(runId);
    return {
      status: 200,
      body: {
        runId,
        count: rows.length,
        events: rows,
        note:
          'Events are read back from data/state/runs/run-events.jsonl in append order (the bus `seq` is monotonic), ' +
          'and every payload was redacted before it was written.',
      },
    };
  }

  /**
   * `POST /api/runtime/runs/:id/cancel`
   *
   * Two cases, both real: a run in flight in this process (the loop stops at its
   * next iteration) and a PAUSED run (the persisted row becomes CANCELLED). A
   * terminal run is a conflict, not a no-op.
   */
  function cancel({ params, body }) {
    const runId = params.id;
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'cancelled by an operator';

    const live = active.get(runId);
    if (live) {
      const outcome = live.run.cancel(reason);
      return {
        status: 200,
        body: {
          cancelled: true,
          runId,
          live: true,
          state: outcome.state,
          reason,
          note: 'the run is in flight in this process; its loop stops at the next iteration, and a call already dispatched finishes',
        },
      };
    }

    const record = runtime.runStore.getRun(runId);
    if (!record) {
      throw apiError(API_ERROR_CODES.UNKNOWN_RUN, `no run "${runId}" has been persisted`, { runId });
    }
    if (isTerminalRunStatus(record.status)) {
      throw apiError(
        API_ERROR_CODES.RUN_NOT_CANCELLABLE,
        `run "${runId}" is ${record.status} and cannot be cancelled`,
        { runId, status: record.status },
      );
    }

    const cancelledAt = now();
    const next = {
      ...record,
      status: STATES.CANCELLED,
      phase: 'cancelled',
      terminal: true,
      cancelledAt,
      cancelledIso: new Date(cancelledAt).toISOString(),
      cancelReason: reason,
    };
    runtime.runStore.append('runs', next);
    runtime.audit.write({
      type: 'run.cancelled',
      runId,
      sessionId: record.sessionId ?? null,
      agentId: record.agentId ?? null,
      ts: cancelledAt,
      iso: new Date(cancelledAt).toISOString(),
      status: STATES.CANCELLED,
      reason,
      transitionedFrom: record.status,
    });

    return {
      status: 200,
      body: {
        cancelled: true,
        runId,
        live: false,
        state: STATES.CANCELLED,
        reason,
        transitionedFrom: record.status,
        run: serializeRunSummary(next),
        note:
          'a paused run is a persisted row, so cancelling it appends a CANCELLED row and an audit entry; ' +
          'nothing was executing at the time',
      },
    };
  }

  /**
   * `POST /api/runtime/agents/:id/runs`
   *
   * @returns {{status: number, body: object}} 201 with the run's identity, final
   *   (or paused) state, the decision the run reached and the policy verdict on
   *   that decision.
   */
  function start({ params, body }) {
    const agentId = requireAgent(params.id);
    const input = validateStartBody(body);
    const provider = resolveProvider(body.provider);
    const planning = planningOptions(body.planning);

    if (body.taskType !== undefined && body.taskType !== null && typeof body.taskType !== 'string') {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`taskType` must be a string');
    }
    if (body.sessionId !== undefined && body.sessionId !== null && typeof body.sessionId !== 'string') {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`sessionId` must be a string');
    }
    if (body.approvalId !== undefined && body.approvalId !== null && typeof body.approvalId !== 'string') {
      throw apiError(API_ERROR_CODES.INVALID_REQUEST, '`approvalId` must be a string');
    }

    let approvalId = null;
    if (typeof body.approvalId === 'string' && body.approvalId) {
      const known = runtime.approvals.get(body.approvalId);
      if (!known) {
        throw apiError(API_ERROR_CODES.UNKNOWN_APPROVAL, `no approval "${body.approvalId}"`, { approvalId: body.approvalId });
      }
      approvalId = body.approvalId;
    }

    // Built OUTSIDE the run queue: it only reads the dataset and renders a
    // prompt, and a failure here must never surface as a runnable-but-broken run.
    const plan = buildOfflinePlan({ runtime, agentId, input, mode: planning.mode });
    const scriptCheck = validateScriptAgainstSchemas(runtime, plan.script);
    if (!scriptCheck.ok) {
      // A scripted call that would be refused by its own schema is a bug in the
      // offline fixture layer. Fail loudly instead of running a doomed run.
      throw apiError(API_ERROR_CODES.INTERNAL, 'the offline fixture produced a tool call its own schema refuses', {
        problems: scriptCheck.problems,
      });
    }

    return exclusive(async () => {
      const run = runtime.createRun({
        agentId,
        taskType: body.taskType ?? undefined,
        provider,
        sessionId: body.sessionId ?? undefined,
        planning: planning.limits,
      });

      if (provider === 'mock') runtime.mockProvider.reset({ script: plan.script });
      active.set(run.runId, { run, startedAt: now() });

      try {
        const plannedMode = planning.mode === 'planned';
        const outcome = await run.loop({
          mode: planning.mode,
          systemPrompt: plan.inputs.systemPrompt ?? null,
          userMessage: plan.inputs.userMessage ?? null,
          task: plan.inputs.task ?? null,
          // A caller-supplied plan wins; otherwise the offline fixture's own
          // derivation of the steps for this case.
          steps: plannedMode ? planning.steps ?? plan.steps ?? null : null,
          untrusted: plan.inputs.untrusted ?? null,
          evidence: plan.inputs.evidence ?? {},
          responseFormat: 'json',
          approvalId,
        });

        const decision = parseDecision(outcome.finalText);
        const verdict =
          decision?.action !== undefined && decision?.action !== null
            ? run.evaluateAction(decision.action, plan.inputs.evidence ?? {}, plan.inputs.untrusted ?? null)
            : null;

        const pendingApproval =
          runtime.approvals.listPending().find((approval) => approval.runId === run.runId) ?? null;
        const paused = run.state === STATES.WAITING_FOR_APPROVAL;

        const record = paused
          ? run.pause({
              reason: outcome.stopReason?.code ?? 'APPROVAL_REQUIRED',
              approvalId: pendingApproval?.approvalId ?? null,
              output: decision ?? null,
            })
          : run.finish({
              status: terminalStatusFor(run, outcome),
              output: decision ?? outcome.finalText ?? null,
              reason: outcome.stopReason?.code ?? null,
            });

        const capabilities = runtime.providers.get(provider).capabilities();

        return {
          status: 201,
          body: {
            runId: record.runId,
            state: run.state,
            status: record.status,
            terminal: !paused,
            paused,
            run: serializeRunSummary(record),
            agentId,
            provider,
            providerIsMock: capabilities.mock === true,
            providerDeterministic: capabilities.deterministic === true,
            mode: planning.mode,
            scriptedBy: capabilities.mock === true ? plan.scriptedBy : null,
            resumedWithApprovalId: approvalId,
            pendingApprovalId: record.approvalId ?? pendingApproval?.approvalId ?? null,
            decision,
            policyDecision: verdict
              ? { decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, evidence: verdict.evidence }
              : null,
            toolCalls: record.toolCalls ?? [],
            turns: outcome.turns,
            stopReason: outcome.stopReason ?? null,
            matchedDatasetCase: plan.matchedCaseIndex === null ? null : plan.matchedCaseIndex + 1,
            evidence: plan.inputs.evidence ?? {},
            notes: plan.notes,
            offlineNote:
              capabilities.mock === true
                ? 'provider "mock" is a deterministic test double: the PROPOSAL came from the fixture named in ' +
                  '`scriptedBy`, while the state machine, tool executor, policy kernel, approval gate and stores ' +
                  'are the real runtime. This run says nothing about how a live model behaves.'
                : null,
          },
        };
      } finally {
        active.delete(run.runId);
      }
    });
  }

  return { start, list, detail, events, cancel, active };
}

export default createRunsHandler;
