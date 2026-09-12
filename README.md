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
