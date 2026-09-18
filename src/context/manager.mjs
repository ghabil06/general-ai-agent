/**
 * Context manager — deterministic assembly of the model window.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Everything a model is shown for one turn is assembled here, from named
 * sources, under an explicit budget, with a deterministic rule for what gets
 * dropped. `build()` returns the window plus a full account of the decision:
 *
 *   {
 *     messages,          // [{ role, content }, ...] ready to send
 *     tools,             // model-facing tool definitions, PERMITTED ONLY
 *     droppedCount,      // how many items did not fit
 *     compressed,        // was anything truncated?
 *     budgetReport,      // the item-by-item accounting (see below)
 *   }
 *
 * ── PRIORITY ────────────────────────────────────────────────────────────────
 *   100  policy constraints      PROTECTED — never dropped, only truncated
 *    90  current task            PROTECTED — never dropped, only truncated
 *    70  the current plan
 *    60  prior tool results       (newest kept first)
 *    50  conversation turns       (newest kept first)
 *    40  memory records           (highest-scoring kept first)
 *    20  documents                (dropped first)
 *
 * Items are admitted best-first — highest priority, then newest / best-scoring
 * — while they fit the budget. Dropping therefore happens in the mirror order:
 * lowest priority first, and within one priority the oldest / lowest-scoring
 * first. That order is a total, stable order (`budgetReport.dropOrder` shows
 * it), so the same inputs always produce the same window. There is no
 * randomness and no clock in the selection.
 *
 * ── "SUMMARISATION" IS TRUNCATION, AND IT IS LABELLED AS SUCH ───────────────
 * When an item does not fit whole, the manager does NOT paraphrase it. It
 * truncates it from the end and appends a marker naming how much was removed
 * (`SUMMARIZER` below says so in machine-readable form, and the report records
 * it per item). A real summary would need a model; using one here would make
 * the window depend on a model call, which is exactly what a context manager
 * must not do.
 *
 * ── TOOLS ───────────────────────────────────────────────────────────────────
 * `tools` is `registry.toModelTools({ names: profile.tools })` intersected with
 * whatever the caller asked for. A caller cannot widen the tool list: anything
 * outside the profile's allowlist is dropped and reported under
 * `budgetReport.toolsRejected`. The model never sees a tool it may not call,
 * and never sees a tool's risk level, permissions or side effects.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Rough token estimate, the same 4-characters-per-token convention the router
 * uses (`estimateTokens` in `src/runtime/run.mjs`). Kept local on purpose: the
 * context manager must not import the run loop, or the two would be circular.
 */
export function estimateTextTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/** Priority bands. Higher wins. Exported so tests and callers can name them. */
export const CONTEXT_PRIORITY = Object.freeze({
  POLICY: 100,
  TASK: 90,
  PLAN: 70,
  TOOL_RESULTS: 60,
  CONVERSATION: 50,
  MEMORY: 40,
  DOCUMENTS: 20,
});

/** Priorities that are never dropped, only truncated. */
export const PROTECTED_PRIORITIES = Object.freeze([CONTEXT_PRIORITY.POLICY, CONTEXT_PRIORITY.TASK]);

export const CONTEXT_ITEM_KIND = Object.freeze({
  POLICY: 'policy_constraints',
  TASK: 'task',
  PLAN: 'plan',
  TOOL_RESULT: 'tool_result',
  CONVERSATION: 'conversation',
  MEMORY: 'memory',
  DOCUMENT: 'document',
});

/** What "compression" means here. Machine-readable so a caller cannot guess. */
export const SUMMARIZER = Object.freeze({
  name: 'deterministic-truncation',
  llm: false,
  deterministic: true,
  note:
    'Items that do not fit are truncated from the end and marked with a character count. There is no model call, ' +
    'no paraphrase and no abstractive summary in this path.',
});

export const DEFAULT_CONTEXT_BUDGET = Object.freeze({
  maxTokens: 6_000,
  /** room reserved for the model's own answer */
  reserveTokens: 512,
  /** an item is only admitted truncated if at least this much room remains */
  minChunkTokens: 64,
});

/** Marker appended to a truncated item. Prefixed and suffixed so it is greppable. */
export const TRUNCATION_MARKER = '…[context-manager truncated ';

export function truncateText(text, maxCharacters, { minimumCharacters = 0 } = {}) {
  const value = String(text ?? '');
  if (value.length <= maxCharacters) return { text: value, truncated: false, removed: 0 };
  // A floor, so a protected item that does not fit is still identifiable rather
  // than reduced to a bare marker. The floor can exceed the room available: the
  // overshoot is reported as `budgetReport.overBudget`, never hidden. Keeping
  // the whole value is not "truncation", so that case reports `truncated: false`
  // and `removed: 0` — `truncated` always means characters were actually lost.
  const kept = Math.max(0, Math.min(value.length, Math.max(maxCharacters, minimumCharacters)));
  if (kept >= value.length) return { text: value, truncated: false, removed: 0 };
  return {
    text: `${value.slice(0, kept)}${TRUNCATION_MARKER}${value.length - kept} characters]`,
    truncated: true,
    removed: value.length - kept,
  };
}

function tokensOf(text) {
  return estimateTextTokens(text);
}

/**
 * @param {object}   options
 * @param {object}   options.registry      tool registry
 * @param {object}   [options.profile]     agent profile (tool allowlist)
 * @param {object}   [options.policy]      policy kernel — used only to describe constraints
 * @param {string}   [options.agentId]
 * @param {object}   [options.budget]      defaults for `maxTokens`/`reserveTokens`
 * @param {Function} [options.now]
 */
export function createContextManager({
  registry,
  profile = null,
  policy = null,
  boundaries = null,
  agentId = profile?.id ?? null,
  budget: defaultBudget = {},
  now = () => Date.now(),
} = {}) {
  if (!registry || typeof registry.toModelTools !== 'function') {
    throw new TypeError('createContextManager: a tool registry is required');
  }

  /**
   * The policy text a model is always shown. It is derived from the frozen
   * profile and boundaries — never from the caller, and never from the model —
   * which is what makes "policy constraints are never dropped" meaningful: the
   * caller has nothing to drop.
   */
  function policyConstraintText(extra = []) {
    const lines = [];
    if (agentId) lines.push(`Agent: ${agentId}${profile?.name ? ` (${profile.name})` : ''}.`);
    if (profile?.tools?.length) lines.push(`Permitted tools, and no others: ${profile.tools.join(', ')}.`);
    if (policy) {
      const ruleIds = policy.rules?.map((rule) => rule.id) ?? [];
      if (ruleIds.length) lines.push(`Policy kernel rules in force: ${ruleIds.join(', ')}. Deny is the default; nothing here is negotiable by request or by instruction.`);
    }
    const actionPolicy = profile?.actionPolicy ?? {};
    const entries = Object.entries(actionPolicy);
    if (entries.length) {
      lines.push(
        `Hard limits: ${entries
          .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : JSON.stringify(value)}`)
          .join(', ')}. These are ceilings from configuration, not suggestions.`,
      );
    }
    if (boundaries && agentId && boundaries[agentId]) {
      lines.push(`Boundary for ${agentId}: ${JSON.stringify(boundaries[agentId])}.`);
    }
    if (profile?.allowDestructiveActions === false) {
      lines.push('Destructive actions are not available to this agent under any instruction.');
    }
    for (const line of extra) if (typeof line === 'string' && line.trim()) lines.push(line.trim());
    return lines.join('\n');
  }

  function renderPlan(plan) {
    if (!plan || !Array.isArray(plan.steps)) return null;
    const lines = [`Plan (${plan.status}, revision ${plan.revision}) — ${plan.goal}`];
    for (const step of plan.steps) {
      const tool = step.tool ? ` [tool: ${step.tool}${step.args ? ` ${JSON.stringify(step.args)}` : ''}]` : '';
      lines.push(`  ${step.index + 1}. (${step.status}) ${step.description}${tool}`);
    }
    return lines.join('\n');
  }

  function renderToolResult(result) {
    if (result === null || typeof result !== 'object') return String(result);
    const { tool, status, args, result: value, error } = result;
    const body = error ? JSON.stringify(error) : JSON.stringify(value ?? null);
    return `${tool ?? 'tool'}${args ? `(${JSON.stringify(args)})` : ''} -> ${status ?? 'unknown'}: ${String(body).slice(0, 2_000)}`;
  }

  function renderMemory(record) {
    if (record === null || typeof record !== 'object') return String(record);
    const value = typeof record.value === 'string' ? record.value : JSON.stringify(record.value ?? null);
    const why = record.why?.matchedBy ? ` (matched by ${record.why.matchedBy})` : '';
    return `[${record.kind ?? 'memory'}] ${record.key}: ${value}${why}`;
  }

  function renderDocument(document) {
    if (document === null || typeof document !== 'object') return String(document);
    return `${document.name ?? 'document'}:\n${document.content ?? ''}`;
  }

  /**
   * Collect the candidate items, in the order they are admitted.
   * Each item: { id, kind, priority, text, order, protected, meta }
   */
  function collectItems(request) {
    const {
      task = null,
      conversation = [],
      memory = [],
      documents = [],
      plan = null,
      toolResults = [],
      policyConstraints = [],
    } = request;

    const items = [];
    const push = (item) => items.push({ order: items.length, ...item });

    const policyText = policyConstraintText(policyConstraints);
    if (policyText) {
      push({ id: 'policy', kind: CONTEXT_ITEM_KIND.POLICY, priority: CONTEXT_PRIORITY.POLICY, text: `POLICY CONSTRAINTS (authoritative)\n${policyText}`, protected: true, meta: { source: 'profile+boundaries' } });
    }
    if (typeof task === 'string' && task.trim()) {
      push({ id: 'task', kind: CONTEXT_ITEM_KIND.TASK, priority: CONTEXT_PRIORITY.TASK, text: `TASK\n${task.trim()}`, protected: true, meta: { source: 'request' } });
    }
    const planText = renderPlan(plan);
    if (planText) push({ id: 'plan', kind: CONTEXT_ITEM_KIND.PLAN, priority: CONTEXT_PRIORITY.PLAN, text: planText, protected: false, meta: { planId: plan.planId ?? null } });

    // Newest tool result / conversation turn / best-scoring memory first.
    const toolResultList = [...toolResults];
    for (let i = 0; i < toolResultList.length; i += 1) {
      const item = toolResultList[i];
      push({
        id: item?.id ?? `tool-result-${i}`,
        kind: CONTEXT_ITEM_KIND.TOOL_RESULT,
        priority: CONTEXT_PRIORITY.TOOL_RESULTS,
        text: `TOOL RESULT\n${renderToolResult(item)}`,
        protected: false,
        recency: i,
        meta: { tool: item?.tool ?? null, status: item?.status ?? null },
      });
    }
    const conversationList = [...conversation];
    for (let i = 0; i < conversationList.length; i += 1) {
      const turn = conversationList[i];
      push({
        id: turn?.id ?? `conversation-${i}`,
        kind: CONTEXT_ITEM_KIND.CONVERSATION,
        priority: CONTEXT_PRIORITY.CONVERSATION,
        text: turn?.content,
        role: turn?.role ?? 'user',
        protected: false,
        recency: i,
        meta: { role: turn?.role ?? 'user' },
      });
    }
    const memoryList = [...memory];
    for (let i = 0; i < memoryList.length; i += 1) {
      const record = memoryList[i];
      push({
        id: record?.memoryId ?? `memory-${i}`,
        kind: CONTEXT_ITEM_KIND.MEMORY,
        priority: CONTEXT_PRIORITY.MEMORY,
        text: `MEMORY\n${renderMemory(record)}`,
        protected: false,
        recency: i,
        score: typeof record?.why?.score === 'number' ? record.why.score : 0,
        meta: { memoryKind: record?.kind ?? null, matchedBy: record?.why?.matchedBy ?? null },
      });
    }
    const documentList = [...documents];
    for (let i = 0; i < documentList.length; i += 1) {
      const document = documentList[i];
      push({
        id: document?.id ?? document?.name ?? `document-${i}`,
        kind: CONTEXT_ITEM_KIND.DOCUMENT,
        priority: CONTEXT_PRIORITY.DOCUMENTS,
        text: `DOCUMENT\n${renderDocument(document)}`,
        protected: false,
        recency: i,
        meta: { name: document?.name ?? null },
      });
    }
    return items;
  }

  /**
   * The admission order: priority desc, then (recency desc | score desc), then
   * id asc. Deterministic and total.
   */
  function admitOrder(items) {
    return [...items].sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.recency ?? 0) - (a.recency ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
  }

  /** The drop order: the exact reverse of admission, computed independently. */
  function dropOrder(items) {
    return [...admitOrder(items)].reverse().map((item) => item.id);
  }

  /**
   * @param {object}   request
   * @param {string}   [request.task]
   * @param {Array}    [request.conversation]
   * @param {Array}    [request.memory]
   * @param {Array}    [request.documents]
   * @param {object}   [request.plan]
   * @param {Array}    [request.toolResults]
   * @param {string[]} [request.policyConstraints]
   * @param {string[]} [request.tools]        requested tools (intersected with the allowlist)
   * @param {object}   [request.budget]
   * @param {string}   [request.systemPrompt] replaces the assembled system sections
   */
  function build(request = {}) {
    const budget = { ...DEFAULT_CONTEXT_BUDGET, ...defaultBudget, ...(request.budget ?? {}) };
    const usableTokens = Math.max(0, budget.maxTokens - (budget.reserveTokens ?? 0));
    // Characters are the unit actually counted; the token view is the estimate
    // the router uses (4 characters per token, see src/runtime/run.mjs).
    const usableCharacters = usableTokens * 4;
    const minChunkCharacters = (budget.minChunkTokens ?? 64) * 4;

    // --- tools: the allowlist is the ceiling, never the request ------------
    const allowed = profile?.tools ?? [];
    const requested = Array.isArray(request.tools) && request.tools.length ? request.tools : allowed;
    const acceptedTools = requested.filter((name) => allowed.includes(name));
    const toolsRejected = requested.filter((name) => !allowed.includes(name)).map((name) => ({
      name,
      reason: allowed.length ? `not in the "${agentId}" allowlist (${allowed.join(', ')})` : 'the agent profile grants no tools',
    }));
    const tools = registry.toModelTools({ names: acceptedTools });

    // --- items ------------------------------------------------------------
    const items = collectItems(request);
    const ordered = admitOrder(items);

    let usedCharacters = 0;
    const admitted = new Set();
    let compressed = false;
    const report = new Map();

    for (const item of ordered) {
      const characters = String(item.text ?? '').length;
      const remaining = usableCharacters - usedCharacters;
      if (characters <= remaining) {
        admitted.add(item.id);
        usedCharacters += characters;
        report.set(item.id, { characters, tokens: tokensOf(item.text), truncated: false, removed: 0, reason: 'fits the budget' });
        continue;
      }
      if (item.protected) {
        // Protected items are never dropped: truncate them to the room left,
        // with a floor so they stay identifiable. Any overshoot is reported.
        const chunk = truncateText(item.text, Math.max(0, remaining), { minimumCharacters: minChunkCharacters });
        admitted.add(item.id);
        usedCharacters += chunk.text.length;
        if (chunk.truncated) compressed = true;
        report.set(item.id, {
          characters: chunk.text.length,
          tokens: tokensOf(chunk.text),
          originalCharacters: characters,
          truncated: chunk.truncated,
          removed: chunk.removed,
          reason: chunk.truncated
            ? `protected item truncated to ${chunk.text.length} characters to fit the budget (it is never dropped)`
            : 'fits the budget',
          text: chunk.text,
        });
        continue;
      }
      if (remaining >= minChunkCharacters) {
        // Not enough room for the whole item, but enough for a useful piece:
        // admit it truncated rather than losing it entirely.
        const chunk = truncateText(item.text, Math.max(0, remaining));
        admitted.add(item.id);
        usedCharacters += chunk.text.length;
        compressed = true;
        report.set(item.id, {
          characters: chunk.text.length,
          tokens: tokensOf(chunk.text),
          originalCharacters: characters,
          truncated: true,
          removed: chunk.removed,
          reason: 'admitted truncated: the whole item did not fit',
          text: chunk.text,
        });
        continue;
      }
      report.set(item.id, {
        characters,
        tokens: tokensOf(item.text),
        truncated: false,
        removed: 0,
        dropped: true,
        reason: `dropped: ${characters} characters needed, ${Math.max(0, remaining)} available (priority ${item.priority})`,
      });
    }

    const included = items.filter((item) => admitted.has(item.id));
    const droppedItems = items.filter((item) => !admitted.has(item.id));

    const finalText = (item) => report.get(item.id)?.text ?? String(item.text ?? '');

    // --- messages ---------------------------------------------------------
    // Sections that are not conversation go into the system message: policy
    // constraints, the plan, retrieved memory, tool results and documents.
    // Conversation turns stay turns, and the task is the last user message.
    // A caller-supplied `systemPrompt` is the first section, not a replacement
    // — dropping the assembled sections because a prompt was supplied would
    // silently discard the policy constraints this manager exists to protect.
    const systemSections = [];
    const suppliedPrompt = typeof request.systemPrompt === 'string' && request.systemPrompt.trim() ? request.systemPrompt.trim() : null;
    for (const item of included) {
      if ([CONTEXT_ITEM_KIND.POLICY, CONTEXT_ITEM_KIND.PLAN, CONTEXT_ITEM_KIND.MEMORY, CONTEXT_ITEM_KIND.DOCUMENT, CONTEXT_ITEM_KIND.TOOL_RESULT].includes(item.kind)) {
        systemSections.push(finalText(item));
      }
    }
    const effectiveSystemPrompt =
      [suppliedPrompt, ...systemSections].filter(Boolean).join('\n\n') ||
      'You are a bounded agent. Follow the policy constraints exactly.';

    const messages = [{ role: 'system', content: effectiveSystemPrompt }];
    for (const item of included) {
      if (item.kind === CONTEXT_ITEM_KIND.CONVERSATION) {
        messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: finalText(item) });
      }
    }
    const taskItem = included.find((item) => item.kind === CONTEXT_ITEM_KIND.TASK);
    if (taskItem) {
      messages.push({ role: 'user', content: finalText(taskItem).replace(/^TASK\n/, '') });
    }

    const usedFinal = messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0);

    const budgetReport = {
      budget: { maxTokens: budget.maxTokens, reserveTokens: budget.reserveTokens ?? 0, usableTokens, maxCharacters: usableCharacters },
      usedCharacters: usedFinal,
      usedTokens: tokensOf(messages.map((message) => message.content).join('\n')),
      remainingCharacters: Math.max(0, usableCharacters - usedFinal),
      overBudget: usedCharacters > usableCharacters,
      exceededBy: Math.max(0, usedCharacters - usableCharacters),
      summarizer: SUMMARIZER,
      itemCount: items.length,
      includedCount: included.length,
      droppedCount: droppedItems.length,
      dropped: droppedItems.map((item) => ({ id: item.id, kind: item.kind, priority: item.priority, reason: report.get(item.id).reason })),
      trimmed: included
        .filter((item) => report.get(item.id)?.truncated)
        .map((item) => ({ id: item.id, kind: item.kind, ...report.get(item.id) })),
      dropOrder: dropOrder(items),
      admitOrder: ordered.map((item) => item.id),
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        priority: item.priority,
        protected: item.protected,
        characters: report.get(item.id).characters,
        tokens: report.get(item.id).tokens,
        included: admitted.has(item.id),
        truncated: report.get(item.id).truncated === true,
      })),
      tools: { requested: [...requested], accepted: acceptedTools, rejected: toolsRejected, modelTools: tools.length },
      compressed,
      assembledAt: now(),
      agentId,
    };

    return {
      messages,
      tools,
      droppedCount: droppedItems.length,
      compressed,
      budgetReport,
    };
  }

  return {
    agentId,
    profile,
    defaults: { ...DEFAULT_CONTEXT_BUDGET, ...defaultBudget },
    priorities: CONTEXT_PRIORITY,
    summarizer: SUMMARIZER,
    policyConstraintText,
    build,
    describe: () => ({
      agentId,
      toolAllowlist: profile?.tools ?? [],
      priorities: CONTEXT_PRIORITY,
      protectedPriorities: PROTECTED_PRIORITIES,
      defaults: { ...DEFAULT_CONTEXT_BUDGET, ...defaultBudget },
      summarizer: SUMMARIZER,
      policySource: policy ? 'policy kernel + frozen profile + boundaries' : 'frozen profile + boundaries',
    }),
  };
}

export { estimateTextTokens as estimateTokens };
