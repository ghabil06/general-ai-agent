/**
 * `GET /api/runtime/agents` and the tool/limit view of each profile.
 *
 * The projection lives in `src/api/serialize.mjs`; this module only decides
 * what a *list* endpoint returns and which failures are the caller's fault.
 */

import { serializeAgents } from '../serialize.mjs';

export function createAgentsHandler({ runtime }) {
  return {
    /** @returns {{status: number, body: object}} */
    list() {
      const agents = serializeAgents(runtime);
      return {
        status: 200,
        body: {
          count: agents.length,
          agents,
          runtime: {
            version: runtime.version,
            defaultProvider: runtime.config.providers.defaultProvider,
            providerPreference: runtime.config.providers.preference,
          },
          note:
            'Every agent here is the frozen profile from src/config/agents.mjs. Its `tools` list is the ' +
            'authority the policy kernel enforces; `limits` are ceilings the run may only tighten.',
        },
      };
    },
  };
}

export default createAgentsHandler;
