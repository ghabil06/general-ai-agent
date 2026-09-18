/**
 * `GET /api/runtime/policies` — the rule inventory and the boundary configuration.
 *
 * Read entirely from the runtime: `policy.describe()` for the rules and the
 * frozen `BOUNDARIES` object for the ceilings. Nothing here is a second copy of
 * a number, so a boundary that changes in `src/config/agents.mjs` changes this
 * response with it — and a boundary that cannot be changed from the environment
 * says so in the payload rather than only in a docstring.
 */

import { serializePolicies } from '../serialize.mjs';

export function createPoliciesHandler({ runtime }) {
  return {
    list() {
      const policies = serializePolicies(runtime);
      return {
        status: 200,
        body: {
          ...policies,
          evaluate: {
            kind: 'the kernel takes one request and returns the worst (most restrictive) verdict of every applicable rule',
            decisions: ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'],
            defaultWhenNoRuleMatches: policies.defaultDecision,
            ruleKinds: [...new Set(policies.rules.map((rule) => rule.kind))].sort(),
          },
        },
      };
    },
  };
}

export default createPoliciesHandler;
