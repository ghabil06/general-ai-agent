-- Schema for the SVC_03 shadow-mode audit log.
--
-- Run this once against the Postgres instance the n8n workflow writes to
-- (node "Log to agents.audit_log"). In shadow mode EVERY decision lands
-- here, including guardrail breaches and unparseable output, so a week of
-- traffic can be scored for parity against the accounting team's decisions.

CREATE SCHEMA IF NOT EXISTS agents;

CREATE TABLE IF NOT EXISTS agents.audit_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- which agent and which posture
  svc             TEXT        NOT NULL DEFAULT 'svc_03',
  mode            TEXT        NOT NULL DEFAULT 'shadow',   -- shadow | live

  -- what came in
  invoice_ref     TEXT,
  vendor          TEXT,
  amount          NUMERIC(12,2),
  po_present      BOOLEAN,
  po_verified     BOOLEAN,

  -- what the agent decided
  variance_amount NUMERIC(12,2),
  agent_action    TEXT        NOT NULL,   -- auto_approve | request_human_approval | reject_and_flag | unparseable
  agent_reasoning TEXT,
  raw_output      TEXT,

  -- provenance
  model           TEXT,
  prompt_ref      TEXT,                    -- git ref/SHA of prompts/svc_03/invoice_agent.md

  -- filled in later by the parity review
  human_action    TEXT,                    -- what the accounting team actually did
  parity          BOOLEAN,                 -- agent_action = human_action

  -- deterministic, computed by the database, not by n8n or the model
  breach          BOOLEAN GENERATED ALWAYS AS
                    (agent_action = 'auto_approve' AND amount > 500) STORED
);

-- The one query you will run every morning during shadow week.
CREATE INDEX IF NOT EXISTS audit_log_svc_created_idx
  ON agents.audit_log (svc, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_breach_idx
  ON agents.audit_log (svc) WHERE breach;
