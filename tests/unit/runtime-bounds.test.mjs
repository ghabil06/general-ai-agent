/**
 * Regression tests: the ways the runtime's limits used to be soft.
 *
 * Every test here pins a defect that was reproduced against the code as it
 * stood (the probe output is in docs/ARCHITECTURE.md §9), and was written to
 * FAIL there first. They are grouped by the guarantee they restore:
 *
 *   iteration budget   a model call is never made past the budget
 *   cancellation       cancel() at ANY await resolves the loop and persists
 *   wall-clock         a call cannot outlive the run's remaining time
 *   hard ceilings      no config, profile or request raises a run past them
 *   token accounting   a provider that reports no usage is still budgeted
 *   free-form steps    two tool calls in one plan step is a normal turn
 *   fault containment  a fault mid-run is a persisted FAILED run, not a throw
 *
 * Deadline tests use a REAL clock and short budgets (150–200 ms); every wait is
 * wrapped in `within()` so a regression fails the test instead of hanging it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { STATES } from '../../src/runtime/state-machine.mjs';
import { STOP_REASONS } from '../../src/runtime/budgets.mjs';
import { EVENT_TYPES } from '../../src/observability/events.mjs';
import { HARD_CEILINGS, EnvelopeError, TRANSITIONS_PER_ITERATION } from '../../src/runtime/envelope.mjs';
import { terminalStatusFor } from '../../src/agents/index.mjs';
import {
  buildRuntime,
  sleepTool,
  gatedWriteTool,
  BOUNDS_PROFILE,
  hungProvider,
  runawayProvider,
  within,
  planTurn,
} from '../helpers/bounded.mjs';

const request = (extra = {}) => ({ systemPrompt: 'sys', userMessage: 'go', responseFormat: 'text', ...extra });
const profiles = { bounds_agent: BOUNDS_PROFILE };

// ── iteration budget ───────────────────────────────────────────────────────

test('planned loop: iterations never exceed the budget, and no model call is made past it', async () => {
  const failing = { id: 's', description: 'bad call', tool: 'get_market_quote', args: { ticker: 123 } }; // schema-invalid on purpose
  for (let maxIterations = 1; maxIterations <= 8; maxIterations += 1) {
    const script = Array.from({ length: 40 }, (_, i) =>
      planTurn([{ id: `r${i}`, description: 'retry', tool: 'get_market_quote', args: { ticker: 100 + i } }]),
    );
    const { runtime } = buildRuntime({ budgets: { maxIterations }, mockScript: script });
    const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
    const outcome = await run.loop({ mode: 'planned', goal: 'quote', steps: [failing], ...request() });

    const { iterations } = run.budget.snapshot();
    assert.ok(iterations <= maxIterations, `maxIterations=${maxIterations}: ${iterations} iterations were recorded`);
    assert.ok(run.modelCalls.length <= maxIterations, `maxIterations=${maxIterations}: ${run.modelCalls.length} model calls were made`);
    assert.ok(outcome.stopReason, `maxIterations=${maxIterations}: the run must report why it stopped`);
  }
});

// ── cancellation ───────────────────────────────────────────────────────────

/** Start a loop, cancel it `afterMs` later, and return what the loop settled to. */
async function cancelDuring({ script = [], mode = 'model', agentId = 'general', loop = {}, afterMs = 25, tools, profile } = {}) {
  const { runtime } = buildRuntime({ mockScript: script, tools, profiles: profile ? profiles : null });
  const run = runtime.createRun({ agentId, provider: 'mock' });
  const startedAt = Date.now();
  const pending = run.loop({ mode, ...request(loop) });
  setTimeout(() => run.cancel('operator pressed cancel'), afterMs);
  const outcome = await within(pending, 4000, 'a cancelled loop');
  return { runtime, run, outcome, elapsedMs: Date.now() - startedAt };
}

function assertCancelled({ run, outcome, runtime }) {
  assert.equal(outcome.stopReason?.code, STOP_REASONS.CANCELLATION_REQUESTED);
  assert.equal(run.state, STATES.CANCELLED);
  // …and the run can be closed: it lands in the store like any other run.
  const record = run.finish({ status: terminalStatusFor(run, outcome), reason: outcome.stopReason.code });
  assert.equal(record.status, STATES.CANCELLED);
  assert.equal(runtime.runStore.getRun(run.runId).status, STATES.CANCELLED);
  assert.ok(runtime.runStore.getTrace(run.runId), 'a cancelled run still persists its trace');
}

test('cancel() during an in-flight model call resolves the loop — and returns promptly', async () => {
  const result = await cancelDuring({ script: [{ text: 'a slow answer', delayMs: 1500 }] });
  assertCancelled(result);
  assert.ok(result.elapsedMs < 800, `cancel took ${result.elapsedMs}ms: the loop waited for the model instead of abandoning the call`);
});

test('cancel() during a tool-calling model turn resolves the loop', async () => {
  const result = await cancelDuring({ script: [{ toolCalls: [{ name: 'no_op', arguments: {} }], delayMs: 200 }, { text: 'never reached' }] });
  assertCancelled(result);
  assert.equal(result.run.toolCalls.length, 0, 'a tool call that arrived after the cancel must not run');
});

test('cancel() during an in-flight TOOL call: the call is recorded and nothing further runs', async () => {
  const result = await cancelDuring({
    script: [{ toolCalls: [{ name: 'sleep_tool', arguments: {} }, { name: 'no_op', arguments: {} }] }, { text: 'never reached' }],
    tools: [sleepTool(200)],
    profile: true,
    agentId: 'bounds_agent',
    afterMs: 40,
  });
  assertCancelled(result);
  const executed = result.runtime.runStore.runEvents(result.run.runId).filter((e) => e.type === EVENT_TYPES.TOOL_EXECUTED).map((e) => e.payload.tool);
  assert.deepEqual(executed, ['sleep_tool'], 'the in-flight call finished and is on record; the next call in the turn never started');
});

test('cancel() before the loop starts yields a cancelled outcome, not an exception', async () => {
  const { runtime } = buildRuntime({ mockScript: [{ text: 'unused' }] });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  run.cancel('never started');
  const outcome = await run.loop({ mode: 'model', ...request() });
  assertCancelled({ run, outcome, runtime });
  assert.equal(run.modelCalls.length, 0, 'no model call is made for a run that was cancelled first');
});

const STEP_FAILS = { id: 's1', description: 'bad call', tool: 'get_market_quote', args: { ticker: 123 } };
const PLANNED_CANCEL_SITES = [
  {
    name: 'the plan-proposal call',
    script: [planTurn([{ id: 'p1', description: 'x' }], { delayMs: 1500 })],
    steps: null,
  },
  {
    name: 'a tool step',
    script: [{ text: 'unused' }],
    steps: [{ id: 's1', description: 'sleep', tool: 'sleep_tool', args: {} }],
    tools: [sleepTool(250)],
    profile: true,
    agentId: 'bounds_agent',
    afterMs: 40,
  },
  {
    name: 'a free-form step (model call)',
    script: [{ text: 'a slow step answer', delayMs: 1500 }],
    steps: [{ id: 's1', description: 'think about it' }],
  },
  {
    name: 'the synthesis call',
    script: [{ text: 'a slow synthesis', delayMs: 1500 }],
    steps: [{ id: 's1', description: 'nothing to do', tool: 'no_op', args: {} }],
    afterMs: 120,
  },
  {
    name: 'a replan call',
    script: [planTurn([{ id: 'r1', description: 'retry' }], { delayMs: 1500 })],
    steps: [STEP_FAILS],
    afterMs: 120,
  },
];

for (const site of PLANNED_CANCEL_SITES) {
  test(`planned loop: cancel() during ${site.name} resolves and persists`, async () => {
    const result = await cancelDuring({
      mode: 'planned',
      script: site.script,
      loop: { goal: 'a task', steps: site.steps },
      tools: site.tools,
      profile: site.profile,
      agentId: site.agentId ?? 'general',
      afterMs: site.afterMs ?? 25,
    });
    assertCancelled(result);
    assert.ok(result.elapsedMs < 1200, `cancel took ${result.elapsedMs}ms`);
  });
}

// ── wall-clock ─────────────────────────────────────────────────────────────

test('a model call that outlives the remaining wall-clock is cut off at the deadline', async () => {
  const { runtime } = buildRuntime({ realClock: true, budgets: { wallClockMs: 150 }, mockScript: [{ text: 'too late', delayMs: 1500 }] });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const startedAt = Date.now();
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 4000, 'the run');
  const elapsedMs = Date.now() - startedAt;

  assert.equal(outcome.stopReason?.code, STOP_REASONS.WALL_CLOCK_TIMEOUT);
  assert.equal(outcome.finalText, '', 'an answer that arrived after the deadline is not an answer');
  assert.ok(elapsedMs < 1000, `the run took ${elapsedMs}ms against a 150ms budget`);
});

test('a provider that never resolves cannot hang the run, and its request is aborted', async () => {
  const provider = hungProvider();
  const { runtime } = buildRuntime({ realClock: true, budgets: { wallClockMs: 150 }, providers: { mock: provider } });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const startedAt = Date.now();
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 4000, 'a run against a provider that never answers');

  assert.equal(outcome.stopReason?.code, STOP_REASONS.WALL_CLOCK_TIMEOUT);
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].signal?.aborted, true, 'the abort signal handed to the provider fired, so a real HTTP request is actually dropped');
});

test('a tool call is never given longer than the remaining wall-clock', async () => {
  const { runtime } = buildRuntime({
    realClock: true,
    budgets: { wallClockMs: 200 },
    toolTimeoutMs: 10_000,
    tools: [sleepTool(1500)],
    profiles,
    mockScript: [{ toolCalls: [{ name: 'sleep_tool', arguments: {} }] }, { text: 'never reached' }],
  });
  const run = runtime.createRun({ agentId: 'bounds_agent', provider: 'mock' });
  const startedAt = Date.now();
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 4000, 'the run');

  assert.ok(Date.now() - startedAt < 1000, 'the 10s tool timeout must not outlive a 200ms run budget');
  const failed = runtime.runStore.runEvents(run.runId).find((e) => e.type === EVENT_TYPES.TOOL_FAILED);
  assert.equal(failed?.payload.status, 'TOOL_TIMEOUT');
  assert.equal(outcome.stopReason?.code, STOP_REASONS.WALL_CLOCK_TIMEOUT);
});

// ── hard ceilings ──────────────────────────────────────────────────────────

test('configuration cannot raise a run past the hard ceilings', () => {
  const { runtime } = buildRuntime({ env: { AGENT_MAX_ITERATIONS: '1000000000', AGENT_WALL_CLOCK_MS: '999999999999', AGENT_MAX_TOOL_CALLS: '5000' } });
  const run = runtime.createRun({ agentId: 'svc_03', provider: 'mock' });
  // svc_03's own profile limits are tighter than the ceilings; use an agent without limits to see the ceiling itself.
  const bare = runtime.createRun({ agentId: 'general', provider: 'mock' });
  for (const handle of [run, bare]) {
    assert.ok(handle.budget.limits.maxIterations <= HARD_CEILINGS.maxIterations);
    assert.ok(handle.budget.limits.wallClockMs <= HARD_CEILINGS.wallClockMs);
    assert.ok(handle.budget.limits.maxToolCalls <= HARD_CEILINGS.maxToolCalls);
  }
});

test('planner ceilings are clamped to the hard ceilings, and non-integers are refused', () => {
  const { runtime } = buildRuntime();
  const run = runtime.createRun({ agentId: 'general', provider: 'mock', planning: { maxSteps: 1_000_000_000, maxReplans: 99_999 } });
  assert.equal(run.planner.limits.maxSteps, HARD_CEILINGS.maxSteps);
  assert.equal(run.planner.limits.maxReplans, HARD_CEILINGS.maxReplans);

  for (const bad of [Number.NaN, 0, -3, 2.5, '12']) {
    assert.throws(
      () => runtime.createRun({ agentId: 'general', provider: 'mock', planning: { maxSteps: bad } }),
      (err) => err instanceof EnvelopeError && err.code === 'INVALID_LIMIT',
      `maxSteps=${String(bad)} must be refused rather than silently disabling the ceiling`,
    );
  }
});

// ── tool-call budget: the number means what it says ────────────────────────

test('maxToolCalls = N executes N calls — the kernel counts the calls BEFORE the one it is judging', async () => {
  for (const n of [1, 2, 5]) {
    const provider = runawayProvider();
    const limited = { ...BOUNDS_PROFILE, id: 'limited_agent', limits: { maxToolCalls: n, maxIterations: 20, maxTokens: 60_000 } };
    const { runtime } = buildRuntime({ providers: { mock: provider }, profiles: { limited_agent: limited } });
    const run = runtime.createRun({ agentId: 'limited_agent', provider: 'mock' });
    const outcome = await run.loop({ mode: 'model', ...request() });

    const executed = runtime.runStore.runEvents(run.runId).filter((e) => e.type === EVENT_TYPES.TOOL_EXECUTED).length;
    assert.equal(executed, n, `maxToolCalls=${n} executed ${executed} calls (it used to execute ${n - 1}: the run handed the rule a history that already held the call being judged)`);
    assert.equal(outcome.stopReason?.code, STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED, 'and the stop is the budget speaking, not a policy denial');
  }
});

// ── per-turn fan-out: every ATTEMPT is charged ─────────────────────────────

const FLOOD_CAPS = { tools: true, json: true, streaming: false, maxContextTokens: 128_000, deterministic: false, mock: true };
/** One completion carrying `n` tool calls, every one schema-invalid — they fail BEFORE the budget step. */
function floodProvider(n) {
  let called = 0;
  return {
    get called() {
      return called;
    },
    model: 'flood-double',
    capabilities: () => FLOOD_CAPS,
    async complete() {
      called += 1;
      return {
        text: '',
        toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${called}_${i}`, name: 'get_market_quote', arguments: { ticker: i } })),
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      };
    },
  };
}

test('a completion carrying thousands of schema-invalid tool calls is cut off at maxToolCalls attempts, not ground through', async () => {
  // Invalid, unknown-tool and malformed calls fail BEFORE the executor's budget step, so only an
  // attempt ledger can bound them. Before call 4 this run recorded 10 000 attempts while the
  // tool-call budget counted 0; only the iteration budget eventually stopped it.
  const provider = floodProvider(5000);
  const { runtime } = buildRuntime({ providers: { mock: provider } });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 5000, 'a flooded run');

  const cap = run.budget.limits.maxToolCalls;
  assert.equal(outcome.stopReason?.code, STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED);
  assert.equal(provider.called, 1, 'the run stopped inside the first turn, not after two');
  assert.equal(run.toolCalls.length, cap + 1, `${cap} attempts allowed, the next one refused and recorded`);
  assert.equal(runtime.runStore.runEvents(run.runId).filter((e) => e.type === EVENT_TYPES.TOOL_EXECUTED).length, 0);
});

test('the same cap holds for a free-form plan step (the planned loop used to process every remaining call)', async () => {
  const provider = floodProvider(5000);
  const { runtime } = buildRuntime({ providers: { mock: provider } });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await within(
    run.loop({ mode: 'planned', goal: 'flood', steps: [{ id: 's1', description: 'do it' }], ...request() }),
    5000,
    'a flooded planned run',
  );

  assert.equal(outcome.stopReason?.code, STOP_REASONS.TOOL_CALL_BUDGET_EXCEEDED);
  assert.equal(run.toolCalls.length, run.budget.limits.maxToolCalls + 1);
});

// ── what maxStepAttempts does and does not bound ───────────────────────────

test('a failed step is never re-run in place: attempts stays at 1, so the only retry is a replan (which maxReplans bounds)', async () => {
  const failing = { id: 's1', description: 'bad call', tool: 'get_market_quote', args: { ticker: 7 } }; // schema-invalid on purpose
  const good = { id: 'r1', description: 'good call', tool: 'get_market_quote', args: { ticker: 'AAPL' } };
  const { runtime } = buildRuntime({ mockScript: [{ text: 'done' }] });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock', planning: { maxStepAttempts: 3 } });
  const outcome = await run.loop({ mode: 'planned', goal: 'quote', steps: [failing], replanSteps: [good], ...request() });

  assert.equal(outcome.stopReason, null, `${outcome.stopReason?.code}: ${outcome.stopReason?.message}`);
  const [original, replacement] = outcome.plan.steps;
  assert.equal(original.status, 'failed');
  assert.equal(original.attempts, 1, 'the failed step was started once and never started again');
  assert.equal(replacement.status, 'done');
  assert.equal(run.planner.limits.maxStepAttempts, 3, 'the ceiling is carried and reported …');
  assert.ok(Math.max(...outcome.plan.steps.map((s) => s.attempts)) <= 1, '… but no code path can reach it: it is not an independent bound');
});

// ── token accounting ───────────────────────────────────────────────────────

test('a provider that reports no usage is still charged an estimate, so the token budget binds', async () => {
  let call = 0;
  const silent = {
    model: 'no-usage-double',
    capabilities: () => ({ tools: true, json: true, streaming: false, maxContextTokens: 128_000, deterministic: false, mock: true }),
    async complete() {
      call += 1;
      return call === 1
        ? { text: '', toolCalls: [{ id: 'c1', name: 'no_op', arguments: {} }] } // note: no `usage`
        : { text: 'would be the answer', toolCalls: [] };
    },
  };
  const { runtime } = buildRuntime({ budgets: { maxTokens: 50 }, providers: { mock: silent } });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await run.loop({ mode: 'model', ...request({ userMessage: 'x'.repeat(800) }) });

  assert.equal(outcome.stopReason?.code, STOP_REASONS.TOKEN_BUDGET_EXCEEDED);
  assert.equal(run.modelCalls.length, 1, 'the second call must be refused before it is made');
  assert.ok(run.budget.tokens > 50, 'the estimate was recorded');
});

// ── free-form steps ────────────────────────────────────────────────────────

test('a free-form plan step may carry several tool calls (parallel tool calls are a normal turn)', async () => {
  const script = [
    planTurn([{ id: 's1', description: 'fetch the quote and the portfolio' }]),
    {
      toolCalls: [
        { name: 'get_market_quote', arguments: { ticker: 'AAPL' } },
        { name: 'get_portfolio_state', arguments: {} },
      ],
    },
    { text: 'final summary' },
  ];
  const { runtime } = buildRuntime({ mockScript: script });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await run.loop({ mode: 'planned', goal: 'quote and portfolio', ...request() });

  assert.equal(outcome.stopReason, null, `stopped for ${outcome.stopReason?.code}: ${outcome.stopReason?.message}`);
  assert.deepEqual(run.toolCalls.map((c) => c.name), ['get_market_quote', 'get_portfolio_state']);
  assert.equal(outcome.finalText, 'final summary');
  assert.equal(run.state, STATES.COMPLETED);
});

// ── transition fuel ────────────────────────────────────────────────────────

test('a run whose state machine runs out of fuel stops as TRANSITION_LIMIT, persisted', async () => {
  const { runtime } = buildRuntime({ mockScript: [{ toolCalls: [{ name: 'no_op', arguments: {} }] }, { text: 'done' }] });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock', maxTransitions: 3 });
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 4000, 'the run');

  assert.equal(outcome.stopReason?.code, 'TRANSITION_LIMIT');
  assert.equal(run.state, STATES.FAILED);
  assert.ok(run.stateMachine.seq <= 3 + 1, 'at most the fuel, plus the one terminal move that closes the run');
  const record = run.finish({ status: terminalStatusFor(run, outcome), reason: outcome.stopReason.code });
  assert.equal(record.status, STATES.FAILED);
  assert.equal(runtime.runStore.getRun(run.runId).reason, 'TRANSITION_LIMIT');
});

test('a fault inside the loop is contained: FAILED / INTERNAL_ERROR, a run.error event, and the run is closable', async () => {
  // A completion whose `toolCalls` explodes on the third read: the loop reads it
  // after runModel() has already accepted the completion, i.e. outside any
  // try/catch the loop owns.
  let reads = 0;
  const corrupt = {
    model: 'corrupt-double',
    capabilities: () => ({ tools: true, json: true, streaming: false, maxContextTokens: 128_000, deterministic: false, mock: true }),
    async complete() {
      return {
        text: '',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        get toolCalls() {
          reads += 1;
          if (reads > 2) throw new Error('corrupt completion');
          return [];
        },
      };
    },
  };
  const { runtime } = buildRuntime({ providers: { mock: corrupt } });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 4000, 'the run');

  assert.equal(outcome.stopReason?.code, 'INTERNAL_ERROR');
  assert.match(outcome.stopReason.message, /corrupt completion/);
  assert.equal(run.state, STATES.FAILED);
  const events = runtime.runStore.runEvents(run.runId);
  assert.ok(events.some((e) => e.type === EVENT_TYPES.RUN_ERROR && e.payload.code === 'INTERNAL_ERROR'));
  const record = run.finish({ status: terminalStatusFor(run, outcome), reason: outcome.stopReason.code });
  assert.equal(record.status, STATES.FAILED);
});

test('a caller error before the run has started is still thrown, not swallowed', async () => {
  const { runtime } = buildRuntime();
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  await assert.rejects(() => run.loop({ mode: 'bogus', ...request() }), /unknown mode/);
});

// ── the bound that matters most: an adversary cannot make a run unbounded ──

test('an adversarial model that asks for a fresh tool call forever is stopped by the budgets', async () => {
  const provider = runawayProvider();
  const { runtime } = buildRuntime({ providers: { mock: provider } });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await within(run.loop({ mode: 'model', ...request() }), 4000, 'a runaway model');

  assert.ok(outcome.stopReason, 'it must have been stopped');
  assert.ok(provider.calls.length <= 8, `the profile allows 8 iterations; the model was called ${provider.calls.length} times`);
  assert.ok(run.toolCalls.length <= 12);
  assert.ok(run.stateMachine.seq <= run.stateMachine.fuel.limit + 1);
  assert.ok(run.stateMachine.seq / Math.max(1, run.budget.iterations) <= TRANSITIONS_PER_ITERATION);
});

test('an approval-gated call still pauses the run — the hardening did not widen any gate', async () => {
  const sink = [];
  const { runtime } = buildRuntime({
    tools: [gatedWriteTool(sink)],
    profiles,
    mockScript: [{ toolCalls: [{ name: 'gated_write', arguments: { value: 'v1' } }] }, { text: 'never reached' }],
  });
  const run = runtime.createRun({ agentId: 'bounds_agent', provider: 'mock' });
  const outcome = await run.loop({ mode: 'model', ...request() });

  assert.equal(run.state, STATES.WAITING_FOR_APPROVAL);
  assert.equal(outcome.stopReason, null);
  assert.deepEqual(sink, [], 'the gated tool did not execute without an approval');
  assert.equal(runtime.approvals.listPending().length, 1);
});
