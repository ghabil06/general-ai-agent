/**
 * Tool registry.
 *
 * Real implementation. A tool is a first-class record — description, JSON
 * schemas, risk level, side-effect class, confirmation requirement, permissions
 * and the implementation — so the executor, the policy kernel and the model's
 * tool-calling interface all read the same declaration.
 *
 * TOOL SELECTION vs TOOL EXECUTION
 * --------------------------------
 * Registration and lookup live here. Running a tool lives in
 * `src/tools/executor.mjs`, and nothing in this module ever calls `execute()`.
 * That separation is what lets the policy kernel veto a call between the two.
 *
 * Field semantics:
 *   riskLevel            'low' | 'medium' | 'high' | 'critical'
 *   sideEffect           'none' | 'read' | 'write' | 'external' | 'destructive'
 *   requiresConfirmation always pause for a human, whatever the policy says
 *   permissions          coarse grants; every one must be held by the agent
 *                        profile in `src/config/agents.mjs`
 *   dataAccess           exact-match data tags the tool touches; every one must
 *                        be in the profile's `dataAccess`
 *   destructive          shorthand: true only when sideEffect === 'destructive'
 */

import { validate, formatViolations } from './schema.mjs';

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const SIDE_EFFECTS = Object.freeze(['none', 'read', 'write', 'external', 'destructive']);

/** Risk levels that the policy kernel treats as never-autonomous. */
export const ELEVATED_RISK_LEVELS = Object.freeze(['high', 'critical']);

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export class ToolDefinitionError extends Error {
  constructor(message, { tool } = {}) {
    super(message);
    this.name = 'ToolDefinitionError';
    this.tool = tool ?? null;
  }
}

/**
 * Validate and freeze a tool definition.
 *
 * @param {object} definition
 * @returns {object} frozen tool
 */
export function defineTool(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new ToolDefinitionError('defineTool: definition must be an object');
  }

  const {
    name,
    description,
    inputSchema,
    outputSchema = null,
    riskLevel,
    sideEffect = 'read',
    requiresConfirmation = false,
    escalation = false,
    permissions = [],
    dataAccess = [],
    timeoutMs = null,
    execute,
  } = definition;

  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new ToolDefinitionError(
      `defineTool: name "${name}" must match ${NAME_PATTERN} (lower_snake_case, e.g. query_po_database)`,
      { tool: name },
    );
  }
  if (typeof description !== 'string' || description.trim().length < 10) {
    throw new ToolDefinitionError(
      `defineTool: tool "${name}" needs a description of at least 10 characters — the model reads it to choose the tool`,
      { tool: name },
    );
  }
  if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new ToolDefinitionError(`defineTool: tool "${name}" needs an object inputSchema`, { tool: name });
  }
  if (outputSchema !== null && (typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
    throw new ToolDefinitionError(`defineTool: tool "${name}" outputSchema must be an object or null`, { tool: name });
  }
  if (!RISK_LEVELS.includes(riskLevel)) {
    throw new ToolDefinitionError(
      `defineTool: tool "${name}" riskLevel "${riskLevel}" must be one of ${RISK_LEVELS.join(', ')}`,
      { tool: name },
    );
  }
  if (!SIDE_EFFECTS.includes(sideEffect)) {
    throw new ToolDefinitionError(
      `defineTool: tool "${name}" sideEffect "${sideEffect}" must be one of ${SIDE_EFFECTS.join(', ')}`,
      { tool: name },
    );
  }
  if (!Array.isArray(permissions) || !Array.isArray(dataAccess)) {
    throw new ToolDefinitionError(`defineTool: tool "${name}" permissions/dataAccess must be arrays`, { tool: name });
  }
  if (typeof execute !== 'function') {
    throw new ToolDefinitionError(`defineTool: tool "${name}" needs an execute(args, ctx) function`, { tool: name });
  }

  return Object.freeze({
    name,
    description,
    inputSchema,
    outputSchema,
    riskLevel,
    sideEffect,
    requiresConfirmation: Boolean(requiresConfirmation),
    /**
     * `escalation: true` marks a tool that hands a decision to a human. The
     * prompt-injection rule reads it: an injected payload must never be able to
     * deny the escalation path its own text is trying to trigger. It is not an
     * approval gate by itself — `requiresConfirmation` is (see
     * src/policy/rules/required-approval.mjs).
     */
    escalation: Boolean(escalation),
    permissions: Object.freeze([...permissions]),
    dataAccess: Object.freeze([...dataAccess]),
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : null,
    destructive: sideEffect === 'destructive',
    execute,
  });
}

/**
 * @param {object}   [options]
 * @param {Array}    [options.tools]
 */
export function createToolRegistry({ tools = [] } = {}) {
  const map = new Map();

  function register(tool) {
    const frozen = Object.isFrozen(tool) ? tool : defineTool(tool);
    if (map.has(frozen.name)) {
      throw new ToolDefinitionError(`createToolRegistry: tool "${frozen.name}" is already registered`, {
        tool: frozen.name,
      });
    }
    map.set(frozen.name, frozen);
    return frozen;
  }

  for (const tool of tools) register(tool);

  return {
    register,
    has: (name) => map.has(name),
    /** @returns {object} the frozen tool definition */
    get(name) {
      return map.get(name) ?? null;
    },
    require(name) {
      const tool = map.get(name);
      if (!tool) throw new ToolDefinitionError(`tool "${name}" is not registered`, { tool: name });
      return tool;
    },
    names: () => [...map.keys()],
    list: () => [...map.values()],
    get size() {
      return map.size;
    },
    /** Filter to the tools an agent profile is allowed to call, in profile order. */
    forProfile(profile) {
      if (!profile?.tools) return [];
      return profile.tools.map((name) => map.get(name)).filter(Boolean);
    },
    /**
     * The model-facing projection: name + description + input schema. Risk,
     * permissions and side effects are deliberately NOT sent to the model —
     * it does not get to reason about its own guardrails.
     */
    toModelTools({ names } = {}) {
      const selected = names ? names.map((name) => map.get(name)).filter(Boolean) : [...map.values()];
      return selected.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    describe() {
      return [...map.values()].map((tool) => ({
        name: tool.name,
        riskLevel: tool.riskLevel,
        sideEffect: tool.sideEffect,
        requiresConfirmation: tool.requiresConfirmation,
        permissions: [...tool.permissions],
        dataAccess: [...tool.dataAccess],
      }));
    },
  };
}

/**
 * Validate arguments against a tool's input schema.
 * @returns {Array<{path: string, keyword: string, message: string}>}
 */
export function validateToolArguments(tool, args) {
  return validate(args ?? {}, tool.inputSchema);
}

/** Human-readable one-liner for logs and tool error results. */
export function describeArgumentViolations(violations) {
  return formatViolations(violations);
}
