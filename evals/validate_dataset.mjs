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
 * The mechanical structural checks (case shape, contains-json schema,
 * null vars, config resolution, coverage) live in evals/lib/validate_common.mjs
 * and are shared with the SVC_04 validator. This file keeps only what is
 * specific to the invoice agent: the written policy, restated as code.
 *
 * Exit code 0 = clean, 1 = problems found.
 */

import { resolve } from 'node:path';
import {
  REPO_ROOT,
  loadJsonDataset,
  checkCaseShape,
  checkContainsJson,
  checkNullVars,
  checkConfigFile,
  checkPromptFile,
  checkCoverage,
  printReport,
  absorb,
} from './lib/validate_common.mjs';

const DATASET = resolve(REPO_ROOT, 'evals/invoices_dataset.json');
const PROMPT = resolve(REPO_ROOT, 'prompts/svc_03/invoice_agent.md');

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

// --- load + per-case checks -------------------------------------------------
const cases = loadJsonDataset(DATASET);
const seenCategories = new Map();
const collected = { errors: [], warnings: [] };

if (cases.length < MIN_CASES) {
  collected.errors.push(`dataset has ${cases.length} cases; minimum is ${MIN_CASES}`);
}

cases.forEach((test, i) => {
  const label = test.description || `case[${i}]`;
  const vars = test.vars || {};

  absorb(collected, checkCaseShape(test, i, { validActions: VALID_ACTIONS, dataVar: 'invoice_data' }));
  absorb(collected, checkContainsJson(test, i, vars));
  absorb(collected, checkNullVars(test, i));

  // Recompute the expected action from the structured fields.
  const recomputed = decide({
    amount: vars.case_amount,
    poPresent: vars.case_po_present,
    poVerified: vars.case_po_verified,
    variance: vars.case_variance,
  });

  if (vars.expected_action !== recomputed) {
    collected.errors.push(
      `${label}: dataset self-contradiction — rules give "${recomputed}" for ` +
        `amount=${vars.case_amount}, po_present=${vars.case_po_present}, ` +
        `po_verified=${vars.case_po_verified}, variance=${vars.case_variance}, ` +
        `but expected_action is "${vars.expected_action}"`,
    );
  }

  // Prose must agree with the structured amount.
  if (vars.case_amount === undefined) {
    // Omitted on purpose: the amount is not determinable, and decide()
    // returns reject_and_flag for that case.
  } else if (typeof vars.case_amount === 'number') {
    const needle = `$${vars.case_amount.toFixed(2)}`;
    if (!vars.invoice_data.includes(needle)) {
      collected.errors.push(`${label}: prose does not contain ${needle} but case_amount is ${vars.case_amount}`);
    }
  } else {
    collected.errors.push(`${label}: case_amount must be a number, or omitted to mean "not determinable"`);
  }

  if (!vars.case_category) {
    collected.warnings.push(`${label}: no case_category set`);
  } else {
    seenCategories.set(vars.case_category, (seenCategories.get(vars.case_category) || 0) + 1);
  }
});

// --- prompt template ----------------------------------------------------------
absorb(
  collected,
  checkPromptFile(PROMPT, {
    placeholder: '{{invoice_data}}',
    warnings: [{ pattern: /\$500\.00/, message: 'does not mention the $500.00 limit' }],
  }),
);

// --- configs ------------------------------------------------------------------
absorb(
  collected,
  checkConfigFile(resolve(REPO_ROOT, 'promptfooconfig.yaml'), { requireProviders: true }),
);
absorb(
  collected,
  checkConfigFile(resolve(REPO_ROOT, 'evals/promptfooconfig.offline.yaml'), { requireProviders: true }),
);

// --- coverage -------------------------------------------------------------------
absorb(
  collected,
  checkCoverage(seenCategories, {
    required: REQUIRED_CATEGORIES,
    minimums: { prompt_injection: 2 },
  }),
);

// --- report ---------------------------------------------------------------------
const ok = printReport({
  label: 'SVC_03',
  caseCount: cases.length,
  seenCategories,
  warnings: collected.warnings,
  errors: collected.errors,
});

process.exit(ok ? 0 : 1);
