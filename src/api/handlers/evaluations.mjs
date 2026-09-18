/**
 * `GET /api/runtime/evaluations` — the last `npm run eval:runtime` report.
 *
 * The report is a file this server did not write and cannot regenerate:
 * `data/state/evals/runtime-results.json`, produced by `scripts/eval-runtime.mjs`.
 * So the endpoint has two honest answers — the report, or a "not run yet"
 * payload that names the command to run — and it never invents a report to fill
 * the gap. `available: false` is a 200: the absence of a report is not an error
 * in the request.
 *
 * The report is summarised rather than returned whole: per agent, the gate
 * verdict, the oracle/naive counts and the suite totals. The full report
 * (including per-case assertions) stays on disk, and the response says where.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where `scripts/eval-runtime.mjs` writes by default. */
export function defaultReportPath(storageDir) {
  return path.join(storageDir, 'evals', 'runtime-results.json');
}

function summarizeSuite(suite) {
  return {
    name: suite?.name ?? null,
    title: suite?.title ?? null,
    coverage: suite?.coverage ?? null,
    requiresLiveModel: suite?.requiresLiveModel === true,
    empty: suite?.empty === true,
    note: suite?.note ?? null,
    totals: suite?.totals ?? { cases: 0, passed: 0, failed: 0, skipped: 0, asserted: 0 },
  };
}

function summarizeFixture(fixture) {
  if (!fixture) return null;
  return {
    fixture: fixture.fixture ?? null,
    provider: fixture.provider ?? null,
    runtimeVersion: fixture.runtimeVersion ?? null,
    cases: fixture.cases ?? 0,
    taskCorrect: fixture.taskCorrect ?? 0,
    taskIncorrect: fixture.taskIncorrect ?? 0,
    passed: fixture.passed ?? 0,
    failed: fixture.failed ?? 0,
    matchesDocumented: fixture.matchesDocumented ?? null,
    durationMs: fixture.durationMs ?? null,
    maxLatencyMs: fixture.maxLatencyMs ?? null,
    totalTokens: fixture.totalTokens ?? null,
  };
}

function summarizeAgent(agent) {
  const counts = { cases: 0, passed: 0, failed: 0, skipped: 0 };
  for (const suite of agent.suites ?? []) {
    counts.cases += suite?.totals?.cases ?? 0;
    counts.passed += suite?.totals?.passed ?? 0;
    counts.failed += suite?.totals?.failed ?? 0;
    counts.skipped += suite?.totals?.skipped ?? 0;
  }
  return {
    agentId: agent.agentId,
    hasDataset: agent.hasDataset === true,
    gate: agent.gate ?? null,
    oracle: summarizeFixture(agent.oracle),
    naive: summarizeFixture(agent.naive),
    suites: (agent.suites ?? []).map(summarizeSuite),
    suiteTotals: counts,
    emptySuites: (agent.suites ?? []).filter((suite) => suite?.empty === true).map((suite) => suite.name),
    caseCount: (agent.cases ?? []).length,
  };
}

export function createEvaluationsHandler({ runtime, reportPath = null }) {
  const resolvedPath = reportPath ?? defaultReportPath(runtime.storageDir);

  return {
    latest() {
      if (!fs.existsSync(resolvedPath)) {
        return {
          status: 200,
          body: {
            available: false,
            path: resolvedPath,
            command: 'npm run eval:runtime',
            oracleOnlyCommand: 'npm run eval:runtime:oracle',
            note:
              'no runtime evaluation report has been written to this path. The report is produced by ' +
              'scripts/eval-runtime.mjs against the real runtime with the deterministic mock provider; this ' +
              'endpoint will not fabricate one.',
          },
        };
      }

      let report;
      try {
        report = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      } catch (error) {
        return {
          status: 200,
          body: {
            available: false,
            path: resolvedPath,
            command: 'npm run eval:runtime',
            unreadable: true,
            error: error?.message ?? String(error),
            note: 'the report file exists but could not be parsed; re-run the gate to regenerate it',
          },
        };
      }

      const agents = (report.agents ?? []).map(summarizeAgent);
      const totals = agents.reduce(
        (accumulator, agent) => {
          accumulator.oracleCases += agent.oracle?.cases ?? 0;
          accumulator.oracleCorrect += agent.oracle?.taskCorrect ?? 0;
          accumulator.oracleFailedAssertions += agent.oracle?.failed ?? 0;
          if (agent.naive) {
            accumulator.naiveCases += agent.naive.cases ?? 0;
            accumulator.naiveCorrect += agent.naive.taskCorrect ?? 0;
          }
          accumulator.agents += 1;
          if (agent.gate?.ok === false) accumulator.agentsFailingGate += 1;
          return accumulator;
        },
        { agents: 0, agentsFailingGate: 0, oracleCases: 0, oracleCorrect: 0, oracleFailedAssertions: 0, naiveCases: 0, naiveCorrect: 0 },
      );

      return {
        status: 200,
        body: {
          available: true,
          path: resolvedPath,
          kind: report.kind ?? null,
          generatedAt: report.generatedAt ?? null,
          mode: report.mode ?? null,
          fixtureNote: report.fixtureNote ?? null,
          agents,
          totals,
          statement:
            'Every suite in this report runs offline against the real runtime with the deterministic mock ' +
            'provider. It measures the runtime, the policy kernel and the harness — not any live model.',
          requiresLiveModel:
            'The categories that need a live model to say anything about a real model are task_correctness, ' +
            'tool_selection, tool_arguments, planning, prompt_injection_resistance and hallucination. Run ' +
            '`npm run eval`, `eval:security`, `eval:trading` (and their `:oracle` variants) with a key configured.',
        },
      };
    },
  };
}

export default createEvaluationsHandler;
