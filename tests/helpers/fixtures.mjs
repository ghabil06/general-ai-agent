/**
 * Test helpers. Not part of the runtime — nothing in `src/` imports this.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'data', 'fixtures');
export const EVALS_DIR = path.join(REPO_ROOT, 'evals');

/** A fresh, empty storage directory per test — never the repo's data/state. */
export function tempStorageDir(prefix = 'agent-rt-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Read one of the real eval datasets. Tests read them; nothing writes them. */
export function loadDataset(name) {
  return JSON.parse(fs.readFileSync(path.join(EVALS_DIR, name), 'utf8'));
}

/** Build a deterministic clock: `clock()` returns t, `clock.advance(ms)`. */
export function fixedClock(start = 1_700_000_000_000) {
  let current = start;
  const clock = () => current;
  clock.advance = (ms) => {
    current += ms;
    return current;
  };
  clock.set = (value) => {
    current = value;
    return current;
  };
  return clock;
}

/** Extract the human-readable text of a dataset case. */
export function caseText(testCase) {
  const vars = testCase?.vars ?? {};
  return vars.invoice_data ?? vars.alert_data ?? vars.market_data ?? '';
}
