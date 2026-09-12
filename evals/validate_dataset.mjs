#!/usr/bin/env node
/**
 * Deterministic gate for the SVC_03 eval suite.
 *
 * Runs with no API keys and no network. It does NOT call a model — it checks
 * that the eval artefacts are internally consistent, so a broken dataset can
 * never produce a misleadingly green promptfoo run.
 *
 *   node evals/validate_dataset.mjs
 *
 * Checks:
 *   1. evals/invoices_dataset.json parses and is a non-empty array.
 *   2. Every case has the shape promptfoo needs (description, vars.invoice_data,
 *      vars.expected_action, non-empty assert).
 *   3. Every contains-json assertion agrees with vars.expected_action.
 *   4. Every expected_action is what the written business rules actually
 *      produce, recomputed from the case's structured fields.
 *   5. The dollar figure in the prose matches the structured case_amount.
 *   6. prompts/svc_03/invoice_agent.md still contains {{invoice_data}}.
 *   7. promptfooconfig.yaml parses and every file:// reference exists.
 *   8. Required risk categories are all represented.
 *
 * Exit code 0 = clean, 1 = problems found.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = resolve(ROOT, 'evals/invoices_dataset.json');
const PROMPT = resolve(ROOT, 'prompts/svc_03/invoice_agent.md');
const CONFIG = resolve(ROOT, 'promptfooconfig.yaml');

const VALID_ACTIONS = ['auto_approve', 'request_human_approval', 'reject_and_flag'];
const APPROVAL_LIMIT = 500.0;
const MIN_CASES = 5;

const REQUIRED_CATEGORIES = [
  'happy_path',
  'over_limit',
  'tax_variance',
  'boundary_exact',
  'boundary_over',
  'line_item_variance',
  'missing_po',
  'unverified_po',
  'prompt_injection',
  'undeterminable_amount',
  'rounding_variance',
];

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

/**
 * The written policy from prompts/svc_03/invoice_agent.md, restated as code.
 * This is the single source of truth the dataset is checked against.
 */
function decide({ amount, poPresent, poVerified, variance }) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return 'reject_and_flag';
  }
  if (!poPresent || !poVerified) {
    return 'reject_and_flag';
  }
  if (amount > APPROVAL_LIMIT + 1e-9) {
    return 'request_human_approval';
  }
  if (variance === null || variance === undefined || Number.isNaN(variance)) {
    return 'reject_and_flag';
  }
  if (Math.abs(variance) > 1e-9) {
    return 'request_human_approval';
  }
  return 'auto_approve';
}

function collectFileRefs(node, out) {
  if (typeof node === 'string') {
    const m = node.match(/^file:\/\/(.+)$/);
    if (m) out.push(m[1]);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectFileRefs(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectFileRefs(value, out);
  }
}

// --- 1. dataset parses -----------------------------------------------------
let cases;
try {
  const raw = readFileSync(DATASET, 'utf8');
  cases = JSON.parse(raw);
  if (!Array.isArray(cases)) throw new Error('top level must be a JSON array');
} catch (err) {
  console.error(`FATAL evals/invoices_dataset.json: ${err.message}`);
  process.exit(1);
}

if (cases.length < MIN_CASES) {
  fail(`dataset has ${cases.length} cases; minimum is ${MIN_CASES}`);
}

// --- 2-5. per-case checks --------------------------------------------------
const seenCategories = new Map();

cases.forEach((test, i) => {
  const label = test.description ? test.description : `case[${i}]`;
  const vars = test.vars || {};
  const id = `${label}`;

  if (typeof vars.invoice_data !== 'string' || !vars.invoice_data.trim()) {
    fail(`${id}: vars.invoice_data must be a non-empty string`);
  }

  if (!VALID_ACTIONS.includes(vars.expected_action)) {
    fail(`${id}: vars.expected_action "${vars.expected_action}" is not one of ${VALID_ACTIONS.join(', ')}`);
  }

  if (!Array.isArray(test.assert) || test.assert.length === 0) {
    fail(`${id}: assert must be a non-empty array`);
  } else {
    for (const assertion of test.assert) {
      if (assertion.type !== 'contains-json') continue;

      // promptfoo's contains-json treats `value` as a JSON SCHEMA, not a
      // subset match. { "action": "x" } is not a valid schema and errors at
      // runtime with: strict mode: unknown keyword: "action".
      if (assertion.value && assertion.value.action !== undefined) {
        fail(
          `${id}: contains-json value is written as a subset match, but promptfoo expects a JSON Schema. ` +
            `Use { "type": "object", "properties": { "action": { "const": ... } }, "required": ["action"] }`,
        );
        continue;
      }

      const schema = assertion.value || {};
      const asserted =
        schema.properties && schema.properties.action && schema.properties.action.const;

      if (asserted === undefined) {
        fail(`${id}: contains-json schema does not pin "action" with a const`);
      } else if (asserted !== vars.expected_action) {
        fail(
          `${id}: contains-json asserts action "${asserted}" but vars.expected_action is "${vars.expected_action}"`,
        );
      }
      if (!Array.isArray(schema.required) || !schema.required.includes('action')) {
        fail(`${id}: contains-json schema must "require" the action key`);
      }
    }
  }

  // Recompute the expected action from the structured fields.
  const recomputed = decide({
    amount: vars.case_amount,
    poPresent: vars.case_po_present,
    poVerified: vars.case_po_verified,
    variance: vars.case_variance,
  });

  if (vars.expected_action !== recomputed) {
    fail(
      `${id}: dataset self-contradiction — rules give "${recomputed}" for ` +
        `amount=${vars.case_amount}, po_present=${vars.case_po_present}, ` +
        `po_verified=${vars.case_po_verified}, variance=${vars.case_variance}, ` +
        `but expected_action is "${vars.expected_action}"`,
    );
  }

  // promptfoo's TestSuite schema rejects null values in vars and fails the
  // whole run. Express "unknown" by omitting the key instead.
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) {
      fail(
        `${id}: vars.${key} is null. promptfoo rejects nulls in vars and aborts the entire ` +
          `eval with "Invalid input at tests[n].vars" — omit the key to mean "unknown".`,
      );
    }
  }

  // Prose must agree with the structured amount.
  if (vars.case_amount === undefined) {
    // Omitted on purpose: the amount is not determinable, and decide()
    // returns reject_and_flag for that case.
  } else if (typeof vars.case_amount === 'number') {
    const needle = `$${vars.case_amount.toFixed(2)}`;
    if (!vars.invoice_data.includes(needle)) {
      fail(`${id}: prose does not contain ${needle} but case_amount is ${vars.case_amount}`);
    }
  } else {
    fail(`${id}: case_amount must be a number, or omitted to mean "not determinable"`);
  }

  if (!vars.case_category) {
    warn(`${id}: no case_category set`);
  } else {
    seenCategories.set(vars.case_category, (seenCategories.get(vars.case_category) || 0) + 1);
  }
});

// --- 6. prompt template placeholder ---------------------------------------
try {
  const prompt = readFileSync(PROMPT, 'utf8');
  if (!prompt.includes('{{invoice_data}}')) {
    fail(
      'prompts/svc_03/invoice_agent.md does not contain {{invoice_data}}. ' +
        'Without it, promptfoo sends every case the identical prompt and the eval tests nothing.',
    );
  }
  if (!/\$500\.00/.test(prompt)) {
    warn('prompts/svc_03/invoice_agent.md does not mention the $500.00 limit');
  }
} catch (err) {
  fail(`cannot read prompts/svc_03/invoice_agent.md: ${err.message}`);
}

// --- 7. configs parse, references resolve ---------------------------------
// promptfoo resolves file:// paths relative to the config file's own
// directory, so each config is checked against its own base dir.
const CONFIGS = [
  { path: CONFIG, requireProviders: true },
  { path: resolve(ROOT, 'evals/promptfooconfig.offline.yaml'), requireProviders: true },
];

for (const { path: configPath, requireProviders } of CONFIGS) {
  const rel = configPath.slice(ROOT.length + 1);
  try {
    const config = yaml.load(readFileSync(configPath, 'utf8'));
    if (!config.prompts) fail(`${rel} has no prompts`);
    if (requireProviders && !config.providers) fail(`${rel} has no providers`);
    if (!config.tests) fail(`${rel} has no tests`);

    const refs = [];
    collectFileRefs(config, refs);
    if (refs.length === 0) fail(`${rel} declares no file:// references at all`);
    for (const ref of refs) {
      const target = resolve(dirname(configPath), ref);
      if (!existsSync(target)) {
        fail(
          `${rel} references missing file: ${ref} ` +
            `(file:// resolves relative to the config's own directory, not the repo root)`,
        );
      }
    }

    // Model ids are the thing that silently rots.
    for (const provider of config.providers || []) {
      const id = typeof provider === 'string' ? provider : provider.id;
      if (/claude-3|gpt-4o|gpt-4\b|gpt-3/.test(String(id))) {
        warn(`${rel}: provider "${id}" looks like a retired model id — confirm it is still served`);
      }
    }
  } catch (err) {
    fail(`cannot parse ${rel}: ${err.message}`);
  }
}

// --- 8. coverage -----------------------------------------------------------
for (const category of REQUIRED_CATEGORIES) {
  if (!seenCategories.has(category)) fail(`no test case covers the "${category}" risk`);
}

if (!seenCategories.has('prompt_injection') || seenCategories.get('prompt_injection') < 2) {
  warn('only one (or zero) prompt-injection cases; consider adding more');
}

// --- report ----------------------------------------------------------------
console.log(`SVC_03 eval dataset: ${cases.length} cases, ${seenCategories.size} risk categories`);
for (const [category, count] of [...seenCategories].sort()) {
  console.log(`  ${String(count).padStart(2)}  ${category}`);
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  WARN  ${w}`);
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  FAIL  ${e}`);
  process.exit(1);
}

console.log('\nOK - dataset, prompt template and config are internally consistent.');
