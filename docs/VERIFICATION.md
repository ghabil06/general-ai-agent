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

Expected totals: unit **333/333**, integration **81/81**, API **27/27**,
verify **84/84**, eval:runtime **gates passed** (oracle 12/12 per SVC agent,
naive 3/5/3), validators **3× OK**, promptfoo oracle **12/12** and naive
**9 failures**.
