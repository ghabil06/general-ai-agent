/**
 * `GET /api/runtime/tools` — the tool registry as an operator needs to read it.
 *
 * A tool's declaration IS its policy surface: `riskLevel`, `sideEffect`,
 * `requiresConfirmation`, `permissions`, `dataAccess`. The registry already
 * holds all of it; this endpoint adds the one thing the registry cannot know on
 * its own — which agent profiles hold the tool, and therefore who can reach it.
 */

import { serializeTools } from '../serialize.mjs';

export function createToolsHandler({ runtime }) {
  return {
    list() {
      const tools = serializeTools(runtime);
      return {
        status: 200,
        body: {
          count: tools.length,
          tools,
          riskLevels: [...new Set(tools.map((tool) => tool.riskLevel))].sort(),
          sideEffects: [...new Set(tools.map((tool) => tool.sideEffect))].sort(),
          unheld: tools.filter((tool) => tool.heldBy.length === 0).map((tool) => tool.name),
          note:
            '`requiresConfirmation: true` means the policy kernel pauses the call for a persisted human approval ' +
            'whatever the other rules say. `escalation: true` marks the tool that hands a decision to a person; ' +
            'it is not itself a gate. `heldBy` is empty when no agent profile may call the tool at all.',
        },
      };
    },
  };
}

export default createToolsHandler;
