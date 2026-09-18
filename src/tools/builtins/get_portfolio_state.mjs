/**
 * TOOL: get_portfolio_state — the paper account snapshot.
 *
 * Reads `data/fixtures/paper_portfolio.json` (derived from
 * `evals/trading_dataset.json`). The account is `PT-001`, `accountType: paper`,
 * `realMoney: false`, `longOnly: true`. It returns the baseline state and never
 * selects a scenario itself: which day's P&L applies is a fact about the run,
 * not a choice this tool gets to make. The fixture keeps every P&L value the
 * dataset uses in `dayPnlScenarios` so the halt boundary is documented next to
 * the account it applies to.
 *
 * Read-only: riskLevel 'low', sideEffect 'read'. This is the tool the runtime
 * also uses to populate `evidence.portfolio` for the trading boundary rules, so
 * long-only checks are made against the same numbers the agent was shown.
 */

import { defineTool } from '../registry.mjs';

export const GET_PORTFOLIO_STATE = Object.freeze({
  name: 'get_portfolio_state',
  description:
    'Read the paper trading account state: cash, buying power, current positions and realized day P&L. ' +
    'The account is long-only and simulated; there is no real-money account to read.',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string' },
      accountType: { type: 'string' },
      realMoney: { type: 'boolean' },
      longOnly: { type: 'boolean' },
      positions: { type: 'object' },
      realizedDayPnl: { type: 'number' },
    },
    required: ['accountId', 'accountType', 'positions'],
  },
  riskLevel: 'low',
  sideEffect: 'read',
  permissions: ['portfolio:read'],
  dataAccess: ['trading/portfolio'],
});

export const DEFAULT_ACCOUNT_ID = 'PT-001';

export function createGetPortfolioStateTool({ fixtures, accountId = DEFAULT_ACCOUNT_ID }) {
  return defineTool({
    ...GET_PORTFOLIO_STATE,
    async execute() {
      const fixture = fixtures.load('paper_portfolio');
      const record = fixture.records?.[accountId];

      if (!record) {
        // A missing account is a deployment error, not a tradeable state: throw
        // so the executor records TOOL_ERROR instead of a plausible-looking
        // empty portfolio that later checks would read as "holds nothing".
        throw new Error(`paper account "${accountId}" is absent from data/fixtures/paper_portfolio.json`);
      }

      return {
        ...record,
        asOf: fixture.asOf,
        boundaries: fixture.boundaries,
        source: 'data/fixtures/paper_portfolio.json',
      };
    },
  });
}

export default createGetPortfolioStateTool;
