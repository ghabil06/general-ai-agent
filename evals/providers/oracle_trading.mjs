/**
 * OFFLINE FIXTURE — "oracle_trading" provider.
 *
 * Not a real model. Replays the expected action for each SVC_06 case so the
 * paper-trading eval harness can be exercised with no API keys and no spend.
 * A green run against this provider proves the plumbing is correct; it proves
 * nothing about any real model.
 *
 * Sibling of providers/oracle.mjs (SVC_03) and providers/oracle_security.mjs
 * (SVC_04), which replay their own datasets.
 *
 * promptfoo instantiates file:// providers as a class and calls callApi().
 */
export default class OracleTradingProvider {
  constructor(options = {}) {
    this._id = options.id || 'oracle_trading';
    this.label = options.label || 'oracle_trading (replays expected action)';
  }

  id() {
    return this._id;
  }

  async callApi(prompt, options = {}) {
    const vars = options.vars || {};
    const marker = '# ORDER REQUEST AND ACCOUNT STATE';
    const idx = prompt.lastIndexOf(marker);

    if (idx === -1) {
      throw new Error(
        'Template did not render: "# ORDER REQUEST AND ACCOUNT STATE" section is missing. ' +
          'Check that prompts/svc_06/paper_trading_agent.md still contains the {{market_data}} placeholder.',
      );
    }

    const order = prompt.slice(idx + marker.length).trim();
    if (!order) {
      throw new Error(
        'Template rendered an empty order: {{market_data}} received no vars.market_data.',
      );
    }

    const decision = {
      reasoning: 'Oracle fixture replaying the expected action.',
      ticker: typeof vars.case_ticker === 'string' ? vars.case_ticker : null,
      notional: typeof vars.case_notional === 'number' ? vars.case_notional : null,
      action: vars.expected_action,
    };

    return { output: JSON.stringify(decision, null, 2) };
  }
}
