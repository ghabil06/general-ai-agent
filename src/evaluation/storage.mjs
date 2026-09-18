/**
 * Storage helper for the evaluation harness.
 *
 * `src/` must not import from `tests/`, so the harness carries its own tiny
 * temp-directory helper. An evaluation therefore never writes into the
 * repository's `data/state/` unless a caller explicitly asks for a directory
 * (which `scripts/eval-runtime.mjs` does, under `data/state/evals/`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh temp directory. Caller-owned; deleting it is safe. */
export function tempStorageDir(prefix = 'agent-eval-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A deterministic clock: `clock()` returns the current value, `clock.advance(ms)` moves it. */
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
