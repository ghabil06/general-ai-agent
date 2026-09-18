/**
 * The offline ("no API key") provider script for an API-started run.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TRUSTING ANY OUTPUT FROM THIS MODULE.
 *
 * The runtime's default provider is `mock`, and the mock provider is a test
 * double: it replays a script of turns and does not reason. So when the API
 * starts an offline run, something has to supply that script. This module does,
 * and it is the ONLY place in the API layer that decides "what the model
 * proposed". Everything downstream of the proposal — the state machine, the
 * tool executor, the policy kernel, the approval gate, the stores, the trace —
 * is the real runtime, unmodified.
 *
 * The scripts come from fixtures this repository already ships and already
 * gates on (`src/evaluation/mock-scripts.mjs`, the runtime port of
 * `evals/providers/*`). No new "reasoning" is authored here:
 *
 *   input matches a dataset case   -> the ORACLE fixture: the read-only
 *                                    verification calls derived from the case
 *                                    text, then the case's own
 *                                    `expected_action`. This is the reference
 *                                    agent, and the policy kernel still has to
 *                                    agree with it before anything is allowed.
 *   input matches nothing          -> the NAIVE fixture: the keyword-scanning
 *                                    port of `evals/providers/naive_*.mjs`. It
 *                                    "trusts what it finds", so the boundary
 *                                    rules get a chance to refuse it.
 *   the general agent              -> its own labelled offline scenario, or a
 *                                    text-only fixture turn (it has no dataset
 *                                    of record, so there is no fixture to
 *                                    replay).
 *
 * One derived rule, stated plainly because it is the bit that is NOT a verbatim
 * fixture: when the fixture's disposition is one of `HUMAN_DISPOSITIONS`
 * ("hand it to a human"), the run proposes the agent's *escalation tool call*
 * instead of the bare disposition JSON. That is the tool form of the same
 * disposition, and it is what makes the approval gate reachable offline — a
 * disposition quoted in text cannot create a pending approval, a tool call can.
 * The arguments are validated against the tool's own input schema before they
 * are scripted, and a script that would not validate is not used.
 *
 * Every response that used this says so: `scriptedBy`, `provider: "mock"`,
 * `mock: true`.
 * ────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../config/index.mjs';
import { loadAgent } from '../agents/index.mjs';
import { validateToolArguments } from '../tools/registry.mjs';
import { HUMAN_DISPOSITIONS } from '../policy/rules/required-approval.mjs';
import { OFFLINE_SCENARIOS } from '../agents/general/index.mjs';
import {
  naiveScript,
  naiveDecision,
  oracleScript,
  scriptFor,
  plannedSteps,
  deriveToolCalls,
} from '../evaluation/mock-scripts.mjs';
import { escalationToolFor } from './serialize.mjs';

/** Dataset var carrying the untrusted payload, per agent. */
export const DATA_VAR = Object.freeze({ svc_03: 'invoice_data', svc_04: 'alert_data', svc_06: 'market_data' });

/** How the script handed to the mock provider was derived. Reported to callers. */
export const SCRIPT_SOURCE = Object.freeze({
  ORACLE_CASE: 'oracle-fixture:dataset-case',
  ORACLE_CASE_ESCALATION: 'oracle-fixture:dataset-case+escalation-tool',
  ORACLE_CASE_PLAN: 'oracle-fixture:dataset-case+plan',
  NAIVE_TEXT: 'naive-fixture:free-text',
  NAIVE_TEXT_ESCALATION: 'naive-fixture:free-text+escalation-tool',
  NAIVE_TEXT_PLAN: 'naive-fixture:free-text+plan',
  GENERAL_SCENARIO: 'general-scenario',
  GENERAL_SCENARIO_PLAN: 'general-scenario+plan',
  GENERAL_TEXT: 'general-text-fixture',
  GENERAL_TEXT_PLAN: 'general-text-fixture+plan',
});

/** Collapse whitespace so a pasted payload still matches its dataset case. */
function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Read an agent's dataset. Read-only: nothing in the API writes into `evals/`. */
export function readDatasetCases(agent) {
  const relative = agent?.dataset?.path;
  if (!relative) return { path: null, cases: [], error: null };
  const absolute = path.isAbsolute(relative) ? relative : path.resolve(REPO_ROOT, relative);
  try {
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    return { path: absolute, cases: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (err) {
    return { path: absolute, cases: [], error: err?.message ?? String(err) };
  }
}

/** Deterministic, non-zero usage so budget accounting measures something real. */
function usageFor(promptLength, completionTokens) {
  const promptTokens = Math.max(1, Math.ceil(promptLength / 4));
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** The disposition the fixture proposed, used to grade the run. */
function dispositionFrom(fixture, agentId, vars, prompt) {
  if (fixture === 'oracle') return vars?.expected_action ?? null;
  const decision = naiveDecision(agentId, vars, { prompt });
  return decision?.action ?? null;
}

/**
 * Arguments for the agent's escalation tool, derived from the case text and the
 * adapter's structured evidence. Mirrors `escalationArgs()` in
 * `src/evaluation/runner.mjs`; validated against the tool's schema by the
 * caller, so an argument the schema refuses is never scripted.
 *
 * @returns {object|null} null when a required argument is not derivable
 */
export function escalationArguments(agentId, { inputs, input, prompt, vars }) {
  const evidence = inputs?.evidence ?? {};
  const preview = normalize(input).slice(0, 240);
  if (agentId === 'svc_03') {
    return {
      reason: 'the invoice boundary requires a human decision: the amount is not autonomously approvable',
      payload: { evidence, invoiceExcerpt: preview },
    };
  }
  if (agentId === 'svc_04') {
    const derived = deriveToolCalls(agentId, vars, { prompt }).find((call) => call.name === 'query_alert_context');
    const alertId = String(derived?.arguments?.alertId ?? '');
    // The schema pins `^[0-9]{1,8}$`, so "no derivable id" means "do not script
    // this call" rather than "script a plausible-looking id".
    if (!/^[0-9]{1,8}$/.test(alertId)) return null;
    return { alertId, reason: 'the alert disposition is not determinable autonomously; a human analyst is required' };
  }
  if (agentId === 'svc_06') {
    const tickerMatch = normalize(input).match(/\b(AAPL|AMZN|GOOG[A-Z0-9.-]*|MSFT|SPY|BTC[A-Z0-9.-]*|ETH[A-Z0-9.-]*|TSLA|NVDA)\b/);
    return {
      reason: 'the order cannot be executed autonomously under the paper-trading boundaries',
      ticker: tickerMatch ? tickerMatch[1] : 'n/a',
      payload: { evidence, orderExcerpt: preview },
    };
  }
  return null;
}

/** The mock turn that proposes the escalation tool call. */
function escalationTurn({ agentId, toolName, inputs, input, prompt, vars, promptLength }) {
  const args = escalationArguments(agentId, { inputs, input, prompt, vars });
  if (args === null) return { turn: null, problems: ['no valid escalation arguments could be derived from the input'] };
  return { turn: { toolCalls: [{ name: toolName, arguments: args }], text: '', usage: usageFor(promptLength, 40) }, problems: [] };
}

/**
 * Build the offline plan for one API-started run.
 *
 * In `planned` mode the plan's steps come from the same derivation the
 * evaluation harness uses (`plannedSteps`, built on `deriveToolCalls`), and the
 * script is the fixture's *planned* variant: with supplied steps the planned loop
 * makes no decomposition call, so the only model call left is the synthesis at
 * the end, and that is the turn the script supplies. The escalation substitution
 * does NOT apply in planned mode: a plan step that a human must approve is a
 * different flow, and pretending otherwise would produce a run that claims to
 * have paused without a plan step behind it.
 *
 * @param {object} request
 * @param {object} request.runtime   the runtime the run will execute against
 * @param {string} request.agentId
 * @param {string} request.input     the operator's payload / task text
 * @param {string} [request.mode]    'model' (default) or 'planned'
 * @returns {object} `{ agent, inputs, script, steps, scriptedBy, disposition, matchedCaseIndex, notes }`
 */
export function buildOfflinePlan({ runtime, agentId, input, mode = 'model' }) {
  const planned = mode === 'planned';
  const agent = loadAgent(agentId, { renderer: runtime.promptRenderer });
  const dataVar = agent.dataset?.dataVar ?? DATA_VAR[agentId] ?? null;
  const notes = [];

  // ── the general agent: no dataset, no fixture port ───────────────────────
  if (!dataVar) {
    const key = normalize(input).toLowerCase();
    const scenarioName = Object.keys(OFFLINE_SCENARIOS).find((name) => name === key || key.includes(name));
    if (scenarioName) {
      const scenario = agent.offlineScenario(scenarioName);
      const inputs = Object.freeze({
        ...agent.caseAdapter({}),
        task: scenario.task,
        userMessage: scenario.userMessage,
        untrusted: scenario.untrusted,
        evidence: scenario.evidence,
      });
      notes.push(`input matched the general agent's offline scenario "${scenarioName}"`);
      const steps = scenario.script
        .filter((turn) => Array.isArray(turn.toolCalls) && turn.toolCalls.length)
        .flatMap((turn, index) =>
          turn.toolCalls.map((call) => ({
            id: `step-${index + 1}`,
            description: `Call ${call.name} (${scenarioName})`,
            tool: call.name,
            args: call.arguments ?? {},
          })),
        );
      if (planned) {
        const finalTurn = [...scenario.script].reverse().find((turn) => typeof turn.text === 'string' && turn.text.length);
        return {
          agent,
          dataVar: null,
          inputs,
          steps: steps.length ? steps : [{ id: 'step-1', description: 'Answer from the task text; no tool is required.' }],
          script: [{ text: finalTurn ? finalTurn.text : 'Offline scenario completed.', usage: usageFor(scenario.task.length, 40) }],
          scriptedBy: SCRIPT_SOURCE.GENERAL_SCENARIO_PLAN,
          disposition: null,
          matchedCaseIndex: null,
          notes: [...notes, 'planned mode: the scenario\'s tool calls became plan steps'],
        };
      }
      return {
        agent,
        dataVar: null,
        inputs,
        steps: null,
        script: scenario.script.map((turn) => ({ ...turn, usage: usageFor(200, 40) })),
        scriptedBy: SCRIPT_SOURCE.GENERAL_SCENARIO,
        disposition: null,
        matchedCaseIndex: null,
        notes,
      };
    }
    return {
      agent,
      dataVar: null,
      inputs: agent.caseAdapter({ task: input, userMessage: input }),
      steps: planned ? [{ id: 'step-1', description: 'Answer from the task text; no tool is required.' }] : null,
      script: [
        {
          text:
            'Offline fixture: the general agent has no dataset of record, so the deterministic provider has no scripted ' +
            'tool sequence for this input. It proposes no action and no tool call.',
          usage: usageFor(input.length, 30),
        },
      ],
      scriptedBy: planned ? SCRIPT_SOURCE.GENERAL_TEXT_PLAN : SCRIPT_SOURCE.GENERAL_TEXT,
      disposition: null,
      matchedCaseIndex: null,
      notes: [
        ...notes,
        'the general agent has no adversarial dataset, so a free-text input has no fixture of record to replay',
      ],
    };
  }

  const dataset = readDatasetCases(agent);
  if (dataset.error) notes.push(`dataset ${dataset.path} could not be read: ${dataset.error}`);
  const wanted = normalize(input);
  const matchedCaseIndex = dataset.cases.findIndex((entry) => normalize(entry?.vars?.[dataVar]) === wanted);
  const matched = matchedCaseIndex >= 0 ? dataset.cases[matchedCaseIndex] : null;

  const vars = matched ? matched.vars : { [dataVar]: input };
  const inputs = agent.caseAdapter(vars);
  const prompt = inputs.systemPrompt ?? '';
  const promptLength = prompt.length;
  const fixture = matched ? 'oracle' : 'naive';
  const disposition = dispositionFrom(fixture, agentId, vars, prompt);
  const caseNote = matched
    ? `input matched dataset case ${matchedCaseIndex + 1} of ${dataset.cases.length} (${dataset.path})`
    : `input matched no case in ${dataset.path ?? 'the agent dataset'}, so the naive fixture was replayed`;

  if (planned) {
    return {
      agent,
      dataVar,
      inputs,
      steps: plannedSteps(agentId, vars, { prompt }),
      script: scriptFor(fixture, agentId, vars, { prompt, mode: 'planned' }),
      scriptedBy: fixture === 'oracle' ? SCRIPT_SOURCE.ORACLE_CASE_PLAN : SCRIPT_SOURCE.NAIVE_TEXT_PLAN,
      disposition,
      matchedCaseIndex: matched ? matchedCaseIndex : null,
      notes: [
        caseNote,
        'planned mode: the plan steps were derived from the case text and executed by the planned loop, one tool call at a time',
        ...notes,
      ],
    };
  }

  const escalationTool = escalationToolFor(runtime, agentId);
  const handsToHuman = disposition !== null && HUMAN_DISPOSITIONS.includes(disposition);
  let escalation = { turn: null, problems: [] };
  if (handsToHuman && escalationTool) {
    escalation = escalationTurn({ agentId, toolName: escalationTool, inputs, input, prompt, vars, promptLength });
    notes.push(...escalation.problems);
  } else if (handsToHuman && !escalationTool) {
    notes.push(`disposition "${disposition}" hands the decision to a human but the profile holds no escalation tool`);
  }

  if (matched) {
    const base = oracleScript(agentId, vars, { prompt });
    const script = escalation.turn ? [...base.slice(0, -1), escalation.turn, base[base.length - 1]] : base;
    return {
      agent,
      dataVar,
      inputs,
      steps: null,
      script,
      scriptedBy: escalation.turn ? SCRIPT_SOURCE.ORACLE_CASE_ESCALATION : SCRIPT_SOURCE.ORACLE_CASE,
      disposition,
      matchedCaseIndex,
      notes: [caseNote, ...notes],
    };
  }

  const base = naiveScript(agentId, vars, { prompt });
  const script = escalation.turn ? [escalation.turn, ...base] : base;
  return {
    agent,
    dataVar,
    inputs,
    steps: null,
    script,
    scriptedBy: escalation.turn ? SCRIPT_SOURCE.NAIVE_TEXT_ESCALATION : SCRIPT_SOURCE.NAIVE_TEXT,
    disposition,
    matchedCaseIndex: null,
    notes: [caseNote, ...notes],
  };
}

/**
 * Self-check: every scripted escalation tool call must satisfy the tool's own
 * input schema. Exposed so `verify:runtime` and the API test can prove it
 * rather than assume it.
 *
 * @returns {{ok: boolean, checked: number, problems: string[]}}
 */
export function validateScriptAgainstSchemas(runtime, script) {
  const problems = [];
  let checked = 0;
  for (const turn of script ?? []) {
    for (const call of turn?.toolCalls ?? []) {
      checked += 1;
      const tool = runtime.registry.get(call.name);
      if (!tool) {
        problems.push(`scripted tool call names unregistered tool "${call.name}"`);
        continue;
      }
      const violations = validateToolArguments(tool, call.arguments ?? {});
      for (const violation of violations) {
        problems.push(`scripted ${call.name} violates its schema at ${violation.path}: ${violation.message}`);
      }
    }
  }
  return { ok: problems.length === 0, checked, problems };
}

export default buildOfflinePlan;
