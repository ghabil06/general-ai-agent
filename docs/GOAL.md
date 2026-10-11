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

---

# Call 4 — the bounded tool-calling state machine (General AI Agents)

## The request

> **SVC_03 — General AI Agents.** *Algorithm: bounded tool-calling state machine.*
> Reuse the existing runtime's planning, tool allowlists, execution budgets, policy
> checks, approval gates, and persisted traces. Use a deterministic state machine for
> transitions and bounded model-driven planning for flexible tasks. **Do not use:**
> open-ended agent loops without execution limits.

No file list or acceptance criteria were given, so the criteria below are this call's
reading of the request. They are what `docs/VERIFICATION.md` §6 verifies.

**A naming collision, resolved by assumption.** In this repository `svc_03` is the
accounts-payable invoice agent, whose frozen $500.00 boundary must not change. The
general-purpose agent is `general`. This call builds a bounded execution path for
general-purpose agents and makes it agent-agnostic (default agent: `general`; any profile,
`svc_03` included, on request). If "SVC_03" meant something else, only the default agent id
changes. This is flagged, not confirmed.

## Definition of done

A reviewer can hand a flexible task to `runtime.boundedAgent().execute(task)` and get back a
persisted result whatever happens: the model's plan is validated against the agent's
allowlist and capped; every tool call goes through the executor and the policy kernel; a
gated call pauses the run for a human; and no model, tool, plan, clock or configuration can
make the run exceed a limit that is written in code. Every pre-existing gate is unchanged
and the counts only grew.

## Scope

| In scope | Where |
| --- | --- |
| The execution envelope: hard ceilings, one resolution point | `src/runtime/envelope.mjs` |
| The bounded agent: one entry point, one result shape, every run recorded | `src/runtime/bounded-agent.mjs` |
| Transition fuel on the state machine | `src/runtime/state-machine.mjs` |
| Runtime hardening found necessary while probing (see ARCHITECTURE §9.5) | `src/runtime/run.mjs`, `src/planning/planner.mjs`, `src/api/handlers/runs.mjs` |
| Tests, including regression tests written to fail on the old code first | `tests/unit/{envelope,state-machine-fuel,runtime-bounds,planner-proposal-parse}.test.mjs`, `tests/integration/{bounded-agent,api-bounds}.test.mjs`, `tests/helpers/bounded.mjs` |
| Gate additions | `scripts/verify-runtime.mjs` §13, `npm run test:bounded` |
| Documentation | `docs/ARCHITECTURE.md` §9, `docs/HANDOVER.md`, `docs/VERIFICATION.md` §6, `README.md` |

### Out of scope (deliberately not done)

- **No new npm dependency; nothing under `evals/`, `prompts/`, `n8n_exports/`,
  `promptfooconfig*.yaml` or the datasets; no existing test edited.**
- **No change to a boundary, a policy rule or the approval rules.** Approvals are still not
  single-use (a pre-existing finding, reported in ARCHITECTURE §9.8).
- **No HTTP endpoint for `execute()` and no console view.** It is a library entry point; the
  existing run endpoint gets the runtime hardening and a ceiling check, nothing else.
- **No route-table entry for `general_assistance`** (an existing test pins the table; which
  model serves general tasks is a product decision).
- **No live-model run.** No key in this environment; every adversarial provider is a test double.
- **No runtime version bump** (an existing test pins `0.2.0`).

## Acceptance criteria

| # | Criterion |
| --- | --- |
| AC-B1 | `execute(task)` is the single entry point. It returns a result for every outcome and throws only `BoundedAgentError`, only for a request refused **before a run exists**, creating nothing (no run, event or audit row). |
| AC-B2 | The model proposes; code disposes. Every tool call goes through the executor; every executed tool has an earlier `ALLOW` verdict from the policy kernel in the same run. |
| AC-B3 | Strategy (`auto` / `planned` / `direct`) is a deterministic function of the request and the profile. A caller-supplied plan executes deterministically; a model-proposed plan is bounded model-driven planning. |
| AC-B4 | A plan naming a tool outside the agent's allowlist is refused before any tool is asked to run; plan size and replans are capped. |
| AC-B5 | No environment variable, profile, request or API call can raise any limit past a hard ceiling. A request may only tighten, and the envelope reports what bound each limit. |
| AC-B6 | Every wait is bounded: a model that never answers and a tool that outlasts the run are cut off by the run's remaining wall-clock; the provider's request is aborted. |
| AC-B7 | The state machine has its own bound: after N transitions only a terminal move remains; a terminal move is reachable from every non-terminal state; spent fuel stops the run as `TRANSITION_LIMIT`, recorded. |
| AC-B8 | A model that asks for a fresh tool call forever, or returns thousands of invalid calls in one completion, is stopped by the budgets, inside the envelope. |
| AC-B9 | Cancelling at any await point resolves the loop (never rejects), records the run `CANCELLED`, abandons a model call in flight promptly, and runs no further tool. |
| AC-B10 | Every run that is created is recorded — run row, trace, audit row — on every exit, including a fault. A gated call pauses the run non-terminal; a granted approval resumes it; it is bound to the call's arguments. |
| AC-B11 | The SVC_03 boundary is unchanged through the new path: $500.00 allowed, $500.01 denied, no structured facts means denied. |
| AC-B12 | Mock vs real is labelled: a test-double result says so; an unconfigured provider is refused, never silently replaced. |
| AC-B13 | Every pre-existing test and gate is unchanged in expectation: no existing test edited, the evaluation numbers identical, the counts only grew. |
| AC-B14 | `docs/ARCHITECTURE.md` §9, `docs/HANDOVER.md`, `docs/VERIFICATION.md` §6, `docs/GOAL.md` and `README.md` describe it, including what is not verified and what was found wrong. |

