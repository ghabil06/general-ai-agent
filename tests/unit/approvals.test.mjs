/**
 * Approval lifecycle: creation, resolution, expiry with an injected clock,
 * fingerprint binding, and persistence across a restart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_ERROR_CODES,
  APPROVAL_STATUS,
  ApprovalError,
  approvalFingerprint,
  canResolveApproval,
  createApprovalManager,
  createApprovalStore,
  isTerminalApproval,
} from '../../src/policy/approvals.mjs';
import { createJsonlStore } from '../../src/store/jsonl-store.mjs';
import { fixedClock, tempStorageDir } from '../helpers/fixtures.mjs';

const HOUR = 60 * 60 * 1000;

function makeManager({ ttlMs = HOUR } = {}) {
  const clock = fixedClock();
  const store = createJsonlStore({ dir: tempStorageDir(), name: 'approvals' });
  const manager = createApprovalManager({ store, now: clock, defaultTtlMs: ttlMs });
  return { manager, clock, store };
}

test('a new approval is pending, bound to its tool and arguments, and persisted', () => {
  const { manager, store } = makeManager();
  const record = manager.request({
    runId: 'run_1',
    agentId: 'svc_06',
    reason: 'notional over the cap',
    toolName: 'submit_paper_order',
    args: { ticker: 'SPY', quantity: 20, limitPrice: 500.01 },
  });

  assert.equal(record.status, APPROVAL_STATUS.PENDING);
  assert.match(record.approvalId, /^apr_/);
  assert.equal(record.toolName, 'submit_paper_order');
  assert.equal(record.requestFingerprint, approvalFingerprint('submit_paper_order', { ticker: 'SPY', quantity: 20, limitPrice: 500.01 }));
  assert.equal(record.expiresAt - record.createdAt, HOUR);
  assert.equal(store.count(), 1);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(manager.listPending().length, 1);
});

test('request() requires a reason and a known scope of usage', () => {
  const { manager } = makeManager();
  assert.throws(() => manager.request({ agentId: 'svc_03', reason: '' }), ApprovalError);
  assert.throws(() => manager.request({}), /non-empty reason/);
});

test('the pending -> approved lifecycle, and double resolution is refused', () => {
  const { manager, store } = makeManager();
  const record = manager.request({ agentId: 'svc_03', reason: 'over ceiling', toolName: 'request_human_approval', args: { x: 1 } });

  const approved = manager.approve(record.approvalId, { resolvedBy: 'controller@larptech', note: 'checked against the contract' });
  assert.equal(approved.status, APPROVAL_STATUS.APPROVED);
  assert.equal(approved.resolvedBy, 'controller@larptech');
  assert.equal(isTerminalApproval(approved.status), true);
  assert.equal(canResolveApproval(APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED), false);

  // every lifecycle row is appended, not rewritten
  assert.equal(store.count(), 2);

  assert.throws(
    () => manager.reject(record.approvalId, { resolvedBy: 'x' }),
    (error) => {
      assert.equal(error.code, APPROVAL_ERROR_CODES.ILLEGAL_TRANSITION);
      return true;
    },
  );
  assert.throws(() => manager.resolve('apr_missing', { status: APPROVAL_STATUS.APPROVED }), /APPROVAL_NOT_FOUND/);
});

test('rejected and cancelled are terminal and recorded', () => {
  const { manager } = makeManager();
  const a = manager.request({ agentId: 'svc_04', reason: 'r1' });
  const b = manager.request({ agentId: 'svc_04', reason: 'r2' });
  assert.equal(manager.reject(a.approvalId, { resolvedBy: 'analyst' }).status, APPROVAL_STATUS.REJECTED);
  assert.equal(manager.cancel(b.approvalId, { resolvedBy: 'requester' }).status, APPROVAL_STATUS.CANCELLED);
  assert.throws(() => manager.approve(a.approvalId), /cannot become approved/);
  assert.equal(manager.listPending().length, 0);
});

test('expiry is driven by the injected clock and enforced on read', () => {
  const { manager, clock } = makeManager({ ttlMs: 2 * HOUR });
  const record = manager.request({ agentId: 'svc_03', reason: 'waiting on a human' });

  assert.equal(manager.get(record.approvalId).status, APPROVAL_STATUS.PENDING);

  clock.advance(2 * HOUR - 1);
  assert.equal(manager.get(record.approvalId).status, APPROVAL_STATUS.PENDING, 'still pending one ms before the TTL');

  clock.advance(1);
  const expired = manager.get(record.approvalId);
  assert.equal(expired.status, APPROVAL_STATUS.EXPIRED);
  assert.equal(expired.resolvedBy, 'system');
  assert.equal(isTerminalApproval(expired.status), true);

  // an expired approval cannot be approved after the fact
  assert.throws(
    () => manager.approve(record.approvalId, { resolvedBy: 'late' }),
    (error) => {
      assert.equal(error.code, APPROVAL_ERROR_CODES.EXPIRED);
      return true;
    },
  );
});

test('expireOverdue sweeps only overdue pending approvals', () => {
  const { manager, clock, store } = makeManager({ ttlMs: HOUR });
  const older = manager.request({ agentId: 'svc_03', reason: 'old' });
  clock.advance(30 * 60 * 1000);
  const newer = manager.request({ agentId: 'svc_03', reason: 'new' });
  clock.advance(31 * 60 * 1000);

  const expired = manager.expireOverdue();
  assert.deepEqual(expired.map((record) => record.approvalId), [older.approvalId]);
  assert.equal(manager.get(newer.approvalId).status, APPROVAL_STATUS.PENDING);
  assert.equal(manager.listPending().length, 1);
  // created, plus the expiry row
  assert.equal(store.count(), 3);
});

test('an approval is bound to its tool AND its exact arguments', () => {
  const { manager } = makeManager();
  const args = { ticker: 'SPY', quantity: 20, limitPrice: 500.01 };
  const record = manager.request({ agentId: 'svc_06', reason: 'over cap', toolName: 'submit_paper_order', args });
  manager.approve(record.approvalId, { resolvedBy: 'desk' });

  assert.equal(manager.check(record.approvalId, { toolName: 'submit_paper_order', args }).approved, true);
  // argument order does not matter
  assert.equal(manager.check(record.approvalId, { toolName: 'submit_paper_order', args: { limitPrice: 500.01, quantity: 20, ticker: 'SPY' } }).approved, true);

  // a different instrument, size or tool is a different request
  const mismatch = manager.check(record.approvalId, { toolName: 'submit_paper_order', args: { ticker: 'BTC-USD', quantity: 500, limitPrice: 1 } });
  assert.equal(mismatch.approved, false);
  assert.match(mismatch.reason, /different arguments/);

  const wrongTool = manager.check(record.approvalId, { toolName: 'request_human_review', args });
  assert.equal(wrongTool.approved, false);
  assert.match(wrongTool.reason, /bound to tool/);

  assert.throws(
    () => manager.resolve(record.approvalId, { status: APPROVAL_STATUS.APPROVED, args: { ticker: 'X' } }),
    /APPROVAL_MISMATCH|cannot become/,
  );
});

test('check() refuses a pending, rejected or unknown approval', () => {
  const { manager } = makeManager();
  const pending = manager.request({ agentId: 'svc_03', reason: 'x' });
  assert.equal(manager.check(pending.approvalId).approved, false);
  assert.match(manager.check(pending.approvalId).reason, /is pending/);

  manager.reject(pending.approvalId, { resolvedBy: 'human' });
  assert.equal(manager.check(pending.approvalId).approved, false);
  assert.match(manager.check(pending.approvalId).reason, /is rejected/);

  assert.equal(manager.check('apr_nope').approved, false);
  assert.match(manager.check('apr_nope').reason, /unknown approval/);
});

test('approvals survive a restart: hydrate() loads persisted state', () => {
  const dir = tempStorageDir();
  const clock = fixedClock();
  const store = createApprovalStore(dir);

  const first = createApprovalManager({ store, now: clock, defaultTtlMs: HOUR });
  const pending = first.request({ runId: 'run_1', agentId: 'svc_03', reason: 'persist me', toolName: 'request_human_approval', args: { a: 1 } });
  const approved = first.request({ runId: 'run_1', agentId: 'svc_03', reason: 'approve me' });
  first.approve(approved.approvalId, { resolvedBy: 'controller' });

  // a new process
  const second = createApprovalManager({ store: createApprovalStore(dir), now: clock, defaultTtlMs: HOUR });
  assert.equal(second.size, 0);
  const hydrated = second.hydrate();
  assert.equal(hydrated, 2);
  assert.equal(second.get(pending.approvalId).status, APPROVAL_STATUS.PENDING);
  assert.equal(second.get(approved.approvalId).status, APPROVAL_STATUS.APPROVED);
  assert.equal(second.listPending().length, 1);
  assert.equal(second.check(approved.approvalId).approved, true);
});

test('an approval with ttlMs 0 never expires', () => {
  const { manager, clock } = makeManager({ ttlMs: HOUR });
  const record = manager.request({ agentId: 'svc_03', reason: 'no ttl', ttlMs: 0 });
  assert.equal(record.expiresAt, null);
  clock.advance(365 * 24 * HOUR);
  assert.equal(manager.get(record.approvalId).status, APPROVAL_STATUS.PENDING);
  assert.deepEqual(manager.expireOverdue(), []);
});

test('the lifecycle emits an event per state change (for approval.requested/resolved)', () => {
  const events = [];
  const manager = createApprovalManager({
    now: fixedClock(),
    defaultTtlMs: HOUR,
    onEvent: (event) => events.push(`${event.type}:${event.row.status}`),
  });
  const record = manager.request({ agentId: 'svc_03', reason: 'x' });
  manager.approve(record.approvalId, { resolvedBy: 'human' });
  assert.deepEqual(events, ['approval.created:pending', 'approval.approved:approved']);
});
