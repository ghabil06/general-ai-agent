#!/usr/bin/env node
/**
 * Turns a promptfoo results JSON file into a pass/fail gate for CI.
 *
 * promptfoo exits 100 when an assertion fails, but exits 0 even when the
 * config is broken and zero tests ran, so its exit code alone cannot be the
 * gate. This script asserts the exact expected outcome and the exact result
 * count instead.
 *
 *   node evals/check_results.mjs results.json --require-all-pass
 *   node evals/check_results.mjs results.json --expect-failures 9 --total 12
 *
 * Counts come from promptfoo's own results.stats block and are cross-checked
 * against a per-record recount, so the two cannot silently disagree.
 * Assertion failures (the model chose the wrong action) are reported
 * separately from provider errors (the call blew up), because they mean
 * opposite things: the first is the eval doing its job, the second is the
 * harness being broken.
 */

import { readFileSync } from 'node:fs';

const [, , file, ...flags] = process.argv;

if (!file) {
  console.error(
    'usage: check_results.mjs <results.json> [--require-all-pass | --expect-failures N --total M]',
  );
  process.exit(2);
}

function flag(name) {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
}

const doc = JSON.parse(readFileSync(file, 'utf8'));
const results = doc?.results?.results;

if (!Array.isArray(results) || results.length === 0) {
  console.error(`FAIL ${file}: no test results found in the promptfoo output`);
  process.exit(1);
}

// A record is an assertion failure when it has a grading result that says the
// assertions did not pass. Anything else that did not succeed is a transport
// or provider error.
const isAssertionFailure = (r) =>
  !r.success && r.gradingResult && r.gradingResult.pass === false;

const passed = results.filter((r) => r.success).length;
const assertionFailures = results.filter(isAssertionFailure).length;
const providerErrors = results.length - passed - assertionFailures;

// Cross-check against promptfoo's own aggregate.
const stats = doc?.results?.stats;
if (stats) {
  const mismatch =
    stats.successes !== passed ||
    stats.failures !== assertionFailures ||
    stats.errors !== providerErrors;
  if (mismatch) {
    console.error(
      `FAIL ${file}: recount disagrees with promptfoo's own stats ` +
        `(stats: ${stats.successes} passed / ${stats.failures} failed / ${stats.errors} errored, ` +
        `recount: ${passed} / ${assertionFailures} / ${providerErrors})`,
    );
    process.exit(1);
  }
}

console.log(
  `${file}: ${results.length} results — ${passed} passed, ` +
    `${assertionFailures} assertion failures, ${providerErrors} provider errors`,
);

for (const r of results) {
  if (r.success) continue;
  const desc = r.testCase?.description || '(no description)';
  if (!isAssertionFailure(r)) {
    console.log(`  ERR  ${desc}\n        provider/transport error: ${r.error || 'unknown'}`);
    continue;
  }
  const reasons = (r.gradingResult.componentResults || [])
    .filter((c) => !c.pass)
    .map((c) => c.reason);
  console.log(
    `  FAIL ${desc}\n        ${reasons.join(' | ') || r.gradingResult.reason || 'no reason reported'}`,
  );
}

if (providerErrors > 0) {
  console.error(
    `FAIL ${providerErrors} result(s) errored instead of being graded. ` +
      `That means the harness itself broke, not that a guardrail failed.`,
  );
  process.exit(1);
}

if (flags.includes('--require-all-pass')) {
  if (passed === results.length) {
    console.log(`OK all ${passed} results passed`);
    process.exit(0);
  }
  console.error(`FAIL expected every result to pass; ${passed}/${results.length} did`);
  process.exit(1);
}

const expectFailures = flag('--expect-failures');
if (expectFailures !== undefined) {
  const want = Number(expectFailures);
  const total = flag('--total') !== undefined ? Number(flag('--total')) : results.length;

  if (total !== results.length) {
    console.error(`FAIL expected ${total} results but the file contains ${results.length}`);
    process.exit(1);
  }
  if (assertionFailures === want) {
    console.log(`OK ${assertionFailures} assertion failures, exactly as the fixture predicts`);
    process.exit(0);
  }
  console.error(`FAIL expected ${want} assertion failures but got ${assertionFailures}`);
  process.exit(1);
}

console.error('FAIL no assertion mode given (--require-all-pass or --expect-failures N)');
process.exit(2);
