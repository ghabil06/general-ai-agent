/**
 * Response projections for the runtime API.
 *
 * Real implementation, and deliberately the ONLY module that decides what a
 * client sees. Every handler returns one of these shapes, and every shape is
 * built from what the runtime actually recorded — a persisted run row, a
 * persisted event, a persisted approval, the live tool registry. Nothing here
 * invents a field that the runtime did not produce.
 *
 * Two rules this module exists to keep:
 *
 * 1. **A response is a projection, not a copy.** A run row carries the trace
 *    root, the budget snapshot and the model calls; the detail view carries the
 *    decision, the timeline and the policy verdicts. Handing a client the raw
 *    internal object would couple the API contract to internal field names, so
 *    each view names its fields explicitly.
 * 2. **The trace is summarised, never dumped.** A trace tree is a tree of spans
 *    with inputs and outputs; the detail view reports each span as
 *    `{ name, type, status, durationMs, childCount }` and keeps the full tree
 *    available under `trace.full` for a client that wants it (the console shows
 *    it behind a collapsed `<details>`).
 */

import { BOUNDARIES, REAL_ACCOUNT_NAMES } from '../config/agents.mjs';
import { loadAgent } from '../agents/index.mjs';
import { ESCALATION_TOOL, FIXTURE_AGENTS } from '../evaluation/runner.mjs';
import { TERMINAL_STATES } from '../runtime/state-machine.mjs';
import { APPROVAL_STATUS } from '../policy/approvals.mjs';

/** USD formatting with no locale dependency — `500.00`, `10000.00`. */
function usd(value) {
  return `$${Number(value).toFixed(2)}`;
}

/**
 * One sentence stating the ceiling this agent runs under, built from the frozen
 * `BOUNDARIES` object rather than from prose. If a number changes in
 * `src/config/agents.mjs`, this sentence changes with it; a hand-written string
 * would silently go stale.
 */
export function boundarySummary(agentId) {
  const boundary = BOUNDARIES[agentId];
  if (!boundary) {
    return 'no domain boundary: the generic policy kernel only, fail-closed DENY for any unauthorised action';
  }
  if (agentId === 'svc_03') {
    return (
      `autonomous approval only at or below ${usd(boundary.autonomousApprovalCeilingUsd)} with a verified PO ` +
      `(requireVerifiedPo=${boundary.requireVerifiedPo}) and a variance of exactly zero (requireZeroVariance=${boundary.requireZeroVariance}); ` +
      'everything else is escalated to a human or rejected'
    );
  }
  if (agentId === 'svc_04') {
    return (
      `rule level ${boundary.incidentLevelCeiling} and above can never be auto-closed (levels ${boundary.minRuleLevel}-${boundary.maxRuleLevel}); ` +
      `allowlist matching is ${boundary.allowlistMatch}; corroboration always escalates (escalateOnCorroboration=${boundary.escalateOnCorroboration})`
    );
  }
  if (agentId === 'svc_06') {
    return (
      `single-order notional at or below ${usd(boundary.maxSingleOrderNotionalUsd)} on ${boundary.instrumentAllowlist.join('/')} ` +
      `(exact match, long-only=${boundary.longOnly}), daily-loss halt at ${usd(boundary.dailyLossHaltUsd)}, ` +
      `real-account routing ${boundary.realAccountRouting}, halt on symbol halt=${boundary.haltOnSymbolHalt}`
    );
  }
  return `boundary declared for "${agentId}" in src/config/agents.mjs`;
}

/** The escalation tool an agent's profile actually holds, or null. */
export function escalationToolFor(runtime, agentId) {
  const profile = runtime.findAgentProfile?.(agentId) ?? null;
  if (!profile) return null;
  const named = ESCALATION_TOOL[agentId] ?? null;
  if (named && profile.tools.includes(named)) return named;
  // Fall back to the registry's own declaration rather than a second name map:
  // an escalation tool is one that declares `escalation: true`.
  const declared = profile.tools.find((name) => runtime.registry.get(name)?.escalation === true);
  return declared ?? null;
}

/** The tools profile names + the registry's declarations for the ones it holds. */
function toolsForProfile(runtime, profile) {
  return profile.tools.map((name) => {
    const tool = runtime.registry.get(name);
    if (!tool) {
      // A profile naming an unregistered tool is a wiring error the API must
      // report rather than hide: it shows up as `registered: false`.
      return { name, registered: false };
    }
    return {
      name: tool.name,
      registered: true,
      description: tool.description,
      riskLevel: tool.riskLevel,
      sideEffect: tool.sideEffect,
      requiresConfirmation: tool.requiresConfirmation,
      escalation: tool.escalation === true,
      destructive: tool.destructive === true,
      permissions: [...tool.permissions],
      dataAccess: [...tool.dataAccess],
    };
  });
}

/**
 * `GET /api/runtime/agents` — one entry per runnable agent.
 *
 * @returns {object[]}
 */
export function serializeAgents(runtime) {
  return runtime.listAgents().map((agentId) => serializeAgent(runtime, agentId));
}

/** @returns {object} the agent view: identity, boundary, tools, limits. */
export function serializeAgent(runtime, agentId) {
  const profile = runtime.getAgentProfile(agentId);
  const boundary = BOUNDARIES[agentId] ?? null;
  let definition = null;
  let definitionError = null;
  try {
    definition = loadAgent(agentId, { renderer: runtime.promptRenderer });
  } catch (err) {
    // An agent that cannot be loaded is reported, not silently dropped: the
    // console shows the failure next to the agent.
    definitionError = err?.message ?? String(err);
  }

  return {
    id: profile.id,
    name: profile.name,
    taskType: profile.taskType,
    boundary,
    boundarySummary: boundarySummary(agentId),
    hasDomainBoundary: boundary !== null,
    tools: [...profile.tools],
    toolDetails: toolsForProfile(runtime, profile),
    permissions: [...profile.permissions],
    dataAccess: [...profile.dataAccess],
    limits: { ...profile.limits },
    actionPolicy: { ...profile.actionPolicy },
    allowDestructiveActions: profile.allowDestructiveActions === true,
    escalationTool: escalationToolFor(runtime, agentId),
    escalationDisposition: definition?.policy?.dispositions?.escalation ?? null,
    autonomousDisposition: definition?.policy?.dispositions?.autonomous ?? null,
    prompt: {
      path: profile.promptPath ?? null,
      source: profile.promptSource ?? profile.promptPath ?? null,
      guardrailPath: profile.guardrailPromptPath ?? null,
    },
    dataset: definition
      ? { path: definition.dataset.path ?? null, dataVar: definition.dataset.dataVar ?? null, cases: definition.dataset.cases ?? 0 }
      : null,
    suites: definition ? [...definition.evaluation.suites] : [],
    offlineFixture: FIXTURE_AGENTS.includes(agentId) ? 'oracle + naive (src/evaluation/mock-scripts.mjs)' : 'scenario text only',
    definitionError,
  };
}

/** `GET /api/runtime/tools` — the registry, with the policy-relevant fields. */
export function serializeTools(runtime) {
  return runtime.registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    sideEffect: tool.sideEffect,
    destructive: tool.destructive === true,
    requiresConfirmation: tool.requiresConfirmation,
    escalation: tool.escalation === true,
    permissions: [...tool.permissions],
    dataAccess: [...tool.dataAccess],
    timeoutMs: tool.timeoutMs,
    inputSchema: tool.inputSchema,
    requiredArguments: Array.isArray(tool.inputSchema?.required) ? [...tool.inputSchema.required] : [],
    heldBy: runtime
      .listAgents()
      .filter((agentId) => runtime.getAgentProfile(agentId).tools.includes(tool.name)),
  }));
}

/**
 * `GET /api/runtime/policies` — the rule inventory and the SVC boundary
 * configuration, both read from the runtime rather than restated here.
 */
export function serializePolicies(runtime) {
  return {
    defaultDecision: runtime.policy.defaultDecision,
    ruleCount: runtime.policy.rules.length,
    rules: runtime.policy.describe(),
    boundaries: runtime.listAgents()
      .filter((agentId) => BOUNDARIES[agentId])
      .map((agentId) => ({
        agentId,
        boundary: BOUNDARIES[agentId],
        summary: boundarySummary(agentId),
        source: 'src/config/agents.mjs#BOUNDARIES (deep-frozen, not configurable from the environment)',
        actionPolicy: { ...runtime.getAgentProfile(agentId).actionPolicy },
      })),
    withoutBoundary: runtime.listAgents().filter((agentId) => !BOUNDARIES[agentId]),
    realAccountNames: [...REAL_ACCOUNT_NAMES],
    notes: [
      'Policy boundaries are not configuration: src/config/index.mjs exposes BOUNDARIES for inspection only.',
      'A verdict is the worst (most restrictive) decision any applicable rule returns; no rule matching means fail-closed DENY.',
      'REQUIRE_APPROVAL is not a soft DENY: the executor creates a persisted approval bound to the tool name and an argument fingerprint.',
    ],
  };
}

/** Is this run status terminal? */
export function isTerminalRunStatus(status) {
  return TERMINAL_STATES.includes(status);
}

/**
 * The list view of one persisted run row. `phase` distinguishes the start row
 * from the finish row; `status` is only meaningful on a finish or pause row.
 */
export function serializeRunSummary(record) {
  if (!record) return null;
  return {
    runId: record.runId,
    sessionId: record.sessionId ?? null,
    agentId: record.agentId ?? null,
    taskType: record.taskType ?? null,
    mode: record.mode ?? null,
    phase: record.phase ?? null,
    status: record.status ?? null,
    terminal: isTerminalRunStatus(record.status),
    reason: record.reason ?? null,
    startedAt: record.startedAt ?? null,
    startedIso: record.startedIso ?? (record.startedAt ? new Date(record.startedAt).toISOString() : null),
    finishedAt: record.finishedAt ?? record.pausedAt ?? null,
    finishedIso: record.finishedIso ?? (record.finishedAt || record.pausedAt ? new Date(record.finishedAt ?? record.pausedAt).toISOString() : null),
    durationMs: record.durationMs ?? null,
    toolCalls: Array.isArray(record.toolCalls) ? [...record.toolCalls] : [],
    modelCalls: Array.isArray(record.modelCalls)
      ? record.modelCalls.map((call) => ({ provider: call.provider, model: call.model, routeId: call.routeId }))
      : [],
    traceRoot: record.traceRoot ?? null,
    budgets: record.budgets ?? null,
  };
}

/** Project `state.changed` events into a timeline with timestamps. */
export function stateTimelineFrom(events) {
  return events
    .filter((event) => event.type === 'state.changed')
    .map((event) => ({
      seq: event.seq,
      ts: event.ts,
      iso: event.iso,
      from: event.payload?.from ?? null,
      to: event.payload?.to ?? null,
      meta: event.payload?.meta ?? {},
    }));
}

/** Every policy verdict the executor or the run recorded. */
export function policyDecisionsFrom(events) {
  return events
    .filter((event) => event.type === 'policy.decided')
    .map((event) => ({
      seq: event.seq,
      iso: event.iso,
      kind: event.payload?.kind ?? null,
      tool: event.payload?.tool ?? null,
      action: event.payload?.action ?? null,
      decision: event.payload?.decision ?? null,
      rule: event.payload?.rule ?? null,
      reason: event.payload?.reason ?? null,
      evidence: event.payload?.evidence ?? null,
    }));
}

/** Tool activity, reconstructed from the proposal/result events. */
export function toolCallsFrom(events) {
  const calls = [];
  const bySeq = new Map();
  for (const event of events) {
    if (event.type === 'tool.proposed') {
      const entry = {
        seq: event.seq,
        tool: event.payload?.tool ?? null,
        args: event.payload?.args ?? null,
        riskLevel: event.payload?.riskLevel ?? null,
        sideEffect: event.payload?.sideEffect ?? null,
        status: 'PROPOSED',
        policyDecision: null,
        policyRule: null,
        approvalId: null,
        durationMs: null,
        error: null,
        result: null,
      };
      calls.push(entry);
      bySeq.set(event.seq, entry);
      continue;
    }
    if (event.type === 'tool.executed') {
      const entry = lastEntryFor(calls, event.payload?.tool, 'PROPOSED');
      if (entry) {
        entry.status = 'OK';
        entry.result = event.payload?.result ?? null;
        entry.durationMs = event.payload?.durationMs ?? null;
        entry.approvalId = event.payload?.approvalId ?? null;
      }
      continue;
    }
    if (event.type === 'tool.failed') {
      const entry = lastEntryFor(calls, event.payload?.tool, 'PROPOSED');
      if (entry) {
        entry.status = event.payload?.status ?? 'FAILED';
        entry.error = event.payload?.error ?? null;
        entry.durationMs = event.payload?.durationMs ?? null;
        if (event.payload?.approvalId) entry.approvalId = event.payload.approvalId;
      }
      continue;
    }
    if (event.type === 'policy.decided' && event.payload?.kind === 'tool_call') {
      const entry = lastEntryFor(calls, event.payload?.tool, 'PROPOSED');
      if (entry) {
        entry.policyDecision = event.payload?.decision ?? null;
        entry.policyRule = event.payload?.rule ?? null;
      }
    }
  }
  return calls;
}

/** The most recent entry for a tool that still carries `status`. */
function lastEntryFor(calls, tool, status) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i].tool === tool && calls[i].status === status) return calls[i];
  }
  return null;
}

/** The pending approval a run paused on, if any. */
export function pendingApprovalIdFrom(events, approvals = []) {
  const requested = events.filter((event) => event.type === 'approval.requested');
  const resolved = new Set(events.filter((event) => event.type === 'approval.resolved').map((event) => event.payload?.approvalId));
  const pending = approvals.filter((record) => record.status === APPROVAL_STATUS.PENDING);
  if (pending.length) return pending[pending.length - 1].approvalId;
  for (let i = requested.length - 1; i >= 0; i -= 1) {
    const id = requested[i].payload?.approvalId;
    if (id && !resolved.has(id)) return id;
  }
  return null;
}

/** Project a trace tree into a compact span list, keeping `full` optional. */
export function serializeTrace(traceRecord, { full = false } = {}) {
  if (!traceRecord?.trace) return null;
  const spans = [];
  const walk = (span, depth) => {
    spans.push({
      spanId: span.spanId ?? null,
      parentId: span.parentId ?? null,
      name: span.name ?? null,
      type: span.type ?? null,
      status: span.status ?? null,
      depth,
      startedAt: span.startedAt ?? null,
      endedAt: span.endedAt ?? null,
      durationMs: typeof span.durationMs === 'number'
        ? span.durationMs
        : span.startedAt !== undefined && span.endedAt !== undefined && span.endedAt !== null
          ? span.endedAt - span.startedAt
          : null,
      error: span.error ?? null,
      childCount: Array.isArray(span.children) ? span.children.length : 0,
    });
    for (const child of span.children ?? []) walk(child, depth + 1);
  };
  if (traceRecord.trace.root) walk(traceRecord.trace.root, 0);
  return {
    runId: traceRecord.runId ?? null,
    agentId: traceRecord.agentId ?? null,
    spanCount: spans.length,
    spans,
    ...(full ? { full: traceRecord.trace } : {}),
  };
}

/** One approval, as the operator queue needs it. */
export function serializeApproval(record) {
  if (!record) return null;
  return {
    approvalId: record.approvalId,
    status: record.status,
    runId: record.runId ?? null,
    sessionId: record.sessionId ?? null,
    agentId: record.agentId ?? null,
    reason: record.reason ?? null,
    policyRule: record.policyRule ?? null,
    toolName: record.toolName ?? null,
    requestFingerprint: record.requestFingerprint ?? null,
    args: record.args ?? null,
    payload: record.payload ?? null,
    createdAt: record.createdAt ?? null,
    createdIso: record.createdIso ?? null,
    expiresAt: record.expiresAt ?? null,
    expiresIso: record.expiresAt === null || record.expiresAt === undefined ? null : new Date(record.expiresAt).toISOString(),
    resolvedAt: record.resolvedAt ?? null,
    resolvedIso: record.resolvedIso ?? null,
    resolvedBy: record.resolvedBy ?? null,
    resolutionNote: record.resolutionNote ?? null,
  };
}

/** The runtime identity a health check and the console header both report. */
export function serializeRuntimeIdentity(runtime) {
  return {
    // Read from the runtime itself, not from a second constant: a version
    // reported here must be the version of the object actually serving.
    version: runtime.version,
    storageDir: runtime.storageDir,
    fixturesDir: runtime.fixturesDir,
    agents: runtime.listAgents(),
    svcAgents: runtime.listSvcAgents(),
    providerDefault: runtime.config.providers.defaultProvider,
    providerPreference: runtime.config.providers.preference,
    budgets: { ...runtime.config.budgets },
    toolTimeoutMs: runtime.config.toolTimeoutMs,
    approvalTtlMs: runtime.config.approvalTtlMs,
    env: runtime.config.env,
  };
}

export default {
  serializeAgent,
  serializeAgents,
  serializeTools,
  serializePolicies,
  serializeRunSummary,
  serializeApproval,
  serializeTrace,
  boundarySummary,
};
