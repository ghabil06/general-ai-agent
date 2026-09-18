/**
 * Runtime test helper: a fully isolated runtime per test.
 *
 * `storageDir` is a fresh temp directory, so tests never write into the repo's
 * `data/state/`, and the clock is injectable so budget/expiry tests do not
 * sleep.
 */

import { createRuntime } from '../../src/index.mjs';
import { loadConfig } from '../../src/config/index.mjs';
import { tempStorageDir, fixedClock, FIXTURES_DIR } from './fixtures.mjs';

/** A config whose storage/providers are test-controlled and which reads no env. */
export function testConfig(overrides = {}) {
  return loadConfig(
    {
      NODE_ENV: 'test',
      AGENT_STORAGE_DIR: overrides.storageDir,
      ...(overrides.env ?? {}),
    },
    {
      storageDir: overrides.storageDir,
      fixturesDir: overrides.fixturesDir ?? FIXTURES_DIR,
      budgets: overrides.budgets,
      toolTimeoutMs: overrides.toolTimeoutMs,
      approvalTtlMs: overrides.approvalTtlMs,
      defaultProvider: overrides.defaultProvider ?? 'mock',
      providerPreference: overrides.providerPreference,
    },
  );
}

/**
 * @param {object} [options]
 * @param {Array}  [options.mockScript]
 * @param {object} [options.budgets]
 * @param {number} [options.approvalTtlMs]
 * @param {number} [options.startAt]  fixed clock start (epoch ms)
 * @param {boolean}[options.advanceOnCall] advance the clock 1ms per read
 */
export function makeTestRuntime(options = {}) {
  const storageDir = options.storageDir ?? tempStorageDir(options.prefix);
  const clock = options.clock ?? fixedClock(options.startAt);
  const now = options.advanceOnCall ? () => clock.advance(1) : () => clock();

  const runtime = createRuntime({
    config: testConfig({ ...options, storageDir }),
    storageDir,
    fixturesDir: options.fixturesDir ?? FIXTURES_DIR,
    mockScript: options.mockScript ?? [],
    now,
    echoEvents: false,
    rules: options.rules,
  });

  return { runtime, storageDir, clock, now };
}
