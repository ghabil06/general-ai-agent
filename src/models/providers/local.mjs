/**
 * LOCAL OpenAI-compatible endpoint provider.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STATUS: **PLACEHOLDER + real adapter in one file**, deliberately split by
 * configuration:
 *
 *   - With `LOCAL_MODEL_BASE_URL` unset, `complete()` throws
 *     `ModelError(PROVIDER_UNAVAILABLE)` with the message "local model is not
 *     configured". That is the placeholder path: there is no local model in
 *     this repository, and pretending there is would be a simulation.
 *   - With `LOCAL_MODEL_BASE_URL` set, the SAME code performs a real
 *     OpenAI-compatible `POST {baseUrl}/chat/completions` against your local
 *     server (Ollama `/v1`, LM Studio, llama.cpp server, vLLM, text-generation-
 *     webui-openai-api). It is the same request shape as
 *     `src/models/providers/openai.mjs`, minus the required key: many local
 *     servers ignore auth, so a key is sent only when `LOCAL_MODEL_API_KEY` is
 *     set.
 *
 * The runtime never selects this provider by default — `src/models/router.mjs`
 * only routes to `local` when it is configured, or when a caller forces it.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ModelError, MODEL_ERROR_CODES, DEFAULT_CAPABILITIES, normalizeCompletion } from '../provider.mjs';

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

export function createLocalProvider({
  id = 'local',
  baseUrl = process.env.LOCAL_MODEL_BASE_URL ?? '',
  apiKey = process.env.LOCAL_MODEL_API_KEY ?? '',
  model = process.env.LOCAL_MODEL_NAME ?? 'llama3.1:8b',
  fetchImpl = globalThis.fetch,
  // Local servers vary: tool calling is assumed OFF unless the operator opts in
  // with LOCAL_MODEL_TOOLS=1. Injectable so the refusal path is testable.
  toolsEnabled = /^(1|true|yes|on)$/i.test(String(process.env.LOCAL_MODEL_TOOLS ?? '')),
  maxContextTokens = Number(process.env.LOCAL_MODEL_MAX_CONTEXT ?? 8_192),
  now = () => Date.now(),
} = {}) {
  const caps = Object.freeze({
    ...DEFAULT_CAPABILITIES,
    tools: Boolean(toolsEnabled),
    json: true,
    maxContextTokens,
    deterministic: false,
    mock: false,
    local: true,
  });

  function assertConfigured() {
    if (!baseUrl) {
      throw new ModelError(
        MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
        'local model is not configured: set LOCAL_MODEL_BASE_URL to an OpenAI-compatible endpoint ' +
          '(e.g. http://127.0.0.1:11434/v1 for Ollama). This provider is a placeholder until then.',
        { provider: id, model },
      );
    }
  }

  async function complete({ messages = [], tools = [], responseFormat = 'text', timeoutMs = 60_000, signal, temperature } = {}) {
    assertConfigured();

    if (!caps.tools && tools.length) {
      throw new ModelError(
        MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
        'local provider was asked to use tools but LOCAL_MODEL_TOOLS is not enabled; ' +
          'set LOCAL_MODEL_TOOLS=1 only if your local server really supports OpenAI-style tool calls',
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

    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: toOpenAiMessages(messages),
          ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
          ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, `local model request exceeded ${timeoutMs}ms`, {
          provider: id,
          model,
          cause: err,
        });
      }
      throw new ModelError(MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE, `local model request failed: ${err.message}`, {
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
      throw new ModelError(
        status === 429 ? MODEL_ERROR_CODES.RATE_LIMITED : MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
        `local model HTTP ${status}: ${text.slice(0, 300)}`,
        { provider: id, model, status },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, `local model response was not JSON: ${err.message}`, {
        provider: id,
        model,
      });
    }

    const choice = payload?.choices?.[0];
    if (!choice) {
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, 'local model response had no choices[0]', {
        provider: id,
        model,
      });
    }

    const message = choice.message ?? {};
    const toolCalls = (message.tool_calls ?? []).map((call, index) => {
      let args = call.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = args ? JSON.parse(args) : {};
        } catch (err) {
          throw new ModelError(
            MODEL_ERROR_CODES.MALFORMED_OUTPUT,
            `local model tool call arguments were not valid JSON: ${err.message}`,
            { provider: id, model },
          );
        }
      }
      return { id: call.id ?? `call_local_${index}`, name: call.function?.name, arguments: args };
    });

    return normalizeCompletion(
      {
        text: message.content ?? '',
        toolCalls,
        usage: {
          promptTokens: payload.usage?.prompt_tokens,
          completionTokens: payload.usage?.completion_tokens,
          totalTokens: payload.usage?.total_tokens,
        },
        raw: { finishReason: choice.finish_reason, model: payload.model ?? model, receivedAt: now() },
      },
      { provider: id, model },
    );
  }

  return {
    id: () => id,
    capabilities: () => caps,
    complete,
    model,
    configured: Boolean(baseUrl),
    isAvailable: () => Boolean(baseUrl),
    describe: () => ({ id, model, baseUrl: baseUrl || null, configured: Boolean(baseUrl), apiKeyPresent: Boolean(apiKey) }),
    isMock: false,
    isPlaceholder: true,
  };
}

export default createLocalProvider;
