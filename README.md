# Larptech Agent Prompts

Version-controlled prompts and evaluation cases for a bounded-agency accounts-payable reconciliation agent.

## Layout

- `prompts/svc_03/invoice_agent.md` — system prompt for the n8n AI Agent node.
- `prompts/svc_03/guardrail.md` — secondary compliance prompt for validating proposed actions.
- `evals/invoices_dataset.json` — adversarial invoice cases for Arena.ai, Promptfoo, or LangSmith.
- `prompts/svc_01/` — reserved for future marketing-agent prompts.
- `n8n_exports/` — reserved for future n8n workflow exports.

## Use

1. Connect this repository to Arena.ai.
2. Run `evals/invoices_dataset.json` against the models you want to compare.
3. Iterate on the prompts while keeping the hard approval boundary intact.
4. In n8n, load the raw `invoice_agent.md` content into the AI Agent system prompt and run the compliance guardrail before any approval webhook.

The $500 boundary should also be enforced deterministically in the workflow, not only in a language-model prompt.
