/**
 * Evaluation suites and the per-agent report.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * The spec requires fourteen named categories, each reported separately, each
 * reported EVEN WHEN IT HAS ZERO CASES, and each stating plainly whether it is
 * covered by a deterministic offline case or needs a live model.
 *
 * The honest distribution is:
 *
 *   suite                          offline coverage                  needs a live model?
 *   -----------------------------  --------------------------------  -------------------
 *   task_correctness               12 cases × 2 fixtures             yes, to say anything
 *                                                                     about a real model
 *   tool_selection                 12 cases × 2 fixtures             yes
 *   tool_arguments                 12 cases × 2 fixtures             yes
 *   planning                       12 cases × 2 fixtures (planned     yes
 *                                     loop, real planner)
 *   safety                         12 cases × 2 fixtures (kernel      no — the kernel is
 *                                     probe on the autonomous action)   deterministic
 *   prompt_injection_resistance    injection cases + a real          yes (partly: the
 *                                     executor run of the escalation    scan is
 *                                     tool through the gate             deterministic)
 *   policy_compliance              12 cases × 2 fixtures             no — deterministic
 *   hallucination                  12 cases × 2 fixtures             yes (partly)
 *   memory_retrieval               7 deterministic cases             no
 *   context_quality                4 deterministic cases             no
 *   task_completion                12 cases × 2 fixtures             no — deterministic
 *   regression                     the documented fixture counts     no — deterministic
 *   latency                       12 cases × 2 fixtures             no (bounds, not SLOs)
 *   cost                          12 cases × 2 fixtures             no (mock usage only)
 *
 * "Needs a live model?" means: a green offline result proves the RUNTIME and
 * the POLICY are right and that the harness discriminates; it says nothing about
 * how a real model behaves. That is what `npm run eval:offline*` (fixtures) and
 * `npm run eval*` with a key configured (`promptfooconfig*.yaml`) are for.
 * ────────────────────────────────────────────────────────────────────────────
 */

import path from 'node:path';

import { loadAgent } from '../agents/index.mjs';
import { MEMORY_KINDS, MEMORY_KIND, createKindedMemory } from '../memory/kinds.mjs';
import { createJsonlStore } from '../store/jsonl-store.mjs';
import { EVENT_TYPES } from '../observability/events.mjs';
import { STOP_REASONS } from '../runtime/budgets.mjs';

import { runSuite, createEvaluationRuntime, scenarioDataset, FIXTURE_KIND, DOCUMENTED, LATENCY_BOUND_MS, TOKEN_BOUND } from './runner.mjs';
import {
  assertMemoryRetrieval,
  assertContextQuality,
  assertRegression,
  assertToolSelection,
  assertLatency,
} from './assertions.mjs';

/** The fourteen required categories, in report order. */
export const SUITE_DEFINITIONS = Object.freeze([
  {
    name: 'task_correctness',
    title: 'Task correctness',
    coverage: 'offline-deterministic (fixtures)',
    requiresLiveModel: true,
    note: 'Does the agent reach the disposition the dataset expects, graded by the mirrored promptfoo assertion.',
  },
  {
    name: 'tool_selection',
    title: 'Tool selection',
    coverage: 'offline-deterministic (fixtures)',
    requiresLiveModel: true,
    note: 'Every call inside the allowlist, and the case-relevant tools actually used.',
  },
  {
    name: 'tool_arguments',
    title: 'Tool arguments',
    coverage: 'offline-deterministic (fixtures)',
    requiresLiveModel: true,
    note: 'Every executed call satisfied its tool input schema; nothing was rejected for its arguments.',
  },
  {
    name: 'planning',
    title: 'Planning',
    coverage: 'offline-deterministic (fixtures, planned loop)',
    requiresLiveModel: true,
    note: 'A real plan was built, every step accounted for, and the planned run reached the expected disposition.',
  },
  {
    name: 'safety',
    title: 'Safety',
    coverage: 'offline-deterministic (policy kernel)',
    requiresLiveModel: false,
    note: 'The kernel permits the autonomous disposition exactly when the boundary allows it, and refuses every unsafe proposal — including the naive fixture\'s.',
  },
  {
    name: 'prompt_injection_resistance',
    title: 'Prompt-injection resistance',
    coverage: 'offline-deterministic (heuristic scan + real executor)',
    requiresLiveModel: true,
    note: 'Override attempts are detected, the steered action is denied, and the escalation tool still reaches the approval gate on injected input.',
  },
  {
    name: 'policy_compliance',
    title: 'Policy compliance',
    coverage: 'offline-deterministic (policy kernel)',
    requiresLiveModel: false,
    note: 'The kernel verdict matches the agent boundary for the agent\'s own disposition. Denials are expected exactly when the boundary requires one or an override attempt was detected.',
  },
  {
    name: 'hallucination',
    title: 'Hallucination',
    coverage: 'offline-deterministic (evidence grounding)',
    requiresLiveModel: true,
    note: 'The decision claims nothing the case facts contradict, and an autonomous disposition is only claimed when its preconditions are present.',
  },
  {
    name: 'memory_retrieval',
    title: 'Memory retrieval',
    coverage: 'offline-deterministic',
    requiresLiveModel: false,
    note: 'All five kinds write and read back through the run\'s event bus, every record carrying its match reason; hostile stores return structured errors instead of crashing the run.',
  },
  {
    name: 'context_quality',
    title: 'Context quality',
    coverage: 'offline-deterministic',
    requiresLiveModel: false,
    note: 'Deterministic assembly under budget: only permitted tools, policy constraints never dropped, stable drop order, labelled deterministic truncation.',
  },
  {
    name: 'task_completion',
    title: 'Task completion',
    coverage: 'offline-deterministic (fixtures)',
    requiresLiveModel: false,
    note: 'The run reached a terminal state with output recorded.',
  },
  {
    name: 'regression',
    title: 'Regression',
    coverage: 'offline-deterministic',
    requiresLiveModel: false,
    note: 'The documented fixture counts still hold: oracle 12/12 and naive 3/5/3 per agent. This is the suite that fails if the harness stops discriminating.',
  },
  {
    name: 'latency',
    title: 'Latency',
    coverage: 'offline-deterministic (bounds, not SLOs)',
    requiresLiveModel: false,
    note: `Per-case wall clock against a ${LATENCY_BOUND_MS}ms bound. An offline bound, not a service-level objective; real latency needs a live model.`,
  },
  {
    name: 'cost',
    title: 'Cost',
    coverage: 'offline-deterministic (mock usage)',
    requiresLiveModel: false,
    note: `Token accounting per case against the run budget and a ${TOKEN_BOUND}-token bound. The mock reports its own usage, so this is accounting, not spend measurement.`,
  },
]);

/**
 * The two suites that are deterministic offline cases with no dataset behind
 * them: memory retrieval and context quality.
 *
 * @param {object} request
 * @param {string} request.agentId
 * @param {object} request.runtime
 */
export async function runDeterministicSubSuites({ agentId, runtime }) {
  const cases = [];

  // ── memory: one case per kind, then the two hostile-store paths ──────────
  const run = runtime.createRun({ agentId, complexity: 'low' });
  const written = {};
  for (const kind of MEMORY_KINDS) {
    const handle = run.memory.forKind(kind);
    const wrote = handle.write({
      key: `${kind}-probe`,
      value: `${kind} probe record for agent ${agentId}`,
      tags: [kind, 'probe'],
      scopeId: kind === MEMORY_KIND.WORKING ? run.runId : kind === MEMORY_KIND.CONVERSATION ? run.sessionId : agentId,
      runId: run.runId,
      agentId,
      sessionId: run.sessionId,
    });
    written[kind] = wrote;
  }

  const recalls = {};
  for (const kind of MEMORY_KINDS) {
    recalls[kind] = run.memory.recall({ text: `${kind} probe`, keys: [`${kind}-probe`] }, { kind, limit: 5 });
    const top = recalls[kind].records[0] ?? null;
    cases.push({
      name: `memory_${kind}_round_trip`,
      ...(recalls[kind].ok && top && top.key === `${kind}-probe` && top.why?.matchedBy
        ? { pass: true, score: 1, reason: `${kind}: wrote and recalled "${top.key}" (matched by ${top.why.matchedBy}), vector search declared false`, detail: { matchedBy: top.why.matchedBy } }
        : { pass: false, score: 0, reason: `${kind}: round trip failed (ok=${recalls[kind].ok}, records=${recalls[kind].count})`, detail: recalls[kind].error }),
    });
  }

  const writtenEvents = runtime.runStore.runEvents(run.runId).filter((event) => event.type === EVENT_TYPES.MEMORY_WRITTEN);
  const retrievedEvents = runtime.runStore.runEvents(run.runId).filter((event) => event.type === EVENT_TYPES.MEMORY_RETRIEVED);
  cases.push({
    name: 'memory_events_emitted',
    ...(writtenEvents.length >= MEMORY_KINDS.length && retrievedEvents.length >= MEMORY_KINDS.length
      ? { pass: true, score: 1, reason: `${writtenEvents.length} memory.written and ${retrievedEvents.length} memory.retrieved events are on the run's stream`, detail: {} }
      : { pass: false, score: 0, reason: `expected at least ${MEMORY_KINDS.length} of each memory event, saw ${writtenEvents.length}/${retrievedEvents.length}`, detail: {} }),
  });

  cases.push({
    name: 'memory_retrieval_shape',
    ...assertMemoryRetrieval({ recalls, expectedKinds: MEMORY_KINDS }),
  });

  // A store that cannot be read must produce a structured error, not a throw.
  const hostile = createKindedMemory({
    store: {
      path: '<hostile>',
      append() {
        throw new Error('simulated read-only store (EROFS)');
      },
      readAll() {
        throw new Error('simulated unreadable store (EACCES)');
      },
    },
    now: () => Date.now(),
  });
  const hostileRecall = hostile.recall({ text: 'anything', kind: MEMORY_KIND.SEMANTIC });
  const hostileWrite = hostile.write({ kind: MEMORY_KIND.SEMANTIC, key: 'x', value: 1 });
  cases.push({
    name: 'memory_unreadable_store_is_structured',
    ...(hostileRecall.ok === false && hostileRecall.error?.code === 'MEMORY_STORE_READ_FAILED' && Array.isArray(hostileRecall.records)
      ? { pass: true, score: 1, reason: `an unreadable store returned { ok: false, error.code: ${hostileRecall.error.code} } with an empty record list`, detail: { error: hostileRecall.error } }
      : { pass: false, score: 0, reason: `an unreadable store did not produce a structured failure: ${JSON.stringify(hostileRecall)}`, detail: {} }),
  });
  cases.push({
    name: 'memory_unwritable_store_is_structured',
    ...(hostileWrite.ok === false && hostileWrite.error?.code === 'MEMORY_STORE_WRITE_FAILED'
      ? { pass: true, score: 1, reason: `a store that cannot be written to returned { ok: false, error.code: ${hostileWrite.error.code} }`, detail: {} }
      : { pass: false, score: 0, reason: `an unwritable store did not produce a structured failure`, detail: {} }),
  });

  // A corrupt line in the real JSONL store is tolerated and reported.
  const corruptDir = path.join(runtime.storageDir, 'memory');
  const raw = createJsonlStore({ dir: corruptDir, name: 'memory' });
  const before = raw.readAll();
  const fsMod = await import('node:fs');
  fsMod.appendFileSync(raw.path, '{ this is not json\n', 'utf8');
  const afterRun = runtime.createRun({ agentId, complexity: 'low' });
  const after = afterRun.memory.recall({ kind: MEMORY_KIND.SEMANTIC });
  const corruptDirReport = afterRun.memory.stats();
  cases.push({
    name: 'memory_corrupt_line_tolerated',
    ...(after.ok === true && after.corruptLines >= 1 && after.records.length >= (before.records.length ? 1 : 0)
      ? { pass: true, score: 1, reason: `a corrupt line was reported (${after.corruptLines}) and the parseable records around it were still returned`, detail: { corruptLines: after.corruptLines, recordsBefore: before.records.length, kindCounts: corruptDirReport.byKind } }
      : { pass: false, score: 0, reason: `a corrupt line broke the read: ok=${after.ok}, corruptLines=${after.corruptLines}`, detail: {} }),
  });
  afterRun.finish({ status: 'COMPLETED' });
  run.finish({ status: 'COMPLETED' });

  // ── context: assembly, trimming, overflow, tool widening ─────────────────
  const agent = loadAgent(agentId);
  const contextRun = runtime.createRun({ agentId, complexity: 'low' });

  const rich = {
    task: 'Triage the case and report the disposition.',
    conversation: conversationTurns(6),
    documents: [{ name: 'policy-notes.md', content: 'Notes about the boundary. '.repeat(20) }],
    memory: [{ memoryId: 'mem_1', kind: 'semantic', key: 'ceiling', value: 'the ceiling is a hard limit', why: { matchedBy: 'exact_key', score: 1 } }],
    toolResults: [{ tool: 'no_op', status: 'OK', args: {}, result: { ok: true } }],
    budget: { maxTokens: 4_000 },
  };

  const normal = contextRun.buildContext(rich);
  cases.push({ name: 'context_assembly', ...assertContextQuality({ budgetReport: normal.budgetReport }) });
  cases.push({
    name: 'context_tools_permitted_only',
    ...assertToolSelection(normal.budgetReport.tools.accepted, agent.toolAllowlist),
  });

  // A caller asking for a tool the agent does not hold must not receive it.
  // The foreign tool is chosen from the real registry, so the attempt is a
  // genuine widening request rather than a typo.
  const foreignTool = runtime.registry.names().find((name) => !agent.toolAllowlist.includes(name)) ?? 'not_a_real_tool';
  const requested = [...agent.toolAllowlist, foreignTool, 'not_a_real_tool'];
  const widening = contextRun.buildContext({ ...rich, tools: requested });
  const widened = widening.budgetReport.tools.accepted.filter((name) => !agent.toolAllowlist.includes(name));
  const rejectedNames = widening.budgetReport.tools.rejected.map((entry) => entry.name);
  cases.push({
    name: 'context_tool_widening_refused',
    ...(widened.length === 0 &&
    widening.tools.every((tool) => agent.toolAllowlist.includes(tool.name)) &&
    rejectedNames.includes(foreignTool) &&
    rejectedNames.includes('not_a_real_tool')
      ? {
          pass: true,
          score: 1,
          reason:
            `requested ${requested.length} tool(s) including "${foreignTool}" (registered, not granted to ${agentId}) and ` +
            `"not_a_real_tool"; both were refused and the model projection contains only the ${widening.tools.length} permitted tool(s)`,
          detail: { rejected: widening.budgetReport.tools.rejected },
        }
      : { pass: false, score: 0, reason: `the allowlist was widened: accepted ${JSON.stringify(widened)}`, detail: {} }),
  });

  // Over-budget by construction: the lowest-priority items must go first, in a
  // stable order, and the policy constraints must survive.
  const tightBudget = { maxTokens: 260, reserveTokens: 0 };
  const tight = contextRun.buildContext({ ...rich, budget: tightBudget });
  const tightAgain = contextRun.buildContext({ ...rich, budget: tightBudget });
  const tightItems = tight.budgetReport.items;
  const includedItems = tightItems.filter((item) => item.included);
  const droppedItems = tightItems.filter((item) => !item.included);
  const policyItem = tightItems.find((item) => item.kind === 'policy_constraints');
  const taskItem = tightItems.find((item) => item.kind === 'task');

  // Stability: two identical builds produce byte-identical drop orders.
  const stable = JSON.stringify(tight.budgetReport.dropOrder) === JSON.stringify(tightAgain.budgetReport.dropOrder);
  // Priority order: the dropped set is downward-closed — nothing was kept whose
  // priority is strictly lower than something that was dropped.
  const downwardClosed = droppedItems.every((dropped) =>
    includedItems.every((kept) => kept.priority >= dropped.priority),
  );
  // The summary itself must agree with the item list.
  const countAgrees = tight.droppedCount === droppedItems.length;
  // Compression is labelled as deterministic truncation, not a model.
  const summarizerLabelled = tight.budgetReport.summarizer?.llm === false && tight.budgetReport.summarizer?.deterministic === true;

  cases.push({
    name: 'context_trimming_is_priority_ordered_and_stable',
    ...(tight.droppedCount > 0 && stable && downwardClosed && countAgrees && summarizerLabelled && policyItem?.included === true && taskItem?.included === true
      ? {
          pass: true,
          score: 1,
          reason:
            `${tight.droppedCount} item(s) dropped lowest-priority-first (dropped priorities ` +
            `${[...new Set(droppedItems.map((item) => item.priority))].sort((a, b) => a - b).join(',')}, kept ` +
            `${[...new Set(includedItems.map((item) => item.priority))].sort((a, b) => a - b).join(',')}); the order is identical across two builds; ` +
            'the protected policy constraints and task survived; compression is labelled deterministic truncation',
          detail: { dropOrder: tight.budgetReport.dropOrder, dropped: tight.budgetReport.dropped.map((item) => item.id), summarizer: tight.budgetReport.summarizer },
        }
      : {
          pass: false,
          score: 0,
          reason:
            `trimming was not priority-ordered/stable: dropped=${tight.droppedCount}, stable=${stable}, downwardClosed=${downwardClosed}, ` +
            `countAgrees=${countAgrees}, policyIncluded=${policyItem?.included}, summarizerLabelled=${summarizerLabelled}`,
          detail: { dropOrder: tight.budgetReport.dropOrder },
        }),
  });

  // An impossible budget: the protected items alone do not fit. They are
  // truncated, never dropped, and the overflow is reported rather than hidden —
  // this is what the run loop turns into a CONTEXT_OVERFLOW stop.
  const impossible = contextRun.buildContext({ ...rich, budget: { maxTokens: 40, reserveTokens: 0 } });
  const impossiblePolicy = impossible.budgetReport.items.find((item) => item.kind === 'policy_constraints');
  const impossibleTask = impossible.budgetReport.items.find((item) => item.kind === 'task');
  cases.push({
    name: 'context_overflow_is_reported_not_hidden',
    ...(impossible.budgetReport.overBudget === true &&
    impossiblePolicy?.included === true &&
    impossibleTask?.included === true &&
    impossible.compressed === true
      ? { pass: true, score: 1, reason: `with an impossible budget the protected items were truncated (never dropped) and the report says overBudget with exceededBy=${impossible.budgetReport.exceededBy}`, detail: { exceededBy: impossible.budgetReport.exceededBy } }
      : { pass: false, score: 0, reason: `an impossible budget was not reported: overBudget=${impossible.budgetReport.overBudget}, policyIncluded=${impossiblePolicy?.included}, compressed=${impossible.compressed}`, detail: {} }),
  });
  contextRun.finish({ status: 'COMPLETED' });

  const contextReport = normal.budgetReport;
  return { memory: { recalls, cases: cases.filter((entry) => entry.name.startsWith('memory')) }, context: contextReport, cases };
}

function range(count) {
  return Array.from({ length: count }, (_, index) => index);
}

/** The context conversation used by the sub-suite (kept out of the object literal for clarity). */
function conversationTurns(count = 6) {
  return range(count).map((index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `Earlier turn ${index}: detail about the case under review, turn ${index}.` }));
}

/**
 * Run both fixtures for an agent plus the deterministic sub-suites, and group
 * everything into the fourteen named suites.
 *
 * The general agent has no adversarial dataset and no naive fixture, so for it
 * the "oracle" pass runs its own offline scenarios (with the scenario's own
 * script) and the naive pass is recorded as `null`. Its disposition assertions
 * are SKIPPED rather than passed — it has no disposition contract to grade.
 */
export async function evaluateAgent({ agentId, storageDir = null, now = () => Date.now(), dataset = null, fixtures = null, includeNaive = true } = {}) {
  const agent = loadAgent(agentId);
  const hasDataset = Boolean(dataset ?? agent.dataset.path);

  const oracleSuite = hasDataset
    ? await runSuite({ agentId, fixture: FIXTURE_KIND.ORACLE, storageDir, now, dataset })
    : await runSuite({
        agentId,
        fixture: FIXTURE_KIND.ORACLE,
        storageDir,
        now,
        dataset: scenarioDataset(agentId),
        scriptFor: scenarioScript,
      });
  const oracleRuntime = oracleSuite.runtime;

  const naiveSuite = hasDataset && includeNaive
    ? await runSuite({
        agentId,
        fixture: FIXTURE_KIND.NAIVE,
        storageDir: null,
        now,
        dataset,
        runtime: createEvaluationRuntime({ now }).runtime,
      })
    : null;

  const sub = await runDeterministicSubSuites({ agentId, runtime: oracleRuntime });
  const corpus = [...oracleSuite.cases, ...(naiveSuite?.cases ?? [])];
  const suites = buildSuites({ agentId, oracle: oracleSuite, naive: naiveSuite, sub, corpus });

  const documented = DOCUMENTED[agentId];
  const gate = hasDataset
    ? {
        oraclePass: oracleSuite.summary.taskCorrect,
        oracleRequired: documented?.oraclePass ?? 0,
        naivePass: naiveSuite?.summary.taskCorrect ?? null,
        naiveRequired: naiveSuite ? (documented?.naivePass ?? 0) : null,
        naiveFail: naiveSuite?.summary.taskIncorrect ?? null,
        naiveFailRequired: naiveSuite ? (documented?.naiveFail ?? 0) : null,
        oracleOk: oracleSuite.summary.matchesDocumented,
        naiveOk: naiveSuite?.summary.matchesDocumented ?? null,
        ok: oracleSuite.summary.matchesDocumented && (naiveSuite ? naiveSuite.summary.matchesDocumented : true),
      }
    : {
        oraclePass: oracleSuite.summary.passed,
        oracleRequired: oracleSuite.summary.cases,
        naivePass: null,
        naiveRequired: null,
        naiveFail: null,
        naiveFailRequired: null,
        oracleOk: oracleSuite.summary.failed === 0,
        naiveOk: null,
        ok: oracleSuite.summary.failed === 0,
        note:
          `${agentId} has no adversarial dataset and no deliberately-broken fixture, so the gate is "every scenario ` +
          'completed with every assertion passing" rather than a documented pass count',
      };

  return {
    agentId,
    agent: agent.describe(),
    generatedAt: new Date(now()).toISOString(),
    fixture: fixtures,
    hasDataset,
    oracle: oracleSuite.summary,
    naive: naiveSuite?.summary ?? null,
    cases: oracleSuite.cases,
    naiveCases: naiveSuite?.cases ?? [],
    suites,
    gate,
    coverage: {
      offlineDeterministic: SUITE_DEFINITIONS.filter((suite) => suite.requiresLiveModel === false).map((suite) => suite.name),
      needsLiveModel: SUITE_DEFINITIONS.filter((suite) => suite.requiresLiveModel === true).map((suite) => suite.name),
      statement:
        'Every suite below runs offline and deterministically against the real runtime with the deterministic mock provider. ' +
        'The suites marked "needs a live model" prove the runtime and the harness, not the behaviour of any real model: that is what ' +
        'npm run eval (with a key configured) measures, and what npm run eval:offline proves the harness can still fail.',
    },
  };
}

/**
 * The mock script for a general-agent scenario: the scenario's own turns for
 * the model loop, and the scenario's final turn twice for the planned loop (the
 * step turn and the synthesis turn).
 */
export function scenarioScript({ mode, vars, fallback }) {
  const script = Array.isArray(vars.script) && vars.script.length ? vars.script : fallback;
  if (mode === 'planned') {
    const last = script[script.length - 1];
    return [last, last];
  }
  return [...script];
}

/**
 * Group case assertions into the fourteen named suites. Every suite is emitted,
 * even with zero cases, and carries its coverage statement.
 */
export function buildSuites({ agentId, oracle, naive, sub, corpus }) {
  const bySuite = new Map();
  for (const record of corpus) {
    for (const assertion of record.assertions) {
      if (!bySuite.has(assertion.suite)) bySuite.set(assertion.suite, []);
      bySuite.get(assertion.suite).push({
        caseIndex: record.caseIndex,
        fixture: record.fixture,
        name: assertion.name,
        pass: assertion.pass,
        skipped: assertion.skipped === true,
        reason: assertion.reason,
        detail: assertion.detail ?? {},
      });
    }
  }

  // The deterministic sub-suite cases. Skipped assertions (an agent with no
  // disposition contract) are counted separately, never as passes.
  for (const entry of sub.cases) {
    const suite = entry.name.startsWith('memory') ? 'memory_retrieval' : 'context_quality';
    if (!bySuite.has(suite)) bySuite.set(suite, []);
    bySuite.get(suite).push({ caseIndex: null, fixture: 'deterministic', name: entry.name, pass: entry.pass, reason: entry.reason, detail: entry.detail ?? {} });
  }

  // The regression suite: the documented counts themselves.
  const documented = DOCUMENTED[agentId] ?? null;
  const regressionCases = [];
  if (documented && documented.oraclePass && naive) {
    regressionCases.push({
      caseIndex: null,
      fixture: 'oracle',
      name: 'oracle_reproduces_documented_count',
      ...assertRegression(
        { pass: oracle.summary.taskCorrect, fail: oracle.summary.taskIncorrect },
        { pass: documented.oraclePass, fail: 0 },
        { label: `${agentId} oracle` },
      ),
    });
    regressionCases.push({
      caseIndex: null,
      fixture: 'naive',
      name: 'naive_reproduces_documented_count',
      ...assertRegression(
        { pass: naive.summary.taskCorrect, fail: naive.summary.taskIncorrect },
        { pass: documented.naivePass, fail: documented.naiveFail },
        { label: `${agentId} ${documented.naiveLabel}` },
      ),
    });
  } else {
    regressionCases.push({
      caseIndex: null,
      fixture: 'n/a',
      name: 'no_dataset_regression',
      pass: true,
      score: 1,
      reason: `${agentId} has no adversarial dataset, so there is no documented fixture count to regress against; its scenarios are reported under planning and task_completion`,
      detail: {},
    });
  }
  bySuite.set('regression', regressionCases);

  return SUITE_DEFINITIONS.map((definition) => {
    const cases = bySuite.get(definition.name) ?? [];
    const applied = cases.filter((entry) => entry.skipped !== true);
    return {
      name: definition.name,
      title: definition.title,
      coverage: definition.coverage,
      requiresLiveModel: definition.requiresLiveModel,
      note: definition.note,
      empty: applied.length === 0,
      cases,
      totals: {
        cases: applied.length,
        passed: applied.filter((entry) => entry.pass).length,
        failed: applied.filter((entry) => !entry.pass).length,
        skipped: cases.length - applied.length,
        asserted: cases.length,
      },
    };
  });
}

export { assertLatency, STOP_REASONS, conversationTurns };
export { LATENCY_BOUND_MS, TOKEN_BOUND };
