/**
 * Parsing a plan proposal out of real-model output.
 *
 * A model told "reply with JSON only" usually wraps the JSON in a markdown fence
 * or a sentence. Before call 4 that was a refused plan (`NO_STEPS`), so
 * model-driven planning failed on the commonest shape of real output.
 *
 * The safety argument for being lenient is pinned here too: parsing decides what
 * text to LOOK at; `planner.plan()` still decides what is ALLOWED.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stepsFromProposal, PlanError, PLAN_ERROR_CODES } from '../../src/planning/planner.mjs';
import { STATES } from '../../src/runtime/state-machine.mjs';
import { buildRuntime } from '../helpers/bounded.mjs';

const STEPS = [
  { id: 's1', description: 'quote', tool: 'get_market_quote', args: { ticker: 'AAPL' } },
  { id: 's2', description: 'portfolio', tool: 'get_portfolio_state', args: {} },
];
const PLAN = JSON.stringify({ steps: STEPS });

test('the shapes that already worked still work', () => {
  assert.deepEqual(stepsFromProposal({ steps: [{ description: 'a' }] }), [{ description: 'a' }]);
  assert.deepEqual(stepsFromProposal([{ description: 'a' }]), [{ description: 'a' }]);
  assert.deepEqual(stepsFromProposal({ description: 'a' }), [{ description: 'a' }]);
  assert.deepEqual(stepsFromProposal('{"steps":[{"description":"a"}]}'), [{ description: 'a' }]);
  assert.equal(stepsFromProposal('not json'), null);
  assert.equal(stepsFromProposal(null), null);
  assert.equal(stepsFromProposal(undefined), null);
  assert.equal(stepsFromProposal({ nothing: true }), null);
  assert.equal(stepsFromProposal(''), null);
});

test('a plan wrapped the way real models wrap it is found', () => {
  const wrapped = {
    'a ```json fence': '```json\n' + PLAN + '\n```',
    'a bare ``` fence': '```\n' + PLAN + '\n```',
    'a sentence before': 'Here is the plan you asked for:\n\n' + PLAN,
    'a sentence after': PLAN + '\n\nLet me know if you would like changes.',
    'a sentence either side': 'Sure! ' + PLAN + ' — that should do it.',
    'a bare array in a fence': '```json\n' + JSON.stringify(STEPS) + '\n```',
    'a single step in prose': 'Just one step: ' + JSON.stringify(STEPS[0]),
  };
  for (const [name, text] of Object.entries(wrapped)) {
    const steps = stepsFromProposal(text);
    assert.ok(steps, `${name}: not parsed`);
    assert.equal(steps[0].description, name === 'a single step in prose' ? 'quote' : 'quote', name);
  }
  assert.equal(stepsFromProposal('```json\n' + PLAN + '\n```').length, 2);
});

test('braces, brackets and escaped quotes inside string values do not end a block early', () => {
  const tricky = JSON.stringify({ steps: [{ id: 's1', description: 'use {braces}, ] brackets and a \\ backslash and "quotes"' }] });
  const steps = stepsFromProposal('Plan: ' + tricky + ' (done)');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].description, 'use {braces}, ] brackets and a \\ backslash and "quotes"');
});

test('non-plan JSON and balanced-but-not-JSON text are skipped, and the real plan after them is still found', () => {
  const text = [
    'Example of the format: [1, 2, 3] and {"note": "not a plan"} and {a plan} and [see below].',
    'Now the actual plan:',
    PLAN,
  ].join('\n');
  const steps = stepsFromProposal(text);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].tool, 'get_portfolio_state');
});

test('prose with no plan in it, an unterminated block, and a plan-less object are all null', () => {
  assert.equal(stepsFromProposal('I could not come up with a plan, sorry.'), null);
  assert.equal(stepsFromProposal('{"steps": [{"description": "never closed"'), null);
  assert.equal(stepsFromProposal('Result: {"ok": true, "count": 3}'), null);
  assert.equal(stepsFromProposal('Steps: []'), null);
  assert.equal(stepsFromProposal('{"steps": []}'.replace('{"steps": []}', 'text {"steps": []} text')), null, 'an empty steps list is not a plan');
});

test('the scan is bounded: hostile input is rejected in linear time and never throws', () => {
  const hostile = {
    'a megabyte of open braces': '{'.repeat(1_000_000),
    'a megabyte of open brackets': '['.repeat(1_000_000),
    'a megabyte of quotes': '"'.repeat(1_000_000),
    'thousands of empty blocks': '{}'.repeat(200_000),
    'alternating mismatched closers': '{]'.repeat(300_000),
  };
  for (const [name, text] of Object.entries(hostile)) {
    const startedAt = process.hrtime.bigint();
    assert.equal(stepsFromProposal(text), null, name);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)}ms`);
  }
  // a valid plan placed beyond the scan window is not found: the window is the bound
  const beyond = 'x'.repeat(250_000) + PLAN;
  assert.equal(stepsFromProposal(beyond), null);
});

test('leniency in PARSING does not widen what the agent may do: the planner still refuses an unauthorised tool', async () => {
  const sneaky = 'Sure!\n```json\n' + JSON.stringify({ steps: [{ id: 's1', description: 'place an order', tool: 'submit_paper_order', args: { ticker: 'AAPL', side: 'buy', quantity: 1 } }] }) + '\n```';
  const proposed = stepsFromProposal(sneaky);
  assert.ok(proposed, 'it parses — parsing is not authorisation');

  const { runtime } = buildRuntime();
  const planner = runtime.createPlanner({ profile: runtime.getAgentProfile('general'), agentId: 'general' });
  assert.throws(
    () => planner.plan({ goal: 'trade', steps: proposed }),
    (err) => err instanceof PlanError && [PLAN_ERROR_CODES.TOOL_NOT_PERMITTED, PLAN_ERROR_CODES.UNKNOWN_TOOL].includes(err.code),
    'general may not plan a tool outside its allowlist',
  );
});

test('end to end: a model that fences its plan now gets it run (it used to be a NO_STEPS failure)', async () => {
  const script = [
    { text: 'Here is my plan:\n```json\n' + PLAN + '\n```' },
    { text: 'AAPL quote and portfolio state, summarised.' },
  ];
  const { runtime } = buildRuntime({ mockScript: script });
  const run = runtime.createRun({ agentId: 'general', provider: 'mock' });
  const outcome = await run.loop({ mode: 'planned', goal: 'quote + portfolio', systemPrompt: 's', userMessage: 'go', responseFormat: 'text' });

  assert.equal(outcome.stopReason, null, `${outcome.stopReason?.code}: ${outcome.stopReason?.message}`);
  assert.deepEqual(run.toolCalls.map((c) => c.name), ['get_market_quote', 'get_portfolio_state']);
  assert.equal(run.state, STATES.COMPLETED);
});
