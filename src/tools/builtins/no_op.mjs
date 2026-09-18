/**
 * TOOL: no_op — does nothing, on purpose.
 *
 * Exists for two honest reasons:
 *   1. Tests and dry runs need a tool with a declared contract, zero side
 *      effects, and no required permission, to exercise the executor's paths
 *      (validation, rate limits, timing) without touching state.
 *   2. It is the reference example of the lowest-risk tool shape:
 *      `riskLevel: 'low'`, `sideEffect: 'none'`, no permissions, no data
 *      access, no confirmation. Any new tool should be able to justify every
 *      field it adds beyond this one.
 *
 * It is not registered to any agent profile, so no SVC agent can call it.
 */

import { defineTool } from '../registry.mjs';

export const NO_OP = Object.freeze({
  name: 'no_op',
  description:
    'Do nothing and return the arguments unchanged. A deliberate no-op used to exercise the tool pipeline ' +
    'and as the reference shape for the lowest-risk tool: no side effects, no permissions, no confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Optional note echoed back in the result.' },
      echo: { type: 'object', description: 'Optional object echoed back unchanged.' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      noOp: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: ['ok', 'noOp'],
  },
  riskLevel: 'low',
  sideEffect: 'none',
  permissions: [],
  dataAccess: [],
});

export function createNoOpTool({ now = () => Date.now() } = {}) {
  return defineTool({
    ...NO_OP,
    async execute({ note = null, echo = null } = {}) {
      return { ok: true, noOp: true, note, echo, at: new Date(now()).toISOString() };
    },
  });
}

export default createNoOpTool;
