# Larptech Agent Prompts

Version-controlled prompts and evaluation cases for bounded-agency agents:
an accounts-payable reconciliation agent (SVC_03), a Wazuh security-triage
agent (SVC_04), and a paper-trading agent (SVC_06) — bounded to the simulated
account, with no real-money routing path anywhere.

## Layout

- `promptfooconfig.yaml` — SVC_03 eval config. Live models, real spend.
- `promptfooconfig.security.yaml` — SVC_04 eval config. Live models, real spend.
- `promptfooconfig.trading.yaml` — SVC_06 eval config. Live models, real spend.
- `prompts/svc_03/invoice_agent.md` — system prompt for the n8n AI Agent node.
- `prompts/svc_03/guardrail.md` — secondary compliance prompt for validating proposed actions.
- `prompts/svc_04/security_triage_agent.md` — system prompt for the security-triage AI Agent node.
- `prompts/svc_06/paper_trading_agent.md` — system prompt for the paper-trading agent. Paper account only.
- `evals/` — datasets, assertions, fixtures and the deterministic gates for all three agents. See `evals/README.md`.
- `prompts/svc_01/` — reserved for future marketing-agent prompts.
- `n8n_exports/` — importable n8n workflow for SVC_03 (dynamic prompt fetch, deterministic guardrail, shadow-mode audit log). See `n8n_exports/README.md`.
- `src/` — the agent runtime: state machine, budgets, model router and providers, tool registry and executor, a policy kernel with the SVC boundaries as code, approvals, JSONL stores, events/traces/audit and memory. See `docs/ARCHITECTURE.md`.
- `src/runtime/bounded-agent.mjs`, `src/runtime/envelope.mjs` — the bounded tool-calling state machine for general-purpose agents (`runtime.boundedAgent().execute(task)`) and the execution envelope (hard ceilings) it runs inside. See "Bounded general agents" below.
- `src/api/` — the runtime HTTP API as a library (router, handlers, response projections, the offline fixture layer). Mounted by `server.mjs` behind `/api/runtime`.
- `public/` — `index.html`/`app.js`/`style.css` are the original animated dashboard; `runtime.html`/`runtime.js`/`runtime.css` are the operator console served at `/console`.
- `docs/ARCHITECTURE.md` — repository audit (what is real, simulated, configuration-only or missing) and the target architecture map.
- `docs/GOAL.md`, `docs/HANDOVER.md`, `docs/VERIFICATION.md` — the goals and acceptance criteria (calls 3 and 4), the handover, and the verification reports.
- `server.mjs` — the single HTTP entry point: the dashboard, the legacy simulation and the runtime API.
- `data/fixtures/` — hand-authored fixtures derived from the eval datasets, each with a provenance block. `data/state/` holds runtime artefacts and is not committed.

## Runtime checks

The prompt/eval gates below are unchanged. The runtime adds its own offline gates:

```bash
npm test               # 232 unit tests, no network, no keys
npm run test:integration   # 10 end-to-end offline runs, all three agents
npm run verify:runtime     # builds a runtime, runs a full agent run, 32 invariant checks
```

> **Note (call 3):** those counts are from the first runtime call and are out of
> date. The current numbers are unit **333**, integration **81**, API **27**,
> `verify:runtime` **84 checks**, `eval:runtime` **all gates passed** — measured
> on Node v22.22.0 and recorded in `docs/VERIFICATION.md`.
>
> **Note (call 4):** now unit **388** (one pre-existing failure on POSIX — fixed in
> batch B1, see the next note), integration **114**, `verify:runtime` **103 checks**,
> `eval:runtime` unchanged. `npm run test:bounded` runs the 88 bounded-execution tests
> on their own.
>
> **Note (batch B1):** unit **398**, all passing on POSIX — the one pre-existing failure
> is fixed. A Windows-rooted prompt template path (`C:/x`, `C:\x`, `\\server\share`, `\x`)
> is now refused with `PROMPT_PATH_ESCAPE` on **every** host, not only on Windows;
> `tests/unit/prompts-path-containment.test.mjs` pins it. See `docs/ARCHITECTURE.md` §7.4
> and `docs/VERIFICATION.md` §7.

## Runtime API and operator console (call 3)

The runtime is served over HTTP and can be operated from a browser.

```bash
node server.mjs      # or: npm start
```

| URL | What it is |
| --- | --- |
| http://localhost:3000/ | the original dashboard (unchanged) |
| http://localhost:3000/console | the operator console: agents, runs, approvals, tools, policies, the last evaluation report |
| http://localhost:3000/api/runtime/health | the API's own health payload |

- **HTTP API** — `src/api/`, mounted behind `/api/runtime`: list and start runs,
  read a run's decision, state timeline, policy verdicts, tool calls, trace and
  audit rows, resolve the approval queue, inspect the tool registry and the
  policy inventory, and read the last `eval:runtime` report. JSON in and out,
  structured errors, a request id on every response, and no secret in any
  response. No new dependency; `server.mjs` is still a plain `node:http` server.
- **Default provider is the deterministic double.** A run started offline
  replays a repository fixture for the *proposal* while the state machine, tool
  executor, policy kernel, approval gate and stores are the real runtime. Every
  response says which fixture it used (`scriptedBy`), and
  `POST /api/runtime/agents/svc_03/runs` with `"provider":"openai"` (and a key
  configured) is a real, paid model call. A provider with no credential is a
  `503`, never a silent fallback.
- **The offline approval round trip works end to end:** a disposition that hands
  the decision to a human pauses the run on a real persisted approval, which the
  console can approve, after which the gated tool runs.

New npm scripts:

```bash
npm run test:api       # the HTTP API integration tests only (27 tests)
```

Everything else is unchanged, and `npm run gate:runtime`
(`test:unit && test:integration && verify:runtime && eval:runtime`) now includes
the API tests and the API invariants.

Documentation:

- `docs/GOAL.md` — the goal, the scope, and the acceptance criteria list.
- `docs/HANDOVER.md` — prerequisites, how to run it, how to run a live model,
  how to extend a tool/agent/boundary, where data lives, and the known
  limitations.
- `docs/VERIFICATION.md` — the acceptance criteria verified one row at a time,
  with the exact commands and the observed output.
- `docs/ARCHITECTURE.md` — the architecture audit, the runtime reference, and
  the "Call 3" section with the final gap list.

## Bounded general agents (call 4)

A general-purpose agent runs as a **bounded tool-calling state machine**: the model
proposes (a plan, a tool call, an answer) and deterministic code decides everything
else — the next state, whether a tool may run, whether the run may go on, how it ends.
It reuses the runtime's planner, tool allowlists, budgets, policy kernel, approval
gates and persisted traces; it adds no second loop.

```js
import { createRuntime } from './src/index.mjs';

// Offline the provider is a deterministic TEST DOUBLE that replays these proposals.
// With no script it has nothing to replay, and the run fails with PROVIDER_UNAVAILABLE.
const runtime = createRuntime({
  mockScript: [
    { text: JSON.stringify({ steps: [{ id: 's1', description: 'Get the AAPL quote', tool: 'get_market_quote', args: { ticker: 'AAPL' } }] }) },
    { text: 'AAPL quoted; summarised.' },
  ],
});
const result = await runtime.boundedAgent().execute({
  goal: 'Report the AAPL quote.',
  limits: { maxIterations: 6, wallClockMs: 30_000 }, // a request may only tighten a limit
});
// result.ok · result.status · result.answer · result.stopReason · result.envelope · result.record
```

- **No unbounded loop.** Every dimension has a hard ceiling in code that no environment
  variable, profile, request or API call can raise; every model and tool wait is raced
  against the run's remaining wall-clock; the state machine itself refuses a non-terminal
  move after N transitions; cancelling abandons a model call in flight.
- **Every run is recorded** — run row, trace tree and audit row — whether it completed,
  was blocked by policy, paused at an approval gate, hit a budget, timed out, was
  cancelled or hit an internal fault.
- **Honest about what it is not:** with the default provider the *proposals* come from a
  script, and the result says so (`provider.mock`, `notice`). No live model has been run
  from this environment.
- In this repository `svc_03` is the invoice agent; the general-purpose agent is
  `general`. `execute` runs `general` by default and any other profile on request.

Design, guarantees, the defects found in the shared runtime on the way, and the known
limitations: `docs/ARCHITECTURE.md` §9. Numbers and commands: `docs/VERIFICATION.md` §6.

## Evaluate before you deploy

```bash
npm ci

# Gate 1: dataset/template/config consistency, no API keys
node evals/validate_dataset.mjs            # SVC_03
node evals/validate_security_dataset.mjs   # SVC_04
node evals/validate_trading_dataset.mjs    # SVC_06

# Gate 2: assertions can still fail. No API keys, no cost.
npm run eval:offline              # SVC_03, broken fixture must fail exactly 9/12
npm run eval:offline:oracle       # SVC_03, oracle must pass 12/12
npm run eval:offline:security     # SVC_04, broken fixture must fail exactly 7/12
npm run eval:offline:security:oracle
npm run eval:offline:trading      # SVC_06, broken fixture must fail exactly 9/12
npm run eval:offline:trading:oracle

npm run gate                      # all of the above, plus the n8n export lint and tests

# Gate 3: live models. needs OPENAI_API_KEY / ANTHROPIC_API_KEY
npm run eval                      # SVC_03
npm run eval:security             # SVC_04
npm run eval:trading              # SVC_06
npm run view                      # browse the results
```

CI runs gates 1 and 2 on every push and pull request. Gate 3 runs on pushes to
`main` when model API keys are present as repository secrets.

Do not cut a release tag until gate 3 is green on both models.

## Feeding the prompt to n8n
Do not paste the prompt into the AI Agent node. Fetch it, so the repo stays the
single source of truth and every change stays audited.

**Node 1 — HTTP Request**

- Method: `GET`
- URL: `https://raw.githubusercontent.com/ghabil06/general-ai-agent/main/prompts/svc_03/invoice_agent.md`

**Node 2 — Set**

The prompt contains a `{{invoice_data}}` placeholder. n8n will **not**
substitute it for you: once the text arrives as data from the HTTP node, n8n
does not re-evaluate expressions inside it. Left alone, the model receives the
literal characters `{{invoice_data}}`.

Do the substitution explicitly, using a regex so you do not have to nest `{{`
inside an n8n expression:

```
system_prompt = {{ $json.body.replace(/[{]{2}\s*invoice_data\s*[}]{2}/g, $json.invoice_text) }}
```

Confirm the resolved value in the node's output before wiring it up.

**Node 3 — AI Agent**

Leave the System Prompt field typed as nothing and drag in `system_prompt` from
node 2.

Then run `prompts/svc_03/guardrail.md` over the agent's proposed action before
any approval webhook fires.

All of this is already wired up in `n8n_exports/svc_03_invoice_agent.json` —
import that workflow instead of rebuilding the nodes by hand. Importing,
credentials, shadow mode and the go-live checklist are documented in
`n8n_exports/README.md`.

## The $500 boundary is enforced twice

The prompt enforces it in language. Enforce it again in code, in the n8n
workflow, as a deterministic check on the parsed `action` and amount before the
approval webhook. A prompt is a policy statement; it is not a control.

## Model IDs rot

`promptfooconfig.yaml` pins model IDs, and they get retired without notice.
Confirm them before a release run:

```bash
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | jq -r '.data[].id'
curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | jq -r '.data[].id'
```

`claude-3-5-sonnet-20241022` was retired on 2025-10-28 and `gpt-4o` has been
withdrawn from ChatGPT; neither is a safe pin for new work.
