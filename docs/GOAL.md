# Goal, scope and acceptance criteria

## Programme goal

Turn the `general-ai-agent-main` repository from a set of prompt-only
bounded-agency demonstrations (SVC_03 invoice reconciliation, SVC_04 Wazuh
security triage, SVC_06 paper trading) plus a hardcoded dashboard simulation
into a production-oriented **general AI agent runtime**: one shared runtime with
explicit execution states, model-provider abstraction, planning, iterative
tool-calling execution, a deterministic policy/guardrail kernel, human approval,
context engineering, memory, observability with replayable audit traces,
evaluation, and the three specialized agents migrated onto it as profiles.

**Audience:** the engineering team that will operate, audit and extend the
runtime; the operators who review its decisions (accounts-payable reviewer,
SOC analyst, trading desk lead); and a reviewer checking what the runtime did
and why.

**Definition of done:** every specification step is implemented as real code;
the three specialized agents run end to end through the real runtime with the
boundary decisions enforced deterministically in the kernel rather than in
prompt text; runs, approvals and audit records are persisted and survive a
restart; an operator can drive and inspect all of it from an HTTP API and a
console; every pre-existing eval, validator and promptfoo gate still passes
unchanged; and the whole thing is documented well enough for a second person to
run and extend it without asking the author.

---

## The goal

Build a real HTTP API and an operator console over the agent runtime that calls
1 and 2 produced, so that a person who is not reading the source can start a
run, watch it reach a decision or stop at a human gate, resolve that gate, read
the reasoning (state, policy verdicts, tool calls, trace, audit) and see the
last evaluation report — without the console being able to widen a policy
boundary, fabricate a decision, or show a number the runtime did not produce.

The audience is an operator (on-call SOC analyst, accounts-payable reviewer,
trading desk lead) and a reviewer auditing what the runtime did and why.
The API's audience is the same person plus any client they wire up next.

## Definition of done

A reviewer can start `node server.mjs`, open `/console`, and:

1. see the four agent profiles with the ceiling each one runs under;
2. start a run and see the disposition it reached and the kernel's verdict on it;
3. start a run that pauses at an approval gate, approve or reject it, and see
   both the approval and the run recorded on disk;
4. cancel a run that is waiting;
5. read the tool registry, the policy inventory, the frozen boundaries and the
   last `eval:runtime` report from the same page;
6. do all of that with every existing gate still green, and with every existing
   route and static file byte-for-byte unchanged.

## Confirmed scope

| In scope | Where |
| --- | --- |
| Runtime HTTP API as a library | `src/api/` |
| Mounting it behind `/api/runtime` in the existing server | `server.mjs` |
| `run.pause()` — a run stopped at a human gate is non-terminal | `src/runtime/run.mjs` |
| `approvalId` resume path through both loops | `src/runtime/run.mjs` |
| `run.paused` event + audit types | `src/observability/{events,audit}.mjs` |
| Operator console (views, keyboard operable, responsive) | `public/runtime.*` |
| One link from the existing dashboard | `public/index.html`, `public/style.css` |
| Endpoint-level integration tests over a real socket | `tests/integration/api.test.mjs` |
| API invariants added to the existing verification script | `scripts/verify-runtime.mjs` |
| Requirement documents | `docs/GOAL.md`, `docs/HANDOVER.md`, `docs/VERIFICATION.md` |

### Out of scope (deliberately not done)

- **No new npm dependency.** The router, the console and the tests use `node:http`,
  `node:fs` and platform `fetch` only.
- **No framework migration.** `server.mjs` stays a plain `node:http` server; the
  runtime API is a library mounted into it, not a second server.
- **No changes under `evals/`, `prompts/`, `n8n_exports/`, `promptfooconfig*.yaml`
  or the datasets.** The API reads `evals/*_dataset.json`; nothing writes them.
- **No weakening of an existing test or gate.** `npm test`, every integration
  test, `verify:runtime`, `eval:runtime` and all promptfoo gates are unchanged in
  expectation, and the counts only grew.
- **No authentication or multi-tenancy.** The API is bound to localhost by
  default and has no auth layer. Stated as a known limitation in
  `docs/HANDOVER.md`; adding auth is a separate piece of work with its own
  threat model.
- **No streaming.** `GET /runs/:id/events` returns the persisted stream; there is
  no SSE or WebSocket push.
- **No live-model run in the gates.** Nothing in the test suite or the gates
  spends money or needs a key; the live path exists and is documented but is
  unverified here (no key in this environment).
- **No vector search, no new memory kind, no agent hand-off.** Unchanged from
  call 2.

## Acceptance criteria

These are the criteria `docs/VERIFICATION.md` verifies one row at a time.

| # | Criterion |
| --- | --- |
| AC-1 | `server.mjs` keeps its current behaviour for every existing route and static file, and additionally delegates `/api/runtime/*` to the new router. |
| AC-2 | `POST /api/simulate` keeps its response shape (the fields `public/app.js` reads), with the legacy marker added additively. |
| AC-3 | `GET /api/runtime/agents` returns each profile's id, name, boundary summary, tools and limits. |
| AC-4 | `POST /api/runtime/agents/{id}/runs` runs a REAL runtime run offline by default and returns the run id and the final state. |
| AC-5 | A real provider id without a credential returns a clear 4xx/5xx with a structured error, never a fake result. |
| AC-6 | The run endpoints (`GET /runs`, `GET /runs/{id}`, `GET /runs/{id}/events`, `POST /runs/{id}/cancel`) return the record, decision, state history, trace and ordered events, with 404 for unknown and 409 for a terminal run. |
| AC-7 | A run that pauses for approval persists a pending approval; `GET /api/runtime/approvals?status=pending` lists it; approve/reject resolve it; 409 when not pending; 404 when unknown; and the resolution is persisted. |
| AC-8 | `GET /api/runtime/tools` and `GET /api/runtime/policies` return the registry (risk, side-effect class, permissions, requiresConfirmation) and the rule inventory plus the SVC boundary configuration. |
| AC-9 | `GET /api/runtime/evaluations` returns the last `eval:runtime` report or a clear "not run yet" payload, and never fabricates one. |
| AC-10 | `GET /api/runtime/health` reports storage readability, provider availability (never a key) and the runtime version. |
| AC-11 | Every response is JSON, uses the correct status code, carries a structured `{error:{code,message}}` on failure, contains no secret, and echoes a request id. |
| AC-12 | Unknown runtime route => 404 JSON, never a static file fallback; method mismatch => 405 with `Allow`; over-limit body => 413. |
| AC-13 | `tests/integration/api.test.mjs` starts the real server on an ephemeral port and exercises every endpoint, including a real persisted approval round trip. |
| AC-14 | The console is served at `/console`, follows the "Information Architects" preset (system font stack, classic link colours, ~66ch prose measure, no shadows/gradients/animation/icon fonts/CDN), and is operable with the keyboard only. |
| AC-15 | The console has the Agents, Tools, Policies, Runs (list + detail with timeline, decision, tool calls, policy decisions, trace), Approvals (pending queue, approve/reject, resolution history) and Evaluations views, calls only `/api/runtime/*`, and renders loading, empty and error states. |
| AC-16 | The console is structurally sound at ~380px and ~1600px: single column when narrow, multi-column from 60rem, relative units only, no fixed pixel width. |
| AC-17 | The existing dashboard links to the console with no change to its layout or to `app.js` behaviour. |
| AC-18 | `docs/GOAL.md`, `docs/HANDOVER.md`, `docs/VERIFICATION.md` exist; `docs/ARCHITECTURE.md` carries a "Call 3" section; `README.md` points at the docs, `src/`, the console URL and the new npm scripts. |
| AC-19 | Every existing test and gate still passes, and the whole offline set passes with no API key. |
| AC-20 | The offline path is labelled: a response never claims a fixture result is a model result. |
