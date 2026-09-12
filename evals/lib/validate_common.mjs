/**
 * Shared mechanical checks for the per-service dataset validators.
 *
 * This module holds the parts of dataset validation that are identical for
 * every agent (case shape, contains-json schema agreement, null vars, config
 * file resolution, category coverage, report formatting).
 *
 * It deliberately holds NO policy. What makes an expected_action correct is
 * encoded per service in the validator's own decide() function — see
 * evals/validate_dataset.mjs (SVC_03) and evals/validate_security_dataset.mjs
 * (SVC_04).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse a dataset file or die immediately — nothing downstream can be trusted. */
export function loadJsonDataset(path) {
  let cases;
  try {
    cases = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(cases)) throw new Error('top level must be a JSON array');
  } catch (err) {
    console.error(`FATAL ${path}: ${err.message}`);
    process.exit(1);
  }
  return cases;
}

/** Case 2 of the SVC_03 gate: every case has the shape promptfoo needs. */
export function checkCaseShape(test, i, { validActions, dataVar }) {
  const errors = [];
  const label = test.description || `case[${i}]`;
  const vars = test.vars || {};

  if (typeof vars[dataVar] !== 'string' || !vars[dataVar].trim()) {
    errors.push(`${label}: vars.${dataVar} must be a non-empty string`);
  }

  if (!validActions.includes(vars.expected_action)) {
    errors.push(
      `${label}: vars.expected_action "${vars.expected_action}" is not one of ${validActions.join(', ')}`,
    );
  }

  if (!Array.isArray(test.assert) || test.assert.length === 0) {
    errors.push(`${label}: assert must be a non-empty array`);
  }

  return errors;
}

/**
 * promptfoo's contains-json treats `value` as a JSON SCHEMA, not a subset
 * match. { "action": "x" } is not a valid schema and errors at runtime with:
 * strict mode: unknown keyword: "action".
 */
export function checkContainsJson(test, i, vars) {
  const errors = [];
  const label = test.description || `case[${i}]`;

  for (const assertion of test.assert || []) {
    if (assertion.type !== 'contains-json') continue;

    if (assertion.value && assertion.value.action !== undefined) {
      errors.push(
        `${label}: contains-json value is written as a subset match, but promptfoo expects a JSON Schema. ` +
          `Use { "type": "object", "properties": { "action": { "const": ... } }, "required": ["action"] }`,
      );
      continue;
    }

    const schema = assertion.value || {};
    const asserted =
      schema.properties && schema.properties.action && schema.properties.action.const;

    if (asserted === undefined) {
      errors.push(`${label}: contains-json schema does not pin "action" with a const`);
    } else if (asserted !== vars.expected_action) {
      errors.push(
        `${label}: contains-json asserts action "${asserted}" but vars.expected_action is "${vars.expected_action}"`,
      );
    }
    if (!Array.isArray(schema.required) || !schema.required.includes('action')) {
      errors.push(`${label}: contains-json schema must "require" the action key`);
    }
  }

  return errors;
}

/**
 * promptfoo's TestSuite schema rejects null values in vars and fails the
 * whole run. Express "unknown" by omitting the key instead.
 */
export function checkNullVars(test, i) {
  const errors = [];
  const label = test.description || `case[${i}]`;
  for (const [key, value] of Object.entries(test.vars || {})) {
    if (value === null) {
      errors.push(
        `${label}: vars.${key} is null. promptfoo rejects nulls in vars and aborts the entire ` +
          `eval with "Invalid input at tests[n].vars" — omit the key to mean "unknown".`,
      );
    }
  }
  return errors;
}

export function collectFileRefs(node, out) {
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

/**
 * promptfoo resolves file:// paths relative to the config file's own
 * directory, not the repo root — check every reference against its base dir.
 * Model ids are the thing that silently rots, so flag retired-looking ones.
 */
export function checkConfigFile(configPath, { requireProviders = false } = {}) {
  const errors = [];
  const warnings = [];
  const rel = configPath.slice(REPO_ROOT.length + 1);

  let config;
  try {
    config = yaml.load(readFileSync(configPath, 'utf8'));
  } catch (err) {
    return { errors: [`cannot parse ${rel}: ${err.message}`], warnings };
  }

  if (!config.prompts) errors.push(`${rel} has no prompts`);
  if (requireProviders && !config.providers) errors.push(`${rel} has no providers`);
  if (!config.tests) errors.push(`${rel} has no tests`);

  const refs = [];
  collectFileRefs(config, refs);
  if (refs.length === 0) errors.push(`${rel} declares no file:// references at all`);
  for (const ref of refs) {
    const target = resolve(dirname(configPath), ref);
    if (!existsSync(target)) {
      errors.push(
        `${rel} references missing file: ${ref} ` +
          `(file:// resolves relative to the config's own directory, not the repo root)`,
      );
    }
  }

  for (const provider of config.providers || []) {
    const id = typeof provider === 'string' ? provider : provider.id;
    if (/claude-3|gpt-4o|gpt-4\b|gpt-3/.test(String(id))) {
      warnings.push(`${rel}: provider "${id}" looks like a retired model id — confirm it is still served`);
    }
  }

  return { errors, warnings };
}

/** The prompt template must still have its placeholder, and carry its policy numbers. */
export function checkPromptFile(promptPath, { placeholder, warnings: promptWarnPatterns = [] }) {
  const errors = [];
  const warnings = [];
  const rel = promptPath.slice(REPO_ROOT.length + 1);

  let prompt;
  try {
    prompt = readFileSync(promptPath, 'utf8');
  } catch (err) {
    return { errors: [`cannot read ${rel}: ${err.message}`], warnings };
  }

  if (!prompt.includes(placeholder)) {
    errors.push(
      `${rel} does not contain ${placeholder}. ` +
        'Without it, promptfoo sends every case the identical prompt and the eval tests nothing.',
    );
  }
  for (const { pattern, message } of promptWarnPatterns) {
    if (!pattern.test(prompt)) warnings.push(`${rel} ${message}`);
  }

  return { errors, warnings };
}

/** Risk-category coverage: every required category present, minimums respected. */
export function checkCoverage(seenCategories, { required = [], minimums = {} }) {
  const errors = [];
  const warnings = [];
  for (const category of required) {
    if (!seenCategories.has(category)) errors.push(`no test case covers the "${category}" risk`);
  }
  for (const [category, min] of Object.entries(minimums)) {
    const have = seenCategories.get(category) || 0;
    if (have < min) {
      warnings.push(`only ${have} (or zero) "${category}" cases; consider adding more`);
    }
  }
  return { errors, warnings };
}

/** Print the summary block every validator ends with. Returns true when clean. */
export function printReport({ label, caseCount, seenCategories, warnings, errors }) {
  console.log(`${label} eval dataset: ${caseCount} cases, ${seenCategories.size} risk categories`);
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
    return false;
  }

  console.log('\nOK - dataset, prompt template and config are internally consistent.');
  return true;
}

/** Convenience: collect { errors, warnings } pairs into shared arrays. */
export function absorb(target, { errors = [], warnings = [] } = {}) {
  target.errors.push(...errors);
  target.warnings.push(...warnings);
}
