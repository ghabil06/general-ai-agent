/**
 * Deterministic model router.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * INTENTIONALLY NOT CLEVER. There is no scoring model, no learned policy and no
 * call to a model to choose a model. Routing is a static table, a documented
 * filter order and a total ordering on the surviving candidates, so the same
 * inputs always produce the same provider and model id — including across
 * process restarts and across machines.
 *
 * Inputs:  task type, complexity hint, latency/cost preference, context size,
 *          whether tools are required, optional forced provider/model.
 * Output:  `{ provider, model, routeId, reason, candidates }`
 *
 * Filter order (each step narrows the candidate set, never widens it):
 *   1. task type matches the route (or the route is a `*` catch-all)
 *   2. complexity is in the route's allowed complexity list
 *   3. tools: routes that need tools are dropped when `requiresTools` is false;
 *      routes that cannot use tools are dropped when `requiresTools` is true
 *   4. context: routes whose provider declares a smaller window than
 *      `contextTokens` are dropped
 *   5. opt-in routes (the deterministic test double) are dropped unless the
 *      caller passes `allowTestDoubles: true`
 *   6. forced provider/model, when the caller supplied one
 *
 * Ranking: `scores[preference]` descending, then the mean of the three scores
 * descending, then `routeId` ascending. Every comparison is by value, so the
 * result is stable and unit-testable.
 *
 * Failing closed: if nothing survives, the router throws
 * `ModelError(PROVIDER_UNAVAILABLE)` — it never silently falls back to a
 * different task's model.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ModelError, MODEL_ERROR_CODES } from './provider.mjs';
import { PROVIDER_IDS } from '../config/index.mjs';

export const ROUTER_TABLE_VERSION = '2026-01-15.1';

export const COMPLEXITY_HINTS = Object.freeze(['low', 'medium', 'high']);
export const PREFERENCES = Object.freeze(['cost', 'latency', 'quality', 'balanced']);

/**
 * The routing table. One row per (task, capability) combination the runtime
 * currently needs. `scores` are 1-5, higher is a better fit for that dimension.
 *
 * Model ids here are *defaults for a deployment*, not a benchmark result.
 * `promptfooconfig.yaml` / `.security.yaml` / `.trading.yaml` pin the ids that
 * were actually evaluated; if you change an id here, change it there and re-run
 * gate 3 (`npm run eval`), because the eval is the only evidence a prompt is
 * safe on a given model.
 */
export const ROUTES = Object.freeze([
  {
    routeId: 'svc03-reconcile-low-cost',
    taskTypes: ['invoice_reconciliation'],
    complexity: ['low', 'medium'],
    requiresTools: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    scores: { cost: 5, latency: 5, quality: 3 },
  },
  {
    routeId: 'svc03-reconcile-hard-quality',
    taskTypes: ['invoice_reconciliation'],
    complexity: ['medium', 'high'],
    requiresTools: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    scores: { cost: 2, latency: 3, quality: 5 },
  },
  {
    routeId: 'svc04-triage-low-cost',
    taskTypes: ['security_triage'],
    complexity: ['low', 'medium'],
    requiresTools: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    scores: { cost: 5, latency: 5, quality: 3 },
  },
  {
    routeId: 'svc04-triage-hard-quality',
    taskTypes: ['security_triage'],
    complexity: ['medium', 'high'],
    requiresTools: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    scores: { cost: 2, latency: 3, quality: 5 },
  },
  {
    routeId: 'svc06-trading-low-cost',
    taskTypes: ['paper_trading'],
    complexity: ['low', 'medium'],
    requiresTools: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    scores: { cost: 5, latency: 5, quality: 3 },
  },
  {
    routeId: 'svc06-trading-hard-quality',
    taskTypes: ['paper_trading'],
    complexity: ['medium', 'high'],
    requiresTools: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    scores: { cost: 2, latency: 3, quality: 5 },
  },
  {
    routeId: 'utility-no-tools-local',
    taskTypes: ['*'],
    complexity: ['low'],
    requiresTools: false,
    provider: 'local',
    model: 'llama3.1:8b',
    scores: { cost: 5, latency: 4, quality: 2 },
  },
  {
    routeId: 'test-double-any',
    taskTypes: ['*'],
    complexity: ['low', 'medium', 'high'],
    requiresTools: true,
    provider: 'mock',
    model: 'mock-deterministic-1',
    scores: { cost: 5, latency: 5, quality: 1 },
    // OPT-IN. A deterministic test double must never be chosen implicitly: it
    // would happily "answer" production traffic and look successful. It only
    // wins when the caller passes `allowTestDoubles: true`, or forces
    // `provider: 'mock'`.
    optIn: true,
  },
]);

function mean(scores) {
  return (scores.cost + scores.latency + scores.quality) / 3;
}

/** Stable, total ordering. Ties fall back to `routeId` so it is never random. */
function compareCandidates(a, b, preference) {
  const key = preference === 'balanced' ? 'balanced' : preference;
  const av = key === 'balanced' ? mean(a.scores) : a.scores[key];
  const bv = key === 'balanced' ? mean(b.scores) : b.scores[key];
  if (av !== bv) return bv - av;
  const am = mean(a.scores);
  const bm = mean(b.scores);
  if (am !== bm) return bm - am;
  return a.routeId.localeCompare(b.routeId);
}

/**
 * @param {object}   request
 * @param {string}   request.taskType
 * @param {string}   [request.complexity]      'low' | 'medium' | 'high'
 * @param {string}   [request.preference]      'cost' | 'latency' | 'quality' | 'balanced'
 * @param {number}   [request.contextTokens]
 * @param {boolean}  [request.requiresTools]
 * @param {boolean}  [request.allowTestDoubles] permit the opt-in mock route
 * @param {string}   [request.forcedProvider]  test hook, and how the API will pin
 * @param {string}   [request.forcedModel]
 * @param {object}   [options]
 * @param {object}   [options.providers]       provider registry; enables the
 *                                             capability/context filters
 * @param {Array}    [options.routes]
 * @param {Function} [options.now]
 */
export function route(request = {}, { providers = null, routes = ROUTES, now = () => Date.now() } = {}) {
  const {
    taskType,
    complexity = 'medium',
    preference = 'balanced',
    contextTokens = 0,
    requiresTools = false,
    forcedProvider = null,
    forcedModel = null,
    allowTestDoubles = false,
  } = request;

  if (typeof taskType !== 'string' || !taskType) {
    throw new TypeError('route: `taskType` is required');
  }
  if (!COMPLEXITY_HINTS.includes(complexity)) {
    throw new TypeError(`route: complexity must be one of ${COMPLEXITY_HINTS.join(', ')}`);
  }
  if (!PREFERENCES.includes(preference)) {
    throw new TypeError(`route: preference must be one of ${PREFERENCES.join(', ')}`);
  }
  if (forcedProvider && !PROVIDER_IDS.includes(forcedProvider)) {
    throw new TypeError(`route: unknown forcedProvider "${forcedProvider}" (known: ${PROVIDER_IDS.join(', ')})`);
  }

  const rejected = [];
  let candidates = routes.filter((candidate) => {
    const taskMatch = candidate.taskTypes.includes(taskType) || candidate.taskTypes.includes('*');
    if (!taskMatch) {
      rejected.push({ routeId: candidate.routeId, reason: `task type "${taskType}" not served` });
      return false;
    }
    if (!candidate.complexity.includes(complexity)) {
      rejected.push({ routeId: candidate.routeId, reason: `complexity "${complexity}" not allowed` });
      return false;
    }
    if (requiresTools && candidate.requiresTools !== true) {
      rejected.push({ routeId: candidate.routeId, reason: 'tools required but route has no tool support' });
      return false;
    }
    if (candidate.optIn === true && !allowTestDoubles && forcedProvider !== candidate.provider) {
      rejected.push({
        routeId: candidate.routeId,
        reason: 'opt-in route (deterministic test double); pass allowTestDoubles: true or force the provider',
      });
      return false;
    }
    return true;
  });

  if (providers) {
    candidates = candidates.filter((candidate) => {
      if (!providers.has(candidate.provider)) {
        rejected.push({ routeId: candidate.routeId, reason: `provider "${candidate.provider}" not registered` });
        return false;
      }
      // Fail closed on credentials: a provider with no key is not a valid
      // routing target, it is a guaranteed AUTH_MISSING. The mock provider
      // reports itself as available, so a keyless environment routes to the
      // test double instead of crashing mid-run.
      if (typeof providers.isAvailable === 'function' && !providers.isAvailable(candidate.provider)) {
        rejected.push({
          routeId: candidate.routeId,
          reason: `provider "${candidate.provider}" is not configured (missing credential or base URL)`,
        });
        return false;
      }
      const capabilities = providers.get(candidate.provider).capabilities();
      if (requiresTools && !capabilities.tools) {
        rejected.push({ routeId: candidate.routeId, reason: `provider "${candidate.provider}" cannot use tools` });
        return false;
      }
      if (contextTokens > 0 && capabilities.maxContextTokens < contextTokens) {
        rejected.push({
          routeId: candidate.routeId,
          reason: `context ${contextTokens} exceeds ${candidate.provider} window ${capabilities.maxContextTokens}`,
        });
        return false;
      }
      return true;
    });
  }

  if (forcedProvider) {
    const narrowed = candidates.filter((candidate) => candidate.provider === forcedProvider);
    if (narrowed.length) {
      candidates = narrowed;
    } else {
      // A forced provider with no matching route is still honoured when the
      // provider is registered and capable: the caller asked for it explicitly.
      const fallbackModel =
        forcedModel ??
        (providers?.has(forcedProvider) ? providers.get(forcedProvider).model ?? null : null) ??
        `${forcedProvider}-default`;
      const capabilities = providers?.has(forcedProvider) ? providers.get(forcedProvider).capabilities() : null;
      if (capabilities && requiresTools && !capabilities.tools) {
        throw new ModelError(
          MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
          `forced provider "${forcedProvider}" cannot use tools`,
          { provider: forcedProvider },
        );
      }
      return {
        provider: forcedProvider,
        model: forcedModel ?? fallbackModel,
        routeId: `forced:${forcedProvider}`,
        reason: `forced provider "${forcedProvider}" (no table entry matched; using its default model)`,
        forced: true,
        taskType,
        complexity,
        preference,
        requiresTools,
        contextTokens,
        allowTestDoubles,
        candidates: [],
        rejected,
        tableVersion: ROUTER_TABLE_VERSION,
        selectedAt: now(),
      };
    }
  }

  if (!candidates.length) {
    throw new ModelError(
      MODEL_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `no route for taskType="${taskType}" complexity="${complexity}" requiresTools=${requiresTools} ` +
        `contextTokens=${contextTokens}: ${rejected.map((r) => `${r.routeId} (${r.reason})`).join('; ') || 'table is empty'}`,
      { provider: forcedProvider ?? null },
    );
  }

  const ranked = [...candidates].sort((a, b) => compareCandidates(a, b, preference));
  const winner = ranked[0];
  const winningScore = preference === 'balanced' ? mean(winner.scores) : winner.scores[preference];

  return {
    provider: winner.provider,
    model: forcedModel ?? winner.model,
    routeId: winner.routeId,
    reason:
      `route "${winner.routeId}" for taskType="${taskType}" complexity="${complexity}" ` +
      `preference="${preference}" (${winningScore.toFixed(2)} on ` +
      `${preference === 'balanced' ? 'the balanced mean' : preference})`,
    forced: Boolean(forcedProvider || forcedModel),
    taskType,
    complexity,
    preference,
    requiresTools,
    contextTokens,
    allowTestDoubles,
    candidates: ranked.map((candidate) => ({
      routeId: candidate.routeId,
      provider: candidate.provider,
      model: candidate.model,
      scores: candidate.scores,
    })),
    rejected,
    tableVersion: ROUTER_TABLE_VERSION,
    selectedAt: now(),
  };
}

/** Human-readable dump of the table — used by `verify:runtime` and the docs. */
export function describeRoutes(routes = ROUTES) {
  return routes.map((r) => ({
    routeId: r.routeId,
    taskTypes: r.taskTypes,
    complexity: r.complexity,
    requiresTools: r.requiresTools,
    target: `${r.provider}:${r.model}`,
    scores: r.scores,
  }));
}
