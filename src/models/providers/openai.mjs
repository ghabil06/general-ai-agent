/**
 * OpenAI chat-completions ADAPTER — a real HTTP client.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * This is a real adapter, not a mock and not a simulation: it performs an
 * actual `POST {baseUrl}/chat/completions` over global `fetch` (Node >= 20) and
 * translates the response into the provider contract in
 * `src/models/provider.mjs`. No SDK, no dependency.
 *
 * Behaviour that matters:
 *   - No `OPENAI_API_KEY` in the environment => `ModelError(AUTH_MISSING)`.
 *     It never returns a fabricated completion to keep a run alive.
 *   - HTTP 401/403 => AUTH_MISSING, 429 => RATE_LIMITED, 5xx/network =>
 *     PROVIDER_UNAVAILABLE, timeout via AbortController => TIMEOUT, a JSON body
 *     that does not match the contracted shape => MALFORMED_OUTPUT.
 *   - The API key is read from `env` at call time and is never logged, never
 *     stored in a call record and never included in an error message.
 *
 * Untested against the live API in this repository's CI: no key is configured,
 * so the offline suite exercises only the AUTH_MISSING path. Everything else is
 * a translation of documented HTTP behaviour. Treat the first live call as the
 * test.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ModelError, MODEL_ERROR_CODES, DEFAULT_CAPABILITIES, normalizeCompletion } from '../provider.mjs';

/** Map the runtime's tool definitions to OpenAI's `tools` array. */
function toOpenAiTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Map contract messages to OpenAI's `messages` array. */
function toOpenAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: String(message.content ?? '') };
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      };
    }
    return { role: message.role, content: String(message.content ?? '') };
  });
}

function parseToolArguments(raw, { provider, model }) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, `tool call arguments were not valid JSON: ${err.message}`, {
      provider,
      model,
    });
  }
}

export function createOpenAiProvider({
  id = 'openai',
  apiKey = process.env.OPENAI_API_KEY,
  baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  organization = process.env.OPENAI_ORG_ID,
  fetchImpl = globalThis.fetch,
  maxContextTokens = 128_000,
  now = () => Date.now(),
} = {}) {
  const caps = Object.freeze({
    ...DEFAULT_CAPABILITIES,
    tools: true,
    json: true,
    maxContextTokens,
    deterministic: false,
    mock: false,
  });

  async function complete({ messages = [], tools = [], responseFormat = 'text', timeoutMs = 30_000, signal, temperature } = {}) {
    if (!apiKey) {
      throw new ModelError(
        MODEL_ERROR_CODES.AUTH_MISSING,
        'OPENAI_API_KEY is not set; refusing to fabricate a completion. Configure the key or select the mock provider.',
        { provider: id, model },
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new ModelError(MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE, 'global fetch is unavailable in this Node runtime', {
        provider: id,
        model,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const body = {
      model,
      messages: toOpenAiMessages(messages),
      ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: 'auto' } : {}),
      ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };

    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`, // never logged; stripped by redact()
          ...(organization ? { 'openai-organization': organization } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, `openai request exceeded ${timeoutMs}ms`, {
          provider: id,
          model,
          cause: err,
        });
      }
      throw new ModelError(MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE, `openai request failed: ${err.message}`, {
        provider: id,
        model,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }

    if (!response.ok) {
      const status = response.status;
      const text = await response.text().catch(() => '');
      const code =
        status === 401 || status === 403
          ? MODEL_ERROR_CODES.AUTH_MISSING
          : status === 429
            ? MODEL_ERROR_CODES.RATE_LIMITED
            : MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE;
      throw new ModelError(code, `openai HTTP ${status}: ${text.slice(0, 300)}`, { provider: id, model, status });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, `openai response was not JSON: ${err.message}`, {
        provider: id,
        model,
      });
    }

    const choice = payload?.choices?.[0];
    if (!choice) {
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, 'openai response had no choices[0]', {
        provider: id,
        model,
      });
    }

    const message = choice.message ?? {};
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: parseToolArguments(call.function?.arguments, { provider: id, model }),
    }));

    return normalizeCompletion(
      {
        text: message.content ?? '',
        toolCalls,
        usage: {
          promptTokens: payload.usage?.prompt_tokens,
          completionTokens: payload.usage?.completion_tokens,
          totalTokens: payload.usage?.total_tokens,
        },
        raw: { finishReason: choice.finish_reason, model: payload.model, receivedAt: now() },
      },
      { provider: id, model },
    );
  }

  return {
    id: () => id,
    capabilities: () => caps,
    complete,
    model,
    /** Never includes the key itself. */
    describe: () => ({ id, model, baseUrl, apiKeyPresent: Boolean(apiKey) }),
    isMock: false,
    /** Only routable when a key is present; the router fails closed on this. */
    isAvailable: () => Boolean(apiKey),
  };
}

export default createOpenAiProvider;
