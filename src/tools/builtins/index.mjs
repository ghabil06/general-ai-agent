/**
 * The built-in tool set, wired to a runtime's dependencies.
 *
 * Every tool here is deterministic, offline and side-effect-explicit. None of
 * them calls a model, a network or a shell. The set is closed on purpose: an
 * agent can only ever call the tools listed in its profile in
 * `src/config/agents.mjs`, and `no_op` is registered but granted to no profile,
 * so it is unreachable from an SVC agent by construction.
 */

import { createFixtureLoader } from './fixtures.mjs';

import { createQueryPoDatabaseTool } from './query_po_database.mjs';
import { createCalculateTaxVarianceTool } from './calculate_tax_variance.mjs';
import { createRequestHumanApprovalTool } from './request_human_approval.mjs';
import { createCheckIpAllowlistTool } from './check_ip_allowlist.mjs';
import { createQueryAlertContextTool } from './query_alert_context.mjs';
import { createCreateIncidentTicketTool } from './create_incident_ticket.mjs';
import { createGetMarketQuoteTool } from './get_market_quote.mjs';
import { createGetPortfolioStateTool } from './get_portfolio_state.mjs';
import { createSubmitPaperOrderTool } from './submit_paper_order.mjs';
import { createRequestAnalystReviewTool } from './request_analyst_review.mjs';
import { createRequestHumanReviewTool } from './request_human_review.mjs';
import { createNoOpTool } from './no_op.mjs';

export { createFixtureLoader } from './fixtures.mjs';

/** Stable order; also the order the tools are described to a model. */
export const BUILTIN_TOOL_NAMES = Object.freeze([
  'query_po_database',
  'calculate_tax_variance',
  'request_human_approval',
  'check_ip_allowlist',
  'query_alert_context',
  'create_incident_ticket',
  'get_market_quote',
  'get_portfolio_state',
  'submit_paper_order',
  'request_analyst_review',
  'request_human_review',
  'no_op',
]);

/**
 * @param {object}   deps
 * @param {object}   deps.store        run store (`src/store/run-store.mjs`)
 * @param {object}   deps.approvals    approval manager (`src/policy/approvals.mjs`)
 * @param {string}   [deps.fixturesDir] default `data/fixtures`
 * @param {object}   [deps.config]     runtime config (approval TTL, etc.)
 * @param {Function} [deps.now]
 * @returns {object[]} tool definitions, safe to hand to `createToolRegistry`
 */
export function createBuiltinTools({ store, approvals, fixturesDir, config = {}, now = () => Date.now() } = {}) {
  if (!store) throw new TypeError('createBuiltinTools: a run store is required');
  if (!fixturesDir) throw new TypeError('createBuiltinTools: `fixturesDir` is required');

  const fixtures = createFixtureLoader({ fixturesDir });

  return [
    createQueryPoDatabaseTool({ fixtures }),
    createCalculateTaxVarianceTool(),
    createRequestHumanApprovalTool({ approvals, config }),
    createCheckIpAllowlistTool({ fixtures }),
    createQueryAlertContextTool({ fixtures }),
    createCreateIncidentTicketTool({ store, now }),
    createGetMarketQuoteTool({ fixtures }),
    createGetPortfolioStateTool({ fixtures }),
    createSubmitPaperOrderTool({ store, fixtures, now }),
    createRequestAnalystReviewTool({ approvals, config }),
    createRequestHumanReviewTool({ approvals, config }),
    createNoOpTool({ now }),
  ];
}
