/**
 * Agent profile loader.
 *
 * One entry point for "give me everything about agent X": the frozen runtime
 * profile from `src/config/agents.mjs` (reused, never forked), the rendered
 * system prompt of record from `prompts/`, the tool allowlist, the policy view,
 * the dataset pointer and the evaluation suite list. Call 3's HTTP gateway and
 * the evaluation harness both consume this rather than reaching into the four
 * agent modules directly.
 *
 *   import { loadAgent, listAgentIds, runAgentCase } from './src/agents/index.mjs';
 *
 *   const agent = loadAgent('svc_03');
 *   agent.toolAllowlist              // ['query_po_database', ...]
 *   agent.prompts.systemFor(vars)    // the prompts/ file, rendered
 *   agent.policy.boundary            // the frozen $500.00 boundary object
 *   agent.dataset.path               // 'evals/invoices_dataset.json'
 *
 * Everything returned is frozen. Loading an unknown agent throws.
 */

import { AGENT_PROFILES, getAgentProfile, findAgentProfile, BOUNDARIES } from '../config/agents.mjs';
import { createPromptRenderer } from '../prompts/render.mjs';
import { STATES } from '../runtime/state-machine.mjs';

import { buildAgent as buildGeneral, GENERAL_SYSTEM_PROMPT, OFFLINE_SCENARIOS } from './general/index.mjs';
import { buildAgent as buildSvc03 } from './svc_03/index.mjs';
import { buildAgent as buildSvc04 } from './svc_04/index.mjs';
import { buildAgent as buildSvc06 } from './svc_06/index.mjs';

/** Agent id -> builder. The registry of known agents, in a stable order. */
export const AGENT_BUILDERS = Object.freeze({
  general: buildGeneral,
  svc_03: buildSvc03,
  svc_04: buildSvc04,
  svc_06: buildSvc06,
});

/** Every agent id this runtime knows how to run. */
export function listAgentIds() {
  return Object.keys(AGENT_BUILDERS);
}

/** The agent ids that own a domain boundary (the SVC agents). */
export function listSvcAgentIds() {
  return listAgentIds().filter((id) => Boolean(BOUNDARIES[id]));
}

export function isKnownAgent(agentId) {
  return Object.prototype.hasOwnProperty.call(AGENT_BUILDERS, agentId);
}

/**
 * @param {string} agentId
 * @param {object} [options]
 * @param {string} [options.promptsDir]
 * @param {string} [options.datasetPath] override the dataset pointer (tests)
 * @param {object} [options.renderer]    a pre-built prompt renderer
 */
export function loadAgent(agentId, options = {}) {
  const build = AGENT_BUILDERS[agentId];
  if (!build) {
    throw new Error(`unknown agent "${agentId}" (known: ${listAgentIds().join(', ')})`);
  }
  const base = getAgentProfile(agentId);
  const renderer = options.renderer ?? createPromptRenderer(options.promptsDir ? { promptsDir: options.promptsDir } : {});
  const agent = build({ ...options, renderer });
  return Object.freeze({
    ...agent,
    /** The runtime profile the kernel and executor will use, by identity. */
    runtimeProfile: base,
    describe: () => ({
      id: agent.id,
      name: agent.name,
      taskType: agent.taskType,
      tools: agent.toolAllowlist,
      promptPath: agent.prompts.system,
      promptSource: agent.prompts.promptSource ?? agent.prompts.system,
      placeholder: agent.prompts.placeholder,
      datasetPath: agent.dataset.path,
      boundary: agent.policy.boundary,
      actionPolicy: base.actionPolicy,
      suites: agent.evaluation.suites,
      expected: agent.evaluation.expected,
    }),
  });
}

export function loadAllAgents(options = {}) {
  const renderer = options.renderer ?? createPromptRenderer(options.promptsDir ? { promptsDir: options.promptsDir } : {});
  return listAgentIds().map((agentId) => loadAgent(agentId, { ...options, renderer }));
}

/**
 * The rendered system prompt for an agent, from a dataset `vars` object.
 * Thin, so a caller that only wants a prompt does not load a whole agent.
 */
export function systemPromptFor(agentId, vars = {}, options = {}) {
  return loadAgent(agentId, options).prompts.systemFor(vars);
}

/**
 * Run one dataset case (or scenario) end to end through the REAL runtime:
 * a real run handle, the real state machine, the real executor, the real policy
 * kernel, the real approval gate and the real stores. The mock provider supplies
 * "what the model proposes"; nothing else is a stand-in.
 *
 * @param {object}   request
 * @param {string}   request.agentId
 * @param {object}   request.runtime              from createRuntime()
 * @param {object}   [request.vars]               dataset vars -> adapter inputs
 * @param {object}   [request.adapted]            an already-adapted case (wins over vars)
 * @param {Array}    [request.script]             mock-provider script for this case
 * @param {string}   [request.mode]               'model' (default) | 'planned'
 * @param {object}   [request.plan]               a plan object for planned mode
 * @param {Array}    [request.steps]              raw steps to plan in planned mode
 * @param {object}   [request.context]            context-manager inputs
 * @param {number}   [request.maxTurns]
 * @param {Function} [request.evaluateAction]     true to grade the action (default)
 * @returns {Promise<object>} the run outcome plus the run handle's identifiers
 */
export async function runAgentCase({
  agentId,
  runtime,
  vars = null,
  adapted = null,
  script = [],
  mode = 'model',
  plan = null,
  steps = null,
  context = {},
  maxTurns = null,
  evaluateAction = true,
  finish = true,
  status = null,
  complexity = 'low',
  sessionId = null,
  runId = null,
} = {}) {
  const agent = loadAgent(agentId);
  const inputs = adapted ?? agent.caseAdapter(vars ?? {});

  const run = runtime.createRun({ agentId, complexity, sessionId, runId });

  // A fresh script per case, and the mock's call counter reset with it: the
  // provider indexes its script by call number, so a lingering counter would
  // make case N start at the wrong turn of its own script.
  if (runtime.mockProvider?.reset) runtime.mockProvider.reset({ script: script ?? [] });
  else if (runtime.mockProvider?.setScript) runtime.mockProvider.setScript(script ?? []);

  const request = {
    mode,
    systemPrompt: inputs.systemPrompt,
    userMessage: inputs.userMessage,
    task: mode === 'planned' ? inputs.task : null,
    plan,
    steps,
    context,
    untrusted: inputs.untrusted,
    evidence: inputs.evidence,
    responseFormat: 'json',
  };
  if (typeof maxTurns === 'number') request.maxTurns = maxTurns;

  const outcome = await run.loop(request);

  const parsed = parseDecision(outcome.finalText);
  const proposedAction = parsed?.action ?? null;

  // The kernel is asked about the action the agent actually produced, against
  // the case's structured facts. It is never told what the expected answer was.
  const verdict =
    evaluateAction && proposedAction !== null
      ? run.evaluateAction(proposedAction, inputs.evidence, inputs.untrusted)
      : null;

  if (finish) {
    run.finish({
      status: status ?? terminalStatusFor(run, outcome),
      output: parsed ?? outcome.finalText,
      reason: outcome.stopReason?.code ?? null,
    });
  }

  return {
    agentId,
    agent,
    inputs,
    run,
    runId: run.runId,
    sessionId: run.sessionId,
    outcome,
    decision: parsed,
    actualAction: proposedAction,
    policyDecision: verdict,
    toolCalls: run.toolCalls.map((call) => call.name),
    state: run.state,
    turns: outcome.turns,
    finalText: outcome.finalText,
    stopReason: outcome.stopReason,
    plan: outcome.plan ?? null,
    context: outcome.context ?? null,
  };
}

/**
 * The terminal status to report for a finished loop: whichever terminal state
 * the machine actually reached, or the one its last state can legally reach.
 */
export function terminalStatusFor(run, outcome = {}) {
  if (run.stateMachine.isTerminal()) return run.state;
  if (outcome.stopReason) {
    if (run.stateMachine.can(STATES.BLOCKED)) return STATES.BLOCKED;
    if (run.stateMachine.can(STATES.FAILED)) return STATES.FAILED;
    return STATES.FAILED;
  }
  if (run.stateMachine.can(STATES.COMPLETED, { valid: true })) return STATES.COMPLETED;
  if (run.stateMachine.can(STATES.COMPLETED)) return STATES.COMPLETED;
  return STATES.COMPLETED;
}

/** Parse the decision object out of a model answer, or null. */
export function parseDecision(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'object') return text;
  const candidates = [String(text)];
  try {
    candidates.push(JSON.parse(String(text)));
  } catch {
    /* not bare JSON */
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof candidate.action === 'string') return candidate;
  }
  // Fall back to the last balanced braced block, the way the eval assertions do.
  const blocks = balancedBlocks(String(text));
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(blocks[i]);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') return parsed;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Every balanced {...} block, outermost first. Mirrors the eval assertion parser. */
export function balancedBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          blocks.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return blocks;
}

export {
  AGENT_PROFILES,
  getAgentProfile,
  findAgentProfile,
  BOUNDARIES,
  GENERAL_SYSTEM_PROMPT,
  OFFLINE_SCENARIOS,
};
