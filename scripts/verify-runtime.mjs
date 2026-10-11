#!/usr/bin/env node
/**
 * verify:runtime — a smoke check for the agent runtime.
 *
 * Builds a real runtime in a throwaway directory, prints what it is made of,
 * runs one complete offline agent run (mock provider, real tools, real policy
 * kernel, real JSONL stores), and asserts the invariants that must hold for the
 * runtime to be worth running at all:
 *
 *   1. the deterministic test double is not implicitly routable to a real model
 *   2. a tool the agent is not authorised to call is refused, and not executed
 *   3. the SVC boundaries refuse what the datasets refuse
 *   4. every stage wrote its record: events, run, trace, audit
 *   5. a restarted runtime still reads the run it produced
 *
 * Exits 0 when everything holds, 1 with a list of failures otherwise. No
 * network, no API key, no writes outside the temp directory.
 *
 *   node scripts/verify-runtime.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createRuntime } from '../src/index.mjs';
import { loadConfig, REPO_ROOT } from '../src/config/index.mjs';
import { STATES } from '../src/runtime/state-machine.mjs';
import { EXECUTION_STATUS } from '../src/tools/executor.mjs';
import { EVENT_TYPES } from '../src/observability/events.mjs';
import { createPromptRenderer, PROMPT_ERROR_CODES } from '../src/prompts/render.mjs';
import { PlanError } from '../src/planning/planner.mjs';
import { MEMORY_KINDS } from '../src/memory/kinds.mjs';
import { loadAgent, listAgentIds, listSvcAgentIds } from '../src/agents/index.mjs';
import { createRuntimeApi } from '../src/api/index.mjs';
import { buildOfflinePlan, validateScriptAgainstSchemas } from '../src/api/offline.mjs';
import { BoundedAgentError, BOUNDED_ERROR_CODES } from '../src/runtime/bounded-agent.mjs';
import { HARD_CEILINGS } from '../src/runtime/envelope.mjs';

const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) {
    notes.push(`  ok    ${message}`);
  } else {
    failures.push(message);
    notes.push(`  FAIL  ${message}`);
  }
}

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-runtime-'));

const config = loadConfig(
  { NODE_ENV: 'test', AGENT_STORAGE_DIR: storageDir },
  { storageDir, fixturesDir: path.join(REPO_ROOT, 'data', 'fixtures'), defaultProvider: 'mock' },
);

const runtime = createRuntime({
  config,
  storageDir,
  fixturesDir: config.fixturesDir,
  mockScript: [
    { toolCalls: [{ name: 'query_po_database', arguments: { poNumber: '990' } }], usage: { promptTokens: 120, completionTokens: 20 } },
    { json: { action: 'auto_approve', reasoning: 'PO verified, zero variance, within the ceiling' }, usage: { promptTokens: 140, completionTokens: 30 } },
  ],
});

const described = runtime.describe();

console.log('\n=== agent runtime verification ===\n');
console.log(`version        ${described.version}`);
console.log(`storage        ${described.storageDir}`);
console.log(`fixtures       ${described.fixturesDir}`);
console.log(`agents         ${described.agents.join(', ')} (SVC: ${described.svcAgents.join(', ')})`);
console.log(`tools (${described.tools.length})      ${described.tools.join(', ')}`);
console.log(`policy rules   ${described.policyRules.map((rule) => `${rule.priority}:${rule.id}`).join(' ')}`);
console.log(`providers      ${described.providers.map((provider) => `${provider.id}${provider.available ? '' : '(unconfigured)'}`).join(', ')}`);
console.log(`routes         ${described.routes.length} (table ${described.routerTableVersion})`);
console.log(`states         ${described.states.join(', ')}`);
console.log(`memory kinds   ${described.memoryKinds.join(', ')}`);
console.log(`span types     ${described.spanTypes.join(', ')}`);
console.log(`stores         ${Object.keys(described.stores).join(', ')}`);
console.log('');

check(described.agents.length === 4, 'four agents are wired (three SVC + general)');
check(described.svcAgents.length === 3, 'three SVC agents own a domain boundary');
check(described.tools.length === 12, 'twelve built-in tools are registered');
check(described.policyRules.length >= 8, 'the policy kernel has at least eight rules');
check(described.states.length === 13, 'the state machine declares thirteen states');
check(described.memoryKinds.length === 5, 'five memory kinds are declared');
check(described.spanTypes.includes('plan') && described.spanTypes.includes('context'), 'the trace carries planner and context spans');
check(Object.values(described.stores).every((store) => store.corruptLines === 0), 'every store starts uncorrupted');

// 1. the test double is opt-in, and a real provider with no key is not a target
const keylessRuntime = createRuntime({
  config: loadConfig(
    { NODE_ENV: 'test', AGENT_STORAGE_DIR: storageDir },
    { storageDir, fixturesDir: config.fixturesDir, defaultProvider: 'openai' },
  ),
  storageDir,
  fixturesDir: config.fixturesDir,
});
let refused = false;
try {
  keylessRuntime.route({ taskType: 'invoice_reconciliation', complexity: 'low', requiresTools: true });
} catch (error) {
  refused = error.code === 'PROVIDER_UNAVAILABLE';
}
check(refused, 'routing fails closed when no configured provider can serve the request');
check(runtime.mockProvider.capabilities().mock === true, 'the mock provider declares itself a test double');

// 2. cross-agent tool calls are refused and recorded as policy decisions
const run = runtime.createRun({ agentId: 'svc_03', sessionId: 'verify' });

const denied = await run.runTool('submit_paper_order', { ticker: 'AAPL', quantity: 1, limitPrice: 1 }, {});
check(denied.status === EXECUTION_STATUS.POLICY_DENIED, 'an unauthorised tool call is refused');
check(denied.policy.rule === 'tool.authorization', 'the refusal names the authorisation rule');
check(runtime.runStore.listOrders().length === 0, 'the refused call wrote nothing');

// 3. the boundaries refuse what the datasets refuse
const overCap = run.evaluateAction('auto_approve', { amount: 505, poPresent: true, poVerified: true, variance: 0 });
check(overCap.decision === 'DENY', 'SVC_03 refuses auto-approval at $505.00');
const withinCap = run.evaluateAction('auto_approve', { amount: 500, poPresent: true, poVerified: true, variance: 0 });
check(withinCap.decision === 'ALLOW', 'SVC_03 allows auto-approval at exactly $500.00');
const level13 = runtime
  .createRun({ agentId: 'svc_04' })
  .evaluateAction('close_false_positive', { complete: true, ruleLevel: 13, allowlisted: true, fpPattern: true, corroboration: false, injection: false });
check(level13.decision === 'DENY', 'SVC_04 refuses to auto-close a level-13 alert');
const realAccount = runtime
  .createRun({ agentId: 'svc_06' })
  .evaluateAction('execute_trade', {
    realAccount: true,
    ticker: 'AAPL',
    notionalDeterminable: true,
    notional: 100,
    injection: false,
    sellExceedsHoldings: false,
    dayPnl: 0,
    symbolHalted: false,
  });
check(realAccount.decision === 'DENY', 'SVC_06 refuses real-account routing whatever the size');

// 4. a full offline run records every stage
const outcome = await run.loop({
  systemPrompt: 'SVC_03 prompt of record (verification run)',
  userMessage: 'Invoice #101. Amount: $450.00. PO #990 verified in the PO database.',
  responseFormat: 'json',
});
check(outcome.stopReason === null, 'the verification run stopped for no budget reason');
check(JSON.parse(outcome.finalText).action === 'auto_approve', 'the run reached the expected disposition');
const summary = run.finish({ status: STATES.COMPLETED, output: JSON.parse(outcome.finalText) });
check(summary.status === 'COMPLETED', 'the run reached a terminal state');

const events = runtime.runStore.runEvents(run.runId);
const eventTypes = new Set(events.map((event) => event.type));
for (const required of [EVENT_TYPES.RUN_STARTED, EVENT_TYPES.MODEL_CALLED, EVENT_TYPES.TOOL_EXECUTED, EVENT_TYPES.POLICY_DECIDED, EVENT_TYPES.RUN_FINISHED]) {
  check(eventTypes.has(required), `the event stream contains ${required}`);
}
check(runtime.runStore.getRun(run.runId)?.status === 'COMPLETED', 'the run record was persisted');
check(Boolean(runtime.runStore.getTrace(run.runId)?.trace?.root), 'a trace tree was persisted');
check(runtime.runStore.readAudit().records.length >= 1, 'an audit row was written');
check(runtime.runStore.readAudit().corruptLines === 0, 'the audit file has no corrupt lines');

// secrets never reach the log
const logText = fs.readFileSync(runtime.runStore.paths.events, 'utf8');
check(!/\bsk-[A-Za-z0-9]{8,}/.test(logText), 'no credential-shaped string reached the event log');
check(!/"authorization"\s*:\s*"(?!\[REDACTED\])/.test(logText), 'no authorization header value reached the event log');

// 5. a restarted runtime reads what the first one wrote
const restarted = createRuntime({
  config: loadConfig({ NODE_ENV: 'test', AGENT_STORAGE_DIR: storageDir }, { storageDir, fixturesDir: config.fixturesDir, defaultProvider: 'mock' }),
  storageDir,
  fixturesDir: config.fixturesDir,
});
check(restarted.runStore.getRun(run.runId)?.status === 'COMPLETED', 'a restarted runtime reads the run record');
check(restarted.runStore.runEvents(run.runId).length === events.length, 'a restarted runtime reads the whole event stream');
check(restarted.runStore.getTrace(run.runId) !== null, 'a restarted runtime reads the trace');
check(restarted.describe().stores.events.corruptLines === 0, 'the restarted runtime sees an uncorrupted store');

// ── 6. call 2: prompt rendering ─────────────────────────────────────────────
const renderer = createPromptRenderer();
let rendered = null;
try {
  rendered = renderer.renderAgentPrompt('svc_03', { invoice_data: 'Invoice #900. Amount: $1.00.' });
} catch (error) {
  rendered = { error };
}
check(
  typeof rendered.text === 'string' && rendered.text.includes('Invoice #900') && !rendered.text.includes('{{invoice_data}}'),
  'the prompt of record renders with the placeholder substituted',
);
let missingPlaceholderRefused = false;
try {
  renderer.render('svc_03/invoice_agent.md', {});
} catch (error) {
  missingPlaceholderRefused = error.code === PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY;
}
check(missingPlaceholderRefused, 'rendering with an empty placeholder value is refused, not sent as literal braces');

// ── 7. call 2: the planner refuses an unauthorised step ────────────────────
const plannerRun = runtime.createRun({ agentId: 'svc_03' });
let plan = null;
try {
  plan = plannerRun.plan({
    goal: 'Reconcile invoice #101',
    steps: [
      { id: 's1', description: 'Verify the PO', tool: 'query_po_database', args: { poNumber: '990' } },
      { id: 's2', description: 'Compute the variance', tool: 'calculate_tax_variance', args: { expectedTax: 1, actualTax: 1 } },
    ],
  });
} catch (error) {
  plan = { error };
}
check(Boolean(plan?.planId), 'the planner accepts a plan whose tools the agent holds');
check(plan?.steps?.length === 2, 'the plan keeps its steps as data');
let foreignStepRefused = false;
try {
  plannerRun.plan({ goal: 'x', steps: [{ description: 'place an order', tool: 'submit_paper_order', args: {} }] });
} catch (error) {
  foreignStepRefused = error instanceof PlanError && error.code === 'PLAN_TOOL_NOT_PERMITTED';
}
check(foreignStepRefused, 'the planner refuses a step whose tool the agent is not authorised to call');

// ── 8. call 2: the context manager keeps policy and never widens tools ─────
const contextRun = runtime.createRun({ agentId: 'svc_03' });
const assembled = contextRun.buildContext({
  task: 'Reconcile the invoice.',
  conversation: [{ role: 'user', content: 'earlier turn' }],
  documents: [{ name: 'notes.md', content: 'x'.repeat(4_000) }],
  budget: { maxTokens: 400, reserveTokens: 0 },
  tools: ['query_po_database', 'submit_paper_order'],
});
const policyItem = assembled.budgetReport.items.find((item) => item.kind === 'policy_constraints');
check(policyItem?.included === true, 'the policy constraints survive an over-budget assembly');
check(assembled.compressed === true, 'an over-budget assembly compresses rather than silently truncating without saying so');
const tiny = contextRun.buildContext({
  task: 'Reconcile the invoice.',
  conversation: Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index} ${'y'.repeat(300)}` })),
  documents: [{ name: 'notes.md', content: 'x'.repeat(4_000) }],
  budget: { maxTokens: 90, reserveTokens: 0 },
});
check(tiny.droppedCount > 0, 'a budget too small for the candidates drops the lowest-priority ones and says how many');
check(
  assembled.budgetReport.tools.accepted.includes('query_po_database') && !assembled.budgetReport.tools.accepted.includes('submit_paper_order'),
  'the context manager refuses to widen the tool list',
);
check(assembled.budgetReport.summarizer.llm === false, 'the context summarizer is labelled deterministic truncation, not an LLM');

// ── 9. call 2: the five memory kinds write, recall and emit ────────────────
const memoryRun = runtime.createRun({ agentId: 'svc_03' });
for (const kind of MEMORY_KINDS) {
  memoryRun.memory.forKind(kind).write({ key: `${kind}-k`, value: `value for ${kind}`, scopeId: memoryRun.runId });
}
const recalled = memoryRun.memory.recall({ text: 'value for semantic' }, { kind: 'semantic', limit: 3 });
check(recalled.ok === true && recalled.count >= 1, 'a kinded write is retrievable with a match reason');
check(recalled.records.every((record) => Boolean(record.why?.matchedBy)), 'every recalled record says why it matched');
check(recalled.matcher.vectorSearch === false, 'the retrieval model states plainly that it is not vector search');
const memoryEvents = runtime.runStore.runEvents(memoryRun.runId);
check(
  memoryEvents.filter((event) => event.type === EVENT_TYPES.MEMORY_WRITTEN).length >= MEMORY_KINDS.length,
  'every memory write emitted memory.written on the run stream',
);
check(
  memoryEvents.some((event) => event.type === EVENT_TYPES.MEMORY_RETRIEVED),
  'the memory read emitted memory.retrieved on the run stream',
);
memoryRun.finish({ status: STATES.COMPLETED });

// ── 10. call 2: the planned loop runs a real plan, offline ─────────────────
const generalRuntime = runtime;
const generalAgent = loadAgent('general');
const scenario = generalAgent.offlineScenario('market_and_portfolio');
const plannedRun = generalRuntime.createRun({ agentId: 'general' });
generalRuntime.mockProvider.reset({ script: [...scenario.script] });
const planned = await plannedRun.plannedLoop({
  goal: scenario.task,
  systemPrompt: scenario.systemPrompt,
  userMessage: scenario.userMessage,
  steps: [
    { id: 's1', description: 'Read the AAPL quote', tool: 'get_market_quote', args: { ticker: 'AAPL' } },
    { id: 's2', description: 'Read the portfolio state', tool: 'get_portfolio_state', args: {} },
  ],
});
check(planned.plan?.status === 'complete', 'the planned loop completed its plan');
check(planned.steps.filter((step) => step.kind === 'tool').length === 2, 'both plan steps executed through the executor');
check(planned.stopReason === null, 'the planned loop stopped for no budget reason');
plannedRun.finish({ status: STATES.COMPLETED });
check(
  generalRuntime.runStore.getRun(plannedRun.runId)?.status === 'COMPLETED',
  'the planned run persisted a completed record',
);

// ── 11. call 2: every agent profile loads and can run offline ──────────────
check(listAgentIds().length === 4 && listSvcAgentIds().length === 3, 'the agent loader knows four agents, three with boundaries');
const SAMPLE_VARS = {
  svc_03: { invoice_data: 'Invoice #900. Amount: $10.00. PO #990 verified.' },
  svc_04: { alert_data: 'Alert: rule id 31103, rule level 6, host web-01, srcip 10.20.0.31.' },
  svc_06: { market_data: 'ORDER: Buy 1 share of AAPL, limit $100.00.' },
  general: {},
};
for (const agentId of listAgentIds()) {
  let prompt = null;
  try {
    prompt = loadAgent(agentId).prompts.systemFor(SAMPLE_VARS[agentId]);
  } catch (error) {
    prompt = `ERROR: ${error.message}`;
  }
  check(typeof prompt === 'string' && prompt.length > 40 && !prompt.startsWith('ERROR:'), `agent ${agentId} loads with a usable system prompt`);
}
const svc03Agent = loadAgent('svc_03');
check(
  svc03Agent.toolAllowlist.join(',') === 'query_po_database,calculate_tax_variance,request_human_approval',
  'the SVC_03 agent definition reuses the frozen profile allowlist rather than forking it',
);
check(
  svc03Agent.runtimeProfile === runtime.getAgentProfile('svc_03'),
  'the agent definition and the runtime resolve the SAME profile object',
);
check(svc03Agent.dataset.path === 'evals/invoices_dataset.json', 'the agent definition points at its dataset');

// ── 12. call 3: the runtime HTTP API ───────────────────────────────────────
//
// The API is exercised endpoint by endpoint over a real socket by
// `tests/integration/api.test.mjs`. What is asserted HERE is the part that is a
// property of the layer rather than of one scenario, and that a route-by-route
// test cannot state:
//
//   - every GET endpoint answers JSON with an echoed request id;
//   - no response (or persisted event) contains a credential-shaped string;
//   - a runtime path never falls back to a static file, in either direction;
//   - the offline fixture layer cannot script a call its own tool schema
//     refuses, for every dataset case, in both modes — the invariant that stops
//     the API from starting a doomed run.
console.log('\n--- runtime API (call 3) ---\n');

const apiStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-runtime-api-'));
const apiRuntime = createRuntime({
  config: loadConfig(
    { NODE_ENV: 'test', AGENT_STORAGE_DIR: apiStorageDir },
    { storageDir: apiStorageDir, fixturesDir: config.fixturesDir, defaultProvider: 'mock' },
  ),
  storageDir: apiStorageDir,
  fixturesDir: config.fixturesDir,
});
const api = createRuntimeApi({
  runtime: apiRuntime,
  reportPath: path.join(apiStorageDir, 'evals', 'runtime-results.json'),
});

const SECRET_SHAPED =
  /sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

check(api.describe().routes.length === 13, `the router publishes ${api.describe().routes.length} routes`);

const getEndpoints = [
  '/health',
  '/agents',
  '/runs',
  '/tools',
  '/policies',
  '/evaluations',
  '/approvals',
  '/approvals?status=pending',
  '/approvals?status=all',
];
let everyGetJson = true;
let everyGetRedacted = true;
for (const endpoint of getEndpoints) {
  const [routePath, queryString] = endpoint.split('?');
  const response = await api.handle({
    method: 'GET',
    pathname: `/api/runtime${routePath}`,
    searchParams: new URLSearchParams(queryString ?? ''),
  });
  const okShape =
    response &&
    response.status === 200 &&
    /application\/json/.test(response.headers['Content-Type']) &&
    /"requestId"\s*:/.test(response.body);
  if (!okShape) everyGetJson = false;
  if (response && SECRET_SHAPED.test(response.body)) everyGetRedacted = false;
}
check(everyGetJson, 'every GET endpoint answers 200 with JSON and an echoed requestId');
check(everyGetRedacted, 'no GET response contains a credential-shaped string');

const unknownRoute = await api.handle({ method: 'GET', pathname: '/api/runtime/not-a-route' });
check(unknownRoute.status === 404 && JSON.parse(unknownRoute.body).error.code === 'UNKNOWN_ROUTE', 'an unknown runtime path is a structured 404');
check(!/<!DOCTYPE html>/.test(unknownRoute.body), 'an unknown runtime path is never answered with a static file');
const wrongMethod = await api.handle({ method: 'DELETE', pathname: '/api/runtime/runs' });
check(wrongMethod.status === 405 && wrongMethod.headers.Allow === 'GET', 'a wrong method is a 405 that names the method it allows');
check((await api.handle({ method: 'GET', pathname: '/api/overview' })) === null, 'a non-runtime path is left to the caller, not handled here');

// A run through the API persists, and the frozen boundary decides it.
const apiDataset = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'evals', 'invoices_dataset.json'), 'utf8'));
const cleanCase = apiDataset.find((entry) => entry.vars.expected_action === 'auto_approve');
const startedResponse = await api.handle({
  method: 'POST',
  pathname: '/api/runtime/agents/svc_03/runs',
  rawBody: JSON.stringify({ input: cleanCase.vars.invoice_data }),
});
const started = JSON.parse(startedResponse.body);
check(startedResponse.status === 201 && started.status === 'COMPLETED', 'a run started through the API reaches a terminal state');
check(started.policyDecision?.decision === 'ALLOW', 'the kernel verdict on that run is ALLOW for a clean invoice');
check(apiRuntime.runStore.getRun(started.runId)?.status === 'COMPLETED', 'the API run is readable through the runtime store');
const apiEvents = apiRuntime.runStore.runEvents(started.runId);
check(apiEvents.some((event) => event.type === EVENT_TYPES.RUN_FINISHED), 'the API run emitted run.finished into the persisted stream');
check(!SECRET_SHAPED.test(JSON.stringify(apiEvents)), 'the API run persisted no credential-shaped value');

// Every dataset case, both modes: the script must satisfy the tool schemas.
let schemaProblems = [];
let scriptsChecked = 0;
for (const agentId of ['svc_03', 'svc_04', 'svc_06']) {
  const definition = loadAgent(agentId);
  const cases = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, definition.dataset.path), 'utf8'));
  for (const entry of cases) {
    for (const mode of ['model', 'planned']) {
      const plan = buildOfflinePlan({ runtime: apiRuntime, agentId, input: entry.vars[definition.dataset.dataVar], mode });
      const result = validateScriptAgainstSchemas(apiRuntime, plan.script);
      scriptsChecked += result.checked;
      if (!result.ok) schemaProblems = schemaProblems.concat(result.problems);
      if (mode === 'planned' && !plan.steps?.length) schemaProblems.push(`${agentId}: planned mode produced no plan steps`);
    }
  }
  const freeText = buildOfflinePlan({ runtime: apiRuntime, agentId, input: 'an operator pasted something that is not a dataset case' });
  const freeCheck = validateScriptAgainstSchemas(apiRuntime, freeText.script);
  scriptsChecked += freeCheck.checked;
  if (!freeCheck.ok) schemaProblems = schemaProblems.concat(freeCheck.problems);
}
check(
  schemaProblems.length === 0,
  `every offline script for every dataset case satisfies its own tool schema (${scriptsChecked} scripted call(s) across ${24 + 3} builds)`,
);
if (schemaProblems.length) failures.push(...schemaProblems);

// The approval round trip, in process.
const escalationCase = apiDataset.find((entry) => entry.vars.expected_action === 'request_human_approval');
const pausedResponse = await api.handle({
  method: 'POST',
  pathname: '/api/runtime/agents/svc_03/runs',
  rawBody: JSON.stringify({ input: escalationCase.vars.invoice_data }),
});
const paused = JSON.parse(pausedResponse.body);
check(paused.status === 'WAITING_FOR_APPROVAL' && paused.terminal === false, 'a run that hands the decision to a human PAUSES non-terminal');
check(typeof paused.pendingApprovalId === 'string', 'the paused run created a real pending approval');
check(apiRuntime.runStore.getApproval(paused.pendingApprovalId)?.status === 'pending', 'the pending approval is persisted');
const approvalsQueue = JSON.parse(
  (await api.handle({ method: 'GET', pathname: '/api/runtime/approvals', searchParams: new URLSearchParams('status=pending') })).body,
);
check(
  approvalsQueue.approvals.some((approval) => approval.approvalId === paused.pendingApprovalId),
  'the pending approval is listed by the queue endpoint',
);
const approvedResponse = await api.handle({
  method: 'POST',
  pathname: `/api/runtime/approvals/${paused.pendingApprovalId}/approve`,
  rawBody: JSON.stringify({ resolvedBy: 'verify-runtime' }),
});
check(
  approvedResponse.status === 200 && JSON.parse(approvedResponse.body).approval.status === 'approved',
  'approving the pending approval is accepted and recorded',
);
const resumeResponse = await api.handle({
  method: 'POST',
  pathname: '/api/runtime/agents/svc_03/runs',
  rawBody: JSON.stringify({ input: escalationCase.vars.invoice_data, approvalId: paused.pendingApprovalId }),
});
const resumed = JSON.parse(resumeResponse.body);
check(resumed.toolCalls.includes('request_human_approval'), 'the resumed run executed the gated tool with the granted approval');
check(
  apiRuntime.runStore.runEvents(resumed.runId).some((event) => event.type === EVENT_TYPES.APPROVAL_RESOLVED),
  'the executor emitted approval.resolved for the consumed approval',
);
const cancelResponse = await api.handle({
  method: 'POST',
  pathname: `/api/runtime/runs/${paused.runId}/cancel`,
  rawBody: JSON.stringify({ reason: 'verify-runtime' }),
});
check(cancelResponse.status === 200 && JSON.parse(cancelResponse.body).state === 'CANCELLED', 'a paused run can be cancelled through the API');
const cancelAgain = await api.handle({ method: 'POST', pathname: `/api/runtime/runs/${paused.runId}/cancel`, rawBody: '{}' });
check(cancelAgain.status === 409 && JSON.parse(cancelAgain.body).error.code === 'RUN_NOT_CANCELLABLE', 'cancelling a terminal run is a 409');

// ── 13. call 4: the bounded tool-calling state machine (General AI Agents) ──
//
// Every adversary below is a test double: it proves the RUNTIME stops, and says
// nothing about how a live model behaves.
console.log('\n--- bounded execution (call 4) ---\n');

function boundedRuntime(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bounded-'));
  return createRuntime({
    config: loadConfig({ NODE_ENV: 'test', AGENT_STORAGE_DIR: dir }, { storageDir: dir, fixturesDir: config.fixturesDir, defaultProvider: 'mock' }),
    storageDir: dir,
    fixturesDir: config.fixturesDir,
    ...options,
  });
}
const DOUBLE = { tools: true, json: true, streaming: false, maxContextTokens: 128_000, deterministic: false, mock: true };
const planOf = (steps) => ({ text: JSON.stringify({ steps }) });
const PLAN = [
  { id: 's1', description: 'Get the AAPL quote', tool: 'get_market_quote', args: { ticker: 'AAPL' } },
  { id: 's2', description: 'Get the paper portfolio state', tool: 'get_portfolio_state', args: {} },
];

{
  const rt = boundedRuntime({ mockScript: [planOf(PLAN), { text: 'AAPL quote and portfolio, summarised.' }] });
  const agent = rt.boundedAgent();
  const description = agent.describe();
  check(description.algorithm === 'bounded tool-calling state machine' && description.states.length === 13, 'the bounded agent describes itself: the algorithm and the 13-state machine');
  check(Object.isFrozen(HARD_CEILINGS) && Object.values(HARD_CEILINGS).every((v) => Number.isInteger(v) && v > 0), 'the hard ceilings are frozen, finite, positive integers');

  const done = await agent.execute({ goal: 'Report the AAPL quote and the paper portfolio state.' });
  check(done.ok && done.status === 'COMPLETED' && done.strategy.name === 'planned', 'a flexible task is planned by the model and completes (strategy auto -> planned)');
  check(
    done.executedTools.join() === 'get_market_quote,get_portfolio_state' && done.usage.modelCalls === 2,
    'the plan ran step by step through the executor: 2 tool calls, 2 model calls (plan + summary)',
  );
  check(done.provider.mock === true && /test double/.test(done.notice), 'the result says the provider was a test double (mock vs real is labelled, not implied)');
  const stored = { run: rt.runStore.getRun(done.runId), trace: rt.runStore.getTrace(done.runId), audit: rt.runStore.readAudit().records.filter((row) => row.runId === done.runId) };
  check(stored.run?.status === 'COMPLETED' && Boolean(stored.trace) && stored.audit.length > 0, 'the run, its trace and its audit row are on disk, read back from the store');
  const events = rt.runStore.runEvents(done.runId);
  check(
    events.filter((e) => e.type === EVENT_TYPES.TOOL_EXECUTED).every((e) => events.some((p) => p.type === EVENT_TYPES.POLICY_DECIDED && p.payload.tool === e.payload.tool && p.payload.decision === 'ALLOW' && p.seq < e.seq)),
    'every executed tool had an earlier ALLOW verdict from the policy kernel in the same run',
  );
}

{
  const rt = boundedRuntime({ mockScript: [planOf([{ id: 's1', description: 'place an order', tool: 'submit_paper_order', args: { ticker: 'AAPL', side: 'buy', quantity: 1 } }])] });
  const refused = await rt.boundedAgent().execute({ goal: 'trade AAPL' });
  check(refused.status === 'FAILED' && refused.stopReason.code === 'PLAN_TOOL_NOT_PERMITTED' && refused.toolCalls.length === 0, 'a plan naming a tool outside the allowlist is refused before any tool is asked to run');
}

{
  let calls = 0;
  const runaway = {
    model: 'runaway-double',
    capabilities: () => DOUBLE,
    async complete() {
      calls += 1;
      return { text: '', toolCalls: [{ id: `c${calls}`, name: 'get_market_quote', arguments: { ticker: `T${calls}` } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
  };
  const rt = boundedRuntime({ providers: { mock: runaway } });
  const stopped = await rt.boundedAgent().execute({ goal: 'never stop', strategy: 'direct' });
  check(
    !stopped.ok && stopped.stopReason.code === 'ITERATION_BUDGET_EXCEEDED' && calls === stopped.envelope.limits.maxIterations,
    `a model that asks for a fresh tool call forever is stopped by the budget: ${calls} calls = maxIterations ${stopped.envelope.limits.maxIterations}`,
  );
  check(stopped.usage.transitions <= stopped.envelope.maxTransitions, 'the state machine stayed inside its transition fuel');
  check(rt.runStore.getRun(stopped.runId)?.status === stopped.status, 'and the stopped run is recorded with the status it reported');
}

{
  const rt = boundedRuntime({ mockScript: [{ text: 'x' }] });
  const before = rt.runStore.stores.runs.count();
  const outcomes = [];
  for (const task of [{ goal: 'x', limits: { maxIterations: HARD_CEILINGS.maxIterations + 1 } }, { goal: 'x', limits: { maxBananas: 1 } }, { goal: 'x', strategy: 'yolo' }, { goal: '' }, { goal: 'x', provider: 'openai' }]) {
    try {
      await rt.boundedAgent().execute(task);
      outcomes.push('ran');
    } catch (err) {
      outcomes.push(err instanceof BoundedAgentError ? err.code : 'other');
    }
  }
  check(
    outcomes.join() === [BOUNDED_ERROR_CODES.LIMIT_REJECTED, BOUNDED_ERROR_CODES.LIMIT_REJECTED, BOUNDED_ERROR_CODES.UNKNOWN_STRATEGY, BOUNDED_ERROR_CODES.INVALID_TASK, BOUNDED_ERROR_CODES.PROVIDER_NOT_CONFIGURED].join() &&
      rt.runStore.stores.runs.count() === before,
    'a request above a hard ceiling, an unknown limit or strategy, an empty goal and an unconfigured provider are each refused with a typed error, and create no run',
  );
}

{
  // One completion carrying 5000 tool calls, every one schema-invalid: they fail BEFORE the executor's
  // budget step, so only an attempt ledger can bound them.
  let turns = 0;
  const flood = {
    model: 'flood-double',
    capabilities: () => DOUBLE,
    async complete() {
      turns += 1;
      return { text: '', toolCalls: Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, name: 'get_market_quote', arguments: { ticker: i } })), usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    },
  };
  const rt = boundedRuntime({ providers: { mock: flood } });
  const flooded = await rt.boundedAgent().execute({ goal: 'flood', strategy: 'direct' });
  const cap = flooded.envelope.limits.maxToolCalls;
  check(
    flooded.stopReason?.code === 'TOOL_CALL_BUDGET_EXCEEDED' && flooded.toolCalls.length === cap + 1 && flooded.executedTools.length === 0 && turns === 1,
    `one completion carrying 5000 invalid tool calls is cut off at ${flooded.toolCalls.length} recorded attempts (maxToolCalls ${cap}), not ground through`,
  );
}

{
  const hung = { model: 'hung-double', capabilities: () => DOUBLE, complete: () => new Promise(() => {}) };
  const rt = boundedRuntime({ providers: { mock: hung } });
  const startedAt = Date.now();
  const timedOut = await rt.boundedAgent().execute({ goal: 'wait forever', strategy: 'direct', limits: { wallClockMs: 150 } });
  check(
    timedOut.stopReason?.code === 'WALL_CLOCK_TIMEOUT' && Date.now() - startedAt < 2000,
    `a provider that never answers cannot hang a run: stopped by the wall-clock deadline in ${Date.now() - startedAt}ms (budget 150ms)`,
  );
  check(rt.runStore.getRun(timedOut.runId)?.status === 'FAILED', 'and that run is recorded');
}

{
  const rt = boundedRuntime({ mockScript: [{ text: 'a slow answer', delayMs: 1500 }] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('verify-runtime cancelled it')), 40);
  const startedAt = Date.now();
  const cancelled = await rt.boundedAgent().execute({ goal: 'slow', strategy: 'direct', signal: controller.signal });
  check(
    cancelled.status === 'CANCELLED' && Date.now() - startedAt < 1000 && rt.runStore.getRun(cancelled.runId)?.status === 'CANCELLED',
    `aborting a run in flight cancels it without waiting out the model (${Date.now() - startedAt}ms of a 1500ms call), and records it CANCELLED`,
  );
}

{
  const rt = boundedRuntime({ mockScript: [{ toolCalls: [{ name: 'no_op', arguments: {} }] }, { text: 'done' }] });
  const fuel = await rt.boundedAgent().execute({ goal: 'go', strategy: 'direct', limits: { maxTransitions: 4 } });
  check(fuel.stopReason?.code === 'TRANSITION_LIMIT' && fuel.usage.transitions <= 5 && fuel.status === 'FAILED', 'the state machine has its own bound: spent transition fuel stops the run (TRANSITION_LIMIT), never mid-air');
}

{
  const rt = boundedRuntime({ mockScript: [{ text: 'escalation recorded' }] });
  const agent = rt.boundedAgent({ agentId: 'svc_03' });
  const steps = [{ id: 's1', description: 'hand the invoice to a human', tool: 'request_human_approval', args: { reason: 'over the $500.00 ceiling', payload: { invoice: '101' } } }];
  const paused = await agent.execute({ goal: 'Invoice #101. Amount: $750.00.', steps });
  check(paused.paused && paused.status === 'WAITING_FOR_APPROVAL' && paused.executedTools.length === 0 && rt.runStore.getRun(paused.runId)?.phase === 'paused', 'a gated call pauses the bounded run: persisted, non-terminal, nothing executed');
  rt.approvals.approve(paused.pendingApprovalId, { resolvedBy: 'verify-runtime' });
  const resumed = await agent.execute({ goal: 'Invoice #101. Amount: $750.00.', steps, approvalId: paused.pendingApprovalId });
  check(resumed.status === 'COMPLETED' && resumed.executedTools.join() === 'request_human_approval', 'resuming with the granted approval runs the gated call exactly as approved');
}

console.log(notes.join('\n'));
console.log('');

if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`all ${notes.length} checks passed.`);
console.log(`artefacts written under ${storageDir} (delete freely — it is evidence, not configuration).\n`);
process.exit(0);
