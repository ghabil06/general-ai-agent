/**
 * Anthropic Messages API ADAPTER — a real HTTP client.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Real adapter, not a mock: performs an actual `POST {baseUrl}/messages` over
 * global `fetch` (Node >= 20) with the `x-api-key` / `anthropic-version`
 * headers, and translates the response into the provider contract in
 * `src/models/provider.mjs`. No SDK, no dependency.
 *
 * Behaviour that matters:
 *   - No `ANTHROPIC_API_KEY` => `ModelError(AUTH_MISSING)`. Never a fabricated
 *     completion.
 *   - The API requires the system prompt as a top-level `system` field, not as
 *     a `system` role message: this adapter splits them.
 *   - Anthropic answers tool calls as `content[]` blocks of type `tool_use`
 *     with an already-parsed `input` object, and wants tool results back as
 *     `user` messages containing `tool_result` blocks. Both translations
 *     happen here.
 *   - 401/403 => AUTH_MISSING, 429 => RATE_LIMITED, 5xx/network =>
 *     PROVIDER_UNAVAILABLE, timeout => TIMEOUT, unexpected body shape =>
 *     MALFORMED_OUTPUT.
 *   - The key is read from `env` at call time, is never logged and never
 *     appears in an error message.
 *
 * Untested against the live API in CI (no key configured); the offline suite
 * covers the AUTH_MISSING path only. Treat the first live call as the test.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ModelError, MODEL_ERROR_CODES, DEFAULT_CAPABILITIES, normalizeCompletion } from '../provider.mjs';

/** Split contract messages into Anthropic's `system` + `messages` shape. */
function toAnthropicMessages(messages) {
  const systemParts = [];
  const rest = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(String(message.content ?? ''));
      continue;
    }

    if (message.role === 'tool') {
      rest.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
            ...(message.isError ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      rest.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: String(message.content) }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments ?? {},
          })),
        ],
      });
      continue;
    }

    rest.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content ?? '') });
  }

  return { system: systemParts.join('\n\n'), messages: rest };
}

/** Map the runtime's tool definitions to Anthropic's `tools` array. */
function toAnthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

export function createAnthropicProvider({
  id = 'anthropic',
  apiKey = process.env.ANTHROPIC_API_KEY,
  baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
  model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
  apiVersion = process.env.ANTHROPIC_VERSION ?? '2023-06-01',
  maxTokens = 4_096,
  fetchImpl = globalThis.fetch,
  maxContextTokens = 200_000,
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
        'ANTHROPIC_API_KEY is not set; refusing to fabricate a completion. Configure the key or select the mock provider.',
        { provider: id, model },
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new ModelError(MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE, 'global fetch is unavailable in this Node runtime', {
        provider: id,
        model,
      });
    }

    const { system, messages: converted } = toAnthropicMessages(messages);

    // Anthropic has no response_format flag; JSON is requested by instruction.
    const systemWithFormat =
      responseFormat === 'json'
        ? `${system}\n\nRespond with a single strict JSON object and nothing else.`.trim()
        : system;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const body = {
      model,
      max_tokens: maxTokens,
      messages: converted,
      ...(systemWithFormat ? { system: systemWithFormat } : {}),
      ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };

    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey, // never logged; stripped by redact()
          'anthropic-version': apiVersion,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, `anthropic request exceeded ${timeoutMs}ms`, {
          provider: id,
          model,
          cause: err,
        });
      }
      throw new ModelError(MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE, `anthropic request failed: ${err.message}`, {
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
      throw new ModelError(code, `anthropic HTTP ${status}: ${text.slice(0, 300)}`, { provider: id, model, status });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, `anthropic response was not JSON: ${err.message}`, {
        provider: id,
        model,
      });
    }

    if (!Array.isArray(payload?.content)) {
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, 'anthropic response had no content[] array', {
        provider: id,
        model,
      });
    }

    const text = payload.content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls = payload.content
      .filter((block) => block?.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }));

    return normalizeCompletion(
      {
        text,
        toolCalls,
        usage: {
          promptTokens: payload.usage?.input_tokens,
          completionTokens: payload.usage?.output_tokens,
          totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
        },
        raw: { stopReason: payload.stop_reason, model: payload.model, receivedAt: now() },
      },
      { provider: id, model },
    );
  }

  return {
    id: () => id,
    capabilities: () => caps,
    complete,
    model,
    describe: () => ({ id, model, baseUrl, apiKeyPresent: Boolean(apiKey) }),
    isMock: false,
    /** Only routable when a key is present; the router fails closed on this. */
    isAvailable: () => Boolean(apiKey),
  };
}

export default createAnthropicProvider;
