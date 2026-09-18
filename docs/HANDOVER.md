# Handover

Everything a person needs to run, operate and extend this repository after
call 3. Written to be read in order; every command is one you can paste.

Requirement statement and scope: [`GOAL.md`](GOAL.md).
Criterion-by-criterion verification: [`VERIFICATION.md`](VERIFICATION.md).
Architecture and history: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | **>= 20** (developed and verified on **v22.22.0**) | `node --test`, ESM, `fetch`, `AbortSignal` |
| npm | any that can run the scripts | `npm ci` installs `promptfoo` and `js-yaml` |
| API key | **none** | the whole offline path — server, console, runs, approvals, every runtime gate — needs no key and makes no network call |

```bash
npm ci          # installs devDependencies from the committed lockfile
node --version  # expect v20 or newer; v22.22.0 is what this was verified on
```

`npm ci` needs `package-lock.json`, which is committed on purpose (CI runs
`npm ci`). Nothing in `src/`, `server.mjs` or `public/runtime.*` needs a package
that is not already there.

---

## 2. Start the server

```bash
node server.mjs          # or: npm start
```

```
🌐 Dashboard running at: http://localhost:4317
🧭 Operator console at:  http://localhost:4317/console
🔌 Runtime API at:       http://localhost:4317/api/runtime/health
```

| URL | What it is |
| --- | --- |
| `/` | The **existing** dashboard. Unchanged: the anime.js UI, `/api/simulate`, the gate runner. |
| `/console` | The **operator console** (call 3). Same as `/runtime.html`. |
| `/api/runtime/health` | The API's own health payload; a good first request. |
| `/api/runtime/*` | The runtime API (see §4). |

Configuration is environment-only:

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | listen port |
| `AGENT_STORAGE_DIR` | `<repo>/data/state` | where runs, approvals, events, traces, audit and memory are written |
| `AGENT_DEFAULT_PROVIDER` | `mock` | the provider a run uses when the request does not name one |
| `AGENT_ECHO_EVENTS` | `false` | also print events to stdout |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `LOCAL_MODEL_BASE_URL` | unset | presence makes that provider *available*; nothing else |
| `AGENT_MAX_*`, `AGENT_TOOL_TIMEOUT_MS`, `AGENT_APPROVAL_TTL_MS` | see `src/config/index.mjs` | budget ceilings and timeouts |

**Policy boundaries are not configuration.** `src/config/index.mjs` exposes
`BOUNDARIES` for inspection only. There is no environment variable, no request
field and no option that widens an SVC ceiling; widening one is a commit to
`src/config/agents.mjs`.

To run against a scratch storage directory (recommended when experimenting):

```bash
AGENT_STORAGE_DIR=/tmp/agent-scratch PORT=4317 node server.mjs
```

---

## 3. The console

`/console` is served by the same server. It is one HTML file, one stylesheet and
one script, with no framework, no build step, no webfont and no CDN.

**Views** (each is a hash link, so the browser's back button and bookmarks work):

| View | What it reads | What it shows |
| --- | --- | --- |
| `#/agents` | `GET /agents` | every profile: boundary summary built from the frozen `BOUNDARIES`, tools with risk and confirmation, limits, permissions, suites — and the **start-a-run form** |
| `#/runs` | `GET /runs`, `GET /runs/{id}` | the run list (newest first, filterable by agent) and, beside it, the selected run: status, decision, state timeline, policy verdicts, tool calls, approvals, audit rows, trace spans, raw events |
| `#/approvals` | `GET /approvals?status=pending`, `?status=all` | the pending queue with approve/reject and the proposal each approval is bound to, then the resolution history |
| `#/tools` | `GET /tools` | the registry, with each tool's declaration and holders |
| `#/policies` | `GET /policies` | the decision model, the three boundaries, and the rule inventory in evaluation order |
| `#/evaluations` | `GET /evaluations` | the last `npm run eval:runtime` report: gate verdict per agent, oracle/naive counts, suite coverage |

**Keyboard only:** navigation is a list of links, every action is a real `<form>`
with a submit button, long JSON is behind native `<details>` (Enter/Space to
expand), and the status line is an `aria-live` region that reports the request
id of the last call. Tab order follows the visible order; there is a
"Skip to the console content" link first.

**Starting a run from the console.** Pick a profile, paste a payload, submit.

- Paste a payload **verbatim from a dataset case** and the offline double replays
  the reference (oracle) fixture for that case.
- Paste **anything else** and it replays the naive keyword fixture — which is how
  you make the boundary rules visibly refuse something.
- Either way the run itself is real: state machine, tool executor, policy
  kernel, approval gate, stores, trace, audit.
- A disposition that hands the decision to a human is proposed as the agent's
  **escalation tool call**, so the run pauses on a real approval instead of
  merely printing a disposition.
- `Planning: planned` switches to the plan→step→observe→validate loop, with the
  steps derived from the case text the same way the evaluation harness derives
  them.

---

## 4. The runtime API

Base path `/api/runtime`. All JSON in and out. Every response carries
`X-Request-Id` and echoes the same value as `requestId` in the body. Every
failure is `{"error":{"code","message","details"}}`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | storage readability per collection, provider availability (boolean presence only), runtime version, budget ceilings. `503` if a collection is unreadable |
| `GET` | `/agents` | id, name, boundary + boundary summary, tools (with risk/confirmation), limits, permissions, escalation tool, dataset, suites |
| `POST` | `/agents/{id}/runs` | start a run. Body: `{ input, provider?, taskType?, planning?, sessionId?, approvalId? }` → `201` with run id, final (or paused) state, decision, kernel verdict, tool calls, pending approval |
| `GET` | `/runs` | persisted runs, newest first. `?limit=` (1–500) and `?agentId=` |
| `GET` | `/runs/{id}` | the run record plus decision, state timeline, policy verdicts, tool calls, approvals, audit rows and the trace |
| `GET` | `/runs/{id}/events` | the ordered event stream, read back from `runs/run-events.jsonl` |
| `POST` | `/runs/{id}/cancel` | `200` and a `CANCELLED` row; `404` unknown; `409` already terminal |
| `GET` | `/approvals` | `?status=pending\|approved\|rejected\|expired\|cancelled\|all` (default `all`), plus `countsByStatus` |
| `POST` | `/approvals/{id}/approve` | resolve as approved. Body: `{ resolvedBy?, note? }` |
| `POST` | `/approvals/{id}/reject` | resolve as rejected |
| `GET` | `/tools` | the registry: risk level, side-effect class, permissions, `requiresConfirmation`, `escalation`, holders |
| `GET` | `/policies` | rule inventory (id, kind, priority, description) and the SVC boundary objects |
| `GET` | `/evaluations` | the last `eval:runtime` report, or `{available:false, command}` |

Status codes: `200` reads and resolutions, `201` a started run, `400`
invalid request / invalid JSON / unknown provider, `404` unknown agent, run,
approval or route, `405` wrong method (with `Allow`), `409` conflict (a resolved
approval, a terminal run), `413` body over 64 KiB, `500` an unexpected failure,
`503` an unconfigured real provider or an unreadable store.

**A path under `/api/runtime` is never answered with a static file.** A
mistyped API path is a JSON 404, and a non-runtime path is not touched by the
runtime router at all.

### Worked example: the whole approval round trip with curl

```bash
B=http://127.0.0.1:4317

# 1. a payload that hands the decision to a human (dataset case 2 of SVC_03)
curl -s -X POST $B/api/runtime/agents/svc_03/runs -H 'Content-Type: application/json' \
  -d '{"input":"<paste evals/invoices_dataset.json case 2 invoice_data here>"}'
# -> 201, status WAITING_FOR_APPROVAL, terminal false, pendingApprovalId apr_...

# 2. the queue
curl -s "$B/api/runtime/approvals?status=pending"          # -> the approval above

# 3. decide
curl -s -X POST $B/api/runtime/approvals/apr_.../approve \
  -H 'Content-Type: application/json' -d '{"resolvedBy":"you","note":"reviewed"}'

# 4. resume the gated call with the approval id
curl -s -X POST $B/api/runtime/agents/svc_03/runs -H 'Content-Type: application/json' \
  -d '{"input":"<same payload>","approvalId":"apr_..."}'
# -> 201, COMPLETED, toolCalls includes request_human_approval
```

`docs/VERIFICATION.md` has the same sequence with real status codes and bodies,
plus the restart-persistence check.

### Starting a run programmatically (no server)

```js
import { createRuntime } from './src/index.mjs';
import { createRuntimeApi } from './src/api/index.mjs';

const runtime = createRuntime({ storageDir: './data/state' });
const api = createRuntimeApi({ runtime });

const response = await api.handle({
  method: 'POST',
  pathname: '/api/runtime/agents/svc_03/runs',
  rawBody: JSON.stringify({ input: 'Invoice #101. Amount: $450.00 ...' }),
});
// -> { status, headers, body: '<json>' }   (or null for a non-runtime path)
```

---

## 5. Running a real live model

The offline default is a **deterministic test double**. To get a real model
answer you must configure a provider and name it on the request.

```bash
export OPENAI_API_KEY=sk-...            # or ANTHROPIC_API_KEY=..., or LOCAL_MODEL_BASE_URL=...
export AGENT_DEFAULT_PROVIDER=openai    # optional: makes it the default
node server.mjs

curl -s -X POST http://127.0.0.1:4317/api/runtime/agents/svc_03/runs \
  -H 'Content-Type: application/json' \
  -d '{"input":"<invoice text>","provider":"openai"}'
```

What changes and what does not:

| | Offline (`mock`) | Live (`openai` / `anthropic` / `local`) |
| --- | --- | --- |
| Who proposes the disposition | a repository fixture (`scriptedBy` says which) | the model, from the rendered prompt of record |
| Cost | zero | **real money** — one run makes one or more model calls with the full prompt, and the prompt is long |
| The rest of the pipeline | real | identical: same state machine, executor, policy kernel, approval gate, stores |
| What the result proves | that the runtime and the guardrails behave | something about that model, on that prompt, that day |

Details worth knowing before you spend money:

- **A provider without a key is a hard failure, not a fallback.** `503
  PROVIDER_NOT_CONFIGURED` naming the environment variable. The API will not
  substitute the double for a live provider, because a caller who asked for a
  model and silently got a fixture would draw confident conclusions from a
  script.
- **`AGENT_DEFAULT_PROVIDER=openai` with no key makes every run 503**, including
  the console's form. That is intended.
- **Model ids rot.** `promptfooconfig*.yaml` pin ids; check them before a
  release run (`README.md` has the two `curl` commands).
- **Live mode is unverified in this environment**: no key was present, so no run
  in this call made a network call to a model. `/api/runtime/health` reports
  `configured: false` for `openai`/`anthropic`/`local` and `available: false`.
  What IS verified is the refusal path and the provider-selection path
  (`docs/VERIFICATION.md`, AC-5).
- The live path through the API has never been exercised end to end here. Treat
  the first live run as a smoke test you are running yourself.

---

## 6. How do I extend it?

### Add a tool

1. Write `src/tools/builtins/my_tool.mjs` exporting a declaration plus a
   `createMyTool({ store, fixtures, now })` factory. Copy
   `src/tools/builtins/query_po_database.mjs` for a read-only tool or
   `submit_paper_order.mjs` for a write.
2. Declare `inputSchema` (the executor validates against it before policy runs),
   `riskLevel`, `sideEffect`, `requiresConfirmation`, `permissions` and
   `dataAccess`. `defineTool()` in `src/tools/registry.mjs` refuses a malformed
   declaration at registration time.
3. Register it in `src/tools/builtins/index.mjs` (the factory list and
   `BUILTIN_TOOL_NAMES`). `BOUNDARIES`-relevant tools also need a rule; see
   `src/policy/rules/svc-boundaries.mjs`.
4. Grant it to a profile in `src/config/agents.mjs` (`tools`, plus the matching
   `permissions` and `dataAccess`), or the tool exists but no agent can call it.
5. Add a unit test next to `tests/unit/tools-builtins.test.mjs`, and run
   `npm run verify:runtime` (it asserts the tool count, so it will tell you the
   registration took).

A tool is not authorised by being registered. Registration is selection; the
policy kernel and the executor decide whether a call runs.

### Add an agent profile

1. Add the profile to `AGENT_PROFILES` in `src/config/agents.mjs`: id, name,
   taskType, tools, permissions, dataAccess, limits, actionPolicy.
2. If it owns a domain boundary, add the ceilings to `BOUNDARIES` in the same
   file (that object is deep-frozen and is the only place a ceiling lives).
3. Add `src/agents/<id>/index.mjs` exporting `buildAgent()`, a `caseAdapter()`
   and a `dataset` block, and register it in `AGENT_BUILDERS` in
   `src/agents/index.mjs`.
4. `runtime.listAgents()` picks it up, so `/api/runtime/agents` and the console
   show it with no further edit — the API has no per-agent code.
5. Test: `npm run verify:runtime` asserts "four agents are wired", and
   `scripts/eval-runtime.mjs` iterates `listAgentIds()`. Update the assertion and
   `src/evaluation/mock-scripts.mjs`'s `DOCUMENTED` entry if the new agent has a
   dataset.

### Change a policy boundary

Boundaries are code, so a boundary change is a reviewable commit:

1. Edit `BOUNDARIES` in `src/config/agents.mjs` (and, if the number also appears
   in a prompt, the prompt under `prompts/` — the two are asserted to agree by
   the `evals/validate_*.mjs` validators, which is what stops a prompt and a
   control from drifting apart).
2. Run `node evals/validate_dataset.mjs` (and the security/trading variants):
   they recompute the numbers from the prompt and the dataset and fail if they
   no longer match.
3. Run `npm run eval:runtime`: it re-runs every dataset case through the runtime
   and fails if a disposition no longer matches.
4. `GET /api/runtime/policies` and the console's Policies view change with it,
   because both read `BOUNDARIES` rather than restating it.

Never add an environment variable for a ceiling. The absence of one is the
property that makes the boundary a control.

---

## 7. Data: where it lives, how to read it, how to reset it

Everything the runtime writes goes under `storageDir` (default
`data/state/`, overridable with `AGENT_STORAGE_DIR`). It is append-only JSONL —
no database.

| Collection | Path | Written by |
| --- | --- | --- |
| runs | `data/state/runs/runs.jsonl` | one `started` row, then a `finished` / `paused` / `cancelled` row per run |
| events | `data/state/runs/run-events.jsonl` | every event, redacted, all runs |
| approvals | `data/state/approvals/approvals.jsonl` | the approval lifecycle (created, approved/rejected/expired/cancelled) |
| traces | `data/state/traces/traces.jsonl` | one finished trace tree per run |
| audit | `data/state/audit/audit.jsonl` | the audit rows (`run.started`, `run.finished`, `run.paused`, `run.cancelled`, `policy.decision`, …) |
| incidents | `data/state/incidents/tickets.jsonl` | `create_incident_ticket` |
| orders | `data/state/orders/paper_orders.jsonl` | `submit_paper_order` |
| memory | `data/state/memory/memory.jsonl` | the five-kind memory store |
| evaluations | `data/state/evals/runtime-results.json` | `npm run eval:runtime` (the report `/api/runtime/evaluations` reads) |

Inspecting:

```bash
# the last ten runs, newest last
tail -n 10 data/state/runs/runs.jsonl

# every audit row for one run
grep '"runId":"run_abc"' data/state/audit/audit.jsonl

# the approval lifecycle of one approval, oldest first
grep '"approvalId":"apr_abc"' data/state/approvals/approvals.jsonl
```

Reading it through the API is usually easier: `GET /api/runtime/runs/{id}`
returns the record, the audit rows and the trace for one run in one response.

**Resetting** — the directory is evidence, not configuration, and deleting it
loses only history:

```bash
rm -rf data/state/runs data/state/approvals data/state/traces data/state/audit \
       data/state/incidents data/state/orders data/state/memory
# keep data/state/evals/ if you want to keep the last evaluation report
```

`data/state/` is git-ignored (`data/state/.gitignore` keeps the directory
itself). `data/fixtures/` is committed and must not be deleted — the tools read
their fixtures from there.

---

## 8. Command reference

| Command | What it proves | Notes |
| --- | --- | --- |
| `npm test` | 333 unit tests | no network, no key |
| `npm run test:integration` | 81 integration tests (54 runtime + 27 API) | starts the real server on an ephemeral port for the API half |
| `npm run test:api` | the 27 API tests alone | fastest feedback while working on `src/api/` |
| `npm run verify:runtime` | 84 invariant checks, including 20 API checks | writes evidence under a temp directory, not into the repo |
| `npm run eval:runtime` | the three datasets through the real runtime, offline | writes `data/state/evals/runtime-results.json` |
| `npm run eval:runtime:oracle` | oracle only | |
| `node evals/validate_dataset.mjs` (and `validate_security_dataset.mjs`, `validate_trading_dataset.mjs`) | dataset/prompt/config consistency | no key, no spend |
| `npm run eval:offline:oracle` etc. | the promptfoo offline gates (oracle 12/12, naive exactly 9/7/9 failures) | **see the note below about this npm version on Windows** |
| `npm run gate:runtime` | `test:unit && test:integration && verify:runtime && eval:runtime` | the runtime half of CI |
| `npm run gate` | dataset validators, promptfoo offline gates, n8n lint/tests | the prompt/eval half |
| `npm run gate:all` | both halves | |
| `npm start` | the server | |

**Known environment quirk:** the promptfoo gate scripts are written as
`rm -f x.json; promptfoo eval …; node evals/check_results.mjs …`. The npm in this
environment (npm 12.0.2 on Node 22.22.0) passes everything after the `;` to `rm`
on Windows, so those particular scripts fail with `rm: unknown option -- c`
before `promptfoo` runs. The underlying commands pass when run directly:

```bash
rm -f oracle-results.json
npx promptfoo eval -c evals/promptfooconfig.offline.yaml --no-cache --no-table \
  --filter-providers oracle -o oracle-results.json
node evals/check_results.mjs oracle-results.json --require-all-pass
```

This is a pre-existing packaging/npm interaction, not a call-3 regression; the
call-3 gates (`test:*, verify:runtime`, `eval:runtime`) are plain `node`
invocations and are unaffected.

---

## 9. How to verify this call

```bash
npm test && npm run test:integration && npm run verify:runtime && npm run eval:runtime
node evals/validate_dataset.mjs && node evals/validate_security_dataset.mjs && node evals/validate_trading_dataset.mjs
```

Then start the server and walk §4 and §6 of `docs/VERIFICATION.md`, which list
the exact calls, the status codes and the responses observed.

To see the console's structure without a browser:

```bash
curl -s http://127.0.0.1:4317/console    | head -40
curl -s http://127.0.0.1:4317/runtime.js | head -40
```

---

## 10. Known limitations

Stated plainly. Each one is a real limit, not a caveat about style.

1. **The offline provider is a test double, not a model.** With `mock`, the
   *proposal* comes from a fixture in `src/evaluation/mock-scripts.mjs`. Nothing
   in an offline run is evidence about how any real model behaves. Every
   response says so (`providerIsMock`, `scriptedBy`, `offlineNote`).
2. **The API has no authentication.** Anyone who can reach the port can start
   runs, approve approvals and cancel runs. Bind it to localhost (the default)
   or put it behind a proxy that authenticates. Adding auth is its own piece of
   work.
3. **The offline fixture layer can only replay two documented behaviours** for
   free-text input: the oracle fixture (for a payload that matches a dataset
   case exactly, after whitespace normalisation) and the naive fixture. A
   payload that is neither gets the naive fixture. The general agent has no
   dataset, so a free-text input to it produces a text-only fixture turn.
4. **The offline path serialises runs.** The mock provider is a single shared
   double whose script is instance state, so the API runs one run at a time. A
   live provider would not need the queue; the queue is kept anyway so an
   operator console's audit trail is strictly sequential.
5. **Cancellation is cooperative.** A run in flight stops at its next loop
   iteration. A model call or tool call already dispatched finishes — a plain JS
   function cannot be cancelled. Cancelling a *paused* run is a state change on
   a persisted row, because nothing is executing.
6. **A resumed escalation produces a second pending approval.** Approving a
   gated `request_human_approval` call lets the tool run, and that tool records
   its own queue entry. So after a resume the queue can hold a new pending
   approval for the same invoice. That is the call-1 tool's documented
   behaviour (it *is* the queue entry), and call 3 reports it rather than hiding
   it — but it reads as a duplicate.
7. **`POST /api/simulate` is still a simulation.** The legacy dashboard endpoint
   evaluates a payload with keyword checks and fixed stage timings; it does not
   call the runtime. Call 3 labels it (`simulated: true`, `deprecated: true`)
   without changing the shape `public/app.js` reads, and points at
   `/api/runtime/agents/:id/runs` for a real run. It is intentionally not
   rewired: replacing it would change the dashboard's behaviour, which call 3
   was told not to do.
8. **The API returns at most 500 runs per request** and reads the whole
   `runs.jsonl` to build the list. Fine at this scale; a store with tens of
   thousands of runs wants an index, not a bigger limit.
9. **No streaming.** Event delivery is a persisted read, not a subscription.
10. **The trace is embedded in the run detail** and the full tree can be large;
    the console hides it behind a collapsible section for that reason.
11. **No live-model verification in this call.** See §5.
12. **No browser render verification of the console in this call.** No browser
    backend was available to the agent in this environment, so the console's
    structure (links, endpoints, CSS units, breakpoint) is asserted by test and
    its rendering is not. Human eyes on `/console` remain the last step.
13. **`GET /api/runtime/evaluations` reports whatever is on disk.** If the report
    is stale, the payload is stale; it carries `generatedAt` so you can tell.
14. **The console's writes are not optimistic.** Every action re-reads the view
    from the API, which is slower than patching the DOM but means the console
    never shows a state the server did not confirm.
