/**
 * The three policy decision values, in their own module so rules can import
 * them without importing the engine (which imports the rules).
 */

/** The only decision values the kernel may return. */
export const DECISIONS = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
});

export const DECISION_LIST = Object.freeze(Object.values(DECISIONS));

/** Convenience constructors so rules stay short and uniform. */
export function allow(reason, evidence = {}) {
  return { decision: DECISIONS.ALLOW, reason, evidence };
}

export function deny(reason, evidence = {}) {
  return { decision: DECISIONS.DENY, reason, evidence };
}

export function requireApproval(reason, evidence = {}) {
  return { decision: DECISIONS.REQUIRE_APPROVAL, reason, evidence };
}
