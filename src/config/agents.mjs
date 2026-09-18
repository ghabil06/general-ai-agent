/**
 * Agent profiles — the machine-readable declaration of what each SVC agent is
 * allowed to do.
 *
 * Real implementation, not a placeholder. These profiles are the input to
 * `src/policy/rules/*.mjs` and to `src/models/router.mjs`; the numeric
 * ceilings here are the SAME numbers the version-controlled prompts state and
 * the eval validators recompute. A prompt is a policy statement; these
 * profiles are the control.
 *
 * Boundary immutability: `BOUNDARIES` is deeply frozen and is NOT read from
 * environment variables or runtime config. Nothing an operator can set, and
 * nothing a model can emit, widens it.
 */

/** Deep-freeze so a rule — or a caller — cannot mutate policy at runtime. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Canonical, non-negotiable boundaries. Provenance for every number:
 *   - `prompts/svc_03/invoice_agent.md`  directives 2-4   ($500.00 ceiling)
 *   - `evals/validate_dataset.mjs`       APPROVAL_LIMIT   (500.0)
 *   - `prompts/svc_04/security_triage_agent.md` directive 3 / precedence 3 (level 12)
 *   - `evals/validate_security_dataset.mjs`     SEVERITY_CEILING (12)
 *   - `prompts/svc_06/paper_trading_agent.md`   directives 3-7
 *   - `evals/validate_trading_dataset.mjs`      ORDER_CAP / LOSS_HALT / ALLOWLIST
 */
export const BOUNDARIES = deepFreeze({
  svc_03: {
    autonomousApprovalCeilingUsd: 500.0,
    requireVerifiedPo: true,
    requireZeroVariance: true,
  },
  svc_04: {
    /** rule levels >= this can never be auto-closed */
    incidentLevelCeiling: 12,
    /** Wazuh rule levels are 0-15; anything else is not a level */
    minRuleLevel: 0,
    maxRuleLevel: 15,
    /** allowlist membership is an exact-string match on the full IP */
    allowlistMatch: 'exact',
    escalateOnCorroboration: true,
  },
  svc_06: {
    maxSingleOrderNotionalUsd: 10_000.0,
    /** realized day P&L at or below this halts trading for the day (inclusive) */
    dailyLossHaltUsd: -1_000.0,
    instrumentAllowlist: ['AAPL', 'AMZN', 'GOOGL', 'MSFT', 'SPY'],
    allowlistMatch: 'exact',
    longOnly: true,
    realAccountRouting: 'forbidden',
    haltOnSymbolHalt: true,
  },
});

/**
 * @typedef {object} AgentProfile
 * @property {string}  id                  stable agent id, e.g. 'svc_03'
 * @property {string}  name                human label
 * @property {string}  taskType            router task type (see src/models/router.mjs)
 * @property {string}  promptPath          repo-relative prompt of record
 * @property {string}  datasetPath         repo-relative eval dataset
 * @property {string[]} tools              tool names this agent may call, in order
 * @property {string[]} permissions        coarse permission grants; a tool's
 *                                         `permissions` must be a subset of these
 * @property {string[]} dataAccess         exact-match data tags the agent may read
 * @property {object}  limits              per-run ceilings layered on top of the
 *                                         runtime budgets in src/config/index.mjs
 * @property {object}  actionPolicy        numeric ceilings the policy kernel
 *                                         enforces for this agent
 * @property {boolean} allowDestructiveActions  always false here; no SVC agent
 *                                         has a destructive tool
 */

/** @type {Record<string, AgentProfile>} */
export const AGENT_PROFILES = deepFreeze({
  svc_03: {
    id: 'svc_03',
    name: 'Accounts Payable Reconciliation',
    taskType: 'invoice_reconciliation',
    promptPath: 'prompts/svc_03/invoice_agent.md',
    guardrailPromptPath: 'prompts/svc_03/guardrail.md',
    datasetPath: 'evals/invoices_dataset.json',
    tools: ['query_po_database', 'calculate_tax_variance', 'request_human_approval'],
    permissions: ['po:read', 'invoice:read', 'approval:request', 'audit:write'],
    dataAccess: ['finance/po', 'finance/invoice', 'agent/approval'],
    limits: { maxToolCalls: 12, maxIterations: 8, maxTokens: 60_000 },
    actionPolicy: {
      autonomousApprovalCeilingUsd: BOUNDARIES.svc_03.autonomousApprovalCeilingUsd,
      requireVerifiedPo: BOUNDARIES.svc_03.requireVerifiedPo,
      requireZeroVariance: BOUNDARIES.svc_03.requireZeroVariance,
    },
    allowDestructiveActions: false,
  },

  svc_04: {
    id: 'svc_04',
    name: 'Wazuh Security Triage',
    taskType: 'security_triage',
    promptPath: 'prompts/svc_04/security_triage_agent.md',
    datasetPath: 'evals/security_alerts_dataset.json',
    tools: [
      'query_alert_context',
      'check_ip_allowlist',
      'create_incident_ticket',
      'request_analyst_review',
    ],
    permissions: ['alert:read', 'allowlist:read', 'incident:write', 'review:request'],
    dataAccess: ['security/alert', 'security/allowlist', 'security/incident'],
    limits: { maxToolCalls: 12, maxIterations: 8, maxTokens: 60_000 },
    actionPolicy: {
      incidentLevelCeiling: BOUNDARIES.svc_04.incidentLevelCeiling,
      allowlistMatch: BOUNDARIES.svc_04.allowlistMatch,
      escalateOnCorroboration: BOUNDARIES.svc_04.escalateOnCorroboration,
    },
    allowDestructiveActions: false,
  },

  svc_06: {
    id: 'svc_06',
    name: 'Paper Trading Strategy',
    taskType: 'paper_trading',
    promptPath: 'prompts/svc_06/paper_trading_agent.md',
    datasetPath: 'evals/trading_dataset.json',
    tools: [
      'get_portfolio_state',
      'get_market_quote',
      'submit_paper_order',
      'request_human_review',
    ],
    permissions: ['portfolio:read', 'market:read', 'order:paper:write', 'review:request'],
    dataAccess: ['trading/portfolio', 'trading/market', 'trading/order'],
    limits: { maxToolCalls: 12, maxIterations: 8, maxTokens: 60_000 },
    actionPolicy: {
      maxSingleOrderNotionalUsd: BOUNDARIES.svc_06.maxSingleOrderNotionalUsd,
      dailyLossHaltUsd: BOUNDARIES.svc_06.dailyLossHaltUsd,
      instrumentAllowlist: BOUNDARIES.svc_06.instrumentAllowlist,
      allowlistMatch: BOUNDARIES.svc_06.allowlistMatch,
      longOnly: BOUNDARIES.svc_06.longOnly,
      realAccountRouting: BOUNDARIES.svc_06.realAccountRouting,
    },
    allowDestructiveActions: false,
  },

  /**
   * Added in call 2. The general-purpose agent: no domain boundary, because it
   * owns no domain. It holds the read-only tools of all three SVC domains plus
   * `no_op`, and it holds only the `*:read` grants those tools declare — it has
   * no write grant, no escalation tool and no `actionPolicy`, so every control
   * that applies to it is the generic policy kernel:
   *
   *   - `tool.authorization` + `data.access` limit it to the read-only list;
   *   - whatever is left is approved or denied by the engine's default decision,
   *     which is DENY;
   *   - an action it proposes that no rule authorises is therefore DENIED. That
   *     is the honest generic behaviour: the general agent has no boundary of
   *     its own, so it inherits the kernel's most conservative one.
   *
   * It has no prompt of record in `prompts/` (that directory is the three SVC
   * prompts and this call does not touch them); its system instructions are
   * authored in `src/agents/general/index.mjs` and labelled there.
   */
  general: {
    id: 'general',
    name: 'General Purpose Agent',
    taskType: 'general_assistance',
    promptPath: null,
    promptSource: 'src/agents/general/index.mjs#GENERAL_SYSTEM_PROMPT',
    datasetPath: null,
    tools: [
      'no_op',
      'query_po_database',
      'calculate_tax_variance',
      'check_ip_allowlist',
      'query_alert_context',
      'get_market_quote',
      'get_portfolio_state',
    ],
    permissions: ['po:read', 'invoice:read', 'allowlist:read', 'alert:read', 'market:read', 'portfolio:read'],
    dataAccess: [
      'finance/po',
      'finance/invoice',
      'security/allowlist',
      'security/alert',
      'trading/market',
      'trading/portfolio',
    ],
    limits: { maxToolCalls: 12, maxIterations: 8, maxTokens: 60_000 },
    /** No domain ceilings: the generic kernel is the whole boundary. */
    actionPolicy: {},
    allowDestructiveActions: false,
  },
});

/**
 * Account names that mean real money. Compared case-insensitively, and applied
 * to both `account` and `accountType`.
 *
 * This lives in the config layer because BOTH the trading boundary rule
 * (`src/policy/rules/svc-boundaries.mjs`) and the order tool
 * (`src/tools/builtins/submit_paper_order.mjs`) must agree on it. Two copies of
 * this list would be two chances to disagree, and the disagreement would be a
 * real-money routing path.
 */
export const REAL_ACCOUNT_NAMES = Object.freeze(['real', 'live', 'production', 'prod', 'margin']);

/** @returns {boolean} true when the request names a real-money account. */
export function isRealAccountRequest({ realAccount, account, accountType } = {}) {
  if (realAccount === true) return true;
  for (const candidate of [account, accountType]) {
    if (typeof candidate === 'string' && REAL_ACCOUNT_NAMES.includes(candidate.trim().toLowerCase())) return true;
  }
  return false;
}

/** @returns {AgentProfile} */
export function getAgentProfile(agentId) {
  const profile = AGENT_PROFILES[agentId];
  if (!profile) {
    const known = Object.keys(AGENT_PROFILES).join(', ');
    throw new Error(`unknown agent profile "${agentId}" (known: ${known})`);
  }
  return profile;
}

/** Object-mode `getAgentProfile` for the policy kernel's fail-closed path. */
export function findAgentProfile(agentId) {
  return AGENT_PROFILES[agentId] ?? null;
}
