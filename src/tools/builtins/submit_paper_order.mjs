/**
 * TOOL: submit_paper_order — the ONLY order path, and it is paper-only.
 *
 * There is no real-money code path in this file, in this module, or anywhere in
 * `src/`. That is not a configuration flag that could be flipped: the account
 * is hard-coded to the paper account read from the fixture, and a request that
 * asks for real/live/production/margin routing is refused with a structured
 * error (`REAL_ACCOUNT_FORBIDDEN`) rather than being downgraded silently.
 *
 * Defense in depth — three independent layers must agree before an order is
 * written:
 *   1. `src/policy/rules/svc-boundaries.mjs` re-derives the cap, the exact
 *      instrument allowlist, long-only against the real portfolio and the daily
 *      loss halt from the arguments, and DENIES the call if any fails.
 *   2. this tool refuses a real-account flag on its own, without asking policy.
 *   3. the order is appended to `data/state/orders/paper_orders.jsonl`, which
 *      has no connection to any broker, venue or account.
 *
 * riskLevel is 'medium', not 'high': a paper order cannot move real money, and
 * marking it 'high' would force every legitimate in-bounds order through a
 * human approval, which would defeat the bounded autonomy the SVC_06 prompt
 * defines. The real controls are the boundary rules.
 */

import { defineTool } from '../registry.mjs';
import { shortId } from '../../util/ids.mjs';
import { REAL_ACCOUNT_NAMES, isRealAccountRequest } from '../../config/agents.mjs';

// Re-exported so the tool's contract is readable from one file; the definition
// itself is shared with the policy rule (see src/config/agents.mjs).
export { REAL_ACCOUNT_NAMES, isRealAccountRequest };

export const ORDER_SIDES = Object.freeze(['buy', 'sell']);
export const ORDER_TYPES = Object.freeze(['limit', 'market']);

/** Structured refusals. These are returned, never thrown. */
export const ORDER_REFUSALS = Object.freeze({
  REAL_ACCOUNT_FORBIDDEN: 'REAL_ACCOUNT_FORBIDDEN',
  NOTIONAL_UNDETERMINABLE: 'NOTIONAL_UNDETERMINABLE',
});

export const SUBMIT_PAPER_ORDER = Object.freeze({
  name: 'submit_paper_order',
  description:
    'Submit an order to the simulated paper account. Paper only: any request mentioning a real, live, ' +
    'production or margin account is refused. The order is recorded in the paper order ledger and never ' +
    'reaches a broker.',
  inputSchema: {
    type: 'object',
    properties: {
      ticker: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9.-]{0,9}$',
        description: 'Ticker symbol, uppercase (e.g. AAPL).',
      },
      quantity: { type: 'number', minimum: 1, description: 'Number of shares, a positive integer.' },
      limitPrice: { type: 'number', minimum: 0.01, description: 'Limit price per share in dollars.' },
      side: { type: 'string', enum: ORDER_SIDES, description: 'Order side; defaults to "buy".' },
      orderType: { type: 'string', enum: ORDER_TYPES, description: 'Order type; defaults to "limit".' },
      notional: {
        type: 'number',
        minimum: 0,
        description: 'Pre-computed notional in dollars. Optional; derived from quantity x limitPrice when omitted.',
      },
      account: {
        type: 'string',
        description: 'Account the order names. "real", "live", "production" and "margin" are refused outright.',
      },
      realAccount: {
        type: 'boolean',
        description: 'Set true when the request claims real-account routing. Refused outright.',
      },
      halted: {
        type: 'boolean',
        description: 'Set true when the exchange has halted the symbol. Refused outright.',
      },
    },
    required: ['ticker', 'quantity', 'limitPrice'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      orderId: { type: 'string' },
      status: { type: 'string' },
      account: { type: 'string' },
      mode: { type: 'string' },
      notional: { type: 'number' },
    },
    required: ['ok'],
  },
  riskLevel: 'medium',
  sideEffect: 'write',
  permissions: ['order:paper:write'],
  dataAccess: ['trading/order'],
});

/** Round to cents without binary-float drift. */
export function roundCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function createSubmitPaperOrderTool({ store, fixtures, now = () => Date.now() } = {}) {
  if (!store) throw new TypeError('createSubmitPaperOrderTool: a run store is required');
  if (!fixtures) throw new TypeError('createSubmitPaperOrderTool: a fixture loader is required');

  return defineTool({
    ...SUBMIT_PAPER_ORDER,
    async execute(args, ctx = {}) {
      const { ticker, quantity, limitPrice, side = 'buy', orderType = 'limit', notional, account, realAccount, halted } = args;

      // Layer 2: refuse real-account routing before doing anything else.
      if (isRealAccountRequest({ realAccount, account, accountType: account })) {
        return {
          ok: false,
          error: ORDER_REFUSALS.REAL_ACCOUNT_FORBIDDEN,
          message:
            'real-account routing is forbidden: this agent operates the paper account only, and no desk ' +
            'message, memo or configuration can create a real-money path',
          requestedAccount: account ?? (realAccount === true ? 'real' : null),
          ticker,
          executed: false,
        };
      }

      if (halted === true) {
        return {
          ok: false,
          error: 'SYMBOL_HALTED',
          message: `the exchange has halted ${ticker}; no order can be sent while the market for it is closed`,
          executed: false,
        };
      }

      const computedNotional = typeof notional === 'number' ? roundCents(notional) : roundCents(quantity * limitPrice);
      if (!Number.isFinite(computedNotional) || computedNotional <= 0) {
        return {
          ok: false,
          error: ORDER_REFUSALS.NOTIONAL_UNDETERMINABLE,
          message: 'the order notional could not be determined from the arguments',
          executed: false,
        };
      }

      const portfolioFixture = fixtures.load('paper_portfolio');
      const accountRecord = portfolioFixture.records?.['PT-001'] ?? {};
      const createdAt = now();
      const orderId = shortId('ord');
      const record = {
        orderId,
        runId: ctx.runId ?? null,
        sessionId: ctx.sessionId ?? null,
        agentId: ctx.agentId ?? 'svc_06',
        ticker,
        side,
        orderType,
        quantity,
        limitPrice,
        notional: computedNotional,
        account: accountRecord.accountId ?? 'PT-001',
        accountType: 'paper',
        mode: 'paper',
        realMoney: false,
        status: 'recorded',
        createdAt,
        createdIso: new Date(createdAt).toISOString(),
        approvalId: ctx.approvalId ?? null,
        venue: 'none — paper ledger only',
        source: 'submit_paper_order',
      };
      store.append('orders', record);

      return {
        ok: true,
        orderId,
        status: 'recorded',
        account: record.account,
        accountType: 'paper',
        mode: 'paper',
        realMoney: false,
        ticker,
        side,
        quantity,
        limitPrice,
        notional: computedNotional,
        createdAt: record.createdIso,
        ledgerPath: store.paths.orders,
        venue: record.venue,
      };
    },
  });
}

export default createSubmitPaperOrderTool;
