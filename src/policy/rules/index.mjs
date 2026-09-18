/**
 * The default rule set, in priority order.
 *
 * `createPolicyKernel()` sorts by `priority` anyway — this array is written in
 * order so a reader can see the evaluation sequence at a glance.
 *
 *   10  input.validation            arguments must satisfy the tool schema
 *   12  action.destructive_restriction  no destructive or elevated-risk autonomy
 *   14  untrusted.prompt_injection  HEURISTIC scan of attacker-controlled text
 *   20  tool.authorization          profile allowlist + permission grants
 *   22  data.access                 exact-match data tags
 *   30  svc_03.invoice_boundary      $500.00 ceiling, verified PO, zero variance
 *   31  svc_04.triage_boundary       level-12 ceiling, exact allowlist, corroboration
 *   32  svc_06.trading_boundary      $10k cap, allowlist, long-only, loss halt, paper only
 *   35  action.numeric_ceilings      declarative per-agent numeric ceilings
 *   40  run.rate_limit               per-run and per-tool call ceilings
 *   50  action.required_approval     requiresConfirmation / escalation / human dispositions
 */

import { inputValidationRule } from './input-validation.mjs';
import { destructiveActionRule } from './destructive-action.mjs';
import { promptInjectionRule } from './prompt-injection.mjs';
import { toolAuthorizationRule } from './tool-authorization.mjs';
import { dataAccessRule } from './data-access.mjs';
import { svcBoundaryRules } from './svc-boundaries.mjs';
import { actionPolicyRule } from './action-policy.mjs';
import { rateLimitRule } from './rate-limit.mjs';
import { requiredApprovalRule } from './required-approval.mjs';

export const DEFAULT_RULES = Object.freeze([
  inputValidationRule,
  destructiveActionRule,
  promptInjectionRule,
  toolAuthorizationRule,
  dataAccessRule,
  ...svcBoundaryRules,
  actionPolicyRule,
  rateLimitRule,
  requiredApprovalRule,
]);

export {
  inputValidationRule,
  destructiveActionRule,
  promptInjectionRule,
  toolAuthorizationRule,
  dataAccessRule,
  svcBoundaryRules,
  actionPolicyRule,
  rateLimitRule,
  requiredApprovalRule,
};

export default DEFAULT_RULES;
