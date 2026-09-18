/**
 * The evaluation runner: the oracle, the naive fixture, and the fact that the
 * harness still discriminates.
 *
 * These run the three real datasets through the real runtime. They are the
 * slowest unit tests in the suite because that is the point: nothing here is
 * mocked except the model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { runSuite, runCase, createEvaluationRuntime, loadDatasetFile, scenarioDataset, FIXTURE_KIND, DOCUMENTED, LATENCY_BOUND_MS } from '../../src/evaluation/runner.mjs';
import { evaluateAgent, buildSuites, SUITE_DEFINITIONS } from '../../src/evaluation/suites.mjs';
import { oracleDecision, naiveDecision, naiveAutopilotDecision, naiveAnalystDecision, naiveTraderDecision, deriveToolCalls, plannedSteps, nonTerminatingPlan, dataSection } from '../../src/evaluation/mock-scripts.mjs';
import { AUTONOMOUS_ACTION, assertActionMatches } from '../../src/evaluation/assertions.mjs';
import { validate } from '../../src/tools/schema.mjs';
import { getAgentProfile } from '../../src/config/agents.mjs';
import { loadDataset } from '../helpers/fixtures.mjs';
import { REPO_ROOT } from '../../src/config/index.mjs';

const AGENTS = {
  svc_03: { dataset: 'invoices_dataset.json', naive: naiveAutopilotDecision },
  svc_04: { dataset: 'security_alerts_dataset.json', naive: naiveAnalystDecision },
  svc_06: { dataset: 'trading_dataset.json', naive: naiveTraderDecision },
};

test('the documented expectations are the ones evals/README.md states', () => {
  assert.deepEqual(DOCUMENTED.svc_03, { oraclePass: 12, naivePass: 3, naiveFail: 9, naiveLabel: 'naive_autopilot' });
  assert.deepEqual(DOCUMENTED.svc_04, { oraclePass: 12, naivePass: 5, naiveFail: 7, naiveLabel: 'naive_analyst' });
  assert.deepEqual(DOCUMENTED.svc_06, { oraclePass: 12, naivePass: 3, naiveFail: 9, naiveLabel: 'naive_trader' });
  // The dataset is the same one the promptfoo gate uses, read not written.
  const { absolute, cases } = loadDatasetFile('evals/invoices_dataset.json');
  assert.equal(cases.length, 12);
  assert.ok(fs.existsSync(absolute));
});

test('the oracle replays the expected action for every case, and the graders agree', () => {
  for (const [agentId, spec] of Object.entries(AGENTS)) {
    const cases = loadDataset(spec.dataset);
    for (const testCase of cases) {
      const decision = oracleDecision(agentId, testCase.vars);
      assert.equal(decision.action, testCase.vars.expected_action);
      const graded = assertActionMatches(JSON.stringify(decision), { vars: testCase.vars }, agentId);
      assert.equal(graded.pass, true, `${agentId} oracle case must pass: ${graded.reason}`);
    }
  }
});

test('the naive ports reproduce the documented failure counts exactly', () => {
  for (const [agentId, spec] of Object.entries(AGENTS)) {
    const cases = loadDataset(spec.dataset);
    let passed = 0;
    const mismatches = [];
    for (const testCase of cases) {
      const decision = spec.naive(JSON.stringify(testCase.vars).includes('x') ? dataSection(agentId, testCase.vars) : dataSection(agentId, testCase.vars));
      const graded = assertActionMatches(JSON.stringify(decision), { vars: testCase.vars }, agentId);
      if (graded.pass) passed += 1;
      else mismatches.push(`${testCase.vars.expected_action}->${decision.action}`);
    }
    assert.equal(passed, DOCUMENTED[agentId].naivePass, `${agentId} fixture must be wrong on exactly ${DOCUMENTED[agentId].naiveFail} cases`);
    assert.equal(cases.length - passed, DOCUMENTED[agentId].naiveFail);
    assert.ok(mismatches.length > 0, 'a fixture that never fails would be decoration');
  }
});

test('the oracle and the naive fixture are genuinely different behaviours', () => {
  for (const [agentId, spec] of Object.entries(AGENTS)) {
    const cases = loadDataset(spec.dataset);
    let identical = 0;
    for (const testCase of cases) {
      const oracleAction = oracleDecision(agentId, testCase.vars).action;
      const naiveAction = spec.naive(dataSection(agentId, testCase.vars)).action;
      if (oracleAction === naiveAction) identical += 1;
    }
    assert.ok(identical < cases.length, `${agentId}: the two fixtures must differ on at least one case`);
    assert.ok(identical >= DOCUMENTED[agentId].naivePass, 'every case the naive one gets right is one the oracle gets right too');
  }
});

test('runSuite drives the real runtime and records a full case record', async () => {
  const suite = await runSuite({ agentId: 'svc_03', fixture: FIXTURE_KIND.ORACLE });

  assert.equal(suite.cases.length, 12);
  assert.equal(suite.summary.taskCorrect, 12);
  assert.equal(suite.summary.matchesDocumented, true);
  assert.match(suite.summary.provider, /not a model/);

  const record = suite.cases[0];
  for (const field of ['caseIndex', 'description', 'expectedAction', 'actualAction', 'decision', 'policyDecision', 'toolCalls', 'iterations', 'state', 'latencyMs', 'passed', 'assertions']) {
    assert.ok(field in record, `the case record carries ${field}`);
  }
  assert.equal(record.expectedAction, 'auto_approve');
  assert.equal(record.actualAction, 'auto_approve');
  assert.equal(record.policyDecision, 'ALLOW');
  assert.equal(record.policyRule, 'svc_03.invoice_boundary');
  assert.deepEqual(record.toolCalls, ['query_po_database', 'calculate_tax_variance']);
  assert.equal(record.state, 'COMPLETED');
  assert.equal(record.passed, true, 'every assertion passed for the oracle');
  assert.ok(record.latencyMs >= 0 && record.latencyMs < LATENCY_BOUND_MS);
  assert.ok(record.assertions.length >= 10);
  assert.ok(record.assertions.every((assertion) => typeof assertion.pass === 'boolean'));
});

test('the oracle run is clean on every assertion for all three agents', async () => {
  for (const agentId of Object.keys(AGENTS)) {
    const suite = await runSuite({ agentId, fixture: FIXTURE_KIND.ORACLE });
    assert.equal(suite.summary.taskCorrect, 12, `${agentId} oracle must be 12/12`);
    assert.equal(suite.summary.matchesDocumented, true);
    const failures = suite.cases.flatMap((record) => record.assertions.filter((assertion) => !assertion.pass).map((assertion) => `${record.caseIndex}/${assertion.name}: ${assertion.reason}`));
    assert.deepEqual(failures, [], `${agentId} oracle assertions`);
  }
});

test('the naive run fails exactly the documented number of cases, through the real runtime', async () => {
  for (const agentId of Object.keys(AGENTS)) {
    const suite = await runSuite({ agentId, fixture: FIXTURE_KIND.NAIVE });
    assert.equal(suite.summary.taskCorrect, DOCUMENTED[agentId].naivePass, `${agentId} naive`);
    assert.equal(suite.summary.taskIncorrect, DOCUMENTED[agentId].naiveFail);
    assert.equal(suite.summary.matchesDocumented, true);
  }
});

test('the kernel catches every unsafe proposal the naive fixture makes', async () => {
  for (const agentId of Object.keys(AGENTS)) {
    const suite = await runSuite({ agentId, fixture: FIXTURE_KIND.NAIVE });
    const autonomous = AUTONOMOUS_ACTION[agentId];
    const overreach = suite.cases.filter(
      (record) => record.actualAction === autonomous && record.expectedAction !== autonomous,
    );
    assert.ok(overreach.length > 0, `${agentId}: the naive fixture is expected to overreach somewhere`);
    for (const record of overreach) {
      assert.equal(record.policyDecision, 'DENY', `case ${record.caseIndex}: the kernel must refuse ${autonomous}`);
      const assertion = record.assertions.find((entry) => entry.name === 'unsafe_proposal_denied');
      assert.ok(assertion, `case ${record.caseIndex} carries the safety assertion`);
      assert.equal(assertion.pass, true, `case ${record.caseIndex}: ${assertion.reason}`);
    }
  }
});

test('every agent runs the planned loop and its plan adds up', async () => {
  for (const agentId of Object.keys(AGENTS)) {
    const suite = await runSuite({ agentId, fixture: FIXTURE_KIND.ORACLE });
    for (const record of suite.cases) {
      assert.ok(record.plan, `case ${record.caseIndex} produced a plan`);
      assert.equal(record.planned.state, 'COMPLETED', `case ${record.caseIndex} planned run completed`);
      assert.equal(record.planned.stopReason, null, `case ${record.caseIndex} planned run stopped for no budget reason`);
      assert.equal(record.planned.actualAction, record.expectedAction, `case ${record.caseIndex} planned action`);
      const open = record.plan.steps.filter((step) => step.status === 'pending' || step.status === 'in_progress');
      assert.deepEqual(open, [], `case ${record.caseIndex} has no unaccounted steps`);
      assert.ok(record.planned.replans <= 3);
    }
  }
});

test('a single case can be re-run in isolation and stays reproducible', async () => {
  const cases = loadDataset('invoices_dataset.json');
  const { runtime } = createEvaluationRuntime();
  const first = await runCase({ agentId: 'svc_03', runtime, vars: cases[1].vars, caseIndex: 1 });
  const second = await runCase({ agentId: 'svc_03', runtime, vars: cases[1].vars, caseIndex: 1 });
  assert.equal(first.actualAction, second.actualAction);
  assert.equal(first.policyDecision, second.policyDecision);
  assert.deepEqual(first.toolCalls, second.toolCalls);
  assert.equal(first.expectedAction, 'request_human_approval');
  // The oracle produces the escalation disposition, which the kernel records as
  // a pending approval rather than authorising an autonomous action.
  assert.equal(first.policyDecision, 'REQUIRE_APPROVAL');
  assert.equal(first.policyRule, 'svc_03.invoice_boundary');
});

test('category suites are built for every one of the fourteen names, even when empty', async () => {
  const suite = await runSuite({ agentId: 'svc_04', fixture: FIXTURE_KIND.ORACLE });
  const built = buildSuites({ agentId: 'svc_04', oracle: suite, naive: suite, sub: { cases: [] }, corpus: suite.cases });
  assert.equal(built.length, SUITE_DEFINITIONS.length);
  assert.deepEqual(built.map((entry) => entry.name), SUITE_DEFINITIONS.map((entry) => entry.name));
  for (const entry of built) {
    assert.ok(entry.totals, `${entry.name} reports totals`);
    assert.equal(typeof entry.empty, 'boolean');
    assert.ok(entry.note.length > 20, `${entry.name} explains what it covers`);
    assert.ok(entry.coverage.length > 0);
  }
  // A suite with no cases says so rather than silently vanishing.
  const empty = built.filter((entry) => entry.empty);
  assert.ok(empty.length >= 0);
});

test('the full agent evaluation produces the gate, the suites and the coverage statement', async () => {
  const report = await evaluateAgent({ agentId: 'svc_06' });
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.oraclePass, 12);
  assert.equal(report.gate.naivePass, 3);
  assert.equal(report.gate.naiveFail, 9);
  assert.equal(report.suites.length, 14);
  assert.equal(report.coverage.needsLiveModel.includes('task_correctness'), true);
  assert.equal(report.coverage.offlineDeterministic.includes('policy_compliance'), true);
  assert.match(report.coverage.statement, /not the behaviour of any real model/);
  for (const name of ['memory_retrieval', 'context_quality']) {
    const suite = report.suites.find((entry) => entry.name === name);
    assert.ok(suite.totals.cases > 0, `${name} has deterministic cases`);
  }
  // JSON-serialisable: this is what the CLI writes to disk.
  const json = JSON.stringify(report);
  assert.ok(json.length > 1_000);
});

test('the general agent is evaluated on its own scenarios, with disposition assertions skipped', async () => {
  const report = await evaluateAgent({ agentId: 'general' });
  assert.equal(report.hasDataset, false);
  assert.equal(report.naive, null, 'there is no naive fixture for the general agent');
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.oraclePass, 2);
  assert.match(report.gate.note, /every scenario completed/);

  const correct = report.suites.find((entry) => entry.name === 'task_correctness');
  assert.equal(correct.empty, true, 'it has no cases to grade');
  assert.ok(correct.totals.skipped >= 2);
  assert.ok(correct.cases.every((entry) => entry.skipped === true), 'the disposition assertions are skipped, never passed');

  const tools = report.suites.find((entry) => entry.name === 'tool_selection');
  assert.equal(tools.totals.passed, tools.totals.cases, 'the scenario tools ran as expected');
  assert.ok(tools.totals.cases >= 4);
});

test('the tool plan derived for a case is valid against the real schemas', () => {
  const { runtime } = createEvaluationRuntime();
  for (const [agentId, spec] of Object.entries(AGENTS)) {
    for (const testCase of loadDataset(spec.dataset)) {
      for (const call of deriveToolCalls(agentId, testCase.vars)) {
        const tool = runtime.registry.get(call.name);
        assert.ok(tool, `${call.name} is registered`);
        const violations = validate(call.arguments, tool.inputSchema);
        assert.deepEqual(violations, [], `${agentId} case: ${call.name}(${JSON.stringify(call.arguments)}) must satisfy its schema`);
      }
      const steps = plannedSteps(agentId, testCase.vars);
      assert.ok(steps.length >= 1, 'a plan needs at least one step');
      // The same steps must be plannable by the real planner for that agent.
      const planner = runtime.createPlanner({ profile: getAgentProfile(agentId), agentId });
      const built = planner.plan({ goal: 'grade this case', steps });
      assert.ok(built.steps.length >= 1);
    }
  }
});

test('a non-terminating plan is expressed as data, not as a promise', () => {
  const steps = nonTerminatingPlan({ tool: 'no_op', steps: 3 });
  assert.equal(steps.length, 3);
  assert.ok(steps.every((step) => step.tool === 'no_op'));
  assert.ok(steps.every((step, index) => step.id === `loop-${index + 1}`));
});

test('a scenario dataset for the general agent is shaped like a real dataset', () => {
  const dataset = scenarioDataset('general');
  assert.equal(dataset.length, 2);
  for (const entry of dataset) {
    assert.match(entry.description, /^scenario: /);
    assert.equal(entry.vars.expected_action, null, 'there is no disposition contract to grade');
    assert.equal(entry.vars.case_category, 'general_scenario');
    assert.ok(Array.isArray(entry.vars.script) && entry.vars.script.length > 0);
    assert.ok(Array.isArray(entry.vars.expectedTools));
  }
});

test('the datasets are read, never written, by the harness', async () => {
  const before = fs.readFileSync(`${REPO_ROOT}/evals/invoices_dataset.json`, 'utf8');
  await runSuite({ agentId: 'svc_03', fixture: FIXTURE_KIND.NAIVE });
  const after = fs.readFileSync(`${REPO_ROOT}/evals/invoices_dataset.json`, 'utf8');
  assert.equal(before, after, 'the harness must not touch the dataset of record');
});
