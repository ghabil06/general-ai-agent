/**
 * Helpers for the bounded-execution tests. Not part of the runtime — nothing in
 * `src/` imports this.
 *
 * `tests/helpers/runtime.mjs` builds the common case (mock provider, fixed
 * clock). The bounded tests need three things it does not forward: a REAL clock
 * (deadlines are wall-clock), injected tools/profiles, and adversarial
 * providers. This file adds them without editing the shared helper.
 *
 * The adversarial providers are test doubles and are labelled that way: they
 * report `mock: true`, they never talk to anything, and what they prove is that
 * the RUNTIME stops — not how a live model behaves.
 */

import { createRuntime } from '../../src/index.mjs';
import { defineTool } from '../../src/tools/registry.mjs';
import { testConfig } from './runtime.mjs';
import { tempStorageDir, fixedClock, FIXTURES_DIR } from './fixtures.mjs';

/**
 * @param {object} [options]
 * @param {Array}   [options.mockScript]
 * @param {object}  [options.budgets]       runtime budget overrides
 * @param {object}  [options.env]           extra env for loadConfig (AGENT_MAX_ITERATIONS, ...)
 * @param {number}  [options.toolTimeoutMs]
 * @param {boolean} [options.realClock]     use Date.now() — required for deadline tests
 * @param {Function}[options.now]
 * @param {Array}   [options.tools]         extra tool definitions
 * @param {object}  [options.profiles]      extra agent profiles by id
 * @param {object}  [options.providers]     provider overrides by id
 * @param {string}  [options.storageDir]
 */
export function buildRuntime(options = {}) {
  const storageDir = options.storageDir ?? tempStorageDir('bounded-');
  const runtime = createRuntime({
    config: testConfig({
      storageDir,
      defaultProvider: 'mock',
      budgets: options.budgets,
      toolTimeoutMs: options.toolTimeoutMs,
      env: options.env,
    }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    mockScript: options.mockScript ?? [],
    now: options.now ?? (options.realClock ? () => Date.now() : fixedClock()),
    tools: options.tools ?? [],
    profiles: options.profiles ?? null,
    providers: options.providers ?? null,
  });
  return { runtime, storageDir };
}

// ── injected tools ─────────────────────────────────────────────────────────

const EMPTY_INPUT = { type: 'object', properties: {} };

/** A tool that finishes, but slowly. Not a hang: it resolves after `ms`. */
export function sleepTool(ms = 300) {
  return defineTool({
    name: 'sleep_tool',
    description: 'Resolves after a fixed delay, so a tool call can be in flight while something else happens.',
    inputSchema: EMPTY_INPUT,
    riskLevel: 'low',
    sideEffect: 'none',
    permissions: [],
    dataAccess: [],
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { slept: ms };
    },
  });
}

/** A tool that never resolves. */
export const hangTool = defineTool({
  name: 'hang_tool',
  description: 'Never resolves, so the executor timeout and the run deadline can be exercised.',
  inputSchema: EMPTY_INPUT,
  riskLevel: 'low',
  sideEffect: 'none',
  permissions: [],
  dataAccess: [],
  execute() {
    return new Promise(() => {});
  },
});

/**
 * A write tool that declares `requiresConfirmation`, so the policy kernel
 * answers REQUIRE_APPROVAL and the executor creates a real, persisted approval.
 * It records what it was asked to write, so a test can prove it ran only AFTER
 * an approval was granted.
 */
export function gatedWriteTool(sink = []) {
  return defineTool({
    name: 'gated_write',
    description: 'A write that a human must approve before it executes.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    riskLevel: 'medium',
    sideEffect: 'write',
    requiresConfirmation: true,
    permissions: ['test:write'],
    dataAccess: ['test/data'],
    async execute({ value }) {
      sink.push(value);
      return { wrote: value };
    },
  });
}

/** A profile that holds the injected tools plus two real read tools. */
export const BOUNDS_PROFILE = Object.freeze({
  id: 'bounds_agent',
  name: 'Bounded-Execution Test Agent',
  taskType: 'test_scenario',
  promptPath: null,
  datasetPath: null,
  tools: ['no_op', 'sleep_tool', 'hang_tool', 'gated_write', 'get_market_quote', 'get_portfolio_state'],
  permissions: ['market:read', 'portfolio:read', 'test:write'],
  dataAccess: ['trading/market', 'trading/portfolio', 'test/data'],
  limits: { maxToolCalls: 12, maxIterations: 8, maxTokens: 60_000 },
  actionPolicy: {},
  allowDestructiveActions: false,
});

// ── adversarial providers (test doubles) ───────────────────────────────────

const CAPABILITIES = Object.freeze({
  tools: true,
  json: true,
  streaming: false,
  maxContextTokens: 128_000,
  deterministic: false,
  mock: true,
});

/** A provider whose `complete()` never settles and ignores its abort signal. */
export function hungProvider() {
  const calls = [];
  return {
    calls,
    model: 'hung-double',
    capabilities: () => CAPABILITIES,
    complete(request) {
      calls.push(request);
      return new Promise(() => {});
    },
  };
}

/**
 * An adversarial model: it ALWAYS asks for another tool call, never repeats
 * itself (fresh arguments every time, so loop detection cannot catch it) and
 * never gives a final answer. Only a limit can stop it.
 */
export function runawayProvider({ tool = 'get_market_quote' } = {}) {
  let n = 0;
  const calls = [];
  return {
    calls,
    model: 'runaway-double',
    capabilities: () => CAPABILITIES,
    async complete(request) {
      n += 1;
      calls.push(request);
      return {
        text: '',
        toolCalls: [{ id: `call_runaway_${n}`, name: tool, arguments: { ticker: `T${n}` } }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
}

/** Run `promise`, but fail the test (instead of hanging it) if it takes longer than `ms`. */
export async function within(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms — it is hung`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A plan-proposal turn for the mock provider. */
export function planTurn(steps, extra = {}) {
  return { text: JSON.stringify({ steps }), ...extra };
}
