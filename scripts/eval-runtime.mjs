#!/usr/bin/env node
/**
 * eval:runtime — run the eval datasets through the REAL runtime, offline.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * What this is:
 *   The three SVC datasets (12 cases each) plus the general agent's offline
 *   scenarios, executed through the real state machine, tool executor, policy
 *   kernel, approval gate and JSONL stores. The model is the deterministic mock
 *   provider, driven by the oracle and naive fixtures in
 *   `src/evaluation/mock-scripts.mjs` — the runtime equivalents of the
 *   promptfoo fixtures the repository already gates on.
 *
 * What this is NOT:
 *   A model evaluation. Nothing here says anything about how a real model
 *   behaves. That is what `npm run eval` / `eval:security` / `eval:trading`
 *   measure, with a key configured. This gate proves the runtime agrees with
 *   the datasets, and that the harness can still FAIL.
 *
 * Usage:
 *   node scripts/eval-runtime.mjs                 # all agents, oracle + naive
 *   node scripts/eval-runtime.mjs --oracle        # oracle only (12/12 gate)
 *   node scripts/eval-runtime.mjs --agents svc_03 --out /tmp/report.json
 *
 * Exit code:
 *   0 only when, for every agent: the oracle reproduces the dataset's expected
 *   action on every case, every oracle assertion passes, and the naive fixture
 *   reproduces its documented failure count exactly (SVC_03 3/12, SVC_04 5/12,
 *   SVC_06 3/12 — i.e. 9, 7 and 9 documented failures).
 * ────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateAgent } from '../src/evaluation/suites.mjs';
import { DOCUMENTED } from '../src/evaluation/runner.mjs';
import { listAgentIds, listSvcAgentIds } from '../src/agents/index.mjs';
import { REPO_ROOT } from '../src/config/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { out: null, oracle: false, agents: null, json: false, help: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--oracle') options.oracle = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') options.out = argv[++i] ?? null;
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg === '--agents') options.agents = (argv[++i] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    else if (arg.startsWith('--agents=')) options.agents = arg.slice('--agents='.length).split(',').map((value) => value.trim()).filter(Boolean);
    else throw new Error(`eval-runtime: unknown argument "${arg}" (try --help)`);
  }
  return options;
}

const USAGE = `eval:runtime — run the eval datasets through the real runtime, offline.

  node scripts/eval-runtime.mjs [--oracle] [--agents a,b] [--out <file>] [--json] [--quiet]

  --oracle        run the oracle fixture only (each agent must reach 12/12)
  --agents        comma-separated agent ids (default: ${listAgentIds().join(', ')})
  --out           where to write the JSON report (default: data/state/evals/runtime-results.json)
  --json          print the JSON report to stdout instead of the tables
  --quiet         print only the gate summary
`;

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)));
  const line = (cells) => cells.map((cell, index) => (index === 0 ? pad(cell, widths[index]) : padStart(cell, widths[index]))).join('  ');
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const agentIds = options.agents ?? listAgentIds();
  const svcIds = listSvcAgentIds();
  for (const agentId of agentIds) {
    if (!listAgentIds().includes(agentId)) {
      throw new Error(`eval-runtime: unknown agent "${agentId}" (known: ${listAgentIds().join(', ')})`);
    }
  }

  const outPath = options.out ?? path.join(REPO_ROOT, 'data', 'state', 'evals', 'runtime-results.json');

  const report = {
    kind: 'runtime-evaluation',
    generatedAt: new Date().toISOString(),
    mode: options.oracle ? 'oracle-only' : 'oracle+naive',
    fixtureNote:
      'The "model" is src/models/providers/mock.mjs driven by src/evaluation/mock-scripts.mjs. ' +
      'This measures the runtime, the policy kernel and the harness — not any real model.',
    agents: [],
  };

  const failures = [];
  const suiteRows = [];
  const agentRows = [];

  for (const agentId of agentIds) {
    const evaluated = await evaluateAgent({ agentId, includeNaive: !options.oracle });
    const documented = DOCUMENTED[agentId];
    const isSvc = svcIds.includes(agentId);
    const oracle = evaluated.oracle;
    const naive = evaluated.naive;

    report.agents.push({
      agentId,
      hasDataset: evaluated.hasDataset,
      gate: evaluated.gate,
      oracle,
      naive,
      suites: evaluated.suites,
      cases: evaluated.cases.map((record) => ({
        caseIndex: record.caseIndex,
        description: record.description,
        expectedAction: record.expectedAction,
        actualAction: record.actualAction,
        policyDecision: record.policyDecision,
        policyRule: record.policyRule,
        toolCalls: record.toolCalls,
        expectedTools: record.expectedTools,
        iterations: record.iterations,
        state: record.state,
        latencyMs: record.latencyMs,
        passed: record.passed,
        assertions: record.assertions.map((assertion) => ({
          name: assertion.name,
          suite: assertion.suite,
          pass: assertion.pass,
          skipped: assertion.skipped === true,
          reason: assertion.reason,
        })),
      })),
    });

    // ── the gate for this agent ───────────────────────────────────────────
    if (isSvc) {
      if (oracle.taskCorrect !== documented.oraclePass) {
        failures.push(`${agentId}: oracle reached ${oracle.taskCorrect}/${oracle.cases}, the dataset requires ${documented.oraclePass}/${oracle.cases}`);
      }
      if (oracle.failed !== 0) {
        failures.push(`${agentId}: oracle had ${oracle.failed} failing assertion(s) (the oracle must be clean, not just action-correct)`);
      }
      if (!options.oracle) {
        if (naive.taskCorrect !== documented.naivePass) {
          failures.push(
            `${agentId}: ${documented.naiveLabel} passed ${naive.taskCorrect}/${naive.cases}, the documented count is ` +
              `${documented.naivePass}/${naive.cases} (${documented.naiveFail} failures) — the harness has stopped discriminating`,
          );
        }
        if (!naive.matchesDocumented) {
          failures.push(`${agentId}: naive fixture counts no longer match DOCUMENTED`);
        }
      }
    } else if (oracle.failed !== 0) {
      failures.push(`${agentId}: ${oracle.failed} failing assertion(s) across its ${oracle.cases} offline scenario(s)`);
    }

    agentRows.push([
      agentId,
      oracle.cases,
      `${oracle.taskCorrect}/${oracle.cases}`,
      `${oracle.passed}/${oracle.cases}`,
      naive ? `${naive.taskCorrect}/${naive.cases}` : '—',
      naive ? String(naive.taskIncorrect) : '—',
      `${oracle.maxLatencyMs}ms`,
      String(oracle.totalTokens),
      failures.some((failure) => failure.startsWith(`${agentId}:`)) ? 'FAIL' : 'ok',
    ]);

    for (const suite of evaluated.suites) {
      suiteRows.push([
        `${agentId}.${suite.name}`,
        suite.totals.cases,
        suite.totals.passed,
        suite.totals.failed,
        suite.totals.skipped,
        suite.empty ? 'no cases' : suite.coverage.split(' (')[0],
      ]);
    }
  }

  // ── output ──────────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write('\n=== runtime evaluation (offline, deterministic) ===\n\n');
    process.stdout.write(
      `${table(
        ['agent', 'cases', 'correct', 'assertions', options.oracle ? 'naive' : 'naive correct', 'naive fails', 'max latency', 'tokens', 'verdict'],
        agentRows,
      )}\n\n`,
    );
    if (!options.quiet) {
      process.stdout.write('--- per-category suite coverage ---\n\n');
      process.stdout.write(`${table(['suite', 'cases', 'passed', 'failed', 'skipped', 'coverage'], suiteRows)}\n\n`);
      process.stdout.write('--- what is covered, and what is not ---\n\n');
      for (const agentId of agentIds) {
        const evaluated = report.agents.find((agent) => agent.agentId === agentId);
        const documented = DOCUMENTED[agentId];
        const empty = evaluated.suites.filter((suite) => suite.empty);
        process.stdout.write(
          `${agentId}: oracle ${evaluated.oracle.taskCorrect}/${evaluated.oracle.cases} expected action, ` +
            `${evaluated.oracle.passed}/${evaluated.oracle.cases} assertions clean` +
            (evaluated.naive ? `; naive ${evaluated.naive.taskCorrect}/${evaluated.naive.cases} (documented ${documented.naivePass})` : '; no naive fixture') +
            `\n`,
        );
        if (empty.length) {
          process.stdout.write(
            `  suites with zero deterministic cases: ${empty.map((suite) => suite.name).join(', ')}\n` +
              (agentId === 'general'
                ? '  (the general agent has no adversarial dataset; its suites are covered by its own scenarios)\n'
                : '  (no case in this dataset exercises this category)\n'),
          );
        }
      }
      process.stdout.write(
        '\nStatement: every suite above runs offline against the real runtime with the deterministic mock provider.\n' +
          'The categories that need a live model to say anything about a real model are: task_correctness, tool_selection,\n' +
          'tool_arguments, planning, prompt_injection_resistance, hallucination. Run `npm run eval`, `eval:security`,\n' +
          '`eval:trading` (and their `:oracle` variants) with a key configured for those.\n',
      );
    }
    process.stdout.write(`\nJSON report: ${outPath}\n`);
  }

  if (failures.length) {
    process.stderr.write(`\n${failures.length} gate failure(s):\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    return 1;
  }
  process.stdout.write('\nall runtime evaluation gates passed.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
