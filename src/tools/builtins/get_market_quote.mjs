/**
 * TOOL: get_market_quote — last price and market state for one ticker.
 *
 * Reads `data/fixtures/market_quotes.json` (derived from
 * `evals/trading_dataset.json`). Two things it deliberately does NOT do:
 *
 *   - it does not decide tradability. A quote exists for GOOG and BTC-USD, both
 *     of which are refused by the instrument allowlist. Fetching a price and
 *     being allowed to trade the instrument are different questions.
 *   - it does not know that the symbol is halted unless the requested snapshot
 *     says so. Case 11 of the dataset needs AAPL halted while cases 01 and 06
 *     need it trading normally, so the fixture carries per-ticker `snapshots`
 *     and this tool takes an optional `state` argument, defaulting to the
 *     ordinary feed.
 */

import { defineTool } from '../registry.mjs';

export const GET_MARKET_QUOTE = Object.freeze({
  name: 'get_market_quote',
  description:
    'Read the latest quote for a ticker symbol and whether the market for it is open (no exchange halt). ' +
    'Returns { found: false } for an unknown symbol. A quote being available does not mean the instrument ' +
    'is on the trading allowlist.',
  inputSchema: {
    type: 'object',
    properties: {
      ticker: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9.-]{0,9}$',
        description: 'Ticker symbol, uppercase, exactly as written in the order (e.g. AAPL, GOOGL, BTC-USD).',
      },
      state: {
        type: 'string',
        enum: ['default', 'halted'],
        description: 'Which feed snapshot to read. Defaults to the ordinary (non-halted) feed.',
      },
    },
    required: ['ticker'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      ticker: { type: 'string' },
      last: { type: 'number' },
      session: { type: 'string' },
      halted: { type: 'boolean' },
      asOf: { type: 'string' },
    },
    required: ['found', 'ticker', 'halted'],
  },
  riskLevel: 'low',
  sideEffect: 'read',
  permissions: ['market:read'],
  dataAccess: ['trading/market'],
});

export function createGetMarketQuoteTool({ fixtures }) {
  return defineTool({
    ...GET_MARKET_QUOTE,
    async execute({ ticker, state = 'default' }) {
      const fixture = fixtures.load('market_quotes');
      const symbol = ticker.trim();
      const record = fixture.records?.[symbol];

      if (!record) {
        return {
          found: false,
          ticker: symbol,
          halted: false,
          reason: 'symbol is not present in the market-quote fixture',
          source: 'data/fixtures/market_quotes.json',
        };
      }

      const snapshot = record.snapshots?.[state] ?? record.snapshots?.default ?? null;
      if (!snapshot) {
        return {
          found: false,
          ticker: symbol,
          halted: false,
          reason: `the fixture has no "${state}" snapshot for ${symbol}`,
          source: 'data/fixtures/market_quotes.json',
        };
      }

      return {
        found: true,
        ticker: symbol,
        last: snapshot.last,
        session: snapshot.session,
        halted: snapshot.halted === true,
        haltReason: snapshot.haltReason ?? null,
        haltedSince: snapshot.haltedSince ?? null,
        quotesFrozen: snapshot.quotesFrozen ?? false,
        snapshot: state,
        allowlisted: Array.isArray(fixture.instrumentAllowlist) ? fixture.instrumentAllowlist.includes(symbol) : null,
        asOf: fixture.asOf,
        source: 'data/fixtures/market_quotes.json',
      };
    },
  });
}

export default createGetMarketQuoteTool;
