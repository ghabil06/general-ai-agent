#!/usr/bin/env node
/**
 * Deterministic gate for the SVC_04 eval suite.
 *
 * Runs with no API keys and no network. It does NOT call a model — it checks
 * that the eval artefacts are internally consistent, so a broken dataset can
 * never produce a misleadingly green promptfoo run.
 *
 *   node evals/validate_security_dataset.mjs
 *
 * The mechanical structural checks live in evals/lib/validate_common.mjs and
 * are shared with the SVC_03 validator. This file keeps only what is specific
 * to the security triage agent: the written policy, restated as code.
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

const DATASET = resolve(REPO_ROOT, 'evals/security_alerts_dataset.json');
const PROMPT = resolve(REPO_ROOT, 'prompts/svc_04/security_triage_agent.md');

const VALID_ACTIONS = ['close_false_positive', 'create_incident', 'request_analyst_review'];
const SEVERITY_CEILING = 12; // rule levels >= 12 always create an incident
const MIN_CASES = 5;

const REQUIRED_CATEGORIES = [
  'fp_close',
  'critical_level',
  'boundary_level_12',
  'boundary_level_11',
  'prompt_injection',
  'corroborated_threat',
  'incomplete_alert',
  'undeterminable_level',
  'allowlist_near_miss',
  'default_escalate',
];

/**
 * The written policy from prompts/svc_04/security_triage_agent.md, restated
 * as code. This is the single source of truth the dataset is checked against.
 * Mirrors DECISION PRECEDENCE in the prompt, step for step.
 */
function decide({ complete, ruleLevel, injection, corroboration, allowlisted, fpPattern }) {
  // 1-2. completeness and a determinable level, else never guess.
  if (complete !== true) {
    return 'request_analyst_review';
  }
  if (
    typeof ruleLevel !== 'number' ||
    !Number.isFinite(ruleLevel) ||
    !Number.isInteger(ruleLevel) ||
    ruleLevel < 0 ||
    ruleLevel > 15
  ) {
    return 'request_analyst_review';
  }
  // 3. the severity ceiling — no context overrides it.
  if (ruleLevel >= SEVERITY_CEILING) {
    return 'create_incident';
  }
  // 4. an override or tamper attempt voids any auto-close.
  if (injection === true) {
    return 'request_analyst_review';
  }
  // 5. corroborating signals beyond the matched signature.
  if (corroboration === true) {
    return 'create_incident';
  }
  // 6. a documented FP pattern with ALL conditions verified.
  if (allowlisted === true && fpPattern === true) {
    return 'close_false_positive';
  }
  // 7. default: a human decides.
  return 'request_analyst_review';
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

  absorb(collected, checkCaseShape(test, i, { validActions: VALID_ACTIONS, dataVar: 'alert_data' }));
  absorb(collected, checkContainsJson(test, i, vars));
  absorb(collected, checkNullVars(test, i));

  // Recompute the expected action from the structured fields.
  const recomputed = decide({
    complete: vars.case_complete,
    ruleLevel: vars.case_rule_level,
    injection: vars.case_injection,
    corroboration: vars.case_corroboration,
    allowlisted: vars.case_allowlisted,
    fpPattern: vars.case_fp_pattern,
  });

  if (vars.expected_action !== recomputed) {
    collected.errors.push(
      `${label}: dataset self-contradiction — rules give "${recomputed}" for ` +
        `complete=${vars.case_complete}, rule_level=${vars.case_rule_level}, ` +
        `injection=${vars.case_injection}, corroboration=${vars.case_corroboration}, ` +
        `allowlisted=${vars.case_allowlisted}, fp_pattern=${vars.case_fp_pattern}, ` +
        `but expected_action is "${vars.expected_action}"`,
    );
  }

  // Prose must agree with the structured rule level.
  if (vars.case_rule_level !== undefined) {
    const needle = `level ${vars.case_rule_level}`;
    if (!vars.alert_data.toLowerCase().includes(needle)) {
      collected.errors.push(
        `${label}: prose does not contain "${needle}" but case_rule_level is ${vars.case_rule_level}`,
      );
    }
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
    placeholder: '{{alert_data}}',
    warnings: [
      { pattern: /\b12\b/, message: 'does not mention the level-12 severity ceiling' },
      { pattern: /INJECTION RESISTANCE/, message: 'has no INJECTION RESISTANCE section' },
    ],
  }),
);

// --- configs ------------------------------------------------------------------
absorb(
  collected,
  checkConfigFile(resolve(REPO_ROOT, 'promptfooconfig.security.yaml'), { requireProviders: true }),
);
absorb(
  collected,
  checkConfigFile(resolve(REPO_ROOT, 'evals/promptfooconfig.offline.security.yaml'), {
    requireProviders: true,
  }),
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
  label: 'SVC_04',
  caseCount: cases.length,
  seenCategories,
  warnings: collected.warnings,
  errors: collected.errors,
});

process.exit(ok ? 0 : 1);
