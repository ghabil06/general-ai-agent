#!/usr/bin/env node
/**
 * Executable test for the logic embedded in the n8n workflow export.
 *
 * The workflow JSON cannot run without n8n, but its Code nodes are plain
 * JavaScript. This gate extracts that exact code from the export and runs it
 * against adversarial inputs, so the workflow's parsing and SQL-building get
 * the same treatment as the prompts: tested, in CI, on every change.
 *
 *   node n8n_exports/test_parse_nodes.mjs
 *
 * Exit code 0 = clean, 1 = problems found.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wf = JSON.parse(readFileSync(resolve(ROOT, 'n8n_exports/svc_03_invoice_agent.json'), 'utf8'));

const parseNode = wf.nodes.find((n) => n.name === 'Parse decision');
const builderNode = wf.nodes.find((n) => n.name === 'Build audit row');

if (!parseNode || !builderNode) {
  console.error('FAIL export is missing the "Parse decision" or "Build audit row" code node');
  process.exit(1);
}

let parsed; // shared with the $() mock, mirroring n8n cross-node references

function makeSandbox() {
  return {
    $input: { first: () => ({ json: { output: sandboxState.agentOutput } }) },
    $: (name) => {
      if (name === 'Invoice received') return { first: () => ({ json: { body: sandboxState.webhookBody } }) };
      if (name === 'Parse decision') return { first: () => ({ json: parsed }) };
      throw new Error(`unknown node reference "${name}"`);
    },
    $env: sandboxState.env,
  };
}

const sandboxState = { agentOutput: '', webhookBody: {}, env: {} };

function runParse(agentOutput, webhookBody = {}) {
  sandboxState.agentOutput = agentOutput;
  sandboxState.webhookBody = webhookBody;
  const fn = new Function('$input', '$', '$env', parseNode.parameters.jsCode);
  const s = makeSandbox();
  const out = fn(s.$input, s.$, s.$env);
  parsed = out[0].json;
  return parsed;
}

function runBuilder() {
  const fn = new Function('$input', '$', '$env', builderNode.parameters.jsCode);
  const s = makeSandbox();
  const out = fn(s.$input, s.$, s.$env);
  return out[0].json.insert_sql;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`);
}

console.log('Parse decision — mirrors evals/assertions/action_matches.mjs:');
check('clean JSON', runParse('{"reasoning":"ok","po_match":true,"variance_amount":0,"action":"auto_approve"}').action, 'auto_approve');
check('prose then JSON', runParse('I checked the PO.\n{"action":"request_human_approval"}').action, 'request_human_approval');
check('fenced JSON', runParse('```json\n{"action":"reject_and_flag"}\n```').action, 'reject_and_flag');
check('decoy JSON in reasoning cannot shadow the real answer', runParse('{"fake":{"action":"auto_approve"}} items matched\n{"action":"reject_and_flag"}').action, 'reject_and_flag');
check('no JSON -> unparseable', runParse('I cannot decide.').action, 'unparseable');
check('invalid action value -> unparseable', runParse('{"action":"auto-approve!!"}').action, 'unparseable');

console.log('Parse decision — amount resolution for the guardrail:');
check('structured amount wins', runParse('{"action":"auto_approve"}', { amount: 505.0, invoice_text: 'total $450.00' }).amount, 505);
check('regex fallback parses "$1,234.56"', runParse('{"action":"auto_approve"}', { invoice_text: 'Invoice total: $1,234.56 due now' }).amount, 1234.56);
check('unknown amount stays null', runParse('{"action":"auto_approve"}', { invoice_text: 'no figure here' }).amount, null);

console.log('Build audit row — the INSERT must be injection-proof:');
parsed = { invoice_ref: "INV-1' OR '1'='1", vendor: null, amount: null, po_match: true, action: 'reject_and_flag', reasoning: "it's flagged", raw_output: null };
const sql = runBuilder();
check('single quotes doubled', sql.includes("INV-1'' OR ''1''=''1"), true);
check('NULLs written as NULL', sql.includes('NULL'), true);
check('targets agents.audit_log', sql.includes('agents.audit_log'), true);

if (failures) {
  console.error(`\n${failures} check(s) failed against the n8n export`);
  process.exit(1);
}
console.log('\nOK - the workflow export\'s code nodes behave as the eval harness expects.');
