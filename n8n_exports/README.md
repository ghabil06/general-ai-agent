# n8n export: SVC_03 invoice agent

An importable n8n workflow that runs the SVC_03 accounts-payable agent with
the prompt **fetched from this repo, never pasted**, the $500 guardrail
enforced **twice**, and every decision logged for **shadow mode** parity
review.

| File | Purpose |
| --- | --- |
| `svc_03_invoice_agent.json` | The workflow. Imports into any recent n8n (1.60+ tested shape) |
| `audit_log.sql` | Schema for `agents.audit_log`. Run once before first execution |
| `validate_workflow.mjs` | Lint gate: `npm run lint:n8n`. Fails CI if the export loses its guardrail, its audit sink, or its shadow-safe defaults |
| `test_parse_nodes.mjs` | Executable gate: `npm run test:n8n`. Extracts the workflow's Code nodes and runs them against adversarial inputs (decoy JSON, unparseable output, SQL-injecting invoice refs) |

The prompt itself is not stored here. The workflow downloads it on every
execution from
`https://raw.githubusercontent.com/ghabil06/general-ai-agent/main/prompts/svc_03/invoice_agent.md`.
To pin a version, replace `main` in the "Fetch prompt from GitHub" node with a
commit SHA or release tag. If the fetch fails, the workflow stops — it never
falls back to a stale pasted copy.

## Import

1. n8n → Workflows → Import from File → `svc_03_invoice_agent.json`.
2. Create the two Postgres credentials (PO database — read-only — and the
   audit database) and the OpenAI credential, and attach them to the nodes
   that import with a `REPLACE_ME` credential.
3. Set the environment variables below on the n8n instance.
4. Run `audit_log.sql` once against the audit database.
5. Activate the workflow. Note the production webhook URL.

The AI Agent's chat model ships as an OpenAI node pinned to `gpt-4o-mini` as a
placeholder. **Pin the same model family you evaluated.** The evals in
`promptfooconfig.yaml` are the only reason the prompt is trusted; a model that
never ran those 12 cases has no such record.

### Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `SLACK_APPROVAL_WEBHOOK_URL` | `request_human_approval` tool + "Notify approvals" | Slack incoming webhook for the #ap-approvals channel |
| `SLACK_BREACH_WEBHOOK_URL` | "Slack - GUARDRAIL BREACH" | Slack incoming webhook for the #engineering-alerts channel |
| `ACCOUNTING_API_URL` | "Accounting write" / "Flag invoice" | Base URL of the accounting system API (LIVE ONLY nodes, disabled on import) |
| `AGENT_MODE` | "Build audit row" | `shadow` (default when unset) or `live` — stamped on every audit row |

### Webhook payload contract

```json
POST /webhook/svc_03-invoice
{
  "invoice_text": "Invoice #101. Amount: $450.00. PO #990 ...",
  "invoice_ref": "INV-2026-000101",
  "vendor": "Acme Ltd",
  "amount": 450.00
}
```

`invoice_text` is required — it is substituted into the prompt. The structured
`amount` is what the deterministic guardrail checks; if it is absent the
workflow falls back to the first `$` figure in the text and stamps the audit
row with `amount_source = regex_from_text`. Production callers should always
send the structured field: a regex reading invoice prose is a fixture trick,
not a control.

## The two layers of the $500 boundary

1. **In language.** The system prompt's decision precedence tells the model
   never to auto-approve above $500. That is the evaluated, version-controlled
   layer — it is why the prompt is trusted at all.
2. **In code.** The "GUARDRAIL - 500 check" IF node re-checks the parsed
   decision: `action == 'auto_approve' AND amount > 500` routes to the breach
   Slack channel and then to manual review, never to the accounting write.
   The check reads fields from the "Parse decision" node, which extracts the
   agent's **last** balanced JSON object — the same parser as
   `evals/assertions/action_matches.mjs`, so a stray JSON-ish fragment in the
   model's reasoning cannot fool either the CI eval or the workflow.

A prompt is a policy statement; this node is the control. The eval suite
proves the prompt obeys policy on 12 known cases; the IF node proves nothing
gets paid above $500 even on the cases nobody tested.

"Parse decision" also maps any unparseable agent output to `action =
"unparseable"`, which the Switch routes straight to the audit log for review —
an unparseable answer is never allowed to look like an approval.

## Shadow mode (do this first)

On import, "Accounting write (LIVE ONLY)" and "Flag invoice (LIVE ONLY)" are
**disabled**. Nothing reaches the accounting system. Everything reaches
`agents.audit_log`.

1. **Week 1 — replay history.** Feed last month's real invoices through the
   webhook (a small script posting one invoice per request is enough).
2. **Score parity.** For each row, set `human_action` to what the accounting
   team actually did, and mark `parity`:

   ```sql
   UPDATE agents.audit_log
   SET human_action = 'request_human_approval'   -- from the team's records
   WHERE invoice_ref = 'INV-2026-000101';
   ```

3. **Read the numbers.**

   ```sql
   -- Overall parity
   SELECT COUNT(*)                                   AS decisions,
          SUM(CASE WHEN parity THEN 1 ELSE 0 END)    AS agreed,
          ROUND(100.0 * SUM(CASE WHEN parity THEN 1 ELSE 0 END)
                / NULLIF(COUNT(*), 0), 2)            AS pct_agreement
   FROM agents.audit_log
   WHERE svc = 'svc_03' AND mode = 'shadow';

   -- Every disagreement, worst first
   SELECT invoice_ref, amount, agent_action, human_action, agent_reasoning
   FROM agents.audit_log
   WHERE svc = 'svc_03' AND mode = 'shadow' AND parity = FALSE
   ORDER BY created_at;

   -- Deterministic breaches (the database computes this, not n8n, not the model)
   SELECT invoice_ref, amount, agent_action
   FROM agents.audit_log
   WHERE svc = 'svc_03' AND breach;
   ```

   `breach` is a `GENERATED ALWAYS` column: `auto_approve` on an amount over
   500 is a breach by definition, even if every other layer failed.

4. **Investigate disagreements the way you would investigate a test
   failure** — is the prompt wrong, the model wrong, or the human wrong?
   Prompt fixes go through the repo, the evals, and a commit. Never edit the
   fetched prompt inside n8n.

## Cutover checklist (shadow → live)

- [ ] At least one week of shadow traffic, `pct_agreement` at or above the
      bar the business set (the target discussed was 99%)
- [ ] Zero `breach` rows, or every breach investigated and explained
- [ ] Every `unparseable` row explained (fetch failures, model outages)
- [ ] Prompt fetch pinned to a commit SHA or release tag, not `main`
- [ ] Eval gates green on the pinned revision: `npm run gate`
- [ ] Accounting API endpoints tested against a sandbox
- [ ] Set `AGENT_MODE=live`, enable the two LIVE ONLY nodes, save

Rollback is one toggle: disable the LIVE ONLY nodes. The audit log keeps
running either way.
