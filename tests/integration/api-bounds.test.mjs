/**
 * Integration: the HTTP API cannot be used to raise a run past the hard ceilings.
 *
 * `POST /agents/:id/runs` accepts `planning.maxSteps | maxReplans | maxStepAttempts`.
 * Before call 4 any positive integer was honoured — `1000000000` returned 201 — so
 * the planner "ceilings" were whatever the caller said. They may now be lowered, or
 * moved inside the hard ceiling, and nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntime } from '../../src/index.mjs';
import { createRuntimeApi } from '../../src/api/index.mjs';
import { createRunsHandler } from '../../src/api/handlers/runs.mjs';
import { HARD_CEILINGS } from '../../src/runtime/envelope.mjs';
import { testConfig } from '../helpers/runtime.mjs';
import { tempStorageDir, fixedClock, FIXTURES_DIR } from '../helpers/fixtures.mjs';

function makeApi() {
  const storageDir = tempStorageDir('api-bounds-');
  const runtime = createRuntime({ config: testConfig({ storageDir, defaultProvider: 'mock' }), storageDir, fixturesDir: FIXTURES_DIR, now: fixedClock() });
  const api = createRuntimeApi({ runtime });
  const post = async (body) => {
    const response = await api.handle({ method: 'POST', pathname: '/api/runtime/agents/general/runs', rawBody: JSON.stringify(body) });
    return { status: response.status, json: JSON.parse(response.body) };
  };
  return { post, runtime };
}

test('a planner ceiling above the hard ceiling is a 400 that names the ceiling', async () => {
  const { post, runtime } = makeApi();
  for (const key of ['maxSteps', 'maxReplans', 'maxStepAttempts']) {
    const response = await post({ input: 'market_and_portfolio', planning: { mode: 'planned', [key]: HARD_CEILINGS[key] + 1 } });
    assert.equal(response.status, 400, key);
    assert.equal(response.json.error.code, 'INVALID_REQUEST');
    assert.match(response.json.error.message, new RegExp(`planning\\.${key}.*hard ceiling of ${HARD_CEILINGS[key]}`));
    assert.equal(response.json.error.details.ceiling, HARD_CEILINGS[key]);
  }
  const response = await post({ input: 'market_and_portfolio', planning: { mode: 'planned', maxSteps: 1_000_000_000 } });
  assert.equal(response.status, 400, 'the value that used to return 201');
  assert.equal(runtime.runStore.stores.runs.count(), 0, 'a refused request started no run');
});

test('a planner ceiling at the hard ceiling, or below it, is accepted and takes effect', async () => {
  const { post, runtime } = makeApi();
  const atCeiling = await post({ input: 'market_and_portfolio', planning: { mode: 'planned', maxSteps: HARD_CEILINGS.maxSteps } });
  assert.equal(atCeiling.status, 201);

  const lowered = await post({ input: 'market_and_portfolio', planning: { mode: 'planned', maxSteps: 1, maxReplans: 1 } });
  assert.equal(lowered.status, 201);
  assert.ok(runtime.runStore.getRun(lowered.json.runId));
});

// ── cancelling a run that is in flight ─────────────────────────────────────


test('POST /runs/:id/cancel on a run in flight: the run settles CANCELLED and is persisted (it used to throw and vanish)', async () => {
  const storageDir = tempStorageDir('api-cancel-');
  const runtime = createRuntime({ config: testConfig({ storageDir, defaultProvider: 'mock' }), storageDir, fixturesDir: FIXTURES_DIR, now: () => Date.now() });

  // Give the deterministic double latency, so the run is genuinely mid-model-call when the cancel lands.
  const provider = runtime.providers.get('mock');
  const complete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return complete(request);
  };

  const handler = createRunsHandler({ runtime });
  const startedAt = Date.now();
  const starting = handler.start({ params: { id: 'general' }, body: { input: 'market_and_portfolio' } });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const [runId] = [...handler.active.keys()];
  assert.ok(runId, 'the run is addressable while it is in flight');
  const cancelled = handler.cancel({ params: { id: runId }, body: { reason: 'operator pressed cancel' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.live, true);

  const response = await starting; // used to reject with StateTransitionError
  assert.equal(response.status, 201);
  assert.equal(response.body.status, 'CANCELLED');
  assert.equal(response.body.stopReason.code, 'CANCELLATION_REQUESTED');
  assert.ok(Date.now() - startedAt < 1500, 'the cancel did not wait out the model');

  const row = runtime.runStore.getRun(runId);
  assert.equal(row.status, 'CANCELLED');
  assert.ok(runtime.runStore.getTrace(runId), 'and its trace is on disk');
  assert.equal(handler.detail({ params: { id: runId } }).status, 200, 'GET /runs/:id finds it');
});
