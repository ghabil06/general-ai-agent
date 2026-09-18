/**
 * RULE: input validation (priority 10).
 *
 * Arguments are validated against the tool's own `inputSchema` before anything
 * else looks at them, and an explicitly `null` argument is refused: a null is
 * the model saying "I do not know this value", and guessing on its behalf is
 * exactly what the SVC prompts forbid ("do not guess it, reject and flag").
 *
 * A schema violation is a DENY, not an approval prompt. There is nothing for a
 * human to approve: the call is malformed.
 */

import { allow, deny } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';
import { validate, formatViolations } from '../../tools/schema.mjs';

export const inputValidationRule = defineRule({
  id: 'input.validation',
  kind: RULE_KINDS.INPUT_VALIDATION,
  priority: 10,
  description:
    'Tool arguments must satisfy the tool inputSchema; explicit nulls are refused because guessing a ' +
    'missing value is forbidden by the SVC prompts.',
  appliesTo: (request) => request.kind === 'tool_call',
  evaluate(request) {
    if (!request.tool) {
      return deny('tool_call request carried no tool definition; cannot validate arguments', {
        failClosed: true,
      });
    }

    const args = request.args ?? {};
    const violations = validate(args, request.tool.inputSchema);
    if (violations.length) {
      return deny(
        `arguments for tool "${request.tool.name}" failed schema validation: ${formatViolations(violations).join('; ')}`,
        { tool: request.tool.name, violations, args },
      );
    }

    const nullKeys = Object.entries(args)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    if (nullKeys.length) {
      return deny(
        `arguments for tool "${request.tool.name}" contain explicit null for ${nullKeys.join(', ')}; ` +
          'an unknown value must not be guessed or fabricated',
        { tool: request.tool.name, nullKeys },
      );
    }

    return allow(`arguments for tool "${request.tool.name}" satisfy its input schema`, {
      tool: request.tool.name,
    });
  },
});

export default inputValidationRule;
