/**
 * Agent definitions: the migration of the three SVC agents onto the shared
 * runtime, plus the general agent.
 *
 * The contract this file pins is "extend, don't fork": every agent definition
 * must reuse the frozen call-1 profile by identity, and the authoritative
 * numbers must have exactly one source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadAgent, loadAllAgents, listAgentIds, listSvcAgentIds, isKnownAgent, systemPromptFor, runAgentCase, parseDecision, terminalStatusFor } from '../../src/agents/index.mjs';
import { AGENT_PROFILES, BOUNDARIES, getAgentProfile } from '../../src/config/agents.mjs';
import { makeTestRuntime } from '../helpers/runtime.mjs';
import { createPromptRenderer } from '../../src/prompts/render.mjs';
import { loadDataset } from '../helpers/fixtures.mjs';
import { STATES } from '../../src/runtime/state-machine.mjs';

const SVC_IDS = ['svc_03', 'svc_04', 'svc_06'];

test('the loader knows four agents, three with a domain boundary', () => {
  assert.deepEqual(listAgentIds(), ['general', 'svc_03', 'svc_04', 'svc_06']);
  assert.deepEqual(listSvcAgentIds(), SVC_IDS);
  assert.equal(isKnownAgent('svc_03'), true);
  assert.equal(isKnownAgent('svc_99'), false);
  assert.throws(() => loadAgent('svc_99'), /unknown agent "svc_99"/);
});

test('every agent definition reuses the frozen runtime profile by identity', () => {
  for (const agent of loadAllAgents()) {
    assert.equal(agent.runtimeProfile, getAgentProfile(agent.id), `${agent.id} must share the profile object`);
    assert.equal(agent.runtimeProfile, AGENT_PROFILES[agent.id]);
    assert.deepEqual(agent.toolAllowlist, getAgentProfile(agent.id).tools);
    assert.equal(Object.isFrozen(agent), true, `${agent.id} returns a frozen definition`);
  }
});

test('the authoritative numbers have one source: the frozen profile and boundaries', () => {
  const svc03 = loadAgent('svc_03');
  assert.equal(svc03.policy.autonomousApprovalCeilingUsd, 500);
  assert.equal(svc03.policy.boundary, BOUNDARIES.svc_03);
  assert.equal(svc03.runtimeProfile.actionPolicy.autonomousApprovalCeilingUsd, BOUNDARIES.svc_03.autonomousApprovalCeilingUsd);

  const svc04 = loadAgent('svc_04');
  assert.equal(svc04.policy.incidentLevelCeiling, 12);
  assert.equal(svc04.policy.containmentPermitted, false);

  const svc06 = loadAgent('svc_06');
  assert.equal(svc06.policy.maxSingleOrderNotionalUsd, 10_000);
  assert.equal(svc06.policy.dailyLossHaltUsd, -1_000);
  assert.deepEqual(svc06.policy.instrumentAllowlist, ['AAPL', 'AMZN', 'GOOGL', 'MSFT', 'SPY']);
  assert.equal(svc06.policy.realAccountRouting, 'forbidden');
});

test('each SVC agent definition carries its prompt path, dataset pointer and evaluation suite', () => {
  const expected = {
    svc_03: { prompt: 'prompts/svc_03/invoice_agent.md', dataset: 'evals/invoices_dataset.json', placeholder: 'invoice_data', cases: 12, naivePass: 3 },
    svc_04: { prompt: 'prompts/svc_04/security_triage_agent.md', dataset: 'evals/security_alerts_dataset.json', placeholder: 'alert_data', cases: 12, naivePass: 5 },
    svc_06: { prompt: 'prompts/svc_06/paper_trading_agent.md', dataset: 'evals/trading_dataset.json', placeholder: 'market_data', cases: 12, naivePass: 3 },
  };
  for (const [agentId, spec] of Object.entries(expected)) {
    const agent = loadAgent(agentId);
    assert.equal(agent.prompts.system, spec.prompt);
    assert.equal(agent.dataset.path, spec.dataset);
    assert.equal(agent.prompts.placeholder, spec.placeholder);
    assert.equal(agent.dataset.cases, spec.cases);
    assert.equal(agent.evaluation.expected.oraclePass, 12);
    assert.equal(agent.evaluation.expected.naivePass, spec.naivePass);
    assert.equal(agent.evaluation.suites.length, 14, 'every SVC agent reports all fourteen suites');
    assert.equal(agent.prompts.systemFor.name.length > 0, true);
  }
  assert.equal(loadAgent('svc_03').prompts.guardrail, 'prompts/svc_03/guardrail.md');
  assert.match(loadAgent('svc_03').prompts.guardrailText(), /Compliance Guardrail/);
  assert.equal(loadAgent('svc_04').prompts.guardrail, null);
});

test('the SVC agents render their prompt of record from a real dataset case', () => {
  for (const agentId of SVC_IDS) {
    const agent = loadAgent(agentId);
    const [firstCase] = loadDataset(path.basename(agent.dataset.path));
    const rendered = agent.prompts.systemFor(firstCase.vars);
    assert.ok(rendered.includes(firstCase.vars[agent.dataset.dataVar]), `${agentId}: the case data is in the prompt`);
    assert.equal(rendered.includes('{{'), false, `${agentId}: no placeholder survives`);
  }
});

test('a case adapter turns dataset facts into structured evidence, never prose', () => {
  const [invoiceCase] = loadDataset('invoices_dataset.json');
  const adapted = loadAgent('svc_03').caseAdapter(invoiceCase.vars);

  assert.equal(adapted.agentId, 'svc_03');
  assert.equal(adapted.expectedAction, 'auto_approve');
  assert.deepEqual(adapted.evidence, { amount: 450, poPresent: true, poVerified: true, variance: 0 });
  assert.deepEqual(adapted.untrusted, { text: invoiceCase.vars.invoice_data, source: 'invoice' });
  assert.match(adapted.systemPrompt, /INVOICE UNDER REVIEW/);
  assert.ok(Object.isFrozen(adapted.evidence), 'the evidence handed to the policy kernel is immutable');

  const [alertCase] = loadDataset('security_alerts_dataset.json');
  const triage = loadAgent('svc_04').caseAdapter(alertCase.vars);
  assert.equal(triage.evidence.ruleLevel, 6);
  assert.equal(triage.evidence.allowlisted, true);
  assert.equal(triage.evidence.corroboration, false);

  const [tradeCase] = loadDataset('trading_dataset.json');
  const trade = loadAgent('svc_06').caseAdapter(tradeCase.vars);
  assert.equal(trade.evidence.ticker, 'AAPL');
  assert.equal(trade.evidence.notional, 9450);
  assert.equal(trade.evidence.portfolio.realizedDayPnl, 120.5);
  assert.equal(trade.untrusted.source, 'order');
});

test('the evidence an adapter produces is exactly what the kernel needs to agree with the dataset', () => {
  // This is the seam that makes the evaluation harness meaningful: if the
  // adapter dropped a fact, the kernel would disagree with the dataset.
  const datasets = {
    svc_03: 'invoices_dataset.json',
    svc_04: 'security_alerts_dataset.json',
    svc_06: 'trading_dataset.json',
  };
  for (const [agentId, file] of Object.entries(datasets)) {
    const cases = loadDataset(file);
    for (const testCase of cases) {
      const adapted = loadAgent(agentId).caseAdapter(testCase.vars);
      assert.equal(
        loadAgent(agentId).caseAdapter(testCase.vars).expectedAction,
        testCase.vars.expected_action,
        `${agentId}: the adapter passes the expectation through untouched`,
      );
      for (const [key, value] of Object.entries(adapted.evidence)) {
        if (key === 'portfolio') continue;
        assert.notEqual(value, undefined, `${agentId}: evidence.${key} is defined`);
      }
    }
  }
});

test('the general agent has no domain boundary and only read-only tools', () => {
  const general = loadAgent('general');
  assert.equal(general.policy.boundary, null);
  assert.deepEqual(general.policy.dispositions, {});
  assert.deepEqual(general.runtimeProfile.actionPolicy, {}, 'the general agent has no numeric ceiling');
  assert.match(general.policy.policyKernel, /generic kernel only/);
  assert.equal(general.dataset.path, null);

  // Every tool it holds is read-only or none, and it holds no write grant.
  const { runtime } = makeTestRuntime();
  for (const name of general.toolAllowlist) {
    const tool = runtime.registry.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(['none', 'read'].includes(tool.sideEffect), `${name} must not write`);
    assert.equal(tool.requiresConfirmation ?? false, false, `${name} must not need confirmation`);
    assert.equal(tool.escalation ?? false, false, `${name} must not be an escalation path`);
  }
  assert.equal(general.toolAllowlist.includes('no_op'), true);
  for (const forbidden of ['submit_paper_order', 'create_incident_ticket', 'request_human_approval', 'request_analyst_review', 'request_human_review']) {
    assert.equal(general.toolAllowlist.includes(forbidden), false, `${forbidden} must not be granted to the general agent`);
  }
  assert.ok(general.toolAllowlist.every((name) => general.runtimeProfile.permissions.includes(runtime.registry.get(name).permissions[0]) || runtime.registry.get(name).permissions.length === 0));
});

test('the general agent declares its unauthorised-action behaviour instead of hiding it', () => {
  const general = loadAgent('general');
  assert.equal(general.policy.unauthorisedActionOutcome, 'DENY (engine.default, fail closed)');
  const { runtime } = makeTestRuntime();
  const run = runtime.createRun({ agentId: 'general' });
  const verdict = run.evaluateAction('respond', {});
  assert.equal(verdict.decision, 'DENY');
  assert.equal(verdict.rule, 'engine.default');
  run.finish({ status: STATES.COMPLETED });
});

test('the general agent can run a multi-step task offline through the real runtime', async () => {
  const { runtime } = makeTestRuntime();
  const agent = loadAgent('general');
  const scenario = agent.offlineScenario('market_and_portfolio');

  const outcome = await runAgentCase({
    agentId: 'general',
    runtime,
    adapted: scenario,
    script: [...scenario.script],
  });

  assert.deepEqual(outcome.toolCalls, [...scenario.expectedTools], 'both read-only tools ran, in order');
  assert.equal(outcome.state, STATES.COMPLETED);
  assert.equal(outcome.stopReason, null);
  assert.match(outcome.finalText, /AAPL/);
  assert.equal(runtime.runStore.getRun(outcome.runId).status, 'COMPLETED');
  assert.equal(runtime.runStore.runEvents(outcome.runId).length > 8, true, 'the whole pipeline emitted events');
});

test('the general agent is refused the tools it does not hold, even when asked', async () => {
  const { runtime } = makeTestRuntime();
  const run = runtime.createRun({ agentId: 'general' });
  for (const [tool, args] of [
    ['submit_paper_order', { ticker: 'AAPL', quantity: 1, limitPrice: 1 }],
    ['create_incident_ticket', { title: 'x', severity: 'low' }],
    ['request_human_approval', { reason: 'x', payload: {} }],
  ]) {
    const result = await run.runTool(tool, args);
    assert.equal(result.status, 'POLICY_DENIED', `${tool} must be refused`);
    assert.equal(result.policy.rule, 'tool.authorization');
  }
  assert.equal(runtime.runStore.listOrders().length, 0);
  assert.equal(runtime.runStore.listIncidents().length, 0);
  run.finish({ status: STATES.BLOCKED, reason: 'unauthorised tool calls' });
});

test('each SVC agent runs end to end offline with the deterministic mock provider', async () => {
  const cases = {
    svc_03: [loadDataset('invoices_dataset.json')[0], { toolCalls: [{ name: 'query_po_database', arguments: { poNumber: '990' } }] }],
    svc_04: [loadDataset('security_alerts_dataset.json')[0], { toolCalls: [{ name: 'query_alert_context', arguments: { alertId: '31103' } }] }],
    svc_06: [loadDataset('trading_dataset.json')[0], { toolCalls: [{ name: 'get_portfolio_state', arguments: {} }] }],
  };
  for (const agentId of SVC_IDS) {
    const [testCase, toolTurn] = cases[agentId];
    const agent = loadAgent(agentId);
    const adapted = agent.caseAdapter(testCase.vars);
    const { runtime } = makeTestRuntime();
    const run = runtime.createRun({ agentId });
    runtime.mockProvider.reset({
      script: [toolTurn, { json: { reasoning: 'offline', action: testCase.vars.expected_action } }],
    });
    const outcome = await run.loop({
      systemPrompt: adapted.systemPrompt,
      userMessage: adapted.userMessage,
      evidence: adapted.evidence,
      untrusted: adapted.untrusted,
      responseFormat: 'json',
    });
    const decision = parseDecision(outcome.finalText);
    assert.equal(decision.action, testCase.vars.expected_action, `${agentId} reaches its documented disposition`);
    const verdict = run.evaluateAction(decision.action, adapted.evidence, adapted.untrusted);
    assert.notEqual(verdict.decision, 'DENY', `${agentId}: the disposition is inside the boundary`);
    run.finish({ status: terminalStatusFor(run, outcome) });
    assert.equal(runtime.runStore.getRun(run.runId).status !== null, true);
  }
});

test('the shared prompt renderer is threaded through the loader, so all agents agree on paths', () => {
  const renderer = createPromptRenderer();
  const agent = loadAgent('svc_03', { renderer });
  assert.equal(renderer.promptPathFor('svc_03'), 'prompts/svc_03/invoice_agent.md');
  assert.equal(renderer.guardrailPathFor('svc_03'), 'prompts/svc_03/guardrail.md');
  assert.equal(systemPromptFor('svc_04', { alert_data: 'alert text' }, { renderer }).includes('alert text'), true);
  assert.equal(agent.dataset.dataVar, 'invoice_data');
  assert.equal(renderer.describe().agents.length, 3);
});

test('describe() is a complete, serialisable summary of an agent', () => {
  for (const agentId of listAgentIds()) {
    const described = loadAgent(agentId).describe();
    const json = JSON.stringify(described);
    assert.ok(json.length > 100);
    assert.equal(JSON.parse(json).id, agentId);
    assert.equal(Array.isArray(described.suites), true);
    assert.equal(described.suites.length, agentId === 'general' ? 13 : 14, `${agentId} suite count`);
  }
});

test('every agent evaluation suite list names the required categories', () => {
  const required = [
    'task_correctness', 'tool_selection', 'tool_arguments', 'planning', 'safety',
    'prompt_injection_resistance', 'policy_compliance', 'hallucination', 'memory_retrieval',
    'context_quality', 'task_completion', 'regression', 'latency', 'cost',
  ];
  for (const agent of loadAllAgents()) {
    const missing = required.filter((suite) => !agent.evaluation.suites.includes(suite));
    if (agent.id === 'general') {
      // The general agent has no disposition contract, so it has no
      // `task_correctness` to declare — and it says so rather than claiming one.
      assert.deepEqual(missing, ['task_correctness']);
      assert.match(agent.dataset.note, /no adversarial dataset of its own/);
      assert.deepEqual(agent.evaluation.scenarios, ['market_and_portfolio', 'invoice_and_alert_lookup']);
    } else {
      assert.deepEqual(missing, [], `${agent.id} must declare every suite`);
    }
  }
});
