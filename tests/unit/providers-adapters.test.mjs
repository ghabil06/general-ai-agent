/**
 * The real HTTP adapters, exercised without a network.
 *
 * `fetch` is injected, so these tests prove the request translation and the
 * response translation for OpenAI, Anthropic and an OpenAI-compatible local
 * endpoint. They also prove the refusal path: with no credential the adapter
 * throws AUTH_MISSING and never fabricates a completion.
 *
 * Nothing here calls the internet. The live API shapes are documented guesses
 * until a key is configured and `npm run eval` runs — that limitation is stated
 * in each adapter's docstring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_ERROR_CODES, assertProvider, createProviderRegistry, isModelError } from '../../src/models/provider.mjs';
import { createOpenAiProvider } from '../../src/models/providers/openai.mjs';
import { createAnthropicProvider } from '../../src/models/providers/anthropic.mjs';
import { createLocalProvider } from '../../src/models/providers/local.mjs';

/** A fetch double that records the request and returns a canned response. */
function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    if (response instanceof Error) throw response;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? ''),
    };
  };
  impl.calls = calls;
  return impl;
}

// ── the provider contract ──────────────────────────────────────────────────

test('assertProvider rejects a half-implemented provider at wiring time', () => {
  assert.throws(() => assertProvider({}), /missing id\(\)/);
  assert.throws(() => assertProvider({ id: () => 'x', capabilities: () => ({}) }), /missing complete\(\)/);
  assert.throws(() => assertProvider({ id: () => 'x', capabilities: () => ({}), complete: () => {} }), /capabilities\(\) is missing/);
  assert.throws(() => assertProvider(null), /must be an object/);

  const good = {
    id: () => 'good',
    capabilities: () => ({ tools: true, json: true, streaming: false, maxContextTokens: 100, deterministic: false, mock: false }),
    complete: async () => ({ text: '', toolCalls: [], usage: {} }),
  };
  assert.equal(assertProvider(good), good);
});

test('the registry refuses an unknown provider with PROVIDER_UNAVAILABLE', () => {
  const registry = createProviderRegistry({ providers: [createLocalProvider({ baseUrl: '' })] });
  assert.throws(
    () => registry.get('openai'),
    (error) => {
      assert.equal(isModelError(error), true);
      assert.equal(error.code, MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE);
      return true;
    },
  );
});

// ── OpenAI ─────────────────────────────────────────────────────────────────

test('openai: without OPENAI_API_KEY the adapter refuses, and never fakes a completion', async () => {
  const provider = createOpenAiProvider({ apiKey: undefined });
  assert.equal(provider.isAvailable(), false);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.code, MODEL_ERROR_CODES.AUTH_MISSING);
      assert.equal(error.provider, 'openai');
      assert.equal(error.retryable, false);
      assert.match(error.message, /refusing to fabricate a completion/);
      return true;
    },
  );
});

test('openai: the request is translated and the response is normalised', async () => {
  const fetchImpl = fakeFetch({
    json: {
      model: 'gpt-4o-mini',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'Checking the PO.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'query_po_database', arguments: '{"poNumber":"990"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    },
  });
  const provider = createOpenAiProvider({ apiKey: 'test-key', fetchImpl, model: 'gpt-4o-mini', now: () => 1 });

  const completion = await provider.complete({
    messages: [
      { role: 'system', content: 'You are SVC_03.' },
      { role: 'user', content: 'Invoice #101' },
    ],
    tools: [{ name: 'query_po_database', description: 'look up a PO', inputSchema: { type: 'object', required: ['poNumber'] } }],
    responseFormat: 'json',
  });

  const [request] = fetchImpl.calls;
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'gpt-4o-mini');
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(request.body.tools[0].function.name, 'query_po_database');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });

  assert.equal(completion.text, 'Checking the PO.');
  assert.deepEqual(completion.toolCalls, [{ id: 'call_1', name: 'query_po_database', arguments: { poNumber: '990' } }]);
  assert.deepEqual(completion.usage, { promptTokens: 120, completionTokens: 30, totalTokens: 150 });

  assert.equal(provider.describe().apiKeyPresent, true);
  assert.equal(JSON.stringify(provider.describe()).includes('test-key'), false);
});

test('openai: HTTP status codes map onto the typed error codes', async () => {
  const cases = [
    [401, MODEL_ERROR_CODES.AUTH_MISSING],
    [403, MODEL_ERROR_CODES.AUTH_MISSING],
    [429, MODEL_ERROR_CODES.RATE_LIMITED],
    [500, MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE],
  ];
  for (const [status, expected] of cases) {
    const provider = createOpenAiProvider({ apiKey: 'k', fetchImpl: fakeFetch({ ok: false, status, text: 'boom' }) });
    await assert.rejects(
      () => provider.complete({ messages: [] }),
      (error) => {
        assert.equal(error.code, expected, `HTTP ${status}`);
        assert.equal(error.status, status);
        assert.equal(error.retryable, expected !== MODEL_ERROR_CODES.AUTH_MISSING);
        return true;
      },
    );
  }
});

test('openai: a network failure, a bad body and malformed tool arguments are typed', async () => {
  const networkFailure = createOpenAiProvider({ apiKey: 'k', fetchImpl: fakeFetch(new Error('ECONNREFUSED')) });
  await assert.rejects(() => networkFailure.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE);

  const badBody = createOpenAiProvider({ apiKey: 'k', fetchImpl: fakeFetch({ json: { choices: [] } }) });
  await assert.rejects(() => badBody.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.MALFORMED_OUTPUT);

  const badArgs = createOpenAiProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch({ json: { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{not json' } }] } }] } }),
  });
  await assert.rejects(() => badArgs.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.MALFORMED_OUTPUT);
});

test('openai: an aborted caller signal becomes TIMEOUT and is reported as retryable', async () => {
  const provider = createOpenAiProvider({
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      const rejection = new Error('aborted');
      if (init.signal.aborted) throw rejection;
      await new Promise((resolve) => init.signal.addEventListener('abort', resolve, { once: true }));
      throw rejection;
    },
  });
  const controller = new AbortController();
  const pending = provider.complete({ messages: [], timeoutMs: 50_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, MODEL_ERROR_CODES.TIMEOUT);
    assert.equal(error.retryable, true);
    return true;
  });
});

// ── Anthropic ──────────────────────────────────────────────────────────────

test('anthropic: without ANTHROPIC_API_KEY the adapter refuses', async () => {
  const provider = createAnthropicProvider({ apiKey: undefined });
  assert.equal(provider.isAvailable(), false);
  await assert.rejects(
    () => provider.complete({ messages: [] }),
    (error) => {
      assert.equal(error.code, MODEL_ERROR_CODES.AUTH_MISSING);
      assert.match(error.message, /ANTHROPIC_API_KEY is not set/);
      return true;
    },
  );
});

test('anthropic: system is lifted out of messages, tool calls are translated both ways', async () => {
  const fetchImpl = fakeFetch({
    json: {
      model: 'claude-sonnet-4-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Triage:' },
        { type: 'tool_use', id: 'toolu_1', name: 'check_ip_allowlist', input: { ip: '10.20.0.31' } },
      ],
      usage: { input_tokens: 200, output_tokens: 40 },
    },
  });
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetchImpl, now: () => 1 });

  const completion = await provider.complete({
    messages: [
      { role: 'system', content: 'You are SVC_04.' },
      { role: 'user', content: 'ALERT rule id 31103' },
      { role: 'assistant', toolCalls: [{ id: 'toolu_0', name: 'query_alert_context', arguments: { alertId: '31103' } }] },
      { role: 'tool', toolCallId: 'toolu_0', content: '{"found":true}' },
    ],
    tools: [{ name: 'check_ip_allowlist', description: 'check the allowlist', inputSchema: { type: 'object' } }],
    responseFormat: 'json',
  });

  const [request] = fetchImpl.calls;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.body.system.includes('You are SVC_04.'), true);
  assert.match(request.body.system, /single strict JSON object/, 'json mode is requested by instruction for Anthropic');
  assert.equal(request.body.messages.length, 3, 'the system message is not in messages[]');
  assert.equal(request.body.tools[0].input_schema.type, 'object');
  assert.equal(request.body.messages[1].content[0].type, 'tool_use', 'an assistant turn with only tool calls has no text block');
  assert.equal(request.body.messages[1].content[0].input.alertId, '31103');
  assert.equal(request.body.messages[2].content[0].type, 'tool_result');
  assert.equal(request.body.messages[2].content[0].tool_use_id, 'toolu_0');

  assert.equal(completion.text, 'Triage:');
  assert.deepEqual(completion.toolCalls, [{ id: 'toolu_1', name: 'check_ip_allowlist', arguments: { ip: '10.20.0.31' } }]);
  assert.deepEqual(completion.usage, { promptTokens: 200, completionTokens: 40, totalTokens: 240 });
});

test('anthropic: a missing content[] array and a 429 are typed', async () => {
  const noContent = createAnthropicProvider({ apiKey: 'k', fetchImpl: fakeFetch({ json: { id: 'msg_1' } }) });
  await assert.rejects(() => noContent.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.MALFORMED_OUTPUT);

  const throttled = createAnthropicProvider({ apiKey: 'k', fetchImpl: fakeFetch({ ok: false, status: 429, text: 'slow down' }) });
  await assert.rejects(() => throttled.complete({ messages: [] }), (error) => error.code === MODEL_ERROR_CODES.RATE_LIMITED);
});

// ── local ──────────────────────────────────────────────────────────────────

test('local: unconfigured is a PLACEHOLDER that says so, not a silent no-op', async () => {
  const provider = createLocalProvider({ baseUrl: '' });
  assert.equal(provider.isAvailable(), false);
  assert.equal(provider.isPlaceholder, true);
  await assert.rejects(
    () => provider.complete({ messages: [] }),
    (error) => {
      assert.equal(error.code, MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE);
      assert.match(error.message, /local model is not configured/);
      assert.match(error.message, /LOCAL_MODEL_BASE_URL/);
      return true;
    },
  );
  assert.equal(provider.describe().baseUrl, null);
});

test('local: when configured it performs a real OpenAI-compatible request', async () => {
  const fetchImpl = fakeFetch({
    json: {
      model: 'llama3.1:8b',
      choices: [{ finish_reason: 'stop', message: { content: '{"action":"auto_approve"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
  const provider = createLocalProvider({ baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl, model: 'llama3.1:8b' });

  const completion = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
  const [request] = fetchImpl.calls;
  assert.equal(request.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(request.headers.authorization, undefined, 'no key is sent when none is configured');
  assert.equal(completion.text, '{"action":"auto_approve"}');
  assert.equal(provider.isAvailable(), true);
});

test('local: tools are refused unless the operator enables them', async () => {
  const toolless = createLocalProvider({ baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl: fakeFetch({ json: {} }), toolsEnabled: false });
  assert.equal(toolless.capabilities().tools, false);
  await assert.rejects(
    () => toolless.complete({ messages: [], tools: [{ name: 'no_op' }] }),
    (error) => {
      assert.equal(error.code, MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE);
      assert.match(error.message, /LOCAL_MODEL_TOOLS/);
      return true;
    },
  );

  const withTools = createLocalProvider({
    baseUrl: 'http://127.0.0.1:11434/v1',
    fetchImpl: fakeFetch({ json: { choices: [{ message: { content: 'ok' } }] } }),
    toolsEnabled: true,
  });
  assert.equal(withTools.capabilities().tools, true);
  const completion = await withTools.complete({ messages: [], tools: [{ name: 'no_op', inputSchema: { type: 'object' } }] });
  assert.equal(completion.text, 'ok');
  assert.equal(withTools.capabilities().local, true);
});

test('no adapter claims to be a model: every one reports mock:false', () => {
  for (const provider of [
    createOpenAiProvider({ apiKey: 'k' }),
    createAnthropicProvider({ apiKey: 'k' }),
    createLocalProvider({ baseUrl: 'http://127.0.0.1:11434/v1' }),
  ]) {
    assert.equal(provider.capabilities().mock, false);
    assert.equal(provider.isMock, false);
    assert.equal(provider.capabilities().deterministic, false);
  }
});
