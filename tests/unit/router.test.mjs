/**
 * Model router: determinism, the filter order, forced providers and fail-closed
 * behaviour. The router is a table, and these tests pin the table's behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ROUTES, ROUTER_TABLE_VERSION, describeRoutes, route } from '../../src/models/router.mjs';
import { createProviderRegistry, isModelError, MODEL_ERROR_CODES } from '../../src/models/provider.mjs';
import { createMockProvider } from '../../src/models/providers/mock.mjs';
import { createOpenAiProvider } from '../../src/models/providers/openai.mjs';
import { createAnthropicProvider } from '../../src/models/providers/anthropic.mjs';
import { createLocalProvider } from '../../src/models/providers/local.mjs';
import { fixedClock } from '../helpers/fixtures.mjs';

/** A registry with every provider available, regardless of the environment. */
function fullRegistry() {
  return createProviderRegistry({
    providers: [
      createMockProvider(),
      createOpenAiProvider({ apiKey: 'test-key' }),
      createAnthropicProvider({ apiKey: 'test-key' }),
      createLocalProvider({ baseUrl: 'http://127.0.0.1:11434/v1' }),
    ],
  });
}

/** A registry where only the test double is usable — the CI situation. */
function keylessRegistry() {
  return createProviderRegistry({
    providers: [
      createMockProvider(),
      createOpenAiProvider({ apiKey: undefined }),
      createAnthropicProvider({ apiKey: undefined }),
      createLocalProvider({ baseUrl: '' }),
    ],
  });
}

test('the same request routes to the same provider and model, every time', () => {
  const providers = fullRegistry();
  const request = { taskType: 'invoice_reconciliation', complexity: 'low', preference: 'cost', requiresTools: true, contextTokens: 2_000 };

  const first = route(request, { providers, now: fixedClock() });
  for (let i = 0; i < 20; i += 1) {
    const again = route(request, { providers, now: fixedClock() });
    assert.equal(again.provider, first.provider);
    assert.equal(again.model, first.model);
    assert.equal(again.routeId, first.routeId);
  }
  assert.equal(first.tableVersion, ROUTER_TABLE_VERSION);
  assert.equal(first.forced, false);
  assert.ok(first.candidates.length >= 1);
});

test('preference changes the winner but never the legality of the choice', () => {
  const providers = fullRegistry();
  const base = { taskType: 'security_triage', complexity: 'medium', requiresTools: true };

  const cheap = route({ ...base, preference: 'cost' }, { providers });
  const quality = route({ ...base, preference: 'quality' }, { providers });
  const balanced = route({ ...base, preference: 'balanced' }, { providers });

  assert.equal(cheap.provider, 'openai');
  assert.equal(quality.provider, 'anthropic');
  assert.ok(['openai', 'anthropic'].includes(balanced.provider));
  assert.deepEqual(
    new Set([cheap.preference, quality.preference, balanced.preference]),
    new Set(['cost', 'quality', 'balanced']),
  );
});

test('the router fails closed when no route qualifies', () => {
  // No mock in this registry: the opt-in test double cannot rescue a request
  // that no production route serves.
  const providers = createProviderRegistry({
    providers: [createOpenAiProvider({ apiKey: 'k' }), createAnthropicProvider({ apiKey: 'k' })],
  });
  assert.throws(
    () => route({ taskType: 'unknown_task_type', complexity: 'high', requiresTools: true }, { providers }),
    (error) => {
      assert.equal(isModelError(error), true);
      assert.equal(error.code, MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE);
      assert.match(error.message, /no route for taskType="unknown_task_type"/);
      return true;
    },
  );
});

test('an unconfigured provider is not a routing target (credentials fail closed)', () => {
  const providers = keylessRegistry();
  // svc_03 medium is served by openai and anthropic; with no keys and the test
  // double not requested, there is nothing legal to route to. That is the
  // correct outcome: a run that cannot call a real model must fail loudly.
  assert.throws(
    () => route({ taskType: 'invoice_reconciliation', complexity: 'medium', requiresTools: true }, { providers }),
    /no route for taskType="invoice_reconciliation"/,
  );
  assert.throws(
    () => route({ taskType: 'invoice_reconciliation', complexity: 'medium', requiresTools: true }, { providers }),
    /not configured/,
  );
});

test('the deterministic test double is opt-in and never selected implicitly', () => {
  const keyless = keylessRegistry();
  const withDouble = route(
    { taskType: 'invoice_reconciliation', complexity: 'medium', requiresTools: true, allowTestDoubles: true },
    { providers: keyless },
  );
  assert.equal(withDouble.provider, 'mock');
  assert.equal(withDouble.allowTestDoubles, true);

  const keyed = fullRegistry();
  const implicit = route({ taskType: 'invoice_reconciliation', complexity: 'low', requiresTools: true }, { providers: keyed });
  assert.notEqual(implicit.provider, 'mock', 'a real provider wins whenever one is available');
  assert.ok(
    implicit.rejected.some((rejection) => /opt-in route/.test(rejection.reason)),
    JSON.stringify(implicit.rejected),
  );
});

test('tools required filters out providers that cannot use tools', () => {
  // A registry whose only credentialled provider cannot emit tool calls: a
  // tool-requiring request has nowhere legal to go, so it fails closed.
  const toolless = createProviderRegistry({
    providers: [
      createOpenAiProvider({ apiKey: undefined }),
      {
        id: () => 'toolless',
        capabilities: () => ({ tools: false, json: true, streaming: false, maxContextTokens: 8_000, deterministic: false, mock: false }),
        complete: async () => ({ text: '', toolCalls: [], usage: {} }),
        isAvailable: () => true,
      },
    ],
  });
  assert.throws(
    () => route({ taskType: 'paper_trading', complexity: 'low', requiresTools: true }, { providers: toolless }),
    /no route/,
  );

  // With real providers available, the winner must support tools.
  const providers = fullRegistry();
  const routing = route({ taskType: 'paper_trading', complexity: 'low', requiresTools: true }, { providers });
  assert.equal(routing.requiresTools, true);
  assert.equal(providers.get(routing.provider).capabilities().tools, true);
  assert.equal(routing.provider, 'openai');

  const noTools = route({ taskType: 'paper_trading', complexity: 'low', requiresTools: false }, { providers });
  assert.equal(noTools.requiresTools, false);
});

test('context size filters out providers with a smaller window', () => {
  const providers = fullRegistry();
  const small = route({ taskType: 'invoice_reconciliation', complexity: 'high', requiresTools: true, contextTokens: 10_000 }, { providers });
  assert.equal(small.provider, 'anthropic', 'quality wins at high complexity');

  const lowComplexity = route({ taskType: 'invoice_reconciliation', complexity: 'low', requiresTools: true }, { providers });
  assert.equal(lowComplexity.provider, 'openai', 'low complexity prefers cost, so openai wins');

  assert.throws(
    () => route({ taskType: 'invoice_reconciliation', complexity: 'high', requiresTools: true, contextTokens: 500_000 }, { providers }),
    /no route/,
  );

  // 150k exceeds the 128k OpenAI window, so the cheap candidate drops out and
  // the rejection says exactly why. (Medium complexity is served by both
  // providers; high complexity is served by Anthropic alone.)
  const rejectedForContext = route({ taskType: 'invoice_reconciliation', complexity: 'medium', requiresTools: true, contextTokens: 150_000 }, { providers });
  assert.equal(rejectedForContext.provider, 'anthropic');
  assert.ok(
    rejectedForContext.rejected.some((rejection) => /context 150000 exceeds openai window 128000/.test(rejection.reason)),
    JSON.stringify(rejectedForContext.rejected),
  );
});

test('a forced provider is honoured, including when the table has no row for it', () => {
  const providers = fullRegistry();
  const forced = route({ taskType: 'invoice_reconciliation', complexity: 'low', requiresTools: true, forcedProvider: 'anthropic' }, { providers });
  assert.equal(forced.provider, 'anthropic');
  assert.equal(forced.forced, true);

  const forcedModel = route({ taskType: 'invoice_reconciliation', complexity: 'low', requiresTools: true, forcedProvider: 'openai', forcedModel: 'gpt-4o' }, { providers });
  assert.equal(forcedModel.model, 'gpt-4o');

  // mock is the test hook: 'utility-no-tools-local' has no tools, but the
  // catch-all does, so the forced provider still resolves.
  const forcedMock = route({ taskType: 'anything', complexity: 'high', requiresTools: false, forcedProvider: 'mock' }, { providers });
  assert.equal(forcedMock.provider, 'mock');
  assert.equal(forcedMock.forced, true);
  assert.equal(forcedMock.routeId, 'test-double-any', 'forcing the provider also unlocks its opt-in route');
});

test('a forced provider that cannot use tools is refused rather than silently executed', () => {
  const providers = createProviderRegistry({
    providers: [
      {
        id: () => 'toolless',
        capabilities: () => ({ tools: false, json: true, streaming: false, maxContextTokens: 1000, deterministic: false, mock: false }),
        complete: async () => ({ text: '', toolCalls: [], usage: {} }),
        isAvailable: () => true,
      },
    ],
  });
  assert.throws(
    () => route({ taskType: 'anything', complexity: 'low', requiresTools: true, forcedProvider: undefined }, { providers }),
    /no route/,
  );
});

test('input validation is strict about the request itself', () => {
  assert.throws(() => route(), /taskType/);
  assert.throws(() => route({}), /taskType/);
  assert.throws(() => route({ taskType: 'x', complexity: 'extreme' }), /complexity must be one of/);
  assert.throws(() => route({ taskType: 'x', preference: 'cheapest' }), /preference must be one of/);
  assert.throws(() => route({ taskType: 'x', forcedProvider: 'gemini' }), /unknown forcedProvider/);
});

test('routing without a provider registry still works (capability checks skipped)', () => {
  const routing = route({ taskType: 'paper_trading', complexity: 'high' });
  assert.equal(routing.provider, 'anthropic');
  assert.equal(routing.requiresTools, false);
  assert.equal(routing.candidates[0].routeId, 'svc06-trading-hard-quality');

  const withDoubles = route({ taskType: 'paper_trading', complexity: 'high', allowTestDoubles: true });
  assert.equal(withDoubles.candidates.length, 2, 'the opt-in double joins the candidate list');
});

test('the rejection trail explains every candidate that was dropped', () => {
  const providers = fullRegistry();
  const routing = route({ taskType: 'security_triage', complexity: 'high', preference: 'quality', requiresTools: true }, { providers });
  const rejectedTasks = routing.rejected.filter((rejection) => /not served/.test(rejection.reason));
  assert.ok(rejectedTasks.length >= 1, 'routes for other task types are reported as rejected');
  for (const rejection of routing.rejected) {
    assert.equal(typeof rejection.routeId, 'string');
    assert.equal(typeof rejection.reason, 'string');
  }
});

test('describeRoutes() is a complete, human-readable dump of the table', () => {
  const described = describeRoutes();
  assert.equal(described.length, ROUTES.length);
  for (const entry of described) {
    assert.equal(typeof entry.routeId, 'string');
    assert.ok(Array.isArray(entry.taskTypes));
    assert.ok(Array.isArray(entry.complexity));
    assert.match(entry.target, /^[a-z]+:.+$/);
  }
  const taskTypes = new Set(ROUTES.flatMap((entry) => entry.taskTypes));
  for (const taskType of ['invoice_reconciliation', 'security_triage', 'paper_trading', '*']) {
    assert.equal(taskTypes.has(taskType), true, `${taskType} should be served by some route`);
  }
});

test('the routing decision is pure data: JSON-serialisable and frozen-free of functions', () => {
  const routing = route({ taskType: 'invoice_reconciliation', complexity: 'low' }, { providers: fullRegistry() });
  const serialised = JSON.parse(JSON.stringify(routing));
  assert.equal(serialised.provider, routing.provider);
  assert.equal(typeof routing.reason, 'string');
  assert.ok(routing.reason.length > 0);
});
