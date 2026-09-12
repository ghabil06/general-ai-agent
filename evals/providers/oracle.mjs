/**
 * OFFLINE FIXTURE — "oracle" provider.
 *
 * Not a real model. Replays the expected action for each case so the eval
 * harness itself can be exercised with no API keys and no spend.
 *
 * A green run against this provider proves the plumbing is correct: the prompt
 * template renders, the invoice reaches the model, the JSON is found, and the
 * assertions pass. It proves nothing about any real model.
 *
 * promptfoo instantiates file:// providers as a class and calls callApi().
 */
export default class OracleProvider {
  constructor(options = {}) {
    this._id = options.id || 'oracle';
    this.label = options.label || 'oracle (replays expected action)';
  }

  id() {
    return this._id;
  }

  async callApi(prompt, options = {}) {
    const vars = options.vars || {};
    const marker = '# INVOICE UNDER REVIEW';
    const idx = prompt.lastIndexOf(marker);

    if (idx === -1) {
      throw new Error(
        'Template did not render: "# INVOICE UNDER REVIEW" section is missing. ' +
          'Check that prompts/svc_03/invoice_agent.md still contains the {{invoice_data}} placeholder.',
      );
    }

    const invoice = prompt.slice(idx + marker.length).trim();
    if (!invoice) {
      throw new Error(
        'Template rendered an empty invoice: {{invoice_data}} received no vars.invoice_data.',
      );
    }

    const decision = {
      reasoning: 'Oracle fixture replaying the expected action.',
      po_match: vars.case_po_verified === true,
      variance_amount: typeof vars.case_variance === 'number' ? vars.case_variance : 0,
      action: vars.expected_action,
    };

    return { output: JSON.stringify(decision, null, 2) };
  }
}
