/**
 * RULE: tool authorization / permission check (priority 20).
 *
 * Two independent gates, both fail-closed:
 *
 *   1. **Allowlist.** Tools are not ambient. A tool must be listed in the
 *      agent profile's `tools` array. An unlisted tool — or an unknown tool —
 *      is a DENY, not a warning.
 *   2. **Permissions.** Every grant a tool declares (`po:read`,
 *      `order:paper:write`, …) must be held by the profile. The tool's
 *      declaration is the request; the profile is the authority. A model cannot
 *      widen either.
 *
 * When both pass, this rule returns ALLOW so the kernel has an explicit
 * authorisation on record for the call, together with the grants it checked.
 */
import { allow, deny } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';

export const toolAuthorizationRule = defineRule({
  id: 'tool.authorization',
  kind: RULE_KINDS.TOOL_AUTHORIZATION,
  priority: 20,
  description:
    'A tool must be listed in the agent profile and every permission it declares must be granted by that ' +
    'profile. Unknown tool or missing grant is a DENY.',
  appliesTo: (request) => request.kind === 'tool_call',
  evaluate(request) {
    const { tool, profile, agentId } = request;

    if (!tool) {
      return deny('unknown tool: no registered tool definition was supplied for this call', { failClosed: true });
    }
    if (!profile) {
      return deny(
        `no agent profile resolved for agentId "${agentId ?? 'unknown'}"; tool authorisation cannot be evaluated`,
        { tool: tool.name, failClosed: true },
      );
    }

    const allowedTools = profile.tools ?? [];
    if (!allowedTools.includes(tool.name)) {
      return deny(
        `agent "${profile.id}" is not authorised to call tool "${tool.name}" ` +
          `(allowed: ${allowedTools.join(', ') || 'none'})`,
        { tool: tool.name, agentId: profile.id, allowedTools },
      );
    }

    const granted = new Set(profile.permissions ?? []);
    const required = tool.permissions ?? [];
    const missing = required.filter((permission) => !granted.has(permission));
    if (missing.length) {
      return deny(
        `agent "${profile.id}" lacks the permission(s) ${missing.join(', ')} required by tool "${tool.name}"`,
        { tool: tool.name, required, missing, granted: [...granted] },
      );
    }

    return allow(
      `agent "${profile.id}" may call tool "${tool.name}" (permissions ${required.join(', ') || 'none required'})`,
      { tool: tool.name, agentId: profile.id, permissions: required },
    );
  },
});

export default toolAuthorizationRule;
