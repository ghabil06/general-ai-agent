# Larptech Agent Prompts

Version-controlled prompts and evaluation cases for a bounded-agency
accounts-payable reconciliation agent.

## Layout

- `promptfooconfig.yaml` — eval config. Live models, real spend.
- `prompts/svc_03/invoice_agent.md` — system prompt for the n8n AI Agent node.
- `prompts/svc_03/guardrail.md` — secondary compliance prompt for validating proposed actions.
- `evals/` — dataset, assertions, fixtures and the deterministic gate. See `evals/README.md`.
- `prompts/svc_01/` — reserved for future marketing-agent prompts.
- `n8n_exports/` — reserved for future n8n workflow exports.

## Evaluate before you deploy

```bash
npm ci

node evals/validate_dataset.mjs   # gate 1: dataset/template/config consistency, no API keys
npm run eval:offline              # gate 2: assertions can still fail, no API keys
npm run eval                      # gate 3: live models. needs OPENAI_API_KEY / ANTHROPIC_API_KEY
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
