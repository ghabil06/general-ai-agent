/**
 * Integration: the runtime HTTP API, exercised over a real socket.
 *
 * This suite starts the REAL `server.mjs` on an ephemeral port, against a
 * throwaway storage directory, and drives every endpoint through `fetch`. It
 * asserts status codes and bodies, not implementation details, because the
 * status code and the error envelope ARE the contract a console depends on.
 *
 * What it covers, per endpoint: the happy path, an unknown id (404), an invalid
 * body (400), a conflict (409), and — the one that matters most — a real
 * approval round trip: start a run that PAUSES at the gate, list the pending
 * approval, approve it, resume the gated call with the approval id, and confirm
 * the run record, the approval rows and the audit rows are all on disk.
 *
 * The legacy dashboard routes are asserted here too. They share a process with
 * the runtime API, so "the new routes work" is only half the property; the other
 * half is that `/api/simulate`, `/api/overview` and the static fallback still
 * behave exactly as they did.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startServer } from '../../server.mjs';
import { tempStorageDir, loadDataset, REPO_ROOT } from '../helpers/fixtures.mjs';
import { defaultReportPath } from '../../src/api/handlers/evaluations.mjs';

/** The one server this file drives. */
const STORAGE_DIR = tempStorageDir('agent-api-test-');
let server = null;

before(async () => {
  server = await startServer({ port: 0, storageDir: STORAGE_DIR, quiet: true });
});

after(async () => {
  if (server) await server.close();
});

/** JSON fetch helper. Returns the status, headers, raw text and parsed body. */
async function call(pathname, { method = 'GET', body, raw } = {}) {
  const hasBody = body !== undefined || raw !== undefined;
  const response = await fetch(`${server.url}${pathname}`, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json, contentType: response.headers.get('content-type') ?? '' };
}

/** Every response must be a single redacted JSON object with a request id. */
function assertEnvelope(response, expectedStatus) {
  assert.equal(response.status, expectedStatus, `expected ${expectedStatus}, got ${response.status}: ${response.text.slice(0, 300)}`);
  assert.match(response.contentType, /application\/json/, 'every runtime response is JSON');
  assert.ok(response.json, 'the body is JSON');
  assert.equal(typeof response.json.requestId, 'string', 'the request id is echoed in the body');
  assert.equal(response.headers.get('x-request-id'), response.json.requestId, 'the same id is in the X-Request-Id header');
  assert.equal(/sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|ghp_[A-Za-z0-9]{8,}/.test(response.text), false, 'no credential-shaped string in the response');
  return response.json;
}

function assertError(response, expectedStatus, expectedCode) {
  const body = assertEnvelope(response, expectedStatus);
  assert.ok(body.error, 'an error response carries `error`');
  assert.equal(body.error.code, expectedCode);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  return body;
}

// ── health ───────────────────────────────────────────────────────────────────

test('GET /api/runtime/health reports storage, providers and version without a key', async () => {
  const body = assertEnvelope(await call('/api/runtime/health'), 200);
  assert.equal(body.ok, true);
  assert.equal(body.runtime.version, '0.2.0');
  assert.equal(body.runtime.storageDir, STORAGE_DIR);
  assert.equal(body.storage.readable, true);
  assert.ok(Object.keys(body.storage.collections).length >= 8, 'every JSONL collection is reported');
  assert.ok(body.storage.collections.runs.path.startsWith(STORAGE_DIR), 'the runs collection is inside the test storage dir');
  assert.ok(body.checks.every((check) => check.ok), 'every health check passes on a fresh runtime');

  const ids = body.providers.map((provider) => provider.id);
  assert.deepEqual(ids.sort(), ['anthropic', 'local', 'mock', 'openai']);
  const mock = body.providers.find((provider) => provider.id === 'mock');
  assert.equal(mock.available, true);
  assert.equal(mock.mock, true);
  // Presence only — the boolean, never a key.
  for (const provider of body.providers) {
    const configured = provider.configured;
    assert.ok(configured === null || typeof configured === 'boolean', 'credential presence is a boolean or null, never a value');
    assert.equal(provider.credentialPresent, undefined, 'no field whose name contains a secret word, so redact() cannot blank a boolean');
  }
});

// ── agents ───────────────────────────────────────────────────────────────────

test('GET /api/runtime/agents lists the four profiles with boundary, tools and limits', async () => {
  const body = assertEnvelope(await call('/api/runtime/agents'), 200);
  assert.equal(body.count, 4);
  assert.deepEqual(body.agents.map((agent) => agent.id).sort(), ['general', 'svc_03', 'svc_04', 'svc_06']);

  const svc03 = body.agents.find((agent) => agent.id === 'svc_03');
  assert.equal(svc03.boundary.autonomousApprovalCeilingUsd, 500);
  assert.match(svc03.boundarySummary, /\$500\.00/);
  assert.deepEqual(svc03.tools, ['query_po_database', 'calculate_tax_variance', 'request_human_approval']);
  assert.equal(svc03.limits.maxToolCalls, 12);
  assert.equal(svc03.allowDestructiveActions, false);
  assert.equal(svc03.escalationTool, 'request_human_approval');
  assert.equal(svc03.escalationDisposition, 'request_human_approval');
  assert.equal(svc03.toolDetails.length, 3);
  assert.equal(svc03.toolDetails.find((tool) => tool.name === 'request_human_approval').requiresConfirmation, true);
  assert.ok(svc03.dataset.cases === 12);

  const general = body.agents.find((agent) => agent.id === 'general');
  assert.equal(general.hasDomainBoundary, false);
  assert.equal(general.boundary, null);
  assert.match(general.boundarySummary, /fail-closed/);
  assert.equal(general.escalationTool, null);
});

test('GET /api/runtime/tools lists the registry with risk, side effects and holders', async () => {
  const body = assertEnvelope(await call('/api/runtime/tools'), 200);
  assert.equal(body.count, 12);
  const submit = body.tools.find((tool) => tool.name === 'submit_paper_order');
  assert.equal(submit.sideEffect, 'write');
  assert.ok(['high', 'critical', 'medium'].includes(submit.riskLevel));
  assert.deepEqual(submit.heldBy, ['svc_06']);
  assert.ok(Array.isArray(submit.requiredArguments) && submit.requiredArguments.length > 0);
  const approval = body.tools.find((tool) => tool.name === 'request_human_approval');
  assert.equal(approval.requiresConfirmation, true);
  assert.equal(approval.escalation, true);
  assert.deepEqual(approval.heldBy, ['svc_03']);
  assert.ok(body.tools.every((tool) => Array.isArray(tool.permissions)));
});

test('GET /api/runtime/policies returns the rule inventory and the frozen boundaries', async () => {
  const body = assertEnvelope(await call('/api/runtime/policies'), 200);
  assert.ok(body.ruleCount >= 8);
  assert.equal(body.rules.length, body.ruleCount);
  assert.equal(body.defaultDecision, 'DENY');
  assert.equal(body.boundaries.length, 3);
  const svc06 = body.boundaries.find((boundary) => boundary.agentId === 'svc_06');
  assert.equal(svc06.boundary.maxSingleOrderNotionalUsd, 10_000);
  assert.match(svc06.summary, /\$10000\.00/);
  assert.match(svc06.source, /not configurable/);
  assert.deepEqual(body.withoutBoundary, ['general']);
  assert.ok(body.rules.some((rule) => rule.id === 'untrusted.prompt_injection'));
  assert.ok(body.rules.some((rule) => rule.id === 'action.required_approval'));
});

// ── evaluations ──────────────────────────────────────────────────────────────

test('GET /api/runtime/evaluations says "not run yet" rather than inventing a report', async () => {
  const body = assertEnvelope(await call('/api/runtime/evaluations'), 200);
  assert.equal(body.available, false);
  assert.equal(body.path, defaultReportPath(STORAGE_DIR));
  assert.equal(body.command, 'npm run eval:runtime');
  assert.match(body.note, /will not fabricate/);
});

test('GET /api/runtime/evaluations summarises a real report when one is on disk', async () => {
  const source = path.join(REPO_ROOT, 'data', 'state', 'evals', 'runtime-results.json');
  if (!fs.existsSync(source)) {
    test.skip('no report on disk: run `npm run eval:runtime` first');
    return;
  }
  const target = defaultReportPath(STORAGE_DIR);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);

  const body = assertEnvelope(await call('/api/runtime/evaluations'), 200);
  assert.equal(body.available, true);
  assert.ok(body.generatedAt);
  assert.equal(body.agents.length, 4);
  assert.ok(body.totals.oracleCases >= 36, `the report covers the three datasets (got ${body.totals.oracleCases})`);
  const svc03 = body.agents.find((agent) => agent.agentId === 'svc_03');
  assert.equal(svc03.oracle.taskCorrect, 12);
  assert.equal(svc03.naive.taskCorrect, 3);
  assert.equal(svc03.gate.ok, true);
  assert.ok(svc03.suites.length >= 10);
});

// ── starting runs ────────────────────────────────────────────────────────────

test('POST /api/runtime/agents/svc_03/runs runs a real offline run and returns the decision', async () => {
  const dataset = loadDataset('invoices_dataset.json');
  const clean = dataset[0]; // expected_action: auto_approve
  const body = assertEnvelope(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: clean.vars.invoice_data } }), 201);

  assert.equal(body.agentId, 'svc_03');
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.state, 'COMPLETED');
  assert.equal(body.terminal, true);
  assert.equal(body.paused, false);
  assert.match(body.runId, /^run_/);
  assert.equal(body.provider, 'mock');
  assert.equal(body.providerIsMock, true);
  assert.equal(body.scriptedBy, 'oracle-fixture:dataset-case');
  assert.equal(body.matchedDatasetCase, 1);
  assert.equal(body.decision.action, 'auto_approve');
  assert.equal(body.policyDecision.decision, 'ALLOW');
  assert.deepEqual(body.toolCalls, ['query_po_database', 'calculate_tax_variance']);
  assert.ok(body.offlineNote.includes('test double'), 'the response says the provider is a double');
  assert.equal(body.run.status, 'COMPLETED');
  assert.ok(body.run.startedIso && body.run.finishedIso);
  assert.ok(body.run.durationMs >= 0);

  // The run is on disk, in this storage dir and nowhere else.
  const row = JSON.parse(
    fs.readFileSync(path.join(STORAGE_DIR, 'runs', 'runs.jsonl'), 'utf8').trim().split('\n').pop(),
  );
  assert.equal(row.phase, 'finished');
  assert.equal(row.status, 'COMPLETED');
});

test('POST /api/runtime/agents/svc_06/runs reaches a decision for a trading case', async () => {
  const dataset = loadDataset('trading_dataset.json');
  const order = dataset.find((entry) => entry.vars.expected_action === 'execute_trade');
  const body = assertEnvelope(await call('/api/runtime/agents/svc_06/runs', { method: 'POST', body: { input: order.vars.market_data } }), 201);
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.decision.action, 'execute_trade');
  assert.equal(body.policyDecision.decision, 'ALLOW');
  assert.deepEqual(body.toolCalls, ['get_portfolio_state', 'get_market_quote']);
});

test('POST /api/runtime/agents/general/runs runs the general agent scenario offline', async () => {
  const body = assertEnvelope(
    await call('/api/runtime/agents/general/runs', { method: 'POST', body: { input: 'market_and_portfolio' } }),
    201,
  );
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.scriptedBy, 'general-scenario');
  assert.deepEqual(body.toolCalls, ['get_market_quote', 'get_portfolio_state']);
  assert.equal(body.decision, null, 'the general agent has no disposition contract, so there is no decision to grade');
});

test('POST /api/runtime/agents/:id/runs accepts planning=planned and runs the plan', async () => {
  const dataset = loadDataset('invoices_dataset.json');
  const clean = dataset[0];
  const body = assertEnvelope(
    await call('/api/runtime/agents/svc_03/runs', {
      method: 'POST',
      body: { input: clean.vars.invoice_data, planning: 'planned' },
    }),
    201,
  );
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.mode, 'planned');
  assert.ok(body.toolCalls.length >= 1, 'the plan executed its tool steps');
});

test('POST /api/runtime/agents/:id/runs rejects an unknown agent, a missing input and an unknown provider', async () => {
  assertError(await call('/api/runtime/agents/svc_99/runs', { method: 'POST', body: { input: 'x' } }), 404, 'UNKNOWN_AGENT');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: {} }), 400, 'INVALID_REQUEST');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: '   ' } }), 400, 'INVALID_REQUEST');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: 'x', provider: 'gemini' } }), 400, 'UNKNOWN_PROVIDER');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: 'x', planning: 'sideways' } }), 400, 'INVALID_REQUEST');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: 'x', planning: { maxSteps: 0 } } }), 400, 'INVALID_REQUEST');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: 'x', approvalId: 'apr_nope' } }), 404, 'UNKNOWN_APPROVAL');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', raw: '{not json' }), 400, 'INVALID_JSON');
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', raw: '[]' }), 400, 'INVALID_REQUEST');
  assertError(
    await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: 'x'.repeat(60_001) } }),
    400,
    'INVALID_REQUEST',
  );
});

test('POST /api/runtime/agents/:id/runs fails closed for a real provider with no credential', async () => {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  const response = await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: 'hello', provider: 'anthropic' } });
  if (configured) {
    // A key IS configured in this environment, so the interesting assertion is
    // that the API does not refuse the request — it is not a substitute-for-mock
    // check any more. The run itself is not asserted: it would spend money.
    assert.notEqual(response.status, 503, 'a configured provider is not reported as unconfigured');
    return;
  }
  const body = assertError(response, 503, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(body.error.details.provider, 'anthropic');
  assert.equal(body.error.details.envVar, 'ANTHROPIC_API_KEY');
  assert.match(body.error.message, /will not substitute a mock/, 'the refusal says why it will not fake a result');
});

test('POST /api/runtime/agents/:id/runs with an oversized body is a structured 413', async () => {
  const oversized = JSON.stringify({ input: 'x'.repeat(70_000) });
  assertError(await call('/api/runtime/agents/svc_03/runs', { method: 'POST', raw: oversized }), 413, 'BODY_TOO_LARGE');
});

// ── reading runs ─────────────────────────────────────────────────────────────

let pausedRunId = null;
let pausedApprovalId = null;

test('POST a run that PAUSES for approval, then list it as pending', async () => {
  const dataset = loadDataset('invoices_dataset.json');
  const escalated = dataset.find((entry) => entry.vars.expected_action === 'request_human_approval');
  assert.ok(escalated, 'the dataset has an escalation case');

  const body = assertEnvelope(
    await call('/api/runtime/agents/svc_03/runs', { method: 'POST', body: { input: escalated.vars.invoice_data } }),
    201,
  );
  assert.equal(body.status, 'WAITING_FOR_APPROVAL');
  assert.equal(body.state, 'WAITING_FOR_APPROVAL');
  assert.equal(body.terminal, false, 'a paused run is not terminal');
  assert.equal(body.paused, true);
  assert.match(body.pendingApprovalId, /^apr_/);
  assert.equal(body.scriptedBy, 'oracle-fixture:dataset-case+escalation-tool');
  assert.ok(body.toolCalls.includes('request_human_approval'));
  assert.equal(body.policyDecision, null, 'the gated call never produced a disposition');

  pausedRunId = body.runId;
  pausedApprovalId = body.pendingApprovalId;

  const queue = assertEnvelope(await call('/api/runtime/approvals?status=pending'), 200);
  const pending = queue.approvals.find((approval) => approval.approvalId === pausedApprovalId);
  assert.ok(pending, 'the paused run created a real pending approval');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.runId, pausedRunId);
  assert.equal(pending.agentId, 'svc_03');
  assert.equal(pending.toolName, 'request_human_approval');
  assert.ok(pending.requestFingerprint, 'the approval is bound to an argument fingerprint');
  assert.ok(pending.expiresAt > pending.createdAt, 'the approval expires');
  assert.equal(queue.pendingCount >= 1, true);

  const bad = assertError(await call('/api/runtime/approvals?status=nonsense'), 400, 'INVALID_REQUEST');
  assert.ok(bad.error.details.known.includes('pending'));
});

test('GET /api/runtime/runs/{id} returns the record, timeline, verdicts, trace and audit', async () => {
  const body = assertEnvelope(await call(`/api/runtime/runs/${pausedRunId}`), 200);
  assert.equal(body.run.runId, pausedRunId);
  assert.equal(body.run.status, 'WAITING_FOR_APPROVAL');
  assert.equal(body.run.terminal, false);
  assert.equal(body.decision, null);
  assert.ok(body.stateHistory.length >= 3, 'the state history records the path the machine took');
  assert.ok(body.stateTimeline.length >= 3, 'the timeline carries timestamps');
  assert.ok(body.stateTimeline.some((entry) => entry.to === 'WAITING_FOR_APPROVAL'));
  assert.ok(body.policyDecisions.length >= 1);
  assert.ok(body.policyDecisions.every((decision) => ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].includes(decision.decision)));
  assert.ok(body.toolCalls.some((call_) => call_.tool === 'request_human_approval' && call_.status === 'APPROVAL_REQUIRED'));
  assert.equal(body.pendingApprovalId, pausedApprovalId);
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].approvalId, pausedApprovalId);
  assert.ok(body.audit.length >= 1, 'the run wrote an audit row');
  assert.equal(body.audit[0].type, 'run.paused');
  assert.ok(body.trace && body.trace.spanCount > 0, 'the trace was persisted and is summarised');
  assert.ok(body.trace.spans.some((span) => span.status === 'pending'), 'the root span is pending while the run waits');
});

test('GET /api/runtime/runs/{id}/events returns the ordered structured stream', async () => {
  const body = assertEnvelope(await call(`/api/runtime/runs/${pausedRunId}/events`), 200);
  assert.equal(body.runId, pausedRunId);
  assert.ok(body.count >= 8);
  const types = body.events.map((event) => event.type);
  for (const expected of ['run.started', 'state.changed', 'model.called', 'tool.proposed', 'policy.decided', 'approval.requested', 'run.paused']) {
    assert.ok(types.includes(expected), `the event stream contains ${expected}`);
  }
  assert.ok(
    body.events.every((event, index) => index === 0 || event.seq > body.events[index - 1].seq),
    'events are ordered by the monotonic bus sequence',
  );
  assert.ok(body.events.every((event) => event.runId === pausedRunId));
});

test('GET /api/runtime/runs lists persisted runs with timestamps and traceable ids', async () => {
  const body = assertEnvelope(await call('/api/runtime/runs'), 200);
  assert.ok(body.count >= 4, `expected the runs started above to be listed (got ${body.count})`);
  assert.equal(body.storageDir, STORAGE_DIR);
  const paused = body.runs.find((run) => run.runId === pausedRunId);
  assert.ok(paused, 'the paused run is listed');
  assert.equal(paused.terminal, false);
  assert.ok(paused.startedIso && paused.traceRoot, 'the summary carries a timestamp and the trace root');
  assert.ok(body.runs.every((run) => run.runId && run.agentId && run.startedIso));
  assert.ok(body.runs.every((run, index) => index === 0 || (run.startedAt ?? 0) <= (body.runs[index - 1].startedAt ?? 0)), 'newest first');

  assertError(await call('/api/runtime/runs?limit=0'), 400, 'INVALID_REQUEST');
  assertError(await call('/api/runtime/runs?limit=9999'), 400, 'INVALID_REQUEST');
  const filtered = assertEnvelope(await call('/api/runtime/runs?agentId=svc_03&limit=3'), 200);
  assert.ok(filtered.runs.length <= 3);
  assert.ok(filtered.runs.every((run) => run.agentId === 'svc_03'));
});

test('GET /api/runtime/runs/{id} and /events are 404 for an unknown run', async () => {
  assertError(await call('/api/runtime/runs/run_does_not_exist'), 404, 'UNKNOWN_RUN');
  assertError(await call('/api/runtime/runs/run_does_not_exist/events'), 404, 'UNKNOWN_RUN');
});

// ── the approval round trip ──────────────────────────────────────────────────

test('POST /api/runtime/approvals/{id}/approve resolves the pending approval and persists it', async () => {
  const approve = assertEnvelope(
    await call(`/api/runtime/approvals/${pausedApprovalId}/approve`, { method: 'POST', body: { resolvedBy: 'api-test', note: 'reviewed' } }),
    200,
  );
  assert.equal(approve.resolved, true);
  assert.equal(approve.approval.status, 'approved');
  assert.equal(approve.approval.resolvedBy, 'api-test');
  assert.equal(approve.approval.resolutionNote, 'reviewed');
  assert.ok(approve.approval.resolvedIso);
  assert.equal(approve.runId, pausedRunId);

  // It has left the pending queue…
  const pending = assertEnvelope(await call('/api/runtime/approvals?status=pending'), 200);
  assert.equal(pending.approvals.some((approval) => approval.approvalId === pausedApprovalId), false);

  // …and appears in the resolution history.
  const approved = assertEnvelope(await call('/api/runtime/approvals?status=approved'), 200);
  assert.ok(approved.approvals.some((approval) => approval.approvalId === pausedApprovalId));
  assert.equal(approved.countsByStatus.approved >= 1, true);

  // Both lifecycle rows are on disk, newest last.
  const rows = fs
    .readFileSync(path.join(STORAGE_DIR, 'approvals', 'approvals.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.approvalId === pausedApprovalId);
  assert.equal(rows.length, 2, 'created + approved are both persisted');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[1].status, 'approved');

  // Resolving twice is a conflict, not a silent success.
  assertError(await call(`/api/runtime/approvals/${pausedApprovalId}/approve`, { method: 'POST', body: {} }), 409, 'APPROVAL_NOT_PENDING');
  assertError(await call(`/api/runtime/approvals/${pausedApprovalId}/reject`, { method: 'POST', body: {} }), 409, 'APPROVAL_NOT_PENDING');
  assertError(await call('/api/runtime/approvals/apr_missing/approve', { method: 'POST', body: {} }), 404, 'UNKNOWN_APPROVAL');
  assertError(await call('/api/runtime/approvals/apr_missing/reject', { method: 'POST', body: {} }), 404, 'UNKNOWN_APPROVAL');
});

test('resuming the gated call with the approval id executes the tool and completes the run', async () => {
  const dataset = loadDataset('invoices_dataset.json');
  const escalated = dataset.find((entry) => entry.vars.expected_action === 'request_human_approval');
  const body = assertEnvelope(
    await call('/api/runtime/agents/svc_03/runs', {
      method: 'POST',
      body: { input: escalated.vars.invoice_data, approvalId: pausedApprovalId },
    }),
    201,
  );
  assert.equal(body.resumedWithApprovalId, pausedApprovalId);
  assert.equal(body.status, 'COMPLETED');
  // The resumed run replays the whole script: verification first, then the
  // gated escalation call, which now finds an approved approval and executes.
  assert.deepEqual(body.toolCalls, ['query_po_database', 'request_human_approval']);
  assert.equal(body.paused, false);

  const events = assertEnvelope(await call(`/api/runtime/runs/${body.runId}/events`), 200);
  const resolved = events.events.find((event) => event.type === 'approval.resolved');
  assert.ok(resolved, 'the executor emitted approval.resolved when it consumed the approval');
  assert.equal(resolved.payload.approvalId, pausedApprovalId);
  assert.equal(resolved.payload.consumedBy, body.runId);
});

test('POST /api/runtime/runs/{id}/cancel cancels a paused run, and 409s a terminal one', async () => {
  const cancelled = assertEnvelope(await call(`/api/runtime/runs/${pausedRunId}/cancel`, { method: 'POST', body: { reason: 'api-test' } }), 200);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.transitionedFrom, 'WAITING_FOR_APPROVAL');
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.run.status, 'CANCELLED');

  const detail = assertEnvelope(await call(`/api/runtime/runs/${pausedRunId}`), 200);
  assert.equal(detail.run.status, 'CANCELLED');
  assert.equal(detail.run.terminal, true);

  // Cancelling again, and cancelling a completed run, are conflicts.
  assertError(await call(`/api/runtime/runs/${pausedRunId}/cancel`, { method: 'POST', body: {} }), 409, 'RUN_NOT_CANCELLABLE');
  const runs = assertEnvelope(await call('/api/runtime/runs'), 200);
  const completed = runs.runs.find((run) => run.status === 'COMPLETED');
  assert.ok(completed);
  assertError(await call(`/api/runtime/runs/${completed.runId}/cancel`, { method: 'POST', body: {} }), 409, 'RUN_NOT_CANCELLABLE');
  assertError(await call('/api/runtime/runs/run_missing/cancel', { method: 'POST', body: {} }), 404, 'UNKNOWN_RUN');

  // The cancellation is in the audit stream.
  const audit = fs
    .readFileSync(path.join(STORAGE_DIR, 'audit', 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(audit.some((row) => row.type === 'run.cancelled' && row.runId === pausedRunId));
});

// ── routing contract ────────────────────────────────────────────────────────

test('an unknown runtime route is a JSON 404, never a static file', async () => {
  const response = await call('/api/runtime/does-not-exist');
  const body = assertError(response, 404, 'UNKNOWN_ROUTE');
  assert.equal(response.text.includes('<!DOCTYPE html>'), false, 'no HTML fallback on a runtime path');
  assert.ok(body.error.details.knownRoutes.some((route) => route.startsWith('GET /api/runtime/runs')));

  // Nested, mistyped and trailing-slash paths are all JSON too.
  for (const pathname of ['/api/runtime', '/api/runtime/', '/api/runtime/runs/run_1/nope', '/api/runtime/agents/svc_03/runs/extra']) {
    const nested = await call(pathname);
    assert.equal(nested.status, 404);
    assert.match(nested.contentType, /application\/json/);
    assert.equal(nested.json.error.code, 'UNKNOWN_ROUTE');
  }
});

test('a wrong method on a known route is a 405 with an Allow header', async () => {
  const response = await call('/api/runtime/runs', { method: 'DELETE' });
  const body = assertError(response, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(response.headers.get('allow'), 'GET');
  assert.deepEqual(body.error.details.allowed, ['GET']);

  const post = await call('/api/runtime/health', { method: 'POST', body: {} });
  assertError(post, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(post.headers.get('allow'), 'GET');
});

// ── the legacy dashboard still works ────────────────────────────────────────

test('the legacy dashboard routes are unchanged by the runtime API', async () => {
  const overview = await call('/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.stats.totalEvalCases, 36);
  assert.deepEqual(Object.keys(overview.json.agents), ['svc_03', 'svc_04', 'svc_06']);
  assert.equal(overview.json.projectName, 'Larptech Agent Prompts (Bounded Agency)');

  const cases = await call('/api/cases?agent=svc_04');
  assert.equal(cases.json.cases.length, 12);
  assert.equal(cases.json.agent, 'svc_04');

  const prompts = await call('/api/prompts?agent=svc_03');
  assert.ok(prompts.json.promptText.length > 100);
  assert.ok(prompts.json.guardrailText.length > 100);

  const audit = await call('/api/audit-logs');
  assert.ok(Array.isArray(audit.json.rows));

  const simulate = await call('/api/simulate', { method: 'POST', body: { agent: 'svc_03', caseIndex: 0, customText: '' } });
  assert.equal(simulate.status, 200);
  // The shape `public/app.js` reads, field for field.
  assert.equal(simulate.json.stages.length, 5);
  assert.equal(typeof simulate.json.decision.action, 'string');
  assert.equal(typeof simulate.json.guardrailPassed, 'boolean');
  assert.equal(typeof simulate.json.hasInjection, 'boolean');
  assert.ok(simulate.json.auditRow);
  assert.equal(typeof simulate.json.totalDurationMs, 'number');
  // Plus the markers that label it as the legacy path.
  assert.equal(simulate.json.simulated, true);
  assert.equal(simulate.json.deprecated, true);

  const index = await call('/');
  assert.equal(index.status, 200);
  assert.match(index.contentType, /text\/html/);
  assert.ok(index.text.includes('LARPTECH'));

  const missing = await call('/definitely-not-a-file');
  assert.equal(missing.status, 200, 'the legacy fallback still serves index.html with a 200');
  assert.ok(missing.text.includes('LARPTECH'));
});

test('the operator console is served at /console and calls only the runtime API', async () => {
  const page = await call('/console');
  assert.equal(page.status, 200);
  assert.match(page.contentType, /text\/html/);
  assert.ok(page.text.includes('/api/runtime/'), 'the console points at the runtime API');
  assert.equal(/TODO|FIXME|Lorem ipsum|PLACEHOLDER/i.test(page.text), false, 'no placeholder content');
  assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(page.text), false, 'no remote asset or CDN reference');

  const script = await call('/runtime.js');
  assert.equal(script.status, 200);
  assert.ok(script.text.includes("'/api/runtime'"), 'the console builds every URL from the runtime API prefix');
  assert.ok(script.text.includes("'/approvals"), 'the console can resolve approvals');
  assert.equal(/\/api\/overview|\/api\/simulate|\/api\/cases/.test(script.text), false, 'the console does not touch the legacy API');

  const style = await call('/runtime.css');
  assert.equal(style.status, 200);
  assert.match(style.contentType, /text\/css/);
  assert.ok(style.text.includes('system-ui'), 'a system font stack, no webfont');
});

/**
 * The console cannot be click-tested in this environment (no browser backend is
 * available to the agent), so its STRUCTURE is asserted instead — and the
 * distinction is stated here rather than glossed over:
 *
 *   - every `href` in the page resolves over this server (no dead link);
 *   - every `/api/runtime` path the script calls names an endpoint the router
 *     publishes (the console cannot call a route that does not exist);
 *   - the stylesheet is self-contained, responsive through a relative-unit
 *     breakpoint, and free of any fixed pixel width that could overflow a 380px
 *     viewport.
 *
 * What this does NOT prove: that the rendered result looks right. That needs a
 * browser; `docs/VERIFICATION.md` records it as unverified in this environment.
 */
test('the console has no dead links, no unknown API calls and no fixed pixel widths', async () => {
  const page = await call('/console');
  const hrefs = [...page.text.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length >= 8, `the page links somewhere (found ${hrefs.length})`);
  for (const href of new Set(hrefs)) {
    if (href.startsWith('#')) continue; // in-page navigation
    const target = await call(href);
    assert.equal(target.status, 200, `link ${href} resolves`);
  }

  const script = await call('/runtime.js');
  const called = [...new Set([...script.text.matchAll(/api\('([^']+)'/g)].map((match) => match[1].split('?')[0]))];
  assert.ok(called.length >= 6, `the console calls several endpoints (found ${called.join(', ')})`);
  const publishedEndpoints = [
    '/agents',
    '/runs',
    '/runs/',
    '/approvals',
    '/approvals/',
    '/tools',
    '/policies',
    '/evaluations',
    '/health',
  ];
  for (const path of called) {
    assert.ok(
      publishedEndpoints.some((endpoint) => path === endpoint || path.startsWith(endpoint)),
      `the console calls a published endpoint (saw ${path})`,
    );
  }

  const style = await call('/runtime.css');
  assert.ok(/@media\s*\(min-width:\s*60rem\)/.test(style.text), 'the layout has a relative-unit breakpoint');
  assert.ok(
    /grid-template-columns:[^;]*minmax\(0,/.test(style.text),
    'the wide layout uses minmax(0, …) columns, which cannot overflow their column',
  );
  const fixedWidths = [...style.text.matchAll(/(width|min-width|max-width|grid-template-columns)\s*:\s*([^;]+);/g)]
    .filter((match) => /[0-9]+px/.test(match[2]))
    .map((match) => match[0].trim());
  assert.deepEqual(fixedWidths, [], 'no fixed pixel width in the stylesheet');
});

// ── restart persistence ─────────────────────────────────────────────────────

test('a restarted server still lists the runs and approvals it wrote', async () => {
  const dir = tempStorageDir('agent-api-restart-');
  const first = await startServer({ port: 0, storageDir: dir, quiet: true });
  try {
    const dataset = loadDataset('invoices_dataset.json');
    const escalated = dataset.find((entry) => entry.vars.expected_action === 'request_human_approval');
    const started = await fetch(`${first.url}/api/runtime/agents/svc_03/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: escalated.vars.invoice_data }),
    });
    const run = await started.json();
    assert.equal(started.status, 201);
    assert.equal(run.status, 'WAITING_FOR_APPROVAL');

    const approved = await fetch(`${first.url}/api/runtime/approvals/${run.pendingApprovalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolvedBy: 'restart-test' }),
    });
    assert.equal(approved.status, 200);

    // ── restart: a NEW process-equivalent server on the SAME storage dir ────
    await first.close();
    const second = await startServer({ port: 0, storageDir: dir, quiet: true });
    try {
      const health = await (await fetch(`${second.url}/api/runtime/health`)).json();
      assert.equal(health.ok, true);
      assert.ok(health.storage.collections.runs.records >= 2, 'the run rows are still readable');

      const runs = await (await fetch(`${second.url}/api/runtime/runs`)).json();
      const restored = runs.runs.find((entry) => entry.runId === run.runId);
      assert.ok(restored, 'the run is still listed after the restart');
      assert.equal(restored.status, 'WAITING_FOR_APPROVAL');
      assert.equal(restored.startedAt, run.run.startedAt, 'the timestamp survived the restart');
      assert.equal(restored.startedIso, run.run.startedIso);

      const approvals = await (await fetch(`${second.url}/api/runtime/approvals?status=approved`)).json();
      const resolved = approvals.approvals.find((entry) => entry.approvalId === run.pendingApprovalId);
      assert.ok(resolved, 'the resolved approval is still listed after the restart');
      assert.equal(resolved.resolvedBy, 'restart-test');
      assert.equal(resolved.runId, run.runId);

      const detail = await (await fetch(`${second.url}/api/runtime/runs/${run.runId}`)).json();
      assert.equal(detail.run.status, 'WAITING_FOR_APPROVAL');
      assert.ok(detail.trace && detail.trace.spanCount > 0, 'the trace is still readable and traceable to the run id');
      assert.ok(detail.audit.length >= 1);

      const events = await (await fetch(`${second.url}/api/runtime/runs/${run.runId}/events`)).json();
      assert.ok(events.count >= 8, 'the event stream survived the restart');

      // And the run is still cancellable, which is what "non-terminal" means.
      const cancelled = await fetch(`${second.url}/api/runtime/runs/${run.runId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'restart-test' }),
      });
      assert.equal(cancelled.status, 200);
    } finally {
      await second.close();
    }
  } finally {
    if (first.server.listening) await first.close();
  }
});
