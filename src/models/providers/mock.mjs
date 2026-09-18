/**
 * MOCK PROVIDER — a deterministic test double. NOT A MODEL.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * This provider does not call any network, does not load any weights and does
 * not reason about anything. It replays a caller-supplied script of turns, in
 * order, returning exactly what the caller asked for. It exists so the whole
 * runtime — state machine, budgets, router, tool executor, policy kernel,
 * approval gate, audit — can be tested offline, deterministically, with no API
 * key and no spend, including its failure paths.
 *
 * Anything this provider "decides" was decided by the test that scripted it.
 * Never wire it into a production path; `capabilities().mock === true` and
 * `capabilities().deterministic === true` say so, and the router records it.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Script turn shapes (all optional keys, full determinism):
 *
 *   { text: 'hello' }                          plain assistant text
 *   { toolCalls: [{ name, arguments }] }       propose tool calls
 *   { text, toolCalls }                        both in one turn
 *   { json: { action: 'auto_approve' } }       text = JSON.stringify(json)
 *   { malformed: '{"action": ' }               returns invalid JSON text
 *   { throwMalformed: true }                   throws MALFORMED_OUTPUT
 *   { timeout: true }                          throws TIMEOUT
 *   { error: { code, message } }               throws that ModelError code
 *   { delayMs: 25 }                            adds a deterministic sleep
 *   { usage: { promptTokens, completionTokens } }
 *
 * Constructor-level failure injection (applies to call N, 1-based):
 *
 *   failOnCall: 2, failureCode: 'RATE_LIMITED'
 *   malformedOnCall: 1            -> returns invalid JSON text on call 1
 *   timeoutOnCall: 3              -> throws TIMEOUT on call 3
 *   timeoutAfterMs: 50            -> throws TIMEOUT as soon as the call is
 *                                    dispatched, as a caller-side timeout would
 *
 * Every call is recorded in `calls[]` (messages, tools, response) so a test can
 * assert *what the model was asked*, not just what it answered.
 */

import { ModelError, MODEL_ERROR_CODES, DEFAULT_CAPABILITIES, normalizeCompletion } from '../provider.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockProvider({
  id = 'mock',
  model = 'mock-deterministic-1',
  script = [],
  capabilities = {},
  onExhausted = 'error', // 'error' | 'repeat-last' | 'empty-text'
  failOnCall = null,
  failureCode = MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
  failureMessage = 'simulated provider failure',
  malformedOnCall = null,
  timeoutOnCall = null,
  timeoutAfterMs = null,
  latencyMs = 0,
  now = () => Date.now(),
} = {}) {
  let turns = [...script];
  const calls = [];

  const caps = Object.freeze({
    ...DEFAULT_CAPABILITIES,
    tools: true,
    json: true,
    maxContextTokens: 128_000,
    deterministic: true,
    mock: true,
    ...capabilities,
  });

  function reset({ script: nextScript } = {}) {
    calls.length = 0;
    if (nextScript) turns = [...nextScript];
  }

  function setScript(nextScript) {
    turns = [...nextScript];
  }

  function buildFailure(callIndex, override) {
    const error = new ModelError(override?.code ?? failureCode, override?.message ?? failureMessage, {
      provider: id,
      model,
    });
    error.callIndex = callIndex;
    return error;
  }

  async function callApi({ messages = [], tools = [], responseFormat = 'text', timeoutMs, signal } = {}) {
    const callIndex = calls.length + 1;

    // --- injected failures, in a fixed evaluation order ---------------------
    if (timeoutAfterMs !== null && (timeoutMs === undefined || timeoutMs > timeoutAfterMs)) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'TIMEOUT' });
      throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, `simulated timeout after ${timeoutAfterMs}ms`, { provider: id, model });
    }
    if (timeoutOnCall !== null && callIndex === timeoutOnCall) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'TIMEOUT' });
      throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, 'simulated timeout', { provider: id, model });
    }
    if (failOnCall !== null && callIndex === failOnCall) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'FAILURE' });
      throw buildFailure(callIndex);
    }
    if (malformedOnCall !== null && callIndex === malformedOnCall) {
      const text = '{"action": "auto_approve", "reasoning": "truncated'; // deliberately invalid JSON
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'MALFORMED_TEXT', text });
      return { text, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }

    // --- scripted turn -----------------------------------------------------
    let turn = turns[callIndex - 1];
    if (turn === undefined) {
      if (onExhausted === 'repeat-last') turn = turns[turns.length - 1];
      else if (onExhausted === 'empty-text') turn = { text: '' };
      else {
        calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'EXHAUSTED' });
        throw new ModelError(
          MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
          `mock script exhausted after ${turns.length} turn(s); call ${callIndex} has no scripted answer`,
          { provider: id, model },
        );
      }
    }
    if (turn === null || typeof turn !== 'object') {
      throw new TypeError(`mock script turn ${callIndex} must be an object`);
    }

    // Caller-side timeout simulation. The effective delay is the turn's own
    // `delayMs` when it has one, otherwise the provider-wide `latencyMs`: a
    // caller timeout shorter than the simulated latency is a TIMEOUT, which is
    // what a real slow provider would produce.
    const effectiveDelayMs = turn.delayMs ?? latencyMs;
    if (effectiveDelayMs > 0 && typeof timeoutMs === 'number' && timeoutMs > 0 && effectiveDelayMs > timeoutMs) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'TIMEOUT' });
      throw new ModelError(
        MODEL_ERROR_CODES.TIMEOUT,
        `simulated latency ${effectiveDelayMs}ms exceeds caller timeout ${timeoutMs}ms`,
        { provider: id, model },
      );
    }
    if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);

    if (signal?.aborted) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'ABORTED' });
      throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, 'request aborted by caller', { provider: id, model });
    }

    if (turn.timeout) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'TIMEOUT' });
      throw new ModelError(MODEL_ERROR_CODES.TIMEOUT, 'simulated timeout (scripted turn)', { provider: id, model });
    }
    if (turn.throwMalformed) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'MALFORMED_THROW' });
      throw new ModelError(MODEL_ERROR_CODES.MALFORMED_OUTPUT, 'simulated malformed output', { provider: id, model });
    }
    if (turn.error) {
      calls.push({ index: callIndex, messages, tools, responseFormat, at: now(), outcome: 'FAILURE' });
      throw buildFailure(callIndex, turn.error);
    }

    let text = turn.text ?? '';
    if (turn.json !== undefined) text = JSON.stringify(turn.json);
    if (turn.malformed !== undefined) text = turn.malformed;

    const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
      id: call.id ?? `call_mock_${callIndex}_${index}`,
      name: call.name,
      arguments: call.arguments ?? {},
    }));

    const usage = {
      promptTokens: turn.usage?.promptTokens ?? 0,
      completionTokens: turn.usage?.completionTokens ?? 0,
      totalTokens:
        turn.usage?.totalTokens ??
        (turn.usage?.promptTokens ?? 0) + (turn.usage?.completionTokens ?? 0),
    };

    const completion = normalizeCompletion({ text, toolCalls, usage }, { provider: id, model });
    calls.push({
      index: callIndex,
      messages,
      tools,
      responseFormat,
      at: now(),
      outcome: 'OK',
      response: completion,
    });
    return completion;
  }

  return {
    /** @returns {string} */
    id: () => id,
    /** @returns {object} */
    capabilities: () => caps,
    model,
    complete: callApi,
    /** Every call this double received, oldest first. */
    calls,
    get callCount() {
      return calls.length;
    },
    lastCall: () => calls[calls.length - 1] ?? null,
    setScript,
    reset,
    /** True for every provider that is not a real model. */
    isMock: true,
    /** A test double is always available by construction. */
    isAvailable: () => true,
  };
}

export default createMockProvider;
