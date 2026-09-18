/**
 * Mock provider: the deterministic test double, including every failure mode it
 * has to be able to simulate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockProvider } from '../../src/models/providers/mock.mjs';
import { MODEL_ERROR_CODES, createProviderRegistry, isModelError, normalizeCompletion } from '../../src/models/provider.mjs';

test('the mock is loudly a mock', async () => {
  const provider = createMockProvider();
  const capabilities = provider.capabilities();
  assert.equal(capabilities.mock, true);
  assert.equal(capabilities.deterministic, true);
  assert.equal(provider.isMock, true);
  assert.equal(provider.id(), 'mock');

  const registry = createProviderRegistry({ providers: [provider] });
  assert.equal(registry.isAvailable('mock'), true);
  assert.equal(registry.describe()[0].mock, true);
});

test('scripted turns are replayed in order: text, tool calls and JSON', async () => {
  const provider = createMockProvider({
    script: [
      { text: 'thinking out loud' },
      { toolCalls: [{ name: 'query_po_database', arguments: { poNumber: '990' } }] },
      { text: 'done', toolCalls: [{ name: 'calculate_tax_variance', arguments: { expectedTax: 1, actualTax: 1 } }] },
      { json: { action: 'auto_approve' } },
    ],
  });

  const first = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(first.text, 'thinking out loud');
  assert.deepEqual(first.toolCalls, []);

  const second = await provider.complete({ messages: [] });
  assert.equal(second.text, '');
  assert.equal(second.toolCalls.length, 1);
  assert.equal(second.toolCalls[0].name, 'query_po_database');
  assert.deepEqual(second.toolCalls[0].arguments, { poNumber: '990' });
  assert.match(second.toolCalls[0].id, /^call_mock_2_0$/);

  const third = await provider.complete({ messages: [] });
  assert.equal(third.text, 'done');
  assert.equal(third.toolCalls[0].name, 'calculate_tax_variance');

  const fourth = await provider.complete({ messages: [] });
  assert.deepEqual(JSON.parse(fourth.text), { action: 'auto_approve' });
  assert.equal(provider.callCount, 4);
});

test('get_market_quote-style round trip: usage is reported and normalised', async () => {
  const provider = createMockProvider({ script: [{ text: 'ok', usage: { promptTokens: 12, completionTokens: 3 } }] });
  const completion = await provider.complete({ messages: [] });
  assert.deepEqual(completion.usage, { promptTokens: 12, completionTokens: 3, totalTokens: 15 });
});

test('every received call is recorded — messages, tools and response', async () => {
  const provider = createMockProvider({ script: [{ text: 'a' }, { text: 'b' }], now: () => 42 });
  await provider.complete({ messages: [{ role: 'system', content: 'be careful' }], tools: [{ name: 'no_op', inputSchema: { type: 'object' } }], responseFormat: 'json' });
  await provider.complete({ messages: [{ role: 'user', content: 'x' }] });

  assert.equal(provider.calls.length, 2);
  const [first] = provider.calls;
  assert.equal(first.index, 1);
  assert.equal(first.outcome, 'OK');
  assert.equal(first.responseFormat, 'json');
  assert.equal(first.tools.length, 1);
  assert.equal(first.messages[0].content, 'be careful');
  assert.equal(first.at, 42);
  assert.equal(provider.lastCall().index, 2);
});

test('simulated provider failure: failOnCall with a typed code', async () => {
  const provider = createMockProvider({
    script: [{ text: 'fine' }, { text: 'never reached' }],
    failOnCall: 2,
    failureCode: MODEL_ERROR_CODES.RATE_LIMITED,
    failureMessage: 'rate limited by the provider',
  });
  assert.equal((await provider.complete({ messages: [] })).text, 'fine');

  await assert.rejects(
    () => provider.complete({ messages: [] }),
    (error) => {
      assert.equal(isModelError(error), true);
      assert.equal(error.code, MODEL_ERROR_CODES.RATE_LIMITED);
      assert.equal(error.retryable, true);
      assert.equal(error.provider, 'mock');
      assert.match(error.message, /rate limited by the provider/);
      return true;
    },
  );
  assert.equal(provider.calls[1].outcome, 'FAILURE');
});

test('simulated malformed output: both the returned-bad-JSON and the thrown variants', async () => {
  const returnsBadJson = createMockProvider({ malformedOnCall: 1, script: [{ text: 'unused' }] });
  const completion = await returnsBadJson.complete({ messages: [] });
  assert.equal(completion.toolCalls.length, 0);
  assert.throws(() => JSON.parse(completion.text), SyntaxError, 'the scripted text really is invalid JSON');
  assert.equal(returnsBadJson.calls[0].outcome, 'MALFORMED_TEXT');

  const throwsMalformed = createMockProvider({ script: [{ throwMalformed: true }] });
  await assert.rejects(
    () => throwsMalformed.complete({ messages: [] }),
    (error) => {
      assert.equal(error.code, MODEL_ERROR_CODES.MALFORMED_OUTPUT);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('simulated timeout: timeoutOnCall, timeoutAfterMs, a scripted turn and a caller timeout', async () => {
  const onCall = createMockProvider({ script: [{ text: 'ok' }], timeoutOnCall: 1 });
  await assert.rejects(() => onCall.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.TIMEOUT);

  const afterMs = createMockProvider({ script: [{ text: 'ok' }], timeoutAfterMs: 5 });
  await assert.rejects(() => afterMs.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.TIMEOUT);

  const scripted = createMockProvider({ script: [{ timeout: true }] });
  await assert.rejects(() => scripted.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.TIMEOUT);

  const slow = createMockProvider({ script: [{ text: 'slow', delayMs: 50 }] });
  await assert.rejects(
    () => slow.complete({ messages: [], timeoutMs: 5 }),
    (error) => error.code === MODEL_ERROR_CODES.TIMEOUT,
  );

  assert.equal(onCall.calls[0].outcome, 'TIMEOUT');
});

test('scripted inline errors and exhaustion are explicit, never silent', async () => {
  const provider = createMockProvider({ script: [{ error: { code: MODEL_ERROR_CODES.AUTH_MISSING, message: 'no key' } }] });
  await assert.rejects(() => provider.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.AUTH_MISSING);

  const exhausted = createMockProvider({ script: [{ text: 'only one' }] });
  await exhausted.complete({ messages: [] });
  await assert.rejects(
    () => exhausted.complete({ messages: [] }),
    (error) => {
      assert.equal(error.code, MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE);
      assert.match(error.message, /script exhausted after 1 turn/);
      return true;
    },
  );

  const repeating = createMockProvider({ script: [{ text: 'again' }], onExhausted: 'repeat-last' });
  assert.equal((await repeating.complete({ messages: [] })).text, 'again');
  assert.equal((await repeating.complete({ messages: [] })).text, 'again');

  const empty = createMockProvider({ script: [], onExhausted: 'empty-text' });
  assert.equal((await empty.complete({ messages: [] })).text, '');
});

test('an aborted signal is a timeout, not a fabricated answer', async () => {
  const provider = createMockProvider({ script: [{ text: 'x' }] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => provider.complete({ messages: [], signal: controller.signal }),
    (error) => error.code === MODEL_ERROR_CODES.TIMEOUT,
  );
  assert.equal(provider.calls[0].outcome, 'ABORTED');
});

test('the mock is deterministic: the same script yields the same answers twice', async () => {
  const script = [{ toolCalls: [{ name: 'no_op', arguments: { note: 'x' } }] }, { text: 'end' }];
  const a = createMockProvider({ script });
  const b = createMockProvider({ script });
  const runA = [await a.complete({ messages: [] }), await a.complete({ messages: [] })];
  const runB = [await b.complete({ messages: [] }), await b.complete({ messages: [] })];
  assert.deepEqual(runA.map((c) => c.toolCalls[0]?.name ?? c.text), runB.map((c) => c.toolCalls[0]?.name ?? c.text));
});

test('setScript/reset let a test change the script mid-run', async () => {
  const provider = createMockProvider({ script: [{ text: 'first' }] });
  assert.equal((await provider.complete({ messages: [] })).text, 'first');
  provider.setScript([{ text: 'second' }]);
  provider.reset();
  assert.equal(provider.callCount, 0);
  assert.equal((await provider.complete({ messages: [] })).text, 'second');
});

test('normalizeCompletion rejects shapes that break the contract', () => {
  assert.throws(() => normalizeCompletion({ text: 5 }), /MALFORMED_OUTPUT|text/);
  assert.throws(() => normalizeCompletion({ toolCalls: {} }), /toolCalls/);
  assert.throws(() => normalizeCompletion({ toolCalls: [{}] }), /name/);
  assert.throws(() => normalizeCompletion({ toolCalls: [{ name: 'x', arguments: 'not an object' }] }), /arguments/);
  assert.throws(() => normalizeCompletion(null), /must be an object/);

  const ok = normalizeCompletion({ text: 'hi', toolCalls: [{ name: 'no_op' }], usage: { totalTokens: 7 } });
  assert.equal(ok.text, 'hi');
  assert.deepEqual(ok.toolCalls[0].arguments, {});
  assert.equal(ok.usage.totalTokens, 7);
  assert.equal(ok.toolCalls[0].id, 'no_op-0', 'a missing id is synthesised deterministically');
});
