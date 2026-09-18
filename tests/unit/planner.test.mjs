/**
 * The planner: goal decomposition, step data, status transitions, replanning
 * and its ceilings.
 *
 * The planner is bound to the REAL tool registry (the same one the executor
 * uses), so "may only plan steps whose tools exist and are permitted" is tested
 * against the real allowlists rather than a fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlanner,
  snapshotPlan,
  summarizePlan,
  stepsFromProposal,
  STEP_STATUS,
  PLAN_STATUS,
  PLANNER_DEFAULTS,
  PLAN_ERROR_CODES,
  PlanError,
} from '../../src/planning/planner.mjs';
import { makeTestRuntime } from '../helpers/runtime.mjs';
import { getAgentProfile } from '../../src/config/agents.mjs';

function makePlanner(agentId = 'svc_03', options = {}) {
  const { runtime } = makeTestRuntime();
  return { planner: runtime.createPlanner({ profile: getAgentProfile(agentId), agentId, ...options }), runtime };
}

const VALID_STEPS = [
  { id: 's1', description: 'Look up the purchase order', tool: 'query_po_database', args: { poNumber: '990' } },
  { id: 's2', description: 'Compute the tax variance', tool: 'calculate_tax_variance', args: { expectedTax: 36, actualTax: 36 } },
];

test('a plan is data: goal, steps, statuses, attempts, outcomes', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'Reconcile invoice #101', steps: VALID_STEPS });

  assert.match(plan.planId, /^pln_/);
  assert.equal(plan.goal, 'Reconcile invoice #101');
  assert.equal(plan.agentId, 'svc_03');
  assert.equal(plan.status, PLAN_STATUS.ACTIVE);
  assert.equal(plan.revision, 1);
  assert.equal(plan.replans, 0);
  assert.deepEqual(
    Object.keys(plan.steps[0]).sort(),
    ['args', 'attempts', 'description', 'id', 'index', 'outcome', 'status', 'tool'].sort(),
    'a step is exactly the documented data shape',
  );
  assert.equal(plan.steps[0].status, STEP_STATUS.PENDING);
  assert.equal(plan.steps[0].attempts, 0);
  assert.equal(plan.steps[0].outcome, null);
  assert.equal(plan.steps[1].index, 1);
  assert.ok(plan.history.some((entry) => entry.type === 'plan.created'));
  assert.ok(plan.history.some((entry) => entry.type === 'plan.step.planned'));
});

test('nextStep walks the plan in order and marks steps in flight', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'g', steps: VALID_STEPS });

  const first = planner.nextStep(plan);
  assert.equal(first.id, 's1');
  assert.equal(first.status, STEP_STATUS.IN_PROGRESS);
  assert.equal(first.attempts, 1);
  assert.equal(planner.nextStep(plan).id, 's1', 'calling again returns the same in-flight step, without a second attempt');
  assert.equal(plan.steps[0].attempts, 1);

  planner.recordOutcome(plan, 's1', { status: STEP_STATUS.DONE, outcome: { po: 'verified' } });
  const second = planner.nextStep(plan);
  assert.equal(second.id, 's2');
  assert.equal(second.attempts, 1);

  planner.recordOutcome(plan, 's2', { status: STEP_STATUS.DONE });
  assert.equal(planner.nextStep(plan), null, 'no step remains');
  assert.equal(plan.status, PLAN_STATUS.COMPLETE);
  assert.deepEqual(summarizePlan(plan).byStatus, { done: 2 });
});

test('an outcome that is not a legal step status is refused', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'g', steps: VALID_STEPS });
  planner.nextStep(plan);
  assert.throws(() => planner.recordOutcome(plan, 's1', { status: 'nearly-done' }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.INVALID_OUTCOME);
    return true;
  });
  assert.throws(() => planner.recordOutcome(plan, 'nope', { status: STEP_STATUS.DONE }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.STEP_NOT_FOUND);
    return true;
  });
});

test('a plan with no steps, or a malformed step, is refused', () => {
  const { planner } = makePlanner();
  assert.throws(() => planner.plan({ goal: 'g', steps: [] }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.NO_STEPS);
    return true;
  });
  assert.throws(() => planner.plan({ goal: 'g', steps: [{}] }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.INVALID_STEP);
    assert.match(error.message, /description/);
    return true;
  });
  assert.throws(() => planner.plan({ goal: '  ', steps: VALID_STEPS }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.INVALID_STEP);
    return true;
  });
  assert.throws(() => planner.plan({ goal: 'g', steps: [VALID_STEPS[0], VALID_STEPS[0]] }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.DUPLICATE_STEP);
    return true;
  });
  assert.throws(() => planner.plan({ goal: 'g', steps: Array.from({ length: PLANNER_DEFAULTS.maxSteps + 1 }, (_, index) => ({ id: `s${index}`, description: 'x' })) }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.TOO_MANY_STEPS);
    return true;
  });
});

test('the planner only plans tools that exist and that this agent may call', () => {
  const { planner } = makePlanner('svc_03');

  assert.throws(
    () => planner.plan({ goal: 'g', steps: [{ description: 'call a ghost', tool: 'ghost_tool' }] }),
    (error) => {
      assert.equal(error.code, PLAN_ERROR_CODES.UNKNOWN_TOOL);
      assert.match(error.message, /not registered/);
      return true;
    },
  );

  // Not in the allowlist at all: refused on the allowlist check.
  assert.throws(
    () => planner.plan({ goal: 'g', steps: [{ description: 'place an order', tool: 'submit_paper_order' }] }),
    (error) => {
      assert.equal(error.code, PLAN_ERROR_CODES.TOOL_NOT_PERMITTED);
      assert.match(error.message, /not authorised to plan/);
      assert.deepEqual(error.allowedTools, ['query_po_database', 'calculate_tax_variance', 'request_human_approval']);
      return true;
    },
  );

  // Listed, but the grants do not cover it: refused on the permission check.
  const underGranted = makePlanner('svc_03', {
    profile: { id: 'under_granted', tools: ['submit_paper_order'], permissions: [], dataAccess: [] },
  });
  assert.throws(
    () => underGranted.planner.plan({ goal: 'g', steps: [{ description: 'place an order', tool: 'submit_paper_order' }] }),
    (error) => {
      assert.equal(error.code, PLAN_ERROR_CODES.TOOL_NOT_PERMITTED);
      assert.deepEqual(error.missingPermissions, ['order:paper:write']);
      assert.deepEqual(error.missingData, ['trading/order']);
      return true;
    },
  );

  // `no_op` is registered but no SVC agent holds it: a plan may not use it.
  assert.throws(
    () => planner.plan({ goal: 'g', steps: [{ description: 'no-op', tool: 'no_op' }] }),
    (error) => {
      assert.equal(error.code, PLAN_ERROR_CODES.TOOL_NOT_PERMITTED);
      return true;
    },
  );

  // The general agent holds `no_op` and the read-only tools, so it may plan them.
  const general = makePlanner('general');
  const generalPlan = general.planner.plan({ goal: 'g', steps: [{ description: 'no-op', tool: 'no_op' }] });
  assert.equal(generalPlan.steps[0].tool, 'no_op');
  assert.deepEqual(
    general.planner.planableTools().sort(),
    ['calculate_tax_variance', 'check_ip_allowlist', 'get_market_quote', 'get_portfolio_state', 'no_op', 'query_alert_context', 'query_po_database'].sort(),
  );

  // A planner with no profile may plan nothing tool-shaped.
  const anonymous = makePlanner('svc_03', { profile: null, agentId: 'nobody' });
  assert.throws(
    () => anonymous.planner.plan({ goal: 'g', steps: [{ description: 'x', tool: 'query_po_database' }] }),
    (error) => {
      assert.equal(error.code, PLAN_ERROR_CODES.NO_PROFILE);
      assert.equal(error.failClosed, true);
      return true;
    },
  );
  assert.deepEqual(anonymous.planner.plan({ goal: 'g', steps: [{ description: 'think' }] }).steps.length, 1, 'a tool-free step is still plannable');
});

test('shouldReplan tells the truth about when a revision is worthwhile', () => {
  const { planner } = makePlanner('svc_03', { maxReplans: 2 });
  const plan = planner.plan({ goal: 'g', steps: VALID_STEPS });

  assert.equal(planner.shouldReplan(plan), false, 'nothing has failed yet');
  assert.equal(planner.shouldReplan(plan, { failed: true }), true);

  planner.nextStep(plan);
  planner.recordOutcome(plan, 's1', { status: STEP_STATUS.FAILED, error: { message: 'boom' } });
  const decision = planner.replanDecision(plan, { stepId: 's1' });
  assert.equal(decision.replan, true);
  assert.match(decision.reason, /allows 2 more revision/);

  planner.replan(plan, { steps: [{ description: 'try another way', tool: 'query_po_database', args: { poNumber: '991' } }], reason: 'first attempt failed' });
  assert.equal(plan.replans, 1);
  assert.equal(plan.revision, 2);
  assert.equal(planner.shouldReplan(plan, { failed: true }), true);
  planner.replan(plan, { steps: [{ description: 'third way', tool: 'query_po_database', args: { poNumber: '992' } }], reason: 'again' });
  assert.equal(planner.shouldReplan(plan, { failed: true }), false, 'the replan budget is spent');
  assert.throws(() => planner.replan(plan, { steps: [{ description: 'fourth' }], reason: 'again' }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.REPLAN_LIMIT);
    return true;
  });
});

test('replanning supersedes the remaining steps without deleting them', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'g', steps: VALID_STEPS });
  planner.nextStep(plan);
  planner.recordOutcome(plan, 's1', { status: STEP_STATUS.FAILED, error: { message: 'timeout' } });

  planner.replan(plan, {
    steps: [{ id: 's3', description: 'Ask a human instead', tool: 'request_human_approval', args: { reason: 'unverifiable', payload: {} } }],
    reason: 'the PO lookup timed out',
    goal: 'Reconcile invoice #101 (revised)',
  });

  assert.equal(plan.steps.length, 3, 'the superseded step is still in the plan');
  const superseded = plan.steps.find((step) => step.id === 's2');
  assert.equal(superseded.status, STEP_STATUS.SKIPPED);
  assert.match(superseded.outcome.reason, /superseded by plan revision 2/);
  assert.equal(plan.steps.find((step) => step.id === 's1').status, STEP_STATUS.FAILED, 'the failed step keeps its outcome');
  assert.equal(plan.goal, 'Reconcile invoice #101 (revised)');
  assert.equal(plan.status, PLAN_STATUS.ACTIVE);
  assert.ok(plan.history.some((entry) => entry.type === 'plan.replanned'));

  // The replacement step is the next actionable one.
  assert.equal(planner.nextStep(plan).id, 's3');

  // A replan may not smuggle in an unauthorised tool either.
  const other = planner.plan({ goal: 'g', steps: VALID_STEPS });
  planner.nextStep(other);
  planner.recordOutcome(other, 's1', { status: STEP_STATUS.FAILED });
  assert.throws(() => planner.replan(other, { steps: [{ description: 'order', tool: 'submit_paper_order' }] }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.TOOL_NOT_PERMITTED);
    return true;
  });
});

test('complete() closes the plan and refuses to close it twice', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'g', steps: VALID_STEPS });
  planner.nextStep(plan);
  planner.complete(plan, { status: PLAN_STATUS.ABANDONED, outcome: { reason: 'superseded by a human decision' } });

  assert.equal(plan.status, PLAN_STATUS.ABANDONED);
  assert.ok(plan.steps.every((step) => step.status === STEP_STATUS.SKIPPED));
  assert.throws(() => planner.complete(plan, { status: PLAN_STATUS.COMPLETE }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.PLAN_TERMINAL);
    return true;
  });
  assert.throws(() => planner.recordOutcome(plan, 's1', { status: STEP_STATUS.DONE }), (error) => {
    assert.equal(error.code, PLAN_ERROR_CODES.PLAN_TERMINAL);
    return true;
  });
  assert.equal(planner.nextStep(plan), null, 'a terminal plan has no next step');
});

test('a plan whose only step failed stays open for revision, then closes as FAILED', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'g', steps: [{ id: 'only', description: 'the only step' }] });
  planner.nextStep(plan);
  planner.recordOutcome(plan, 'only', { status: STEP_STATUS.FAILED, error: { message: 'nope' } });

  // Out of open steps, with a failure: the plan is awaiting revision, not
  // closed — a revision is still possible, and that is the point of failing.
  assert.equal(plan.status, PLAN_STATUS.ACTIVE);
  assert.equal(planner.nextStep(plan), null);
  assert.ok(plan.history.some((entry) => entry.type === 'plan.awaiting_revision'));
  assert.deepEqual(planner.failedSteps(plan).map((step) => step.id), ['only']);

  // The caller decides to stop: that is what closes it, and it names what failed.
  planner.complete(plan, { status: PLAN_STATUS.FAILED, outcome: { reason: 'no revision budget left' } });
  assert.equal(plan.status, PLAN_STATUS.FAILED);
  assert.deepEqual(plan.outcome.failedSteps, ['only']);
  assert.equal(planner.isTerminal(plan), true);
});

test('snapshotPlan is a frozen deep copy: persisting a plan cannot change it', () => {
  const { planner } = makePlanner();
  const plan = planner.plan({ goal: 'g', steps: VALID_STEPS });
  const snapshot = snapshotPlan(plan);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.steps[0]), true);
  assert.throws(() => {
    snapshot.steps[0].status = 'done';
  }, TypeError);

  planner.nextStep(plan);
  assert.equal(snapshot.steps[0].status, STEP_STATUS.PENDING, 'the snapshot did not move with the live plan');
  assert.equal(plan.steps[0].status, STEP_STATUS.IN_PROGRESS);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).planId, plan.planId);
});

test('stepsFromProposal accepts the shapes a model actually emits, and rejects the rest', () => {
  assert.deepEqual(stepsFromProposal({ steps: [{ description: 'a' }] }), [{ description: 'a' }]);
  assert.deepEqual(stepsFromProposal([{ description: 'a' }]), [{ description: 'a' }]);
  assert.deepEqual(stepsFromProposal({ description: 'a' }), [{ description: 'a' }]);
  assert.deepEqual(stepsFromProposal('{"steps":[{"description":"a"}]}'), [{ description: 'a' }]);
  assert.equal(stepsFromProposal('not json'), null);
  assert.equal(stepsFromProposal(null), null);
  assert.equal(stepsFromProposal({ nothing: true }), null);
});

test('the planner never invents a tool: planableTools is exactly the intersection', () => {
  const { planner, runtime } = makePlanner('svc_04');
  const registered = new Set(runtime.registry.names());
  for (const tool of planner.planableTools()) {
    assert.equal(registered.has(tool), true, `${tool} must be registered`);
    assert.equal(getAgentProfile('svc_04').tools.includes(tool), true, `${tool} must be in the allowlist`);
  }
  assert.deepEqual(planner.describe().stepStatuses.sort(), ['blocked', 'done', 'failed', 'in_progress', 'pending', 'skipped'].sort());
  assert.equal(planner.limits.maxReplans, PLANNER_DEFAULTS.maxReplans);
});

test('a PlanError is a real Error subclass with a stable code', () => {
  const error = new PlanError(PLAN_ERROR_CODES.NO_STEPS, 'no steps');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'PlanError');
  assert.match(error.message, /^PLAN_NO_STEPS: /);
});
