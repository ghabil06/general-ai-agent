# Verification report — call 3

Acceptance-criterion-by-criterion verification of the HTTP API, the operator
console and the documentation. Every row below was executed in this environment;
the commands, the exit codes and the observed output are pasted from the runs,
not reconstructed. Where something could not be verified, it is in §4 with the
reason, and the criterion is marked **PARTIAL** rather than passed.

Environment: Windows 10.0.26200, Git Bash, Node **v22.22.0**, npm 12.0.2.
Repository: `general-ai-agent-main/`. No `OPENAI_API_KEY` and no
`ANTHROPIC_API_KEY` were present in the environment at any point, so no run in
this report made a network call to a model.

Test/verification date: 2026-09-17.

---

## 1. Gate commands

### `npm test` — exit 0

```
# tests 333
# suites 0
# pass 333
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 19025.1979
```

333 unit tests, the same count as before this call: no unit test was changed,
weakened or removed.

### `npm run test:integration` — exit 0

```
# tests 81
# pass 81
# fail 0
# cancelled 0
# skipped 0
```

81 = the 54 pre-existing integration tests + the 27 new API tests. Command:
`node --test "tests/integration/*.test.mjs"`.

### `npm run test:api` — exit 0 (new script)

```
# tests 27
# pass 27
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1576.0034
```

### `npm run verify:runtime` — exit 0

```
all 84 checks passed.
artefacts written under C:\Users\GHABIL~1\AppData\Local\Temp\verify-runtime-wZ7n7y (delete freely — it is evidence, not configuration).
```

62 checks before this call, 84 now: 22 new API checks. The new ones, verbatim
from the run:

```
  ok    the router publishes 13 routes
  ok    every GET endpoint answers 200 with JSON and an echoed requestId
  ok    no GET response contains a credential-shaped string
  ok    an unknown runtime path is a structured 404
  ok    an unknown runtime path is never answered with a static file
  ok    a wrong method is a 405 that names the method it allows
  ok    a non-runtime path is left to the caller, not handled here
  ok    a run started through the API reaches a terminal state
  ok    the kernel verdict on that run is ALLOW for a clean invoice
  ok    the API run is readable through the runtime store
  ok    the API run emitted run.finished into the persisted stream
  ok    the API run persisted no credential-shaped value
  ok    every offline script for every dataset case satisfies its own tool schema (76 scripted call(s) across 27 builds)
  ok    a run that hands the decision to a human PAUSES non-terminal
  ok    the paused run created a real pending approval
  ok    the pending approval is persisted
  ok    the pending approval is listed by the queue endpoint
  ok    approving the pending approval is accepted and recorded
  ok    the resumed run executed the gated tool with the granted approval
  ok    the executor emitted approval.resolved for the consumed approval
  ok    a paused run can be cancelled through the API
  ok    cancelling a terminal run is a 409
```

The "76 scripted call(s) across 27 builds" line is the check that keeps the
offline fixture layer honest: every scripted tool call, for all 12 cases of all
three datasets in both `model` and `planned` mode, plus one free-text input per
agent, is validated against the tool's own input schema before it is ever used.

### `npm run eval:runtime` — exit 0

```
general: oracle 2/2 expected action, 2/2 assertions clean; no naive fixture
svc_03: oracle 12/12 expected action, 12/12 assertions clean; naive 3/12 (documented 3)
svc_04: oracle 12/12 expected action, 12/12 assertions clean; naive 5/12 (documented 5)
svc_06: oracle 12/12 expected action, 12/12 assertions clean; naive 3/12 (documented 3)

JSON report: ...\data\state\evals\runtime-results.json

all runtime evaluation gates passed.
```

Unchanged expectations from call 2 (`eval:runtime` does not touch the API).

### The three dataset validators — all exit 0

```
$ node evals/validate_dataset.mjs
OK - dataset, prompt template and config are internally consistent.

$ node evals/validate_security_dataset.mjs
OK - dataset, prompt template and config are internally consistent.

$ node evals/validate_trading_dataset.mjs
OK - dataset, prompt template and config are internally consistent.
```

### One existing offline promptfoo oracle gate — passes

```
$ npx promptfoo eval -c evals/promptfooconfig.offline.yaml --no-cache --no-table \
    --filter-providers oracle -o oracle-results.json
  ✓ 12 passed (100%)
  0 failed (0%)
  0 errors (0%)
Writing output to oracle-results.json       # promptfoo exit 0

$ node evals/check_results.mjs oracle-results.json --require-all-pass
oracle-results.json: 12 results — 12 passed, 0 assertion failures, 0 provider errors
OK all 12 results passed                    # exit 0

$ npx promptfoo eval ... --filter-providers naive -o naive-results.json
                                            # promptfoo exit 100 (a broken fixture must fail)
$ node evals/check_results.mjs naive-results.json --expect-failures 9 --total 12
OK 9 assertion failures, exactly as the fixture predicts   # exit 0
```

**Caveat about the npm script wrappers.** `npm run eval:offline:oracle` does
**not** work in this environment: npm 12.0.2 on Windows hands everything after
the `;` in the script to `rm`, so it exits 0 having run only `rm` and the
checker against a stale file:

```
$ npm run eval:offline:oracle
rm: unknown option -- c
Try 'rm --help' for more information.
```

This is a pre-existing packaging/npm interaction, reproducible without any
call-3 change, and the underlying commands pass when run directly (above). It is
recorded in `docs/HANDOVER.md` §8. Nothing in call 3 depends on those wrappers.

---

## 2. Acceptance criteria

Legend: **PASS** = executed here with the observed result; **PARTIAL** = executed
but part of the criterion could not be confirmed in this environment.

| # | Criterion | How it was checked | Observed | Verdict |
| --- | --- | --- | --- | --- |
| AC-1 | Existing routes/static files unchanged, `/api/runtime/*` delegated | `curl` against a live server for every legacy route; `tests/integration/api.test.mjs` → "the legacy dashboard routes are unchanged" | `GET /` 200 · `/style.css` 200 · `/app.js` 200 · `/vendor/anime.umd.min.js` 200 · `/api/overview` 200 (`totalEvalCases` 36) · `/api/cases?agent=svc_06` 200 · `/api/prompts?agent=svc_04` 200 · `/api/audit-logs` 200 · `/nonexistent-page` 200 (index.html fallback preserved) | PASS |
| AC-2 | `/api/simulate` shape preserved, marker additive | live `curl` POST; integration test asserts the fields `app.js` reads | `HTTP 200`; `stages` 5, `decision.action` `auto_approve`, `guardrailPassed` true, `hasInjection` false, `auditRow` present, `totalDurationMs` number, **plus** `simulated: true`, `deprecated: true` (additive; `app.js` reads named fields only) | PASS |
| AC-3 | `/agents` returns id, name, boundary summary, tools, limits | `curl` + integration test | `agents: general, svc_03, svc_04, svc_06`; svc_03 `tools: query_po_database, calculate_tax_variance, request_human_approval`; `limits: {"maxToolCalls":12,"maxIterations":8,"maxTokens":60000}`; boundarySummary: "autonomous approval only at or below $500.00 with a verified PO (requireVerifiedPo=true) and a variance of exactly zero (requireZeroVariance=true); everything else is escalated to a human or rejected" | PASS |
| AC-4 | `POST /agents/{id}/runs` runs a REAL run offline and returns run id + final state | live `curl` with dataset case 1 | `HTTP 201` `{"runId":"run_358999bf-…","status":"COMPLETED","state":"COMPLETED","terminal":true,"provider":"mock","scriptedBy":"oracle-fixture:dataset-case","matchedDatasetCase":1,"decision":"auto_approve","policyDecision":"ALLOW","toolCalls":["query_po_database","calculate_tax_variance"]}`; the run row, trace and audit rows are on disk | PASS |
| AC-5 | A real provider without a credential is a structured 4xx/5xx, never a fake result | live `curl` `{"provider":"openai"}` with no key | `HTTP 503` `PROVIDER_NOT_CONFIGURED` — "provider \"openai\" is registered but not configured, so this run cannot use it. Set OPENAI_API_KEY and restart the server; this API will not substitute a mock for a live provider." | PASS |
| AC-6 | Run read endpoints: record, decision, state history, trace, ordered events; 404 unknown; 409 terminal | live `curl` + integration test | `GET /runs/{id}` 200 with `eventCount` 12, `stateTimeline` 5, `policyDecisions` 1, `toolCalls` 1, `approvals` 1, `audit` 1, `trace.spanCount` 5; `GET /runs/{id}/events` 200 ordered by `seq` (`run.started` → `run.paused`); `GET /runs/run_nope` 404 `UNKNOWN_RUN`; `POST /runs/{id}/cancel` on a terminal run → 409 `RUN_NOT_CANCELLABLE` | PASS |
| AC-7 | Approval pause/list/approve/reject; 409 not pending; 404 unknown; resolution persisted | live `curl` round trip, and the same round trip asserted in the integration test | see the transcript in §3 — pause `201 WAITING_FOR_APPROVAL`, queue `200` with the approval pending, approve `200 approved resolvedBy=live-verify`, resume `201 COMPLETED` with `request_human_approval` executed, cancel `200 CANCELLED`; approve-again `409 APPROVAL_NOT_PENDING`; `apr_nope` `404 UNKNOWN_APPROVAL` | PASS |
| AC-8 | `/tools` and `/policies` return the registry and the boundary configuration | live `curl` + integration test | tools `count` 12, `submit_paper_order` `sideEffect: "write"` `heldBy: ["svc_06"]`, `request_human_approval` `requiresConfirmation`/`escalation` true; policies `ruleCount` 11, `defaultDecision` `DENY`, `boundaries.length` 3, `withoutBoundary: ["general"]`, `realAccountNames: ["real","live","production","prod","margin"]` | PASS |
| AC-9 | `/evaluations` returns the last report or a clear "not run yet" payload | live `curl` against both storage dirs | with a report: `available: true`, `generatedAt` `2026-09-17T17:41:52.358Z`, `mode` `oracle+naive`, `agents.length` 4, `totals.oracleCorrect` 38/38, `totals.agentsFailingGate` 0; with none: `available: false`, `path`, `command: "npm run eval:runtime"`, and a note that it "will not fabricate one" | PASS |
| AC-10 | `/health` reports storage readability, provider availability, version — no key | live `curl` + integration test | `{"ok":true,"apiVersion":"1.0.0","runtime.version":"0.2.0","storage.readable":true,"checks.length":6,"providers.1.id":"openai","providers.1.available":false,"providers.1.configured":false}`; `configured` is a boolean, and the field is deliberately *not* called `credentialPresent` because `redact()` blanks any key whose words contain a secret word | PASS |
| AC-11 | Every response JSON, correct status, structured error, no secret, request id echoed | integration test `assertEnvelope()` on all 27 tests + `verify:runtime` scanning every GET endpoint | every response has `Content-Type: application/json`, a `requestId` string in the body and the same value in `X-Request-Id`; no response body matches `sk-…`/`Bearer …`/`ghp_…`/`xox…`/`AKIA…`/PEM; errors are always `{error:{code,message,details}}` | PASS |
| AC-12 | Unknown route 404 JSON (never static), 405 with `Allow`, 413 over limit | live `curl` + integration test | `GET /api/runtime/not-a-route` → `404 UNKNOWN_ROUTE` with `knownRoutes` and **not** HTML; `DELETE /api/runtime/runs` → `405 METHOD_NOT_ALLOWED`, `Allow: GET`; body > 64 KiB → `413 BODY_TOO_LARGE`; `POST` with `{not json` → `400 INVALID_JSON` | PASS |
| AC-13 | `tests/integration/api.test.mjs` starts the real server and covers every endpoint | `npm run test:api` | 27 tests, 0 failures; one server started once on port 0 with a temp storage dir, plus a second pair for the restart test | PASS |
| AC-14 | Console follows the "Information Architects" preset and is keyboard operable | source inspection + the structure test; **no browser available** | `public/runtime.css`: `font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; `a { color: #0000EE }`, `a:visited { color: #551A8B }`; `--measure: 66ch` applied to prose; no `box-shadow`, no `linear-gradient`, no `transition`/`animation`, no icon font, no remote font; navigation is `<a href="#/…">`, actions are real `<form>`+submit, long JSON is behind `<details>`, status is `aria-live="polite"`. Rendering not visually confirmed — see §4 | PARTIAL |
| AC-15 | All six views; only `/api/runtime/*`; loading/empty/error states rendered | integration test asserting the page and script contracts | the script's API calls are all under `/api/runtime` (`api('/approvals')` etc.) and it contains no reference to `/api/overview`, `/api/simulate` or `/api/cases`; the HTML has the six view links; each view renders a `loading` block first, an `empty` block when a list is empty, and an `error` block with the code, message and request id on failure | PASS |
| AC-16 | Structurally sound at ~380px and ~1600px; relative units | structure test asserting the stylesheet | `@media (min-width: 60rem)` switches `.columns` from `block` to `grid-template-columns: minmax(18rem, 1fr) minmax(0, 2fr)` (and `minmax(0, 1fr)` pairs); the test asserts **no** `width`/`min-width`/`max-width`/`grid-template-columns` declaration in the stylesheet contains a `px` value; tables and `<pre>` are wrapped in `overflow-x: auto`; `overflow-wrap: anywhere` on cells | PASS |
| AC-17 | Dashboard links to the console without disturbing layout | `curl /` and grep | exactly one `console-link` anchor added to the top bar; one additive CSS rule appended to `public/style.css`; `public/app.js` unmodified | PASS |
| AC-18 | The three docs exist, ARCHITECTURE has a Call 3 section, README points at the new surface | file inspection | `docs/GOAL.md`, `docs/HANDOVER.md`, `docs/VERIFICATION.md` created; `docs/ARCHITECTURE.md` §8 appended; `README.md` gained a "Runtime API and operator console (call 3)" section | PASS |
| AC-19 | Every existing test and gate still passes, offline, with no key | the gate commands in §1 | unit 333/333, integration 81/81, verify 84/84, eval:runtime gates passed, three validators OK, promptfoo oracle 12/12 and naive exactly 9 failures | PASS |
| AC-20 | The offline path is labelled; a fixture result is never presented as a model result | response inspection + integration test | every run response carries `providerIsMock: true`, `scriptedBy` naming the fixture, and `offlineNote` ("provider \"mock\" is a deterministic test double: the PROPOSAL came from the fixture named in `scriptedBy`, while the state machine, tool executor, policy kernel, approval gate and stores are the real runtime. This run says nothing about how a live model behaves."); the console shows `provider` and `proposal source` on every run result; `/health` marks `mock: true`, `deterministic: true` | PASS |

---

## 3. Live interaction verification

A real `node server.mjs` process (port 4317, `AGENT_STORAGE_DIR` pointing at a
scratch directory), driven with `curl`. Status codes are as returned.

```
$ curl -s -w "\nHTTP %{http_code}" http://127.0.0.1:4317/api/runtime/agents
HTTP 200  agents: general, svc_03, svc_04, svc_06
          svc_03 tools: query_po_database, calculate_tax_variance, request_human_approval
          svc_03 limits: {"maxToolCalls":12,"maxIterations":8,"maxTokens":60000}
          requestId: req_mu5tk015howe1xdp
```

### 3.1 A run that reaches a decision (dataset case 1, pasted verbatim)

```
$ curl -s -w "\nHTTP %{http_code}" -X POST .../api/runtime/agents/svc_03/runs \
    -H 'Content-Type: application/json' -d '{"input":"<invoices_dataset.json case 1>"}'
HTTP 201  {"runId":"run_358999bf-9b83-4cd6-bef5-b0ca74ede408",
           "status":"COMPLETED","state":"COMPLETED","terminal":true,
           "provider":"mock","scriptedBy":"oracle-fixture:dataset-case",
           "matchedDatasetCase":1,"decision":"auto_approve","policyDecision":"ALLOW",
           "toolCalls":["query_po_database","calculate_tax_variance"]}
```

### 3.2 A run that PAUSES for approval (free text, so the naive fixture)

```
HTTP 201  {"runId":"run_77df723f-73b9-4602-b454-2ec33e5931c1",
           "status":"WAITING_FOR_APPROVAL","state":"WAITING_FOR_APPROVAL","terminal":false,
           "paused":true,"pendingApprovalId":"apr_14bec325-4be5-4cbd-aa85-daa02d624a46",
           "scriptedBy":"naive-fixture:free-text+escalation-tool","matchedDatasetCase":null,
           "toolCalls":["request_human_approval"],
           "notes":["input matched no case in ...\evals\invoices_dataset.json, so the naive fixture was replayed"]}
```

### 3.3 List pending approvals

```
$ curl -s -w "\nHTTP %{http_code}" '.../api/runtime/approvals?status=pending'
HTTP 200  {"count":2,"pendingCount":2,"total":2,
           "countsByStatus":{"pending":2,"approved":0,"rejected":0,"expired":0,"cancelled":0},
           "approvals.0.approvalId":"apr_14bec325-…","approvals.0.toolName":"request_human_approval",
           "approvals.0.status":"pending","approvals.0.agentId":"svc_03"}
```

### 3.4 Approve it, then try to approve it again

```
$ curl -s -w "\nHTTP %{http_code}" -X POST .../api/runtime/approvals/apr_14bec325-.../approve \
    -H 'Content-Type: application/json' -d '{"resolvedBy":"live-verify","note":"reviewed by hand"}'
HTTP 200  {"resolved":true,"runId":"run_77df723f-…","approval.status":"approved",
           "approval.resolvedBy":"live-verify","approval.resolutionNote":"reviewed by hand",
           "approval.resolvedIso":"2026-09-17T17:45:02.094Z"}

$ (same call again)
HTTP 409  APPROVAL_NOT_PENDING: APPROVAL_ILLEGAL_TRANSITION: approval "apr_14bec325-…" is approved and cannot become approved

$ curl -s -X POST .../api/runtime/approvals/apr_nope/reject -d '{}'
HTTP 404  UNKNOWN_APPROVAL: no approval "apr_nope"
```

### 3.5 Resume the gated call with the approval id

```
HTTP 201  {"runId":"run_fa0af3c8-574f-4a36-a6cf-81710cf0e570","status":"COMPLETED",
           "state":"COMPLETED","terminal":true,
           "resumedWithApprovalId":"apr_14bec325-…","toolCalls":["request_human_approval"],
           "pendingApprovalId":"apr_26adbaa5-7da4-495f-bffb-a08176682850"}

# the executor emitted approval.resolved for the consumed approval:
evals/… statuses: run.started, state.changed, model.called, tool.proposed, policy.decided,
                  approval.requested, approval.resolved, tool.executed, …, run.finished
```

The new `pendingApprovalId` on the resumed run is the call-1 escalation tool's own
queue entry — approving the gated call let the tool run, and that tool records its
own request. Documented in `docs/HANDOVER.md` §10 item 6.

### 3.6 Cancel a paused run, then cancel it again

```
$ curl -s -w "\nHTTP %{http_code}" -X POST .../api/runtime/runs/run_77df723f-.../cancel \
    -H 'Content-Type: application/json' -d '{"reason":"no longer needed in the live check"}'
HTTP 200  {"cancelled":true,"state":"CANCELLED","transitionedFrom":"WAITING_FOR_APPROVAL",
           "run.status":"CANCELLED"}

$ (same call again)
HTTP 409  RUN_NOT_CANCELLABLE: run "run_77df723f-…" is CANCELLED and cannot be cancelled
```

### 3.7 Error paths

| Request | Status | Code and message |
| --- | --- | --- |
| `GET /api/runtime/runs/run_nope` | `404` | `UNKNOWN_RUN: no run "run_nope" has been persisted` |
| `POST /api/runtime/agents/svc_99/runs` | `404` | `UNKNOWN_AGENT: unknown agent "svc_99" (known: general, svc_03, svc_04, svc_06)` |
| `GET /api/runtime/not-a-route` | `404` | `UNKNOWN_ROUTE: no runtime route matches GET /api/runtime/not-a-route` (JSON, not HTML) |
| `DELETE /api/runtime/runs` | `405` | `METHOD_NOT_ALLOWED: DELETE is not allowed on /api/runtime/runs` (`Allow: GET`) |
| `POST …/runs` body `{not json` | `400` | `INVALID_JSON: the request body is not valid JSON: Expected property name or '}' …` |
| `POST …/runs` body `{}` | `400` | `INVALID_REQUEST: \`input\` is required and must be a non-empty string …` |
| `POST …/runs` `{"provider":"openai"}` | `503` | `PROVIDER_NOT_CONFIGURED: provider "openai" is registered but not configured … Set OPENAI_API_KEY` |
| `POST …/runs` `{"provider":"gemini"}` | `400` | `UNKNOWN_PROVIDER: unknown provider "gemini" (known: mock, openai, anthropic, local)` |

### 3.8 Restart persistence (a real process kill, not a re-import)

State before the restart, then the process was killed and a new one started
against the same storage directory.

```
$ curl -s '.../api/runtime/runs?limit=20'      # before
runs listed: 4
   run_fa0af3c8-… svc_03 COMPLETED            2026-09-17T17:45:09.034Z tools=request_human_approval
   run_77df723f-… svc_03 CANCELLED            2026-09-17T17:44:39.691Z tools=request_human_approval
   run_c8a13d6d-… svc_03 WAITING_FOR_APPROVAL 2026-09-17T17:44:23.502Z tools=query_po_database+request_human_approval
   run_358999bf-… svc_03 COMPLETED            2026-09-17T17:44:17.779Z tools=query_po_database+calculate_tax_variance

approvals listed: 3  counts {"pending":2,"approved":1,"rejected":0,"expired":0,"cancelled":0}

$ netstat -ano | awk '/:4317/ && /LISTENING/ {print $NF}'
4148
$ taskkill //PID 4148 //F
SUCCESS: The process with PID 4148 has been terminated.
$ curl -s -m 3 http://127.0.0.1:4317/api/runtime/health      # refused, as expected
after kill, health http=000

$ PORT=4317 AGENT_STORAGE_DIR='…\Temp\live-verify' node server.mjs    # new process
$ curl -s '.../api/runtime/runs?limit=20'      # after
HTTP 200  {"count":4,"total":4,"storageDir":"C:\\Users\\GHABIL~1\\AppData\\Local\\Temp\\live-verify"}
runs listed: 4
   run_fa0af3c8-… COMPLETED            2026-09-17T17:45:09.034Z duration=62ms traceRoot=run:svc_03
   run_77df723f-… CANCELLED            2026-09-17T17:44:39.691Z duration=23ms traceRoot=run:svc_03
   run_c8a13d6d-… WAITING_FOR_APPROVAL 2026-09-17T17:44:23.502Z duration=87ms traceRoot=run:svc_03
   run_358999bf-… COMPLETED            2026-09-17T17:44:17.779Z duration=95ms traceRoot=run:svc_03
```

The timestamps are identical to the pre-restart values, and each run is still
reachable by id from the new process:

```
$ curl -s '.../api/runtime/runs/run_c8a13d6d-…'                # written by the OLD process
HTTP 200  {"run.status":"WAITING_FOR_APPROVAL","run.startedIso":"2026-09-17T17:44:23.502Z",
           "run.terminal":false,"eventCount":20,"trace.spanCount":9,"audit.length":1,
           "pendingApprovalId":"apr_ea245e9b-…"}

$ curl -s '.../api/runtime/runs/run_c8a13d6d-…/events'
HTTP 200  {"count":20,"events.0.type":"run.started","events.2.type":"state.changed","events.11.type":"state.changed"}

$ curl -s '.../api/runtime/approvals?status=all'
total 3   counts {"pending":2,"approved":1,"rejected":0,"expired":0,"cancelled":0}
   apr_26adbaa5-… pending  run_fa0af3c8-… 2026-09-17T17:45:09.074Z resolvedBy=-        resolvedIso=-
   apr_14bec325-… approved run_77df723f-… 2026-09-17T17:44:39.707Z resolvedBy=live-verify resolvedIso=2026-09-17T17:45:02.094Z
   apr_ea245e9b-… pending  run_c8a13d6d-… 2026-09-17T17:44:23.575Z resolvedBy=-        resolvedIso=-

$ curl -s -X POST '.../api/runtime/runs/run_c8a13d6d-…/cancel' -d '{"reason":"cancelled after restart"}'
HTTP 200  {"cancelled":true,"state":"CANCELLED","transitionedFrom":"WAITING_FOR_APPROVAL"}
```

So a run that paused in one process is still `WAITING_FOR_APPROVAL`,
still cancellable and still traceable to its own event stream and trace in the
next one. Storage files written during the check:

```
approvals/approvals.jsonl   audit/audit.jsonl   runs/run-events.jsonl
runs/runs.jsonl             traces/traces.jsonl
```

### 3.9 Console delivery

```
$ curl -s -o /dev/null -w "GET /console HTTP %{http_code} (%{size_download} bytes)\n" http://127.0.0.1:4317/console
GET /console HTTP 200 (2555 bytes)
GET /runtime.css HTTP 200
GET /runtime.js  HTTP 200

# the served page is byte-identical to the file on disk
runtime.html fetch via /console byte-identical to public/runtime.html: yes
placeholder scan (TODO|FIXME|Lorem ipsum|PLACEHOLDER): none
remote asset scan (https?://): none
console-link occurrences in the served index.html: 1
```

Every `/api/runtime` path the console calls is exercised for real by the
integration tests (§2 AC-15); the console's own request shape is the same one
those tests use.

---

## 4. Not verified, or verified only in part

Recorded plainly rather than omitted.

1. **No visual browser verification of the console (AC-14 PARTIAL).** No browser
   backend was available to this agent in this environment: the browser registry
   reported `[]`, and `getForUrl`, `getDefault` and `get("iab")` each failed with
   `Browser backend '__no_browser_backend__' is unavailable`. Consequences:
   - the console's **rendering** was never observed by a person or a browser in
     this call;
   - the start-a-run form, the approve/reject buttons and the re-render after an
     action were never click-tested.

   What *was* done instead: the page and script are fetched over HTTP and
   asserted (`/console` 200 byte-identical to disk), `node --check
   public/runtime.js` passes, and the new test asserts that every `href`
   resolves, that the script calls only published endpoints, that the
   stylesheet has a relative-unit breakpoint with `minmax(0, …)` columns and no
   fixed pixel width, and that there is no placeholder text or remote asset.
   The API calls those interactions perform are covered end to end by the
   integration tests. **A human should still open `/console` once.**

2. **No live-model run (AC-5 is about the refusal path only).** No API key was
   present, so no request reached a real provider. Verified: the structured `503`
   for an unconfigured provider, `provider: "mock"` runs, and `/health` reporting
   `available: false` / `configured: false`. Unverified: whether a live model
   answer parses into a disposition, what it costs, and how the console renders a
   live run. The first live run is a smoke test the operator must run.

3. **The promptfoo gate wrappers do not work under this npm version on Windows**
   (§1). The underlying commands were run directly and pass. `npm run gate` and
   `npm run gate:all` therefore cannot be reported as green here; the runtime
   half (`gate:runtime`) and the individual promptfoo commands were verified.

4. **`npm run eval:runtime` writes into `data/state/`.** The report it produced
   is real and was used as evidence for AC-9, but it is a local artefact (the
   directory is git-ignored), so a fresh clone will show
   `evaluations.available: false` until the gate is run.

5. **`/api/runtime/evaluations` was read from two different storage dirs**
   (`available: false` for the scratch dir, `available: true` for the repo's
   `data/state`). Both are real; neither was exercised with a *corrupt* report
   file (the unreadable branch is covered by code inspection only, not by a run).

6. **Concurrency was not stress-tested.** Runs are serialised through one queue
   by design, and the queue is exercised by the sequential tests, but no test
   starts two runs concurrently and asserts the queue's behaviour under load.

7. **The approval expiry path was not exercised through the API.**
   `AGENT_APPROVAL_TTL_MS` defaults to 24 hours; the expiry branch (`409` for an
   expired approval) is covered by the pre-existing unit tests of the approval
   manager, not by an API test.

8. **Case 7 of the SVC_04 dataset reaches a decision that the kernel refuses.**
   Reported because it looks like a failure and is not: the case is a
   prompt-injection case with `expected_action: create_incident`, and the run
   reaches `create_incident` while `untrusted.prompt_injection` returns `DENY`
   for the proposed *action* — the rule's documented behaviour is that an
   injected payload must not steer the agent into acting, while the escalation
   *tool* stays callable. The API reports both facts; the console shows the
   DENY with its reason.

---

## 5. Reproducing this report

```bash
# 1. the gates
npm test && npm run test:integration && npm run test:api
npm run verify:runtime && npm run eval:runtime
node evals/validate_dataset.mjs
node evals/validate_security_dataset.mjs
node evals/validate_trading_dataset.mjs

# 2. the promptfoo gates, run directly (see §1 caveat)
rm -f oracle-results.json
npx promptfoo eval -c evals/promptfooconfig.offline.yaml --no-cache --no-table \
  --filter-providers oracle -o oracle-results.json
node evals/check_results.mjs oracle-results.json --require-all-pass

# 3. the live walkthrough in §3
AGENT_STORAGE_DIR=/tmp/agent-verify PORT=4317 node server.mjs   # leave running
# then run the curl calls above; kill the process and restart it for §3.8
```

Expected totals **at the end of call 3**: unit **333/333**, integration **81/81**,
API **27/27**, verify **84/84**, eval:runtime **gates passed** (oracle 12/12 per SVC
agent, naive 3/5/3), validators **3× OK**, promptfoo oracle **12/12** and naive
**9 failures**. *Call 4 added tests and checks to these gates; the current totals are in §6.2.*

---

## 6. Call 4 addendum — the bounded tool-calling state machine (General AI Agents)

Verification of `docs/GOAL.md` AC-B1…AC-B14. As in the rest of this report, the
numbers below were produced by running the commands in this environment; where
something was not run, §6.5 says so and why.

### 6.1 Environment

Linux sandbox, Node **v22.22.3**, npm **10.9.8**, 2026-10-11. No `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY` at any point, so **no run in this section made a network call to a
model**. `node_modules` is not installed and `npm ci` was not run: the unit,
integration, verify and eval gates need no dependency. The three dataset validators need
`js-yaml`; it was installed into `/tmp` alone and supplied through `NODE_PATH`, so the
repository was not touched.

### 6.2 Gate results — before (`edaebc6`) and after

| Gate | Before | After |
| --- | --- | --- |
| `npm test` | 333 tests, 332 pass, **1 fail** (pre-existing, below) | **388** tests, 387 pass, **1 fail** (the same one; fixed later in batch B1, §7) |
| `npm run test:integration` | 82 tests, 81 pass, 1 skip ¹ | **114** tests, 114 pass, 0 skip |
| `npm run test:api` | 27 | 27 (unchanged) |
| `npm run test:bounded` | — | **88** pass |
| `npm run verify:runtime` | 84 checks | **103** checks |
| `npm run eval:runtime` | gates passed; oracle 12/12 ×3, naive 3/12 · 5/12 · 3/12, general 2/2 | **identical** |
| `evals/validate_{dataset,security_dataset,trading_dataset}.mjs` | not run (needs `js-yaml`) | OK ×3 (exit 0) |
| `n8n_exports` lint / parse test / replay dry-run | not run | exit 0 ×3 |
| promptfoo offline gates (`npm run gate`) | not run | **not run** — see §6.5 |

¹ The baseline "skip" was a `test.skip()` called *inside* `api.test.mjs`, which creates a
nested skipped subtest that counts as a test; it is created only when no eval report is on
disk. After `eval:runtime` ran the report existed and the subtest was not created. The four
pre-existing integration files still sum to the same 81 tests, and 33 are new.

**The pre-existing failure** is `tests/unit/prompts-render.test.mjs` "a path outside prompts/
is refused": it feeds the Windows path `C:/Windows/System32/drivers/etc/hosts`, expecting
`PROMPT_PATH_ESCAPE`; on POSIX that string is not absolute, so it resolves *inside*
`prompts/` and yields `PROMPT_NOT_FOUND`. That input resolved to a (missing) file inside
`prompts/`, so nothing outside it was read — but the verdict depended on the host OS. It
failed identically before any change in call 4 and was left alone then. **Batch B1 fixed
it (§7)** by making `resolveTemplate()` refuse Windows-rooted paths on every host; the
test itself was not edited.

**No existing test was edited:** `git diff edaebc6 --name-status -- tests` shows only
**added** files (`tests/helpers/bounded.mjs`, four unit files, two integration files).
Nothing under `evals/`, `prompts/`, `n8n_exports/`, `data/` or `promptfooconfig*.yaml`
changed.

### 6.3 Acceptance criteria

Test names are those in the files named; `verify` rows are lines printed by
`npm run verify:runtime` (§13 of the script).

| # | Evidence | Result |
| --- | --- | --- |
| AC-B1 | `bounded-agent.test.mjs`: *an invalid request throws a typed error and creates NOTHING* — 19 refused requests, `runs`/`events`/`audit` row counts identical before and after; *execute() throws ONLY BoundedAgentError* (a Symbol agent id, a hostile getter, an unrenderable prompt of record → typed, `0` runs, `0` events); *PERSISTENCE_FAILED* names the run. verify: "…each refused with a typed error, and create no run" | PASS |
| AC-B2 | *execution … is gated by the executor: every executed tool was ALLOWed first* (event-order check on the persisted stream); verify: "every executed tool had an earlier ALLOW verdict from the policy kernel in the same run" | PASS |
| AC-B3 | *planned (auto)* strategy reason "flexible task"; *planned with caller-supplied steps is deterministic* (**1** model call, no plan call); *direct*; *auto chooses direct for an agent that holds no tools*; *the same task against the same script follows the same path* (identical `stateHistory`, tools, usage, envelope); *deterministic replans* (**1** model call with a failed step) | PASS |
| AC-B4 | *a plan that names a tool outside the allowlist is refused before anything runs* (`PLAN_TOOL_NOT_PERMITTED`, `toolCalls: []`); *a plan step cap and a replan cap* (`maxReplans: 2` → exactly 2 replanning model calls, plan of 3 steps); `planner-proposal-parse`: *leniency in PARSING does not widen what the agent may do*. verify: "a plan naming a tool outside the allowlist is refused before any tool is asked to run" | PASS |
| AC-B5 | `envelope.test.mjs` (13): precedence, a default is not a ceiling, `Infinity`/`NaN`, ceilings above every default and shipped profile; `runtime-bounds`: *configuration cannot raise a run past the hard ceilings* (`AGENT_MAX_ITERATIONS=1000000000`), *planner ceilings are clamped*; `bounded-agent`: *a request cannot raise a limit past the profile … nor past a hard ceiling*; `api-bounds`: planner ceiling above its ceiling → **400** (it was 201). | PASS |
| AC-B6 | `runtime-bounds`: *a model call that outlives the remaining wall-clock is cut off* (budget 150 ms, call 1 500 ms), *a provider that never resolves cannot hang the run, and its request is aborted* (`signal.aborted === true`), *a tool call is never given longer than the remaining wall-clock*. verify: "a provider that never answers cannot hang a run: stopped by the wall-clock deadline in **152ms** (budget 150ms)" | PASS |
| AC-B7 | `state-machine-fuel.test.mjs` (8): `FAILED` and `CANCELLED` reachable from every non-terminal state; **500 seeded adversarial walks** over the table, longest = fuel + 1 exactly; the same walk without fuel does not end; `runtime-bounds`/`bounded-agent`: `TRANSITION_LIMIT`, persisted; `envelope.test`: the fuel formula checked against the real loops (worst measured **4.3** transitions per iteration, ≥ 46 of 80 to spare). verify: "spent transition fuel stops the run (TRANSITION_LIMIT), never mid-air" | PASS |
| AC-B8 | *a model that asks for a fresh tool call forever (direct)*: the model was called **exactly 8** times (= `maxIterations`); *a completion carrying thousands of schema-invalid tool calls* → **13** recorded attempts (it was 10 000). verify: "8 calls = maxIterations 8", "cut off at 13 recorded attempts (maxToolCalls 12)" | PASS |
| AC-B9 | `runtime-bounds`: cancel during a model call, a tool-calling turn, an in-flight **tool** call (the call is recorded, the next call in the turn never starts), before the loop starts, and at **each of the five** planned-loop await sites (plan proposal, tool step, free-form step, synthesis, replan) — every one resolves `CANCELLATION_REQUESTED`, ends `CANCELLED`, is closable and persisted; `api-bounds`: **`POST /runs/:id/cancel` on a live run** → `201`, `CANCELLED`, persisted (it used to throw and vanish). verify: "(42ms of a 1500ms call)" | PASS |
| AC-B10 | `assertRecorded()` on the happy, blocked, budget, deadline, abort, fuel and fault paths (run row + trace + `run.started` + audit row, read back from disk); approval: *PAUSES the run, persisted and non-terminal; a granted approval resumes it; a different call does not*; *a rejected approval does not resume anything*; *a restarted runtime still reads the run*. verify: "a gated call pauses the bounded run: persisted, non-terminal, nothing executed" | PASS |
| AC-B11 | *the SVC_03 $500.00 boundary still decides, through the bounded agent*: dataset case `boundary_exact` ($500.00, verified PO, variance 0) → `ALLOW`; `boundary_over` ($500.01) → `DENY` by `svc_03.invoice_boundary`, reason names 500; **no structured facts → `DENY`** | PASS |
| AC-B12 | every mock result carries `provider.mock === true` and a `notice`; *a provider that is not configured is refused, never silently replaced by the mock* (message: "will not substitute a mock"). verify: "the result says the provider was a test double" | PASS |
| AC-B13 | §6.2: counts only grew; `eval:runtime` identical; no existing test edited; nothing under `evals/`, `prompts/`, `n8n_exports/` changed | PASS |
| AC-B14 | `docs/ARCHITECTURE.md` §9, `docs/HANDOVER.md`, `docs/GOAL.md`, this section, `README.md` | PASS |

### 6.4 The defects, before and after

Each probe below was run against `edaebc6` **before any change**, then re-run (same script)
after the fix. The regression tests that replaced the probes were written first and were
run against the unfixed runtime: **19 of the first 23 failed**, and failed for the reasons
below (e.g. `'maxIterations=1: 2 iterations were recorded'`).

| Probe | Before (`edaebc6`) | After |
| --- | --- | --- |
| planned loop, always-failing step + replans | `maxIterations` 1/3/5 → **2/4/6** iterations recorded | **1/3/5**; 0 model calls at 1 |
| cancel during an in-flight model call | `loop` **rejected**: `StateTransitionError: CANCELLED -> OBSERVING`; no run row, no trace | `loop` resolves `CANCELLATION_REQUESTED`, state `CANCELLED` |
| 1 500 ms model call, 200 ms wall-clock, real clock | returned after **1 506 ms**, completed normally | returned after **199 ms**, `WALL_CLOCK_TIMEOUT` |
| a provider that never resolves, 200 ms wall-clock | **still hung after 3 000 ms** | `loop` returned, `WALL_CLOCK_TIMEOUT` |
| free-form plan step, two tool calls | `MODEL_ERROR: OBSERVING -> OBSERVING`, FAILED, after both tools ran | COMPLETED, both tools |
| plan wrapped in a fence / a sentence (5 shapes) | 3 of 5 **not parsed** | 5 of 5 |
| `maxToolCalls = N`, runaway model | executed **N − 1** (N=1 → 0) | executed **N** |
| one completion of 5 000 invalid tool calls | **10 000** attempts, budget 0, 1 346 ms | **13** attempts, 51 ms |
| API `planning.maxSteps = 1 000 000 000` | HTTP **201** | HTTP **400** |
| planner `maxSteps: NaN`, 40-step plan | accepted | (via `createAgentRun`) refused: `EnvelopeError INVALID_LIMIT` |

### 6.5 What was not verified

1. **No live model.** Nothing here shows how any real model behaves. The adversarial
   providers (runaway, never-answers, corrupt, flood) are test doubles; they show the
   *runtime* stops. The tolerant plan parsing is verified against fixed strings, not real
   model output.
2. **The promptfoo offline gates were not run** (`npm run gate`, `eval:offline*`): they need
   `npm ci` and the `promptfoo` package. They are structurally independent of this change
   (nothing under `evals/`, `prompts/`, `n8n_exports/` or the configs imports `src/`, and
   none of those paths changed), but "independent by inspection" is not "ran green".
3. **The operator console was not opened in a browser** (unchanged from call 3; no browser
   here). `public/runtime.js` renders `stopReason.code` generically, so the new codes
   (`TRANSITION_LIMIT`, `INTERNAL_ERROR`, `INPUT_REJECTED`) need no console change — checked by
   reading, not by rendering.
4. **No concurrency stress on the runtime itself.** The new timing-sensitive files (59 tests)
   were run 8× sequentially earlier, and on the final tree 6× in parallel under CPU
   contention and once under `--unhandled-rejections=strict` (so an abandoned provider promise
   that rejected late would fail the run) — all green. That is evidence against flakiness,
   not proof.
5. **Pre-existing, found and reported, not changed:** a granted approval is bound to the tool
   and arguments but is **not single-use** (replaying it re-executes the call until it
   expires); `maxStepAttempts` is inert; `general_assistance` has no route-table entry.
   `docs/ARCHITECTURE.md` §9.8.

### 6.6 Reproducing this section

```bash
npm test && npm run test:integration && npm run test:bounded
npm run verify:runtime && npm run eval:runtime

# the dataset validators, with js-yaml supplied from /tmp (the repo stays untouched)
mkdir -p /tmp/yamldeps && (cd /tmp/yamldeps && npm install js-yaml --silent)
NODE_PATH=/tmp/yamldeps/node_modules node evals/validate_dataset.mjs
NODE_PATH=/tmp/yamldeps/node_modules node evals/validate_security_dataset.mjs
NODE_PATH=/tmp/yamldeps/node_modules node evals/validate_trading_dataset.mjs
```

Expected totals after batch B1 (call 4 ended at unit **388** with the one POSIX failure that
B1 fixed): unit **398**, integration **114**, API **27**, bounded **88**, verify **103**,
eval:runtime **gates passed** (oracle 12/12 per SVC agent, naive 3/5/3, general 2/2),
validators **3× OK**.

## 7. Batch B1 addendum — Windows-rooted prompt template paths

Scope: one behaviour. A Windows-rooted template path (`C:/x`, `C:\x`, `\\server\share`,
`\x`) is refused with `PROMPT_PATH_ESCAPE` on **every** host. As in §6, every number below
was produced by running the command in this environment: Linux, Node **v22.22.3**,
2026-10-11, no model call, no dependency installed.

### 7.1 What changed

- `src/prompts/render.mjs` — a guard in `resolveTemplate()`:
  `!path.isAbsolute(p) && path.win32.isAbsolute(p)` → `PROMPT_PATH_ESCAPE`, before the path
  is resolved or any file is read (+15/−1 lines; 7 of the added lines and the one removed
  line are comments). The containment check, `PROMPT_ERROR_CODES` and every other behaviour are unchanged. By Node's design
  `path.isAbsolute` already is `path.win32.isAbsolute` on Windows, so the guard cannot
  fire there.
- `tests/unit/prompts-path-containment.test.mjs` — new, 10 tests (below).
- `README.md`, `docs/ARCHITECTURE.md` §7.4 / §9.8, `docs/HANDOVER.md` §8 / §10, this section.
- `tests/unit/prompts-render.test.mjs` is **byte-identical** (blob `8eafb17…`, the same as on
  `edaebc6` and `main`).

### 7.2 The new tests fail without the fix and pass with it

Against the original `render.mjs`: **5 of 10 fail**, each for the right reason — a
Windows-rooted input gives `PROMPT_NOT_FOUND`, and the file reader **ran** for
`C:/Windows/…`. They are: drive-rooted, UNC / backslash-rooted, every public entry point,
the `runtime.renderPrompt()` facade, and "the reader runs for allowed paths only". The other 5
(POSIX-absolute outside, relative traversal, sibling-prefix, valid inside incl. absolute-inside,
invalid types and empty paths) pass both before and after: they pin containment that already
held, so a wrong fix cannot weaken it unnoticed. With the guard: **10 / 10**; run from `/`,
`/tmp` and the repo root, 3× each, all green, no temp directory left behind.

Mutations, each applied to a scratch copy of the final tree and run against the new file plus
`prompts-render.test.mjs` (23 tests):

| Mutation | Result | Caught by |
| --- | --- | --- |
| M1 guard refuses *every* absolute path | 2 fail | new tests only (valid-inside, reader proof) |
| M2 containment check switched off | 8 fail | 7 new + the existing escape test |
| M3 containment by string prefix (`startsWith(promptsDir)`) | 5 fail | new tests only — the existing file does not catch it |
| M4 guard reports `PROMPT_NOT_FOUND` | 5 fail | 4 new + the existing escape test |
| M5 guard throws a plain `Error` | 6 fail | 5 new + the existing escape test |
| M6 guard removed (= the original) | 6 fail | 5 new + the existing escape test |
| M7 the same guard spelled as a POSIX-only check | 0 fail | control: the tests are not tied to one spelling |

### 7.3 Gate results

| Gate | Before (pristine export of `2117f3d`) | After |
| --- | --- | --- |
| `node --test tests/unit/prompts-render.test.mjs` | exit 1 — 13 tests, 12 pass, **1 fail** | exit 0 — 13 / 13 |
| `node --test tests/unit/prompts-path-containment.test.mjs` | — (new) | exit 0 — **10** / 10 |
| `npm test` | exit 1 — 388 tests, 387 pass, **1 fail** | exit 0 — **398** tests, 398 pass, 0 fail, 0 skip |
| `npm run test:integration` | 115 tests, 114 pass, 1 skip ¹ | 114 / 114, 0 skip (report on disk); 115 / 114 / 1 skip in a pristine layout ¹ |
| `npm run test:api` | 28 tests, 27 pass, 1 skip ¹ | 27 / 27 (report on disk); 28 / 27 / 1 skip in a pristine layout ¹ |
| `npm run test:bounded` | 88 pass | 88 pass |
| `npm run verify:runtime` | 103 checks | 103 checks |
| `npm run eval:runtime` | gates passed | gates passed; report unchanged (§7.4) |

¹ The nested skip is the one explained under §6.2: it exists only while no eval report is on
disk. "Pristine layout" is the final tree exported without the ignored `data/state/evals/`,
which reproduces the *before* numbers exactly, so the integration and API suites are
unchanged by this batch.

### 7.4 The eval report is unchanged

Four reports were compared field by field: before and after, each in a pristine export and in
the repository. Dropped before comparing: `generatedAt`, `startedAt`, `finishedAt`,
`durationMs`, `maxLatencyMs`, `latencyMs`, `storageDir`, `datasetPath` and `planId`. Rewritten
inside 228 strings: temp and home paths, `pln_…` ids and `NNms` text. Everything else — 5943
values (158 null, 3655 boolean, 2130 number) and every string — is **identical in all four**,
and a planted edit to one case verdict and one gate count was detected, so the comparison is
not vacuous. Oracle 12/12 ×3 and 2/2; naive 3/12 · 5/12 · 3/12. The evaluation never passes a
template path, so "no change" was the expectation, not a finding.

### 7.5 What was not verified

1. **No Windows host.** 40 inputs from the new tests' lists were also run through the module's
   real text with `path.win32` swapped in (scratch, in-memory files): every one gave the
   verdict the tests expect. That is an emulation of the path logic, **not a Windows test
   run**; the new tests have never been run on Windows.
2. **The dataset validators and the promptfoo gates were not run.** They need `npm ci`
   (`js-yaml`, `promptfoo`) and nothing was installed. Nothing under `evals/`, `prompts/`,
   `n8n_exports/` or the configs changed.
3. **Not covered by the tests, on purpose:** symlinks, percent-encoded names, backslash
   traversal (`..\x` is an ordinary file name on POSIX, so its verdict is host-dependent and
   is not asserted), and non-string inputs whose message cannot be serialised. The follow-ups
   are listed in `docs/HANDOVER.md` §10 item 15.

### 7.6 Reproducing this section

```bash
node --test tests/unit/prompts-render.test.mjs tests/unit/prompts-path-containment.test.mjs  # 23 tests
npm test && npm run test:integration && npm run test:api && npm run test:bounded
npm run verify:runtime && npm run eval:runtime
```

To watch the new tests fail, change the guard's condition to `false` in a scratch copy: 5 of
the 10 fail (M6 above).
