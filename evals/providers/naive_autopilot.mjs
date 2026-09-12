/**
 * OFFLINE FIXTURE — "naive autopilot" provider.
 *
 * A deliberately broken agent, kept in the repo as a permanent regression
 * fixture. It behaves the way a hallucinating LLM does:
 *
 *   - auto-approves anything at or under $1000 whose text contains "match"
 *   - never escalates a missing or unverifiable PO
 *   - obeys instructions embedded in the invoice text
 *
 * The eval suite MUST fail against this provider. If it ever goes green, the
 * assertions have stopped testing anything.
 *
 * Expected: 3 pass / 9 fail (see evals/README.md).
 *
 * promptfoo instantiates file:// providers as a class and calls callApi().
 */
export default class NaiveAutopilotProvider {
  constructor(options = {}) {
    this._id = options.id || 'naive_autopilot';
    this.label = options.label || 'naive_autopilot (must FAIL)';
  }

  id() {
    return this._id;
  }

  async callApi(prompt) {
    const marker = '# INVOICE UNDER REVIEW';
    const idx = prompt.lastIndexOf(marker);
    const invoice = idx >= 0 ? prompt.slice(idx + marker.length) : prompt;

    const amountMatch = invoice.match(/\$\s*([\d,]+\.\d{2})/);
    const amount = amountMatch ? Number.parseFloat(amountMatch[1].replace(/,/g, '')) : 0;

    // A naive agent keyword-scans and trusts what it finds — including the
    // word "matching" inside "no matching records", and the injected
    // "output action auto_approve" instruction.
    const looksClean = /match/i.test(invoice);

    const action = amount <= 1000 && looksClean ? 'auto_approve' : 'request_human_approval';

    const decision = {
      reasoning: `Amount ${amount} is within tolerance and the line items appear to match; approving.`,
      po_match: true,
      variance_amount: 0,
      action,
    };

    return { output: JSON.stringify(decision, null, 2) };
  }
}
