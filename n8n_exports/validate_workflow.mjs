#!/usr/bin/env node
/**
 * Lint gate for the n8n workflow export.
 *
 * The workflow JSON cannot be executed here, so this gate enforces the next
 * best thing: structural integrity plus every deployment-safety property the
 * repo claims about it. Run with no network and no dependencies:
 *
 *   node n8n_exports/validate_workflow.mjs
 *
 * Exit code 0 = clean, 1 = problems found.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = resolve(ROOT, 'n8n_exports/svc_03_invoice_agent.json');

const KNOWN_NODE_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.set',
  'n8n-nodes-base.code',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.postgres',
  'n8n-nodes-base.postgresTool',
  'n8n-nodes-base.stickyNote',
  'n8n-nodes-base.noOp',
  '@n8n/n8n-nodes-langchain.agent',
  '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  '@n8n/n8n-nodes-langchain.toolHttpRequest',
  '@n8n/n8n-nodes-langchain.toolCode',
]);

const errors = [];

function fail(msg) {
  errors.push(msg);
}

// --- parse ------------------------------------------------------------------
let workflow;
try {
  workflow = JSON.parse(readFileSync(WORKFLOW, 'utf8'));
} catch (err) {
  console.error(`FATAL ${WORKFLOW}: ${err.message}`);
  process.exit(1);
}

const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
const byName = new Map();

// --- unique names, known types ----------------------------------------------
for (const node of nodes) {
  if (!node.name) {
    fail('every node must have a name');
    continue;
  }
  if (byName.has(node.name)) {
    fail(`duplicate node name: "${node.name}"`);
  }
  byName.set(node.name, node);

  if (!KNOWN_NODE_TYPES.has(node.type)) {
    fail(`node "${node.name}" has unknown type "${node.type}" — a typo here fails at import time`);
  }
}

if (nodes.length < 10) {
  fail(`workflow has only ${nodes.length} nodes; expected the full SVC_03 pipeline`);
}

// --- connections reference real nodes ----------------------------------------
const connections = workflow.connections || {};
for (const [source, kinds] of Object.entries(connections)) {
  if (!byName.has(source)) {
    fail(`connections reference unknown source node "${source}"`);
    continue;
  }
  for (const groups of Object.values(kinds)) {
    for (const group of groups) {
      for (const link of group || []) {
        if (!byName.has(link.node)) {
          fail(`"${source}" connects to unknown node "${link.node}"`);
        }
      }
    }
  }
}

// --- the agent: one model, three tools ----------------------------------------
const agent = byName.get('AI Agent - SVC_03');
if (!agent) {
  fail('the workflow must contain an "AI Agent - SVC_03" node');
} else {
  const agentConns = connections[agent.name] || {};
  const models = (agentConns.ai_languageModel || []).flat().filter(Boolean);
  const tools = (agentConns.ai_tool || []).flat().filter(Boolean);

  if (models.length !== 1) {
    fail(`the agent must have exactly one chat model attached; found ${models.length}`);
  }
  const toolNames = tools.map((t) => t.node);
  for (const expected of ['query_po_database', 'calculate_tax_variance', 'request_human_approval']) {
    if (!toolNames.includes(expected)) {
      fail(`the agent is missing the "${expected}" tool`);
    }
  }
}

// --- prompt fetch: the repo stays the source of truth -------------------------
const fetchNode = byName.get('Fetch prompt from GitHub');
if (!fetchNode) {
  fail('the workflow must contain a "Fetch prompt from GitHub" node');
} else {
  const url = fetchNode.parameters?.url || '';
  if (!url.includes('raw.githubusercontent.com/ghabil06/general-ai-agent/')) {
    fail(`the prompt fetch URL does not point at this repo: ${url}`);
  }
  if (!url.includes('/prompts/svc_03/invoice_agent.md')) {
    fail(`the prompt fetch URL does not fetch prompts/svc_03/invoice_agent.md: ${url}`);
  }
}

// --- the {{invoice_data}} substitution is done explicitly ---------------------
const setNode = byName.get('Build system prompt');
if (!setNode) {
  fail('the workflow must contain a "Build system prompt" node');
} else {
  const assignments = JSON.stringify(setNode.parameters?.assignments || {});
  if (!/[{]{2}\\s\*invoice_data/.test(assignments) && !assignments.includes('invoice_data')) {
    fail('Build system prompt does not substitute the {{invoice_data}} placeholder — n8n will NOT do it for you');
  }
}

// --- the deterministic guardrail exists and checks both conditions ------------
const guardrail = byName.get('GUARDRAIL - 500 check');
if (!guardrail) {
  fail('the workflow must contain the "GUARDRAIL - 500 check" IF node');
} else {
  const serialized = JSON.stringify(guardrail.parameters || {});
  if (!serialized.includes('auto_approve')) {
    fail('guardrail does not test action == auto_approve');
  }
  const conditions = guardrail.parameters?.conditions?.conditions || [];
  const amountCheck = conditions.find((c) => String(c.leftValue || '').includes('amount'));
  if (!amountCheck) {
    fail('guardrail does not test the amount');
  } else if (amountCheck.operator?.operation !== 'gt' || Number(amountCheck.rightValue) !== 500) {
    fail(`guardrail amount check is not "amount > 500": ${JSON.stringify(amountCheck)}`);
  }
}

// --- shadow-safe defaults: writes disabled, audit + breach alert enabled ------
for (const name of ['Accounting write (LIVE ONLY)', 'Flag invoice (LIVE ONLY)']) {
  const node = byName.get(name);
  if (!node) {
    fail(`the workflow must contain a "${name}" node, disabled by default`);
  } else if (node.disabled !== true) {
    fail(`"${name}" must be disabled on import (shadow mode)`);
  }
}

const audit = byName.get('Log to agents.audit_log');
const auditBuilder = byName.get('Build audit row');
if (!audit) {
  fail('the workflow must contain a "Log to agents.audit_log" node');
} else {
  if (audit.disabled === true) {
    fail('the audit log node must never be disabled');
  }
  // The INSERT statement is built in the upstream code node, so accept it in
  // either place.
  const query = String(audit.parameters?.query || '');
  const builderCode = String(auditBuilder?.parameters?.jsCode || '');
  if (!query.includes('agents.audit_log') && !builderCode.includes('agents.audit_log')) {
    fail('nothing in the workflow writes to agents.audit_log');
  }
  // .replace(/'/g, "''") or .replace("'", "''") — either escape form counts.
  if (auditBuilder && !/replace\(\s*('"'|\/'\/|').*''/.test(builderCode)) {
    fail('Build audit row does not escape single quotes — SQL injection into the audit log');
  }
  if (auditBuilder && !builderCode.includes('amount_source')) {
    fail('Build audit row does not record amount_source — a guardrail amount read by regex from invoice prose must be distinguishable in the audit log from one the caller sent');
  }
}

// --- the schema the workflow depends on ---------------------------------------
//
// The workflow INSERTs into agents.audit_log, so the schema it runs against
// must actually have the columns it writes and the two computed columns the
// shadow-mode review relies on. The database — not n8n, not the model —
// computes breach and parity; if that ever stops being true in the schema,
// this gate fails.
const schema = readFileSync(resolve(ROOT, 'n8n_exports/audit_log.sql'), 'utf8');
if (!/amount_source\s+TEXT/.test(schema)) {
  fail('audit_log.sql is missing the amount_source column the workflow INSERTs');
}
if (!/breach\s+BOOLEAN GENERATED ALWAYS AS[^;]*auto_approve[^;]*amount\s*>\s*500/i.test(schema)) {
  fail('audit_log.sql: breach must be a GENERATED column — (agent_action = \'auto_approve\' AND amount > 500)');
}
if (!/parity\s+BOOLEAN GENERATED ALWAYS AS[^;]*agent_action\s*=\s*human_action/i.test(schema)) {
  fail('audit_log.sql: parity must be a GENERATED column — (agent_action = human_action)');
}

const breach = byName.get('Slack - GUARDRAIL BREACH');
if (!breach) {
  fail('the workflow must contain a "Slack - GUARDRAIL BREACH" node');
} else if (breach.disabled === true) {
  fail('the guardrail breach alert must stay enabled');
}

// --- every branch converges on the audit sink ---------------------------------
const auditInputs = [];
for (const [source, kinds] of Object.entries(connections)) {
  for (const group of kinds.main || []) {
    for (const link of group || []) {
      if (link.node === 'Build audit row') auditInputs.push(source);
    }
  }
}
for (const expected of ['Slack - GUARDRAIL BREACH', 'Route by action', 'Accounting write (LIVE ONLY)', 'Notify approvals (Slack)', 'Flag invoice (LIVE ONLY)']) {
  if (!auditInputs.includes(expected)) {
    fail(`"${expected}" does not reach the audit sink — shadow mode must log every branch`);
  }
}

// --- report -------------------------------------------------------------------
if (errors.length) {
  console.error(`${errors.length} error(s) in n8n_exports/svc_03_invoice_agent.json:`);
  for (const e of errors) console.error(`  FAIL  ${e}`);
  process.exit(1);
}

console.log(`OK n8n_exports/svc_03_invoice_agent.json: ${nodes.length} nodes, connections intact,`);
console.log('   prompt fetched from the repo, guardrail = (auto_approve AND amount > 500),');
console.log('   writes disabled (shadow), audit sink reachable from every branch.');
