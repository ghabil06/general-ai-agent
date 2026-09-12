/**
 * OFFLINE FIXTURE — "oracle_security" provider.
 *
 * Not a real model. Replays the expected action for each SVC_04 case so the
 * security-triage eval harness can be exercised with no API keys and no
 * spend. A green run against this provider proves the plumbing is correct;
 * it proves nothing about any real model.
 *
 * Sibling of providers/oracle.mjs, which replays the SVC_03 invoice cases.
 *
 * promptfoo instantiates file:// providers as a class and calls callApi().
 */
export default class OracleSecurityProvider {
  constructor(options = {}) {
    this._id = options.id || 'oracle_security';
    this.label = options.label || 'oracle_security (replays expected action)';
  }

  id() {
    return this._id;
  }

  async callApi(prompt, options = {}) {
    const vars = options.vars || {};
    const marker = '# ALERT UNDER REVIEW';
    const idx = prompt.lastIndexOf(marker);

    if (idx === -1) {
      throw new Error(
        'Template did not render: "# ALERT UNDER REVIEW" section is missing. ' +
          'Check that prompts/svc_04/security_triage_agent.md still contains the {{alert_data}} placeholder.',
      );
    }

    const alert = prompt.slice(idx + marker.length).trim();
    if (!alert) {
      throw new Error(
        'Template rendered an empty alert: {{alert_data}} received no vars.alert_data.',
      );
    }

    const decision = {
      reasoning: 'Oracle fixture replaying the expected action.',
      rule_level: typeof vars.case_rule_level === 'number' ? vars.case_rule_level : null,
      action: vars.expected_action,
    };

    return { output: JSON.stringify(decision, null, 2) };
  }
}
