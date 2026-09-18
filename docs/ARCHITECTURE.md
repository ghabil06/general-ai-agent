# Architecture audit and target design

**Status of this document:** call 1 of 3. It records what the repository actually
does today, maps it onto the target agent architecture, and states exactly which
parts of the new `src/` runtime are real implementations, adapters, mocks or
placeholders.

Everything in this document was written by reading the files it cites. Where a
claim is about behaviour, the symbol is named so it can be checked.

**Labels used throughout**

| Label | Meaning |
| --- | --- |
| `implemented` | Real, working code that does what it says, with tests or gates behind it |
| `partially implemented` | Real but incomplete: some paths work, others are absent |
| `simulated` | Deliberately not real — it produces a plausible-looking result without the mechanism |
| `configuration-only` | Declarative artefacts (prompts, schemas, workflow JSON, CI config) with no runtime behind them in this repo |
| `missing` | Does not exist |

---

## 1. Repository audit

### 1.1 Runtime

| Finding | Label | Evidence |
| --- | --- | --- |
| There is **no agent runtime**. The only executable "agent" is `simulateAgentExecution(agent, caseData, customText)` in `server.mjs`, which builds a 5-stage narrative with **hardcoded durations** (`durationMs: 38`, `45`, `82`, `24`, `31`) and reports `totalDurationMs = Date.now() - startTime + 220`. | `simulated` | `server.mjs:50-313` |
| There is **no model client**. No provider, no SDK import, no `fetch` to a model API, no token accounting. The "evidence" the simulation reasons over is regex-extracted from the case text (`textToEvaluate.match(/\$([0-9,]+(?:\.[0-9]{2})?)/)`, `match(/level\s+(\d+)/i)`, `match(/notional\s+\$([0-9,]…)/i)`). | `missing` | `server.mjs:126, 163, 198` |
| There is **no tool registry and no tool execution**. `query_po_database`, `calculate_tax_variance`, `check_ip_allowlist`, `submit_paper_order` and the rest exist only as names inside prompt text (`prompts/svc_03/invoice_agent.md` directive 1) and as n8n nodes. The simulation never calls anything. | `configuration-only` | `prompts/svc_03/invoice_agent.md:7`, `n8n_exports/svc_03_invoice_agent.json` node `query_po_database` |
| There is **no policy engine**. Guardrails are (a) prose in the prompts, (b) a decision cascade hardcoded inside `simulateAgentExecution` (`if (agent === 'svc_03') { … }`), and (c) a second inline re-check labelled `guardrailPassed` that cannot fire, because the branch above it already routed every over-ceiling case to `request_human_approval`. | `simulated` | `server.mjs:123-234` (decision), `server.mjs:248-269` (re-check) |
| There is **no state machine**. The "stages" array is a presentation object, not control flow; nothing can transition, be refused, or be paused. | `missing` | `server.mjs:52-300` |
| There is **no budget, timeout or loop detection** anywhere in the runtime. A run cannot be bounded because no run exists. | `missing` | — |
| There is **no run persistence**. `/api/simulate` writes nothing. The only durable artefact the server can produce is the result of `/api/run-gate`, which runs a pre-existing validator and returns its stdout. | `missing` | `server.mjs:419-484` |
| **New in this call:** `src/` implements a real core runtime — config, state machine, budgets, provider contract, router, tool registry/executor, policy kernel with real SVC rules, approval lifecycle, JSONL stores, events/traces/audit, memory. | `implemented` | `src/index.mjs` → `createRuntime()` |
| **New in this call:** the act loop (`src/runtime/run.mjs` → `createAgentRun().loop()`) is real: think → tool → observe → repeat, with budget stops and per-stage events. | `implemented` | `src/runtime/run.mjs:250-430` |
| **New in this call:** a **planner** (goal decomposition) and a **context manager** (window assembly/compression) do **not** exist. The loop follows the model's own tool calls. | `missing` | stated in `src/runtime/run.mjs` header |

### 1.2 Agent architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| Three bounded-agency agents are **defined by prompt only**: SVC_03 invoice reconciliation, SVC_04 Wazuh triage, SVC_06 paper trading. | `configuration-only` | `prompts/svc_03/invoice_agent.md`, `prompts/svc_04/security_triage_agent.md`, `prompts/svc_06/paper_trading_agent.md` |
| **New in this call:** machine-readable agent profiles with tool allowlists, permission grants, data-access tags, per-run limits and numeric action ceilings. | `implemented` | `src/config/agents.mjs` → `AGENT_PROFILES`, `BOUNDARIES` |
| **New in call 2:** a `general` profile with no domain boundary, and four agent definitions that extend the call-1 profiles by identity (see §7.5). | `implemented` | `src/config/agents.mjs` → `AGENT_PROFILES.general`; `src/agents/{general,svc_03,svc_04,svc_06}/index.mjs`; `src/agents/index.mjs` |
| The SVC_03 agent has a **secondary guardrail prompt** by design ("enforced twice"). It is a prompt, not a control; the version-controlled control for SVC_03 today is the n8n IF node. | `configuration-only` | `prompts/svc_03/guardrail.md`; `n8n_exports/README.md` §"The two layers of the $500 boundary" |
| No agent has memory. Nothing is remembered between runs; there is no store to remember it in. | `missing` (added this call: `src/memory/store.mjs`) | — |
| No agent has a session concept. `/api/simulate` is stateless per request. | `missing` (added this call: `sessionId` on every run and event) | `server.mjs:419` |

### 1.3 Prompt architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| Four prompts of record, version-controlled, with a single `{{invoice_data}}` / `{{alert_data}}` / `{{market_data}}` placeholder each. | `implemented` | `prompts/svc_03/*.md`, `prompts/svc_04/…`, `prompts/svc_06/…` |
| Each prompt states ROLE, DIRECTIVES & BOUNDED AGENCY, an ordered **DECISION PRECEDENCE**, an **INJECTION RESISTANCE** section, and a strict JSON output contract. | `implemented` | `prompts/svc_06/paper_trading_agent.md` directives 1-9 |
| Prompts are **fetched, never pasted**, in the n8n workflow, so the repo stays the single source of truth. | `implemented` | node `Fetch prompt from GitHub` in `n8n_exports/svc_03_invoice_agent.json` |
| The placeholder is **not** substituted by n8n automatically; the README documents the explicit regex substitution. | `partially implemented` (documented manual step) | `README.md` §"Feeding the prompt to n8n" |
| There is no prompt registry, versioning or render step in code. | `missing` (a context manager would own this; call 2) | — |

### 1.4 Evaluation architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| 3 datasets × 12 adversarial cases, each with `vars.expected_action`, structured `case_*` facts and a `contains-json` schema assertion. | `implemented` | `evals/invoices_dataset.json`, `evals/security_alerts_dataset.json`, `evals/trading_dataset.json` |
| Strict assertion: the **last balanced JSON object** in the output is parsed and its `action` compared to `expected_action`. Shared parser `extractDecision` in `evals/assertions/action_matches.mjs`, imported by `triage_matches.mjs` and `trade_matches.mjs`. | `implemented` | `evals/assertions/action_matches.mjs:20-60` |
| Three deterministic **dataset gates** restate the written policy as code (`decide()` in each validator) and cross-check the dataset against it, the prompt placeholder, and config file resolution. No API key, no network. | `implemented` | `evals/validate_dataset.mjs:44-70`, `evals/validate_security_dataset.mjs:50-80`, `evals/validate_trading_dataset.mjs:60-90` |
| Six offline **fixture providers** (oracle + deliberately-broken naive per service) prove the harness discriminates: SVC_03 must fail exactly 9/12 on the naive provider and pass 12/12 on the oracle; SVC_04 5/12; SVC_06 9/12. | `implemented` | `evals/providers/*.mjs`, `evals/promptfooconfig.offline*.yaml` |
| `check_results.mjs` turns promptfoo output into a gate that asserts the exact failure count and cross-checks the recount against promptfoo's own `stats` block, so "0 results" can never look green. | `implemented` | `evals/check_results.mjs` |
| CI runs gates 1 and 2 on every push/PR; the live-model gate decouples on `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` secrets. | `implemented` | `.github/workflows/prompt-eval.yml` jobs `dataset-gate`, `n8n-export-gate`, `harness-discriminates`, `llm-eval` |
| Evaluation covers **prompt behaviour against a model**. It does not cover the runtime, because until this call there was no runtime to cover. | `partially implemented` | — |
| **New in this call:** 232 unit tests + 10 integration tests, and `tests/unit/policy-svc-boundaries.test.mjs` replays **all 36 dataset cases** through `src/policy/boundaries.mjs` and requires agreement with `expected_action`. | `implemented` | `tests/unit/policy-svc-boundaries.test.mjs:60-90` |

### 1.5 Guardrail architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| The boundaries are stated in three places: prompt prose, the validators' `decide()` functions, and (for SVC_03) an n8n IF node. All three are consistent, and the third is a genuine control. | `implemented` (SVC_03), `partially implemented` (SVC_04/SVC_06 have no code-side control outside the validators) | `n8n_exports/README.md`, `server.mjs:248-269` |
| The API-side "guardrail" is dead code in practice: `guardrailViolations` can only be populated in branches the decision cascade has already excluded. | `simulated` | `server.mjs:248-281` |
| Injection defence in the API is an 8-pattern regex list (`injectionPatterns`) evaluated against the whole payload, plus trust in dataset flags. | `partially implemented` | `server.mjs:78-102` |
| **New in this call:** a policy kernel with 11 ordered, pure rules and fail-closed resolution, and the SVC boundaries as real rules — not prompt text. | `implemented` | `src/policy/engine.mjs`, `src/policy/rules/*.mjs` |
| **New in this call:** approval lifecycle with expiry, single-shot resolution and argument-fingerprint binding. | `implemented` | `src/policy/approvals.mjs` |

### 1.6 Audit architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| SVC_03 has a **real database audit schema** with `breach` and `parity` as `GENERATED ALWAYS` columns, so the database — not n8n, not the model, not the prompt — computes the verdict. | `implemented` | `n8n_exports/audit_log.sql` |
| The n8n workflow writes an audit row for every decision, including breaches and unparseable output, and runs in shadow mode by default (`AGENT_MODE` unset ⇒ `shadow`). | `implemented` | `n8n_exports/svc_03_invoice_agent.json` nodes `Build audit row`, `Log to agents.audit_log` |
| The API's `auditRow` (`server.mjs:284-292`) is an in-memory object echoed to the browser as SQL **text**. It is never inserted anywhere. A visitor's browser showing `INSERT INTO agents.audit_log …` is a rendering, not a write. | `simulated` | `server.mjs:284-300`, `public/app.js:374-379` |
| `/api/audit-logs` reads `n8n_exports/replay_sample.jsonl` — a 10-line file whose first six lines are comments and whose last four are sample rows — and presents it as the audit log. `/api/overview` reports that file's **line count** as `stats.auditReplayRows: 10`, so the dashboard advertises ten audit rows where four exist. | `simulated` | `server.mjs:339` and `server.mjs:487-505`, `n8n_exports/replay_sample.jsonl` |
| Guardrail breaches are not persisted by any runtime component. | `missing` (added this call: `createAuditWriter().writeBreach()`) | — |
| **New in this call:** append-only JSONL audit with redaction, plus per-event audit mapping. | `implemented` | `src/observability/audit.mjs` |

### 1.7 n8n architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| One importable workflow for SVC_03 with 23 nodes: webhook → GitHub prompt fetch → Set → AI Agent (OpenAI node + 3 tools: `query_po_database`, `calculate_tax_variance`, `request_human_approval`) → Code `Parse decision` → IF `GUARDRAIL - 500 check` → Switch `Route by action` → Postgres audit + Slack. | `implemented` | `n8n_exports/svc_03_invoice_agent.json` |
| The two write paths (`Accounting write (LIVE ONLY)`, `Flag invoice (LIVE ONLY)`) ship **disabled**; shadow mode is the import default. | `implemented` | same file, `disabled: true` on both nodes |
| `validate_workflow.mjs` lints the export structurally (guardrail present, writes disabled, audit sink reachable) and `test_parse_nodes.mjs` executes the embedded Code nodes against adversarial inputs. | `implemented` | `n8n_exports/validate_workflow.mjs`, `n8n_exports/test_parse_nodes.mjs` |
| The tool nodes are real: `query_po_database` is a `postgresTool` against a read-only credential, `request_human_approval` posts to a Slack webhook. Their credentials are `REPLACE_ME` placeholders, so the workflow cannot execute as imported. | `configuration-only` | `n8n_exports/README.md` §Import, step 2 |
| SVC_04 and SVC_06 have **no** workflow export. Their guardrails exist only as prose and eval assertions. | `missing` | `n8n_exports/` contains one workflow |
| The n8n export is a parallel, not-yet-unified, implementation of the same policy the new `src/policy` kernel enforces. Reconciling them is a later decision; nothing in this call changes the export. | `configuration-only` | — |

### 1.8 UI architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| Single-page dashboard, no framework, no build step: `public/index.html` + `public/style.css` + `public/app.js`, with anime.js v4.5 served from `node_modules` via `/vendor/anime.umd.min.js`. | `implemented` | `server.mjs:510-527`, `public/app.js:9-23` |
| The UI renders exactly what `/api/simulate` returns: `decision`, `stages`, `guardrailPassed`, `hasInjection`, `auditRow`, `totalDurationMs`. | `implemented` | `public/app.js:326-383` |
| The stage timeline is **hardcoded to five slots** (`stg0`…`stg4` in `public/index.html`, iterated positionally in `renderResults`). The simulation happens to emit five stages; a different number would render silently wrong (missing entries are skipped, extra ones ignored). | `partially implemented` | `public/app.js:334-350`, `public/index.html` |
| The batch runner compares each case's `decision.action` to `vars.expected_action` in the browser and reports a match percentage — the UI therefore asserts the same thing the eval dataset asserts, against the simulation. | `implemented` | `public/app.js:439-484` |
| Latent API/UI mismatch: the server returns `stats.totalEvalCases`; the UI reads `d.stats.totalCases` and falls back to the literal `36`. The number shown is correct today only because the datasets total 36. | `partially implemented` (harmless, documented, left unchanged) | `server.mjs:372` vs `public/app.js:188` |
| The dashboard has no run history, no approval queue, no trace view and no live run stream — because there are no runs to show. | `missing` | — |

### 1.9 API architecture

| Finding | Label | Evidence |
| --- | --- | --- |
| Six JSON endpoints on a raw `node:http` server, CORS `*`, no auth, no rate limit: `GET /api/overview`, `GET /api/cases`, `GET /api/prompts`, `POST /api/simulate`, `POST /api/run-gate`, `GET /api/audit-logs`, plus static files. | `implemented` | `server.mjs:316-548` |
| `/api/simulate` is a **pure function of the request**: dataset row + optional `customText` in, simulated narrative out. No state, no persistence, no model. | `simulated` | `server.mjs:419-445` |
| `/api/run-gate` executes `child_process.exec(command, { cwd: __dirname })` — a real shell execution from an HTTP endpoint. The gate name is whitelisted by an `if/else` chain mapping to fixed command strings, so no request text reaches the shell; the remaining exposure is that **any visitor can run the repo's gates**, and there is no auth. | `implemented` with a known exposure | `server.mjs:448-484` |
| Errors are returned as `{ error: message }` with HTTP 500 and interpolated into the DOM by the UI. | `partially implemented` | `server.mjs:439-442`, `public/app.js:473` |
| **Not changed in this call.** `server.mjs`, `public/`, and every existing endpoint contract are untouched. | `implemented` | `git`-visible: no edits to `server.mjs` or `public/` |

### 1.10 Current limitations (summary)

1. **The product's core claim is simulated.** Everything the dashboard shows about "agent execution" is a deterministic narrative written in `simulateAgentExecution`. It is honest in its own comments ("Deterministic simulation engine") but the UI presents it as agent execution.
2. **No boundary is enforced by the runtime**, because there is no runtime. SVC_03's boundary is enforceable only through the n8n workflow; SVC_04's and SVC_06's are enforceable nowhere.
3. **Nothing is persisted.** Decisions, breaches, approvals and incidents exist only for the duration of an HTTP response.
4. **Nothing is bounded.** No iterations, no timeout, no tool-call cap, no loop detection.
5. **No provenance on an audit row.** The API audit row has no run id, session id, model id, prompt revision or tool list.
6. **No approval lifecycle.** `request_human_approval` in n8n posts to Slack; there is no record, no expiry, no resolution, no binding to the arguments it was requested for.
7. **SVC_04 and SVC_06 have no deployable artefact** at all — no workflow, no runtime, no controls.

---

## 2. Current vs target architecture map

Target pipeline, stage by stage. "Today" is the state before this call; "this call" is what `src/` now adds.

| # | Target stage | Today | This call adds |
| --- | --- | --- | --- |
| 1 | **User** | Browser dashboard, `case-select` + `payload-ta`, and an HTTP client for n8n's webhook. | Nothing (unchanged). |
| 2 | **Agent Gateway** | `server.mjs` routing only: `req.url` parsing, no auth, no identity, no session. | `sessionId` on every run/event; `createRuntime().createRun({ sessionId, agentId })`. The HTTP gateway itself is call 2/3. |
| 3 | **Session Manager** | `missing` (each HTTP request is independent). | Session id generation, propagation into every event, trace, audit row and store record. Persistent session state (`SESSION_STATE`) is **not** here yet. |
| 4 | **Agent Runtime** | `simulateAgentExecution` — a fixed narrative. | `src/runtime/run.mjs` → `createAgentRun()` with a real loop, state machine, budgets, traces and a run record. |
| 5 | **Context Manager** | `missing`. The API reads prompt files as text (`readTextFile`) and never renders a template. | `src/context/manager.mjs` — priority-based window assembly with deterministic trimming, a labelled truncation "summarizer" and a full budget report. Wired as `run.buildContext()` / `run.context` and as the loop's window when a caller passes structured material. See §7. |
| 6 | **Planner** | `missing`. The simulation has no notion of a step. | `src/planning/planner.mjs` — real goal decomposition into validated steps, backed by the tool registry and the agent profile, with replanning, explicit ceilings and a `loop({mode:'planned'})` path. See §7. |
| 7 | **Model Router** | `missing`. n8n pins one OpenAI node (`gpt-4o-mini` placeholder); promptfoo pins model ids per config. | `src/models/router.mjs` — deterministic table router over task type, complexity, preference, context size and tool requirement. The test double is opt-in. |
| 8 | **Tool Registry** | Tool **names in prose** and n8n node definitions. | `src/tools/registry.mjs` with risk level, side effect, confirmation flag, permissions, data-access tags, schemas and `execute()`. |
| 9 | **Tool Executor** | `missing` (n8n calls its own nodes; the API calls nothing). | `src/tools/executor.mjs` — resolve → validate → policy → gate → execute → time out → record, with `execute()` unreachable on any failure. |
| 10 | **Policy / Guardrail Kernel** | Prose + three `decide()` functions in the validators + one n8n IF node. | `src/policy/engine.mjs` and `src/policy/rules/*.mjs`: 11 ordered pure rules, fail-closed, with the SVC boundaries as first-class rules and declarative numeric ceilings. |
| 11 | **Action Gate** | An n8n IF node for SVC_03 only. | Real gate inside the executor: `DENY` returns `POLICY_DENIED` without executing; `REQUIRE_APPROVAL` persists an approval bound to tool + argument fingerprint. |
| 12 | **Execution** | `missing`. | `execute(args, ctx)` on each tool, timed, with the result captured. Real deterministic built-ins under `src/tools/builtins/`. |
| 13 | **Observation** | `stages[]` entries with fake durations. | `tool.executed` / `tool.failed` events with status, duration, policy verdict and result; `OBSERVING` state; observations fed back into the message list. |
| 14 | **Validation** | The `guardrailPassed` re-check (unreachable by construction). | `VALIDATING` state with real guards (`meta.valid` required to reach `COMPLETED`); policy re-evaluation for proposed actions via `run.evaluateAction()`; dataset-backed boundary tests. |
| 15 | **Replanning** | `missing`. | `REPLANNING` state; the loop returns to `EXECUTING` with cumulative budget counters; recoverable stop reasons (`LOOP_DETECTED`, `TOOL_REPEAT_LIMIT`) are distinguished from terminal ones. Goal-level replanning is call 2. |
| 16 | **Final Response** | The JSON `decision` object returned by `/api/simulate`. | `run.finish()` writes a terminal state, a run summary, a trace and an audit row. Response shaping for the API is call 2. |
| 17 | **Audit / Trace / Evaluation** | Postgres `agents.audit_log` via n8n (SVC_03 only); trace: none; evaluation: promptfoo gates (unchanged). | `src/observability/{events,traces,audit}.mjs` + JSONL stores: full event stream, nested trace tree, append-only audit, redaction. Evaluation unchanged and still the gate of record. |
| 18 | **Memory** | `missing`. | `src/memory/store.mjs` — append-only, scope-keyed, latest-wins recall, with `memory.retrieved` / `memory.written` events. Exact-match retrieval, not semantic search (stated in the module). |

---

## 3. Migration principles

1. **Additive only.** `server.mjs`, `public/`, `prompts/`, `evals/`, `n8n_exports/` and every promptfoo config are functionally unchanged. All new code lives in `src/`, `docs/`, `tests/`, `scripts/` and `data/`.
2. **The eval gates are the gate.** Nothing in `src/` may weaken, edit or bypass a dataset, assertion, provider or validator. The new runtime is required to *agree* with them, and `tests/unit/policy-svc-boundaries.test.mjs` proves it by replaying all 36 cases.
3. **A prompt is a policy statement; the kernel is the control.** Boundaries are enforced against structured facts in `src/policy/rules/`, never by asking the model to remember a number.
4. **Boundaries are frozen constants, not configuration.** `BOUNDARIES` in `src/config/agents.mjs` is deep-frozen and read from no environment variable. An operator cannot widen a ceiling; only a commit can.
5. **Fail closed.** Unknown tool, unknown agent, un-evaluable rule, throwing rule, invalid decision value, unauthorised provider, missing fixture → refuse. The one deliberate exception is documented where it appears: read-only tools remain callable on injected input, because the read is how the agent produces the escalation the injection was trying to prevent.
6. **The executor is the only path to a side effect.** No module calls `tool.execute()` directly outside the executor's tests. Validation and policy failure mean the call never runs.
7. **Nothing executes without a record.** Every state change, model call, policy verdict, tool call, approval and memory read emits an event; runs, traces and audit rows are persisted before the run is reported complete.
8. **Honest labels.** Mock, adapter, simulation and placeholder are named in the code and in this document. Nothing is called "the agent" if it is a script.
9. **No new dependencies, no import-time side effects.** `node:` built-ins only; no network calls, filesystem writes or environment mutation at import time.
10. **Determinism where tests need it.** Clock injection (`now`), deterministic ids for fixtures, and a deterministic test double make the whole runtime testable offline — and the test double is never a routing target unless the operator asks for it.

---

## 4. Real vs mock vs adapter vs simulation vs placeholder

This is the inventory. Anything not listed as real is not to be trusted in production.

### 4.1 Real implementations (`implemented`)

| Module | What is real about it |
| --- | --- |
| `src/runtime/state-machine.mjs` | The 13-state table, its guards (`WAITING_FOR_APPROVAL → EXECUTING` requires `approvalStatus: 'approved'`, etc.), terminal detection and the transition emitter. `transition()` throws `StateTransitionError` on an illegal move. |
| `src/runtime/budgets.mjs` | Iteration, wall-clock, token and tool-call ceilings; fingerprint-based loop detection; structured stop reasons with a fixed evaluation order. |
| `src/runtime/run.mjs` | Run composition and the act loop: router → provider → tools → observations, with budget checks before every turn and terminal-state handling. |
| `src/policy/engine.mjs` | Priority-ordered, pure, fail-closed rule resolution. A throwing rule is a `DENY`. |
| `src/policy/boundaries.mjs` | The SVC decision procedures, mirroring the three validators' `decide()` functions; pinned to the datasets by test. |
| `src/policy/rules/*.mjs` | 11 rules: input validation, destructive-action restriction, injection scan, tool authorisation, data access, three SVC boundary rules, numeric ceilings, rate limit, required approval. |
| `src/policy/approvals.mjs` | Lifecycle (`pending → approved/rejected/expired/cancelled`), TTL expiry with an injected clock, single-shot resolution, tool+argument fingerprint binding, JSONL persistence. |
| `src/tools/schema.mjs` | JSON-schema-subset validator with a supported-keyword list, and `UNSUPPORTED_KEYWORD` as a fail-closed violation rather than a silent pass. |
| `src/tools/registry.mjs`, `src/tools/executor.mjs` | Definition validation; the eight-step execution order; `TOOL_ARGUMENT_INVALID` returned rather than thrown; timeout; policy gate; result capture. |
| `src/tools/builtins/*.mjs` (12 tools) | Real, deterministic, offline behaviour over real fixtures. See §4.5. |
| `src/store/jsonl-store.mjs`, `src/store/run-store.mjs` | Append-only JSONL, tolerant reads (corrupt line → structured error), latest-wins reduction, restart survival, collection layout. |
| `src/memory/store.mjs` | Append-only, scope-keyed records with latest-wins recall (exact match — no embeddings, stated in the module). |
| `src/observability/{events,traces,audit,redact}.mjs` | Event envelope and sinks; nested trace assembly (live and from events); durable audit rows; key-based secret redaction with a documented value heuristic. |
| `src/config/index.mjs`, `src/config/agents.mjs` | Env-driven config with no secrets in values; frozen agent profiles and boundaries. |
| `src/util/*.mjs` | Canonical JSON, ids, fingerprints. |

### 4.2 Test doubles (`mock`)

| Module | What it is |
| --- | --- |
| `src/models/providers/mock.mjs` | **A deterministic test double, not a model.** It replays a caller-supplied script of turns and can simulate provider failure, malformed JSON, and timeouts. `capabilities().mock === true`, `deterministic === true`. It records every call it received. It is registered in the runtime but is **opt-in for routing** (`ROUTES` entry `test-double-any` carries `optIn: true`); it is only a legal target when a caller passes `allowTestDoubles: true` or forces `provider: 'mock'`. |
| `evals/providers/*.mjs` (pre-existing, untouched) | The offline promptfoo fixtures. `oracle*` replays the expected action; `naive*` is deliberately broken. Not models, and labelled as such in their own headers. |

### 4.3 Real adapters (`adapter`, not mock)

| Module | What it is | What has not been verified |
| --- | --- | --- |
| `src/models/providers/openai.mjs` | A real HTTP client for `POST /chat/completions` on global `fetch`, translating tools, tool calls and usage. | Never executed against the live API here: no key is configured in this environment or in CI, so only the `AUTH_MISSING` path and the injected-`fetch` translation tests have run. |
| `src/models/providers/anthropic.mjs` | A real HTTP client for `POST /messages`, including the `system` split and `tool_use` / `tool_result` block translation. | Same: live path unverified. |
| `src/models/providers/local.mjs` | **Adapter + placeholder in one file.** Unconfigured (`LOCAL_MODEL_BASE_URL` unset) it throws a "not configured" `PROVIDER_UNAVAILABLE`. Configured, the same code performs a real OpenAI-compatible request against a local server. | Local-server behaviour unverified here; `LOCAL_MODEL_TOOLS` gates tool support because servers differ. |

### 4.4 Simulations (deliberately not real)

| Artefact | What it simulates | Why it is still there |
| --- | --- | --- |
| `simulateAgentExecution` (`server.mjs`) | An agent run: stages, decision, guardrail verdict, audit row, durations. | It is the existing demo surface and the UI depends on its exact response shape. This call leaves it untouched and adds the real runtime beside it. Replacing it is a later call, and the honest move when that happens is to label the endpoint as simulated or back it with `createRuntime()`. |
| `auditRow` in the simulation | A database insert, rendered as SQL text. | Same. `/api/audit-logs` serving `replay_sample.jsonl` is a demo dataset, not an audit log. |

### 4.5 Fixtures (`configuration-only`, but derived and traceable)

`data/fixtures/*.json` are hand-authored, committed, and each declares `_provenance.derivedFrom` naming the eval dataset it came from:

| Fixture | Derived from | Notes |
| --- | --- | --- |
| `po_database.json` | `evals/invoices_dataset.json` | PO numbers 990-998 (and 999); PO #777 is deliberately **absent**, because case 08 is the "present but unknown" case. Amounts, expected tax and line items reproduce each case's `case_variance`; PO #995's 390.00 total is what makes case 06's 39.00 variance exact. |
| `ip_allowlist.json` | `evals/security_alerts_dataset.json` | One entry, `10.20.0.31` — case 11 states the allowlist "contains 10.20.0.31 only". The near-miss IP `10.20.0.130` is absent by construction; the tool surfaces it as a `nearMiss` with `allowlisted: false`. |
| `alert_context.json` | `evals/security_alerts_dataset.json` | One record per Wazuh rule id in the dataset (31103, 31151, 5710, 87105, 92032, 550, 92010). |
| `market_quotes.json` | `evals/trading_dataset.json` | `default` snapshots carry the dataset's feed prices; a `halted` snapshot exists for AAPL because case 11 needs a halted symbol while cases 01/06 need it trading. GOOGL is quoted at two prices in the dataset (168.20 and 159.90); the default carries the first and the second is recorded under `alternatePrints` rather than hidden. |
| `paper_portfolio.json` | `evals/trading_dataset.json` | Account `PT-001`, paper, `realMoney: false`, long-only, baseline day P&L 120.50, plus `dayPnlScenarios` listing every P&L the dataset uses and whether it halts. |

### 4.6 Placeholders

| Item | Status |
| --- | --- |
| `src/models/providers/local.mjs` without `LOCAL_MODEL_BASE_URL` | `PLACEHOLDER`, labelled in the file and in its thrown error. |
| Real-model execution in this environment | Not exercised. Every live-model claim in the repo still rests on `npm run eval` with keys configured (gate 3), exactly as before. |
| Planner, context manager, HTTP gateway, dashboard run view | `missing` — see §5. |

---

## 5. Runtime reference (what later calls may rely on)

### 5.1 Entry points

```js
import { createRuntime } from './src/index.mjs';

const runtime = createRuntime({ storageDir, fixturesDir, config, rules, mockScript, now });
const run     = runtime.createRun({ agentId: 'svc_03', taskType, complexity, preference, provider, sessionId, runId });
```

| Export | Signature |
| --- | --- |
| `createRuntime(options)` | → `{ version, config, storageDir, fixturesDir, now, runStore, approvalStore, approvals, registry, executor, policy, memory, audit, providers, mockProvider, eventSinks, profiles, boundaries, getAgentProfile, findAgentProfile, route, routes, describeRoutes, newEventBus, newTrace, traceFromEvents, memorySink, createRun, describe }` |
| `runtime.createRun(options)` | → run handle (below) |
| `runtime.route(request)` | → `{ provider, model, routeId, reason, candidates, rejected, forced, tableVersion }`; throws `ModelError(PROVIDER_UNAVAILABLE)` when nothing qualifies |
| `runtime.describe()` | → full wiring report used by `npm run verify:runtime` |

Run handle:

| Member | Behaviour |
| --- | --- |
| `runId`, `sessionId`, `agentId`, `profile`, `taskType` | identity |
| `run.stateMachine`, `run.state` | the state machine and its current state |
| `run.budget` | the budget tracker (`snapshot()`, `check()`, `remaining()`) |
| `run.events` | this run's event bus (`subscribe`, `on`, `emit`) |
| `run.trace` | this run's trace builder |
| `run.transition(to, meta)` | guarded transition; throws `StateTransitionError` when illegal |
| `run.runModel({ messages, tools, requiresTools, responseFormat, complexity })` | route + call + account + trace; returns `{ completion, routing, usage }` |
| `run.runTool(name, args, { untrusted, evidence, approvalId, toolTimeoutMs })` | executors path: validate → policy → gate → execute; returns a structured result |
| `run.recall(query)`, `run.remember(record)` | memory read/write with events |
| `run.loop({ systemPrompt, userMessage, tools, maxTurns, untrusted, evidence, responseFormat })` | the act loop; returns `{ finalText, turns, steps, stopReason, messages }` |
| `run.finish({ status, output, reason })` | terminal state + run record + trace + audit; idempotent |
| `run.evaluateAction(action, evidence, untrusted)` | the policy verdict for a proposed agent action |

### 5.2 Event names (stable)

`run.started`, `run.finished`, `run.error`, `state.changed`, `model.called`, `model.failed`,
`memory.retrieved`, `memory.written`, `tool.proposed`, `tool.executed`, `tool.failed`,
`policy.decided`, `approval.requested`, `approval.resolved`, `validation.failed`,
`budget.stopped`, `trace.span_started`, `trace.span_ended`.

Envelope: `{ type, runId, sessionId, agentId, seq, ts, iso, spanId, payload }` — `payload` is always deep-redacted before any sink sees it.

### 5.3 Store paths (default `storageDir = <repo>/data/state`)

| Collection | Path | Written by |
| --- | --- | --- |
| `runs` | `runs/runs.jsonl` | `startRun`, `finishRun` |
| `events` | `runs/run-events.jsonl` | the JSONL event sink |
| `approvals` | `approvals/approvals.jsonl` | approval lifecycle |
| `audit` | `audit/audit.jsonl` | `createAuditWriter` |
| `incidents` | `incidents/tickets.jsonl` | `create_incident_ticket` |
| `orders` | `orders/paper_orders.jsonl` | `submit_paper_order` |
| `traces` | `traces/traces.jsonl` | `run.finish()` |
| `memory` | `memory/memory.jsonl` | `run.remember()` |

`data/state/.gitignore` excludes runtime artefacts from git; `data/fixtures/` is committed.

### 5.4 Recommended agent-profile shape

Already implemented in `src/config/agents.mjs`; this is the shape later calls should extend rather than replace.

```js
{
  id: 'svc_03',
  name: 'Accounts Payable Reconciliation',
  taskType: 'invoice_reconciliation',        // router input
  promptPath: 'prompts/svc_03/invoice_agent.md',
  guardrailPromptPath: 'prompts/svc_03/guardrail.md',
  datasetPath: 'evals/invoices_dataset.json',
  tools: ['query_po_database', 'calculate_tax_variance', 'request_human_approval'],
  permissions: ['po:read', 'invoice:read', 'approval:request', 'audit:write'],
  dataAccess: ['finance/po', 'finance/invoice', 'agent/approval'],   // exact-match tags
  limits: { maxToolCalls: 12, maxIterations: 8, maxTokens: 60_000 }, // ceilings, never floors
  actionPolicy: { autonomousApprovalCeilingUsd: 500, requireVerifiedPo: true, requireZeroVariance: true },
  allowDestructiveActions: false,
}
```

SVC_04: `taskType: 'security_triage'`, tools `query_alert_context` / `check_ip_allowlist` / `create_incident_ticket` / `request_analyst_review`, `actionPolicy.incidentLevelCeiling: 12`.
SVC_06: `taskType: 'paper_trading'`, tools `get_portfolio_state` / `get_market_quote` / `submit_paper_order` / `request_human_review`, `actionPolicy` carrying the $10,000 cap, the -$1,000 halt, the five-ticker allowlist, `longOnly: true` and `realAccountRouting: 'forbidden'`.

### 5.5 Policy decisions

`ALLOW` / `DENY` / `REQUIRE_APPROVAL`, each with `{ decision, rule, reason, evidence }`, plus `checks[]` (every rule that applied) and `firedRules[]`. Resolution is most-restrictive-wins; the reporting rule is the first firing at that severity. No rule matching ⇒ `DENY` from `engine.default`.

---

## 6. Known limitations of this call

1. **Planner and context manager are absent.** `loop()` follows the model; there is no goal decomposition, no window assembly, no compression, no prompt rendering from `prompts/`. `run.loop()` takes already-assembled strings.
2. **The HTTP surface is not wired.** `/api/simulate` still returns the simulation. Wiring `createRuntime()` behind new endpoints (a real run start/stream/approve API) is call 2, and the existing endpoints must keep their exact shapes when it happens.
3. **Live model paths are untested.** The OpenAI and Anthropic adapters have never been executed against the real APIs in this repository; no key is configured. Their translation logic is unit-tested with an injected `fetch`.
4. **The n8n workflow and the policy kernel are parallel implementations** of the same SVC_03 policy. Unifying them (or generating one from the other) is a decision for a later call; nothing here touches the export.
5. **A timeout aborts the wait, not the tool.** A plain JS function cannot be cancelled; `ctx.signal` is provided and tools should honour it. Stated in `src/tools/executor.mjs`.
6. **Injection detection is a heuristic** (weighted regex over untrusted text), labelled `heuristic: true` in every decision it produces. It is a second line of defence behind the structural SVC rules, never the only one, and it deliberately over-flags prose that instructs the agent to skip review (documented and tested).
7. **Memory retrieval is exact-match**, not semantic. No embeddings, no vector store, no dependency.
8. **No authentication, authorisation or multi-tenancy** on the runtime or the API. `agentId` is trusted input today.
9. **`/api/run-gate` remains a shell-execution endpoint.** Unchanged by this call and flagged as an exposure rather than silently "fixed".
10. **Six store collections are per-repository, not per-tenant**, and nothing prunes them. `data/state/` grows until deleted.

---

## 7. Call 2 — planning, context, memory kinds, agent migration, evaluation

**Status of this section:** call 2 of 3. It records what this call added on top of
call 1, with the symbols and paths that can be checked, and an honest gap list at
the end. Where this section and §1-§6 disagree, this section is newer; §2's rows
for the Context Manager and the Planner were updated to point here.

Everything in `src/` remains additive: `server.mjs`, `public/`, `prompts/`,
`evals/` (datasets, assertions, providers, promptfoo configs) and `n8n_exports/`
are functionally untouched. The eval gates are still the gate.

### 7.1 Planner — `src/planning/planner.mjs`

| Symbol | What it does |
| --- | --- |
| `createPlanner({ registry, profile, agentId, now, maxSteps, maxReplans, maxStepAttempts })` | Builds a planner bound to the real tool registry and one agent profile. |
| `planner.plan({ goal, steps })` | Decomposes a goal into validated steps. Throws `PlanError` rather than planning something unrunnable. |
| `planner.nextStep(plan)` | The next actionable step, marked in-flight; attempts incremented once per attempt. |
| `planner.recordOutcome(plan, id, { status, outcome, error })` | Records what happened. A failure in the current revision leaves the plan open (`plan.awaiting_revision`); a failure an earlier revision already answered does not. |
| `planner.shouldReplan(plan, detail)` / `replanDecision` | Whether a revision is worthwhile, and why (or why not). |
| `planner.replan(plan, { steps, reason })` | Supersedes the remaining steps — they become `skipped` with the reason, never deleted — and appends replacements, also validated. |
| `planner.complete(plan, { status, outcome })` | Closes the plan out explicitly. |
| `planner.openSteps` / `failedSteps` / `unresolvedFailures` / `isTerminal` | The plan's state, as predicates. |
| `snapshotPlan(plan)` / `summarizePlan(plan)` | A deep-frozen copy for persistence, and a one-line summary. |
| `stepsFromProposal(value)` | Parses the plan shapes a model actually emits (`{steps:[…]}`, `[…]`, one step) into raw data for `plan()`. |

Step data is exactly `{ id, index, description, tool, args, status, attempts, outcome }`.
Statuses are `pending | in_progress | done | failed | skipped | blocked`; plan
statuses are `active | complete | failed | abandoned`.

**What the planner may plan.** Only tools that exist in the registry AND are in
the agent profile's `tools` AND whose `permissions`/`dataAccess` the profile
grants: `PLAN_UNKNOWN_TOOL` and `PLAN_TOOL_NOT_PERMITTED` otherwise. That check
mirrors `src/policy/rules/tool-authorization.mjs` + `data-access.mjs`; it is a
mirror so a bad plan is refused *before* it becomes a run. The control is still
the executor, which re-evaluates every call through the kernel — an unauthorised
step that somehow appeared would be `DENY` there.

**Three ceilings, all enforced:** `maxReplans` (3), `maxStepAttempts` (2) and
`maxSteps` (12) in the planner; the run's iteration budget in the loop.

**Wired into the loop** (`src/runtime/run.mjs`): `loop({ mode: 'planned', plan | steps | goal })`
plans if it must, executes each step through `runTool()`, observes, validates and
replans; `run.plan({ goal, steps })` builds a plan for the run's own agent;
`run.planner`, `run.plannedLoop()`, `run.snapshotPlan()` are addressable.
`loop({ mode:'model' })` (the default) is the call-1 act loop, unchanged.

### 7.2 Context manager — `src/context/manager.mjs`

`createContextManager({ registry, profile, policy, boundaries, agentId, now, budget })`
→ `build(request)` returning `{ messages, tools, droppedCount, compressed, budgetReport }`.

Priority bands (`CONTEXT_PRIORITY`): policy 100 and task 90 (both **protected** —
never dropped, only truncated), plan 70, tool results 60, conversation 50, memory
40, documents 20. Admission is best-first (priority, then newest/best-scoring);
dropping is the exact mirror — lowest priority first, oldest first within a band.
`budgetReport.dropOrder` is the total, stable order, and two identical builds
produce identical orders (asserted in `tests/unit/context-manager.test.mjs`, in
the deterministic sub-suite in `src/evaluation/suites.mjs`, and by
`verify:runtime`).

**Summarisation is truncation, and it says so.** `SUMMARIZER` is
`{ name: 'deterministic-truncation', llm: false, deterministic: true }`, every
trimmed item carries `removed`, and the marker
`…[context-manager truncated N characters]` is in the text itself. A real summary
would need a model call inside window assembly — exactly what a context manager
must not depend on.

**Tools.** `tools` is `registry.toModelTools({ names: profile.tools })` intersected
with whatever the caller asked for. A request outside the allowlist is dropped and
reported under `budgetReport.tools.rejected`; the model projection carries only
`name`, `description`, `inputSchema` — never risk level, permissions or side
effects.

**Overflow.** `budgetReport.overBudget` + `exceededBy` are reported, never hidden,
and the loop turns them into a `CONTEXT_OVERFLOW` stop before any model call
(`run.loop({ task, context: { budget } })`).

**Wired into the loop:** when a caller passes `task`/`conversation`/`memory`/
`documents`/`plan`/`toolResults` instead of a `userMessage`, the loop assembles
its window here (`resolveWindow()`), records a `context` trace span, and never
lets a caller widen the tool list.

### 7.3 Memory kinds — `src/memory/kinds.mjs`

Five kinds, each with `write(record)`, `recall(query, { limit, kind })` and
`list()`: `working`, `conversation`, `episodic`, `semantic`, `user`
(`MEMORY_KIND`, `KIND_SPEC`, and the `forKind(kind)` / `.working()` … facades).

Retrieval is **exact keys + latest-wins + keyword overlap**. `RETRIEVAL_MODEL`
states `vectorSearch: false`, `embeddings: false`, `llm: false` and is reported in
every recall result. Every returned record carries
`why: { matchedBy, score, terms, explanation }` naming which of `exact_key`,
`tag_match`, `keyword_overlap` or `scope_latest` matched it. Ranking is
deterministic (exact/tag, then overlap score, then recency, then id) — same query,
same order.

Events: every write emits `memory.written` and every recall emits
`memory.retrieved` on the calling run's bus (`run.memory` stamps the run's ids on
each record). `list()` is the inspection read and does not claim a retrieval.

**Failure is structured, never thrown.** An unreadable store returns
`{ ok: false, error: { code: 'MEMORY_STORE_READ_FAILED' } }` with an empty record
list; a corrupt line is reported as `corruptLines` while the parseable records
around it still come back. `run.recall()` (the call-1 read) now also catches a
storage fault, emits `memory.retrieved` with `ok: false`, and returns `[]` — a
memory outage degrades a run instead of killing it.

`src/memory/store.mjs` (call 1) is unchanged and keeps working beside it.

### 7.4 Prompt rendering — `src/prompts/render.mjs`

`createPromptRenderer()` → `render`, `renderDetailed`, `load`, `placeholdersOf`,
`renderAgentPrompt`, `promptPathFor`, `guardrailPathFor`. It substitutes the
placeholders the n8n workflow documents (`{{invoice_data}}`, `{{alert_data}}`,
`{{market_data}}`, inner whitespace allowed, every occurrence) and refuses — with
a `PromptRenderError` carrying a stable code — when:

- the template has no placeholder (`PLACEHOLDER_MISSING`),
- a value is absent, `null`, empty, or an empty object/array (`PLACEHOLDER_VALUE_EMPTY`),
- a `{{…}}` survives the substitution (`PLACEHOLDER_UNRESOLVED`),
- the path escapes `prompts/` (`PROMPT_PATH_ESCAPE`),
- the file is missing or unreadable (`PROMPT_NOT_FOUND`, `PROMPT_READ_FAILED`).

The prompt files are read, never written (`tests/unit/prompts-render.test.mjs`
pins the bytes before and after a render). A prompt that carries no data (the
SVC_03 guardrail) is `load()`ed, not rendered.

### 7.5 Agent profiles — `src/agents/`, `src/config/agents.mjs`

`src/agents/index.mjs` is the one entry point: `loadAgent(agentId)`,
`loadAllAgents()`, `listAgentIds()`, `listSvcAgentIds()`, `isKnownAgent()`,
`systemPromptFor()`, `runAgentCase()`, `parseDecision()`, `terminalStatusFor()`.

Each of `src/agents/{general,svc_03,svc_04,svc_06}/index.mjs` returns a frozen
definition that **extends** the call-1 profile (asserted by identity:
`agent.runtimeProfile === getAgentProfile(agentId)`) and adds: the rendered system
prompt, `toolAllowlist`, a `policy` view (including the frozen boundary object),
the dataset pointer, the evaluation suite list with the documented fixture
counts, and a `caseAdapter(vars)` that turns dataset facts into the structured
`evidence` the boundary rules decide on. It never reads the expected answer to
build that evidence.

| Agent | task type | tools | boundary | prompt of record |
| --- | --- | --- | --- | --- |
| `svc_03` | `invoice_reconciliation` | `query_po_database`, `calculate_tax_variance`, `request_human_approval` | $500.00 ceiling, verified PO, zero variance | `prompts/svc_03/invoice_agent.md` (+ guardrail) |
| `svc_04` | `security_triage` | `query_alert_context`, `check_ip_allowlist`, `create_incident_ticket`, `request_analyst_review` | level-12 ceiling, exact allowlist, corroboration | `prompts/svc_04/security_triage_agent.md` |
| `svc_06` | `paper_trading` | `get_portfolio_state`, `get_market_quote`, `submit_paper_order`, `request_human_review` | $10k cap, -$1k halt, ticker allowlist, long-only, paper only | `prompts/svc_06/paper_trading_agent.md` |
| `general` | `general_assistance` | `no_op` + the six read-only tools | **none** — the generic kernel only | authored in `src/agents/general/index.mjs#GENERAL_SYSTEM_PROMPT` (no file added to `prompts/`) |

The general agent holds only `*:read` grants and no write or escalation tool, so
everything constraining it is generic kernel behaviour: allowlist, permission,
data access, the injection scan, the rate limit and the engine's fail-closed
default. One consequence is stated rather than hidden: an *action* the general
agent proposes that no rule authorises is `DENY` from `engine.default`. Its normal
output is text plus read-only tool use, which needs no action approval. It runs a
real multi-step task offline (`offlineScenario()`: `market_and_portfolio`,
`invoice_and_alert_lookup`).

### 7.6 Evaluation harness — `src/evaluation/`, `scripts/eval-runtime.mjs`

| Module | What it is |
| --- | --- |
| `src/evaluation/runner.mjs` | `runSuite({ agentId, datasetPath, fixture, storageDir })` and `runCase()`: drives the REAL runtime (state machine, executor, policy kernel, approval gate, stores) for one dataset under one fixture, and produces per-case records `{ caseIndex, description, expectedAction, actualAction, decision, policyDecision, policyRule, toolCalls, iterations, state, latencyMs, passed, assertions[], plan, planned, usage }` plus an aggregate. Also `createEvaluationRuntime()`, `loadDatasetFile()`, `scenarioDataset()`, `scenarioScript()`, `isInjectionCase()`. |
| `src/evaluation/assertions.mjs` | A deliberate mirror of `evals/assertions/{action_matches,triage_matches,trade_matches}.mjs` (same `extractDecision`, same last-balanced-object rule, same reason strings — pinned side by side against the originals in `tests/unit/evaluation-assertions.test.mjs`), plus this call's own assertions: tool selection, tool arguments, policy consistency, unsafe-proposal denial, injection detection, evidence grounding, completion, plan execution, memory retrieval, context quality, latency, cost, regression. |
| `src/evaluation/mock-scripts.mjs` | The oracle and naive fixtures per agent, derived from the datasets' `vars` exactly as `evals/providers/*.mjs` do: the oracle replays `expected_action`; the naive one is a line-by-line port of the promptfoo naive providers (same regexes, same data slice). `deriveToolCalls()`, `plannedSteps()`, `nonTerminatingPlan()`, `oracleScript()`, `naiveScript()`. |
| `src/evaluation/suites.mjs` | `SUITE_DEFINITIONS` (the fourteen required names), `runDeterministicSubSuites()` (memory retrieval and context quality), `buildSuites()`, `evaluateAgent()` — the per-agent report the CLI writes. |
| `src/evaluation/storage.mjs` | `tempStorageDir()`, `fixedClock()` — `src/` may not import from `tests/`. |
| `scripts/eval-runtime.mjs` | The CLI: `npm run eval:runtime`, `npm run eval:runtime:oracle`. Writes `data/state/evals/runtime-results.json` (gitignored), prints the tables below, exits non-zero unless every agent's oracle is 12/12 with no failing assertion and the naive fixture reproduces its documented count. |

**Suites (all fourteen reported, even when empty), and what each is worth:**

| Category | Cases offline | Covered deterministically | Needs a live model for a real verdict |
| --- | --- | --- | --- |
| `task_correctness` | 24 per SVC agent | oracle + naive, graded by the mirrored assertion | yes |
| `tool_selection` | 48 | allowlist + case-relevant tools | yes |
| `tool_arguments` | 48 | every executed call validated against its input schema | yes |
| `planning` | 84 | the planned loop, plan accounting, planned disposition | yes |
| `safety` | 28-31 | the kernel verdict on the autonomous disposition, unsafe proposals refused | no |
| `prompt_injection_resistance` | 8-12 | the heuristic scan, the denial, the escalation tool through the real gate | yes (the scan is deterministic) |
| `policy_compliance` | 12 | the kernel verdict against the boundary mapping | no |
| `hallucination` | 36 | evidence grounding of the decision object | yes |
| `memory_retrieval` | 10 | five kinds + events + two hostile-store paths + a corrupt line | no |
| `context_quality` | 5 | assembly, tool narrowing, priority trimming, labelled truncation, overflow | no |
| `task_completion` | 24 | terminal state + recorded output | no |
| `regression` | 2 | the documented fixture counts themselves | no |
| `latency` | 24 | per-case wall clock against a 5s bound — a bound, not an SLO | no |
| `cost` | 24 | token accounting against the run budget | no (mock usage) |

**The harness provably discriminates.** Running the same 12 cases through the real
runtime, the oracle reaches the dataset's expected action 12/12 with every
assertion clean, and the naive fixture is wrong on exactly the documented number
of cases:

| Agent | oracle | naive | documented naive | naive's unsafe proposals refused by the kernel |
| --- | --- | --- | --- | --- |
| `svc_03` | 12/12 | 3/12 | 3 pass / 9 fail | 7 of 7 |
| `svc_04` | 12/12 | 5/12 | 5 pass / 7 fail | 4 of 4 |
| `svc_06` | 12/12 | 3/12 | 3 pass / 9 fail | 7 of 7 |
| `general` | 2/2 scenarios | n/a (no fixture) | — | — |

Those naive counts are the same numbers `package.json` already requires from the
promptfoo offline fixtures (9, 7 and 9 failures), so a drift in either direction
fails a gate.

**The action goes through the real kernel.** `run.evaluateAction()` returns the
verdict for the action the agent actually produced, and the oracle's verdict must
match the agent's boundary (SVC_03 `ALLOW` only at or below $500.00 with a verified
PO and zero variance; SVC_04 `ALLOW` on a close only below level 12 with an exact
allowlist match and a verified pattern; SVC_06 `ALLOW` only within the cap, on the
allowlist, long-only and above the halt). One interaction is reported rather than
smoothed over — see §7.8 item 6.

### 7.7 What changed in call-1 code, and why

Five real defects were found by writing these tests, and fixed:

1. **`src/tools/executor.mjs` ignored `toolTimeoutMs`.** The run handle passed a
   per-call timeout that the executor never read, so a caller could not shorten a
   wait. Precedence is now per-call → tool declaration → executor default.
2. **A rejected, expired or mismatched approval could be reported as the pending
   one.** A call whose approval covered *different* arguments returned that
   approval's id alongside `APPROVAL_REQUIRED`. The executor now reuses an approval
   only when it is bound to exactly these arguments (fingerprint match); a changed
   request mints a new pending approval. (A rejected approval for the *same*
   arguments is still reused, not re-queued — that call-1 property is deliberate
   and its test still passes.)
3. **`approvals.listPending()` did not hydrate.** After a restart the queue was
   empty until something called `list()` — an operator would have read that as
   "nothing is waiting".
4. **`runStore.health()` threw on an unreadable collection**, i.e. it exploded on
   the condition it exists to report. It now reports `{ readable: false, error }`
   per collection.
5. **An action verdict left no record.** `run.evaluateAction()` evaluated through
   the kernel without emitting anything, so "this disposition was refused" — the
   enforcement that matters most — was absent from the event stream, the trace and
   the audit. It now emits `policy.decided` (kind `action`) and a `policy_check`
   span.

Two additions to `src/runtime/run.mjs`: **cooperative cancellation**
(`run.cancel(reason)`, checked between iterations, plus
`STOP_REASONS.CANCELLATION_REQUESTED`) and the **non-throwing memory read**
described in §7.3. `createRuntime()` also gained two additive options, `tools` and
`profiles`, so a deployment (and the failure-matrix tests) can add a tool or an
agent without editing the built-in set — a supplied profile may add an id but
never shadow a frozen one. `SPAN_TYPES` gained `PLAN`, `PLAN_STEP` and `CONTEXT`;
`STOP_REASONS` gained `CONTEXT_OVERFLOW` and `CANCELLATION_REQUESTED` (neither is
produced by `createBudgetTracker().check()`, and both say so in the module).

### 7.8 Known limitations of this call

1. **The HTTP surface is still not wired.** `/api/simulate` returns the simulation
   unchanged; there is no run API, no approval queue UI and no trace view. Call 3.
2. **The planner mirrors the policy kernel's checks; it does not call it.** Plan
   validation duplicates the allowlist/permission/data-access logic rather than
   asking the kernel, because the kernel evaluates a *call*, not a plan. The
   executor remains the only control that can authorise execution.
3. **"Summarisation" is deterministic truncation.** No model is called inside
   window assembly, by design. `SUMMARIZER.llm === false` says so in code.
4. **Memory retrieval is exact/latest-wins/keyword overlap.** No vector search, no
   embeddings, no dependency that would provide them. Keyword overlap is a filter
   (any shared term qualifies), not a similarity threshold — stated in
   `RETRIEVAL_MODEL.note` and pinned by test.
5. **Redaction's value heuristic is anchored, so an embedded credential in prose
   survives.** `src/observability/redact.mjs` documents `{"note": "key is sk-abc123"}`
   as a case the value heuristic catches; the patterns are `^…$` anchored, so it
   does not. Key-based redaction (the guarantee) is unaffected.
   `tests/unit/memory-kinds.test.mjs` pins the real behaviour rather than the
   claim. Left unchanged here because changing redaction is a call-1 behaviour
   change with its own test surface.
6. **An override attempt denies EVERY action on that payload, including a safe
   escalation disposition.** `untrusted.prompt_injection` (priority 14) fires on
   `kind: 'action'` and the kernel takes the most restrictive decision, so
   `request_human_approval` on injected input is `DENY`, not `REQUIRE_APPROVAL`.
   The escalation path remains reachable as a *tool* (the rule explicitly allows
   `escalation: true` tools), which the injection suite proves by running it
   through the real executor. Stricter than the boundary, never more permissive —
   but it means an injected payload can suppress the agent's own disposition
   record — and the harness reports the interaction explicitly
   (`assertPolicyConsistent(..., { injectionDetected: true })`).
7. **The general agent has no disposition contract.** Its `task_correctness` suite
   has zero cases and its disposition assertions are reported as *skipped*, not as
   passes — a pass that verified nothing would be exactly the decoration the
   harness exists to avoid.
8. **Cancellation is cooperative, not preemptive.** `run.cancel()` stops the loop at
   the next iteration; it does not interrupt a tool or a model call already in
   flight, because a plain JS function cannot be cancelled. `runTool()` still does
   not thread an `AbortSignal` from the run into the executor, so a long tool call
   runs to its timeout.
9. **Live model paths remain unverified in this environment.** No API key is
   configured, so the OpenAI/Anthropic adapters have still only run against an
   injected `fetch`. Every offline result here is evidence about the runtime, the
   kernel and the harness — never about a real model.
10. **The latency and cost suites are accounting, not SLOs.** Latency is a 5-second
    offline bound per case; cost is the mock's own token accounting against the run
    budget. Neither predicts production behaviour or spend.
11. **`eval:runtime --oracle` runs only the oracle.** The naive discrimination has
    its own gate (`npm run eval:runtime`); a green oracle-only run says nothing
    about whether the assertions can still fail.
12. **The n8n export and the policy kernel are still parallel implementations** of
    the same SVC_03 policy. Nothing in this call touches `n8n_exports/`.
13. **The promptfoo npm scripts do not run under npm on Windows.** `rm -f x; cmd`
    chains written for bash are re-parsed by `cmd` (`rm: unknown option -- c`), and
    the trailing `|| true` hides it. The underlying commands work when run
    directly:

    ```
    npx promptfoo eval -c evals/promptfooconfig.offline.yaml --no-cache --no-table --filter-providers oracle -o oracle-results.json
    node evals/check_results.mjs oracle-results.json --require-all-pass
    ```

14. **Nothing prunes `data/state/`.** The evaluation CLI writes its report there
    (gitignored); the JSONL stores still grow until deleted.
15. **The planner's ceilings are not in the agent profile.** `maxSteps`,
    `maxReplans` and `maxStepAttempts` can be set per run
    (`createAgentRun({ planning })`) or per planner, but not declaratively in
    `src/config/agents.mjs`. Adding them there is a small, obvious change.
16. **`run.memory.list()` does not emit `memory.retrieved`.** It is the inspection
    read; only `recall()` claims a retrieval. Documented in `src/memory/kinds.mjs`
    and pinned by test.
17. **A tool's own declared timeout cannot be shortened by a caller.** Precedence is
    per-call → tool → default, so a tool that declares a long timeout keeps it.
    Deliberate (the tool's author knows its work) and documented in
    `src/tools/executor.mjs`.
18. **Call-1 injection false positives are still call-1 behaviour.** One trading
    dataset case (`undeterminable_size`) trips the heuristic scan on prose that
    mentions sizing the order, so its action-level verdict is `DENY` on the
    injection rule rather than the boundary rule. Reported in the harness rather
    than patched here, because tuning the scanner is a change to a control with its
    own test surface.

### 7.9 Interfaces call 3 should use

```js
import { createRuntime, loadAgent, listAgentIds, runAgentCase } from './src/index.mjs';
import { runSuite, evaluateAgent, FIXTURE_KIND } from './src/evaluation/index.mjs';

const runtime = createRuntime({ storageDir, fixturesDir, config, rules, mockScript, now,
                                tools, profiles, promptsDir });

// agents (reuse the frozen profiles; never fork them)
const agent = runtime.loadAgent('svc_03');       // = loadAgent('svc_03')
agent.prompts.systemFor(vars); agent.toolAllowlist; agent.policy.boundary;
agent.dataset.path; agent.evaluation.suites; agent.caseAdapter(vars);

// runs
const run = runtime.createRun({ agentId, taskType, complexity, provider, sessionId, runId,
                                planning, contextBudget });
run.loop({ mode: 'model' | 'planned', systemPrompt, userMessage, task, context, plan, steps,
           maxTurns, untrusted, evidence, responseFormat });
run.plan({ goal, steps }); run.buildContext(request); run.planner; run.context; run.memory;
run.cancel(reason); run.recall(query); run.remember(record);
run.evaluateAction(action, evidence, untrusted);
run.runTool(name, args, { untrusted, evidence, approvalId, toolTimeoutMs });
run.finish({ status, output, reason });

// memory kinds
run.memory.forKind('episodic').write({ key, value, tags, scopeId });
run.memory.recall({ text, keys, tags }, { kind, limit }); run.memory.list({ kind });
runtime.memoryKinds.stats();

// prompts
runtime.renderAgentPrompt('svc_04', vars); runtime.promptRenderer.load('svc_03/guardrail.md');

// approval queue (call 3's UI)
runtime.approvals.listPending(); runtime.approvals.get(id);
runtime.approvals.approve(id, { resolvedBy }); runtime.approvals.reject(id, { resolvedBy, note });
runtime.runStore.listApprovals({ status }); runtime.runStore.listRuns({ limit });

// evaluation
await runSuite({ agentId: 'svc_03', fixture: 'oracle' });
await evaluateAgent({ agentId: 'svc_03' });      // + the fourteen suites and the gate
```

New npm scripts: `eval:runtime` (oracle + naive gates, all agents),
`eval:runtime:oracle` (oracle only). `npm run gate:runtime` now runs
`test:unit && test:integration && verify:runtime && eval:runtime`.

Expected, reproducible results for those scripts are the tables in §7.6: oracle
12/12 per SVC agent with no failing assertion; naive 3/5/3 passes (9/7/9 failures),
which is what `evals/README.md` already documents.

## 8. Call 3 — the HTTP API, the operator console, and the gap list

Call 1 built the core; call 2 built planning, context, memory kinds, the agent
profiles and the evaluation harness. Call 3 adds the surface a person operates,
and it adds it without a second server, a second policy path or a second source
of truth.

### 8.1 What call 3 added

| Path | What it is |
| --- | --- |
| `src/api/router.mjs` | the route table, request parsing, the response envelope, the error mapping, request ids, the body limit and the redaction of every response. Framework-free: `handle()` maps a parsed request to a serialised response, and returns `null` for a non-runtime path so the caller keeps its own routing |
| `src/api/errors.mjs` | `ApiError`, the error codes and the ONE code→status table. A handler cannot pick a status |
| `src/api/serialize.mjs` | every response projection. Explicit field lists rather than raw internals, and `boundarySummary()` built from the frozen `BOUNDARIES` object so a summary cannot go stale against the control it describes |
| `src/api/offline.mjs` | the offline provider's script, and the only place in the API that decides what the model "proposed": the oracle fixture for a payload that matches a dataset case, the naive fixture otherwise, the general agent's own scenario or a labelled text turn, plus the derived rule that a "hand it to a human" disposition is proposed as the agent's escalation TOOL call so the approval gate is reachable offline |
| `src/api/handlers/{health,agents,runs,approvals,tools,policies,evaluations}.mjs` | one module per resource. `runs.mjs` also owns the run queue and the in-flight registry |
| `src/api/index.mjs` | the library entry point |
| `public/runtime.html`, `public/runtime.css`, `public/runtime.js` | the operator console: six views, no dependency, keyboard operable, responsive through `rem`/`ch` units and one 60rem breakpoint |
| `tests/integration/api.test.mjs` | 27 tests over a real socket: every endpoint, every status-code class, the full approval round trip, and a restart |
| `scripts/verify-runtime.mjs` §12 | 22 API invariants added to the existing gate (62 → 84 checks) |
| `src/runtime/run.mjs` | `pause()` — a run stopped at a human gate is recorded NON-TERMINAL; and `approvalId` threaded through both loops so a granted approval can be resumed |
| `src/observability/events.mjs`, `src/observability/audit.mjs` | `run.paused`, and `run.cancelled` as an audit type |
| `server.mjs` | refactored into `createRequestHandler()` / `startServer()` so it is testable, with the runtime mounted LAZILY behind `/api/runtime` and the `/console` alias checked before the static fallback. Every legacy branch is byte-for-byte the call-1 code |
| `docs/GOAL.md`, `docs/HANDOVER.md`, `docs/VERIFICATION.md` | goal and scope; the handover; the acceptance-criteria verification report |

### 8.2 The three decisions worth recording

**1. A paused run is not a finished run.** `finish()` coerces any non-terminal
status to `COMPLETED` and ends the root span as an error; neither is true of a
run waiting for a human. Rather than relax `finish()`, call 3 added `pause()`,
which writes the run row with the status the machine is actually in, leaves the
machine in `WAITING_FOR_APPROVAL`, ends the span `pending` and writes a
`run.paused` audit row. That is what makes `POST /runs/:id/cancel` (409 when
terminal) and the approval round trip meaningful instead of decorative.

**2. The offline proposal is a fixture, and every response says so.** The default
provider is the deterministic double, so something must script it. That
something is `src/api/offline.mjs`, built only from fixtures the repository
already gates on (`src/evaluation/mock-scripts.mjs`), and every run response
carries `providerIsMock`, `scriptedBy` and an `offlineNote`. The alternative —
writing a "reasonable" decision function in the API layer — would have put
invented reasoning behind a real-looking response.

**3. Field names are part of the security contract.** `redact()` blanks the
*value* of any key whose words contain a secret word. The health endpoint's first
draft returned `credentialPresent: false` and came back as
`credentialPresent: "[REDACTED]"`, because `credential` is in
`SECRET_KEY_WORDS`. Renamed to `configured`. The lesson is in the module: a
boolean an operator needs must not be named after a secret.

### 8.3 Interfaces call 3 exposes (call 4 should use these)

```js
import { createRuntimeApi } from './src/api/index.mjs';

const api = createRuntimeApi({ runtime, now, reportPath, apiVersion });
await api.handle({ method, pathname, searchParams, rawBody, tooLarge, requestId });
//   -> null                                             not a runtime path
//   -> { status, headers, body }                        serialised, redacted JSON
api.routes; api.describe(); api.prefix;                  // RUNTIME_API_PREFIX

// the run handle gained two things:
run.pause({ reason, approvalId, output });               // non-terminal record
run.loop({ mode, steps, approvalId, /* … */ });          // resume a gated call

// every request a caller may send:
//   POST /api/runtime/agents/{id}/runs   { input, provider?, taskType?, planning?, sessionId?, approvalId? }
//   GET  /api/runtime/{health,agents,runs,runs/:id,runs/:id/events,tools,policies,evaluations,approvals}
//   POST /api/runtime/runs/:id/cancel
//   POST /api/runtime/approvals/:id/{approve,reject}
```

The offline fixture layer is a library too:
`buildOfflinePlan({ runtime, agentId, input, mode })` and
`validateScriptAgainstSchemas(runtime, script)` — the second is the invariant
that keeps a scripted call from violating the schema of the tool it names, and
`verify:runtime` runs it over every dataset case in both modes.

### 8.4 Final gap list

Closed during call 3: "there is no HTTP gateway, so nothing outside a process can
start or inspect a run"; "an approval can be created but no operator can see or
resolve the queue"; "a run that stops at a gate has no persisted representation";
and the console the call-2 notes called "the dashboard run view".

Still open, in priority order:

1. **No authentication or authorisation on the API.** Anyone who can reach the
   port can start runs, approve approvals and cancel runs. The server binds to
   localhost by default and the API is read-mostly, but this is the first thing
   to fix before the port is reachable from anywhere else. It needs its own
   threat model (who counts as an approver, and how that identity is bound to
   `resolvedBy`), which is why it was not improvised here.
2. **No streaming.** `GET /runs/:id/events` is a persisted read. A live operator
   view wants SSE; the event bus already supports listeners, so the work is in
   the HTTP layer (and in deciding what happens to a client that disconnects
   mid-run), not in the runtime.
3. **Live-model runs are unverified.** No key in this environment. The refusal
   path is verified; the live path through the API has never been exercised end
   to end.
4. **Multi-agent hand-off** is still absent. The `general` agent has no way to
   delegate to an SVC agent; that needs a `delegatesTo` concept on the profiles
   and a rule that enforces it.
5. **Approval expiry through the API** is untested at the HTTP layer (the TTL is
   24h by default; the approval manager's own unit tests cover the branch).
6. **The run list reads the whole `runs.jsonl`** and caps at 500 rows per
   request. A store with tens of thousands of runs wants an index.
7. **Two pending approvals can describe the same invoice.** Approving a gated
   `request_human_approval` call lets the tool run, and that tool records its own
   queue entry. It is the call-1 tool's documented behaviour and it is reported
   as-is (handover §10 item 6), but a reviewer will ask about it, and the cleaner
   fix — the tool recognising that the gate already queued the decision — is
   worth doing.
8. **`POST /api/simulate` is still a simulation** on the legacy dashboard. It is
   labelled (`simulated`, `deprecated`) and left alone on purpose: rewiring it
   would change the dashboard's behaviour, which call 3 was told not to do.
9. **No browser render verification of the console** in this call (no browser
   backend was available). The structure is asserted by test; a human should
   still open `/console` once.
