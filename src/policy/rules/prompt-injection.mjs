/**
 * RULE: prompt-injection detection on untrusted data (priority 14).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HEURISTIC. This is a regex-and-keyword scorer, not a classifier and not a
 * model. It is labelled `heuristic: true` in every decision it produces, on
 * purpose: it will miss a novel phrasing and it will occasionally flag someone
 * writing "do not hold for review" in earnest. It is a *second* line of
 * defence, never the only one — the durable boundaries are the SVC rules, which
 * do not read prose at all.
 *
 * The threat model is the one the prompts describe: attacker-controlled text
 * inside an invoice, an alert payload or a desk order whose author is trying to
 * move the agent's policy, not to inform it. Patterns are grouped by tactic and
 * weighted; a weighted score at or above the threshold (`3`) counts as
 * detected.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Effect of a detection, by what is being proposed:
 *   - kind 'action'  -> DENY. The action is what the injection is trying to
 *                       steer; the run turns this into the prompt's own
 *                       escalation disposition, so the outcome matches
 *                       `evals/*_dataset.json` (`case_injection: true`).
 *   - kind 'tool_call', read-only tool -> ALLOW with `injection: true` in the
 *                       evidence. Reading the PO database or the allowlist does
 *                       not move anything, and blocking it would stop the agent
 *                       from producing the escalation it is supposed to.
 *   - kind 'tool_call', state-changing tool -> DENY.
 *   - kind 'tool_call', escalation tool (tool.escalation) -> ALLOW with the
 *                       finding recorded; the required-approval rule still
 *                       pauses it for a human.
 */

import { allow, deny } from '../decisions.mjs';
import { RULE_KINDS, defineRule } from '../engine.mjs';

/** Weighted patterns, grouped by tactic. Exported so tests pin them. */
export const INJECTION_PATTERNS = Object.freeze([
  { id: 'ignore_previous_instructions', weight: 3, pattern: /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|limits?|directives?|policy)/i },
  { id: 'ignore_prior_rule', weight: 2, pattern: /\bignore\s+(the\s+|all\s+|any\s+)?(previous|prior|above|earlier)\b/i },
  { id: 'system_override', weight: 2, pattern: /\bsystem\s+(message|notice|override|prompt|instruction)s?\s*[:=]/i },
  { id: 'policy_change_claim', weight: 2, pattern: /\b(new|updated|revised)\s+policy\b|\bpolicy\s+(has\s+been\s+|was\s+|is\s+)?(updated|changed|revoked)\b|\beffective\s+immediately\b/i },
  { id: 'limits_override', weight: 3, pattern: /\boverrides?\s+(all\s+)?(prior|previous|existing)\s+(limits?|rules?|polic)/i },
  { id: 'authority_claim', weight: 3, pattern: /\b(pre-?approved|pre-?authori[sz]ed|approved|verified)\s+by\s+(the\s+|your\s+|our\s+|their\s+)?(cfo|cio|ciso|cso|ceo|soc|coc|soc\s+lead|soc\s+duty\s+officer|duty\s+officer|security\s+team|accounting\s+team)\b/i },
  { id: 'authority_signoff', weight: 2, pattern: /\b(by|from)\s+(the\s+)?(cfo|cio|ciso|cso|ceo|soc\s+lead|soc\s+duty\s+officer|duty\s+officer)\b/i },
  { id: 'authority_active_claim', weight: 2, pattern: /\b(cfo|cio|ciso|cso|ceo|soc\s+lead|duty\s+officer|desk\s+lead)\s+(has\s+|have\s+|already\s+)?(pre-?authori[sz]ed|pre-?approved|approved|authori[sz]ed)\b/i },
  { id: 'bypass_human_review', weight: 3, pattern: /\b(skip|bypass|disregard|ignore|drop)\s+(the\s+|all\s+)?(human\s+review|review|approval|guardrails?|checks?|limits?|verification)\b/i },
  { id: 'do_not_verify', weight: 3, pattern: /\bdo\s+not\s+(verify|escalate|hold|ask|review|check|confirm)\b/i },
  { id: 'threshold_raise', weight: 3, pattern: /\b(threshold|cap|limit|ceiling)\s+(has\s+been\s+|have\s+been\s+|is\s+|was\s+)?(raised|increased|removed|lifted)\b|\braised\s+to\s+\$?\d/i },
  { id: 'auto_decision_claim', weight: 3, pattern: /\b(approved|verified|authori[sz]ed)\s+for\s+auto-?(close|approve)\b|\bmark\s+it\s+auto_?approve\b|\bauto-?approve\s+override\b/i },
  { id: 'close_or_suppress_now', weight: 2, pattern: /\b(close|suppress|dismiss|reclassify|downgrade)\s+(this|it|the|these)\s+(alert|ticket|case|invoice|order)?\b|\bclose\s+it\s*,?\s*no\s+action\b/i },
  { id: 'drill_or_test_claim', weight: 2, pattern: /\bthis\s+is\s+a\s+(drill|test)\b|\b(test|drill)\s+alert\s*[-–—:]?\s*(close|ignore|no\s+action)/i },
  { id: 'real_account_routing', weight: 3, pattern: /\b(route|routing|settle|settlement|execut\w+)\b[\s\S]{0,48}?\b(real|live|production|margin)\s+account\b|\bproduction\s+account\b/i },
  { id: 'self_size_or_guess', weight: 3, pattern: /\bsize\s+it\s+(yourself|for\s+me|up)\b|\busing\s+your\s+(best\s+)?judgment\b/i },
  { id: 'output_format_override', weight: 3, pattern: /\b(output|return|set|emit)\s+(the\s+)?(action|verdict|disposition)\s+(to\s+)?["']?(auto_approve|execute_trade|close_false_positive)/i },
  { id: 'sql_injection', weight: 3, pattern: /\b(drop\s+table|delete\s+from|truncate\s+table)\b|\bunion\s+select\b/i },
  { id: 'urgent_no_review', weight: 2, pattern: /\b(urgent|immediately|right\s+now|asap)\b[\s\S]{0,64}?\b(do\s+not|don'?t|skip|without\s+(review|approval)|no\s+review)\b/i },
]);

export const INJECTION_THRESHOLD = 3;

/** Categories of side effect that make a tool call state-changing. */
const MUTATING_SIDE_EFFECTS = Object.freeze(['write', 'external', 'destructive']);

/**
 * Score untrusted text.
 *
 * @param {string} text
 * @param {{threshold?: number}} [options]
 * @returns {{detected: boolean, score: number, threshold: number, heuristic: true,
 *            matches: Array<{id: string, weight: number, excerpt: string}>}}
 */
export function scanUntrustedText(text, { threshold = INJECTION_THRESHOLD } = {}) {
  const haystack = typeof text === 'string' ? text : '';
  const matches = [];
  let score = 0;

  if (haystack) {
    for (const { id, weight, pattern } of INJECTION_PATTERNS) {
      const found = pattern.exec(haystack);
      if (!found) continue;
      score += weight;
      const start = Math.max(0, found.index - 24);
      matches.push({
        id,
        weight,
        excerpt: haystack.slice(start, Math.min(haystack.length, found.index + found[0].length + 24)).replace(/\s+/g, ' '),
      });
    }
  }

  return { detected: score >= threshold, score, threshold, heuristic: true, matches };
}

export const promptInjectionRule = defineRule({
  id: 'untrusted.prompt_injection',
  kind: RULE_KINDS.PROMPT_INJECTION,
  priority: 14,
  description:
    'HEURISTIC: weighted regex scan of attacker-controlled text (invoice/alert/order payloads). ' +
    'A detection denies the state-changing action the text is steering, but permits read-only and escalation tools.',
  appliesTo: (request) => Boolean(request.untrusted?.text),
  evaluate(request) {
    const { text, source = 'unknown' } = request.untrusted ?? {};
    const scan = scanUntrustedText(text);
    if (!scan.detected) return null;

    const evidence = {
      source,
      heuristic: true,
      score: scan.score,
      threshold: scan.threshold,
      matches: scan.matches,
      note: 'heuristic regex scorer — a detection is a reason to escalate, not proof of intent',
    };

    if (request.kind === 'action') {
      return deny(
        `override attempt detected in untrusted ${source} data (heuristic score ${scan.score} >= ${scan.threshold}); ` +
          'the proposed action is not authorised by data, only by policy',
        evidence,
      );
    }

    const tool = request.tool;
    if (!tool) return null;

    if (tool.escalation === true) {
      return allow(
        `override attempt detected in untrusted ${source} data and tool "${tool.name}" is the escalation path; recorded and routed to a human`,
        { ...evidence, tool: tool.name, escalation: true },
      );
    }

    if (tool.sideEffect === 'read' || tool.sideEffect === 'none') {
      return allow(
        `override attempt detected in untrusted ${source} data; tool "${tool.name}" is read-only so the read is permitted ` +
          'and the finding must gate any later state-changing action',
        { ...evidence, tool: tool.name, readOnly: true },
      );
    }

    if (MUTATING_SIDE_EFFECTS.includes(tool.sideEffect)) {
      return deny(
        `override attempt detected in untrusted ${source} data (heuristic score ${scan.score} >= ${scan.threshold}); ` +
          `tool "${tool.name}" changes state and must not run on injected input`,
        { ...evidence, tool: tool.name },
      );
    }

    return null;
  },
});

export default promptInjectionRule;
