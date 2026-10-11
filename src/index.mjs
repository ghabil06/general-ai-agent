/**
 * Agent runtime — public entry point.
 *
 * `createRuntime()` wires the whole core: config, providers and the router, the
 * tool registry and executor, the policy kernel with its real SVC boundary
 * rules, the approval manager, the JSONL stores, events, traces, audit and
 * memory. `createRun()` starts one bounded execution against that runtime.
 *
 * This call does NOT wire the HTTP server: `server.mjs` and `/api/simulate`
 * remain exactly as they were. The API server is a later call, and it is
 * expected to consume `createRuntime()` rather than reimplement it.
 *
 * Minimal use:
 *
 *   import { createRuntime } from './src/index.mjs';
 *   const runtime = createRuntime({ storageDir: './data/state' });
 *   const run = runtime.createRun({ agentId: 'svc_03' });
 *   const result = await run.runTool('query_po_database', { poNumber: '990' });
 *   run.finish({ status: 'COMPLETED' });
 */

import { loadConfig } from './config/index.mjs';
import { AGENT_PROFILES, BOUNDARIES, getAgentProfile, findAgentProfile } from './config/agents.mjs';

import { createProviderRegistry } from './models/provider.mjs';
import { createMockProvider } from './models/providers/mock.mjs';
import { createOpenAiProvider } from './models/providers/openai.mjs';
import { createAnthropicProvider } from './models/providers/anthropic.mjs';
import { createLocalProvider } from './models/providers/local.mjs';
import { route, ROUTES, ROUTER_TABLE_VERSION, describeRoutes } from './models/router.mjs';

import { createToolRegistry } from './tools/registry.mjs';
import { createToolExecutor } from './tools/executor.mjs';
import { createBuiltinTools, BUILTIN_TOOL_NAMES } from './tools/builtins/index.mjs';
import { DEFAULT_RULES } from './policy/rules/index.mjs';

import { createPolicyKernel, DECISIONS, RULE_KINDS } from './policy/engine.mjs';
import { createApprovalManager, APPROVAL_STATUS, createApprovalStore } from './policy/approvals.mjs';
import { decideSvc03, decideSvc04, decideSvc06 } from './policy/boundaries.mjs';

import { createRunStore } from './store/run-store.mjs';
import { createJsonlStore } from './store/jsonl-store.mjs';

import { createEventBus, createJsonlSink, createMemorySink, createConsoleSink, EVENT_TYPES } from './observability/events.mjs';
import { createTraceBuilder, traceFromEvents, SPAN_TYPES } from './observability/traces.mjs';
import { createAuditWriter, AUDIT_TYPES } from './observability/audit.mjs';
import { redact } from './observability/redact.mjs';

import { createMemoryStore, MEMORY_SCOPES } from './memory/store.mjs';
import { createKindedMemory, MEMORY_KIND, MEMORY_KINDS, RETRIEVAL_MODEL } from './memory/kinds.mjs';
import { createAgentRun } from './runtime/run.mjs';
import { createBoundedAgent, BoundedAgentError, BOUNDED_ERROR_CODES, STRATEGIES } from './runtime/bounded-agent.mjs';
import { HARD_CEILINGS, resolveEnvelope } from './runtime/envelope.mjs';
import { createBudgetTracker, STOP_REASONS } from './runtime/budgets.mjs';
import { createStateMachine, STATES, TRANSITIONS, canTransition } from './runtime/state-machine.mjs';
import { createPlanner, STEP_STATUS, PLAN_STATUS, PlanError } from './planning/planner.mjs';
import { createContextManager, CONTEXT_PRIORITY, SUMMARIZER } from './context/manager.mjs';
import { createPromptRenderer, AGENT_PROMPTS, PromptRenderError } from './prompts/render.mjs';
import { loadAgent, loadAllAgents, listAgentIds, listSvcAgentIds, runAgentCase } from './agents/index.mjs';

export const RUNTIME_VERSION = '0.2.0';

/**
 * Merge caller-supplied agent profiles over the frozen ones.
 *
 * A caller may ADD an agent id (a deployment, a test scenario); a caller may NOT
 * shadow one of the three SVC agents or `general`. That asymmetry is deliberate:
 * widening a boundary is done by editing `src/config/agents.mjs` in a commit,
 * never by passing an option at runtime.
 */
export function mergeProfiles(extra = null) {
  if (!extra) return AGENT_PROFILES;
  const merged = { ...AGENT_PROFILES };
  for (const [id, profile] of Object.entries(extra)) {
    if (Object.prototype.hasOwnProperty.call(AGENT_PROFILES, id)) {
      throw new TypeError(
        `createRuntime: profiles.${id} would shadow the frozen profile for "${id}". A boundary is widened by a ` +
          'commit to src/config/agents.mjs, not by a runtime option',
      );
    }
    if (!profile || typeof profile !== 'object' || !Array.isArray(profile.tools)) {
      throw new TypeError(`createRuntime: profiles.${id} must be an object with a \`tools\` array`);
    }
    merged[id] = Object.freeze({
      limits: {},
      permissions: [],
      dataAccess: [],
      actionPolicy: {},
      allowDestructiveActions: false,
      ...profile,
      id,
    });
  }
  return Object.freeze(merged);
}

/**
 * @param {object}   [options]
 * @param {object}   [options.config]        from loadConfig(); default: env-based
 * @param {string}   [options.storageDir]    default: config.storageDir
 * @param {string}   [options.fixturesDir]   default: config.fixturesDir
 * @param {Array}    [options.rules]         policy rules; default DEFAULT_RULES
 * @param {Array}    [options.mockScript]    script for the mock provider
 * @param {Function} [options.now]           clock injection
 * @param {boolean}  [options.echoEvents]    also write events to stdout
 * @param {object}   [options.providers]     extra/override provider instances by id
 * @param {Array}    [options.tools]         EXTRA tool definitions, registered alongside the built-ins.
 *                                           Added in call 2 so a deployment (and the failure-matrix
 *                                           tests) can add a tool without editing the built-in set.
 * @param {object}   [options.profiles]      EXTRA agent profiles by id. Existing ids may NOT be
 *                                           shadowed — see mergeProfiles().
 * @param {string}   [options.promptsDir]    default `<repo>/prompts`
 */
export function createRuntime({
  config = loadConfig(),
  storageDir = config.storageDir,
  fixturesDir = config.fixturesDir,
  rules = DEFAULT_RULES,
  mockScript = [],
  now = () => Date.now(),
  echoEvents = config.observability.echoEvents,
  providers: providerOverrides = null,
  tools: extraTools = [],
  profiles: extraProfiles = null,
  promptsDir = null,
} = {}) {
  // --- stores -------------------------------------------------------------
  const runStore = createRunStore({ storageDir, now });
  const approvalStore = createApprovalStore(storageDir);

  // --- observability sinks -------------------------------------------------
  const eventSinks = [createJsonlSink(runStore.get('events'))];
  if (echoEvents) eventSinks.push(createConsoleSink());

  // --- agents -------------------------------------------------------------
  const profiles = mergeProfiles(extraProfiles);
  function resolveProfile(agentId) {
    const profile = profiles[agentId];
    if (!profile) {
      const known = Object.keys(profiles).join(', ');
      throw new Error(`unknown agent profile "${agentId}" (known: ${known})`);
    }
    return profile;
  }
  function resolveProfileOrNull(agentId) {
    return profiles[agentId] ?? null;
  }

  // --- providers ----------------------------------------------------------
  const mock = createMockProvider({ script: mockScript, now });
  const providers = createProviderRegistry({
    providers: [
      mock,
      createOpenAiProvider({ baseUrl: config.providers.openai.baseUrl, model: config.providers.openai.defaultModel }),
      createAnthropicProvider({
        baseUrl: config.providers.anthropic.baseUrl,
        model: config.providers.anthropic.defaultModel,
        apiVersion: config.providers.anthropic.apiVersion,
      }),
      createLocalProvider({ baseUrl: config.providers.local.baseUrl, model: config.providers.local.defaultModel }),
      ...(providerOverrides ? Object.entries(providerOverrides).map(([id, provider]) => ({ id: () => id, ...provider })) : []),
    ],
    defaultProviderId: config.providers.defaultProvider,
  });

  // --- approvals ----------------------------------------------------------
  const approvals = createApprovalManager({
    store: runStore.redacting('approvals'),
    now,
    defaultTtlMs: config.approvalTtlMs,
  });

  // --- tools --------------------------------------------------------------
  const builtins = createBuiltinTools({ store: runStore, approvals, fixturesDir, config, now });
  const registry = createToolRegistry({ tools: [...builtins, ...extraTools] });

  // --- policy -------------------------------------------------------------
  const policy = createPolicyKernel({ rules, now });

  // --- memory -------------------------------------------------------------
  const memory = createMemoryStore({ store: runStore.redacting('memory'), now });
  /** The five-kind interface, at runtime scope (no event bus until a run binds one). */
  const memoryKinds = createKindedMemory({ store: runStore.redacting('memory'), now });

  // --- prompts ------------------------------------------------------------
  const promptRenderer = createPromptRenderer(promptsDir ? { promptsDir } : {});

  // --- executor -----------------------------------------------------------
  const executor = createToolExecutor({
    registry,
    policy,
    approvals,
    now,
    defaultTimeoutMs: config.toolTimeoutMs,
  });

  // --- audit --------------------------------------------------------------
  const audit = createAuditWriter({ store: createJsonlStore({ dir: `${storageDir}/audit`, name: 'audit' }), now });

  function routeFor(request) {
    // The deterministic test double is opt-in: it becomes a legal implicit
    // target only when the operator configured it as the default provider
    // (which is what the test helper does, and what an offline demo would do).
    const allowTestDoubles = config.providers.defaultProvider === 'mock';
    return route({ preference: config.providers.preference, allowTestDoubles, ...request }, { providers, now });
  }

  /**
   * The General AI Agents entry point (call 4): `execute(task)` runs one bounded
   * tool-calling task to a persisted result. See `src/runtime/bounded-agent.mjs`.
   */
  function boundedAgent(options = {}) {
    return createBoundedAgent({ runtime: api, ...options });
  }

  /** Start one run. The executor, policy kernel and stores are shared. */
  function createRun(options = {}) {
    const run = createAgentRun({ ...options, runtime: api, provider: options.provider ?? null });
    // Attach the policy verdict helper for proposed agent actions.
    return run;
  }

  const api = {
    version: RUNTIME_VERSION,
    config,
    storageDir,
    fixturesDir,
    promptsDir: promptRenderer.promptsDir,
    now,

    // composition
    runStore,
    approvalStore,
    approvals,
    registry,
    executor,
    policy,
    memory,
    memoryKinds,
    audit,
    providers,
    mockProvider: mock,
    eventSinks,

    // agents
    profiles,
    boundaries: BOUNDARIES,
    getAgentProfile: resolveProfile,
    findAgentProfile: resolveProfileOrNull,
    loadAgent: (agentId, options = {}) => loadAgent(agentId, { renderer: promptRenderer, ...options }),
    listAgents: () => listAgentIds(),
    listSvcAgents: () => listSvcAgentIds(),
    runAgentCase: (options = {}) => runAgentCase({ ...options, runtime: api }),

    // planning + context + prompts (call 2)
    createPlanner: (options = {}) => createPlanner({ registry, now, ...options }),
    createContextManager: (options = {}) => createContextManager({ registry, policy, boundaries: BOUNDARIES, now, ...options }),
    promptRenderer,
    renderPrompt: (templatePath, values, options) => promptRenderer.render(templatePath, values, options),
    renderAgentPrompt: (agentId, vars, options) => promptRenderer.renderAgentPrompt(agentId, vars, options),

    // routing
    route: routeFor,
    routes: ROUTES,
    describeRoutes,

    // bounded execution (call 4)
    boundedAgent,

    // helpers callers will use next
    newEventBus: (options = {}) =>
      createEventBus({ sinks: eventSinks, now, ...options }),
    newTrace: (options = {}) => createTraceBuilder({ now, ...options }),
    traceFromEvents,
    memorySink: () => createMemorySink(),

    createRun,

    /** Everything a `verify:runtime` check wants to report. */
    describe() {
      return {
        version: RUNTIME_VERSION,
        storageDir,
        fixturesDir,
        agents: Object.keys(profiles),
        svcAgents: listSvcAgentIds(),
        tools: registry.names(),
        builtinTools: BUILTIN_TOOL_NAMES,
        extraTools: extraTools.map((tool) => tool.name),
        policyRules: policy.describe(),
        providers: providers.describe(),
        routerTableVersion: ROUTER_TABLE_VERSION,
        routes: describeRoutes(),
        states: Object.values(STATES),
        stopReasons: Object.values(STOP_REASONS),
        eventTypes: Object.values(EVENT_TYPES),
        spanTypes: Object.values(SPAN_TYPES),
        memoryKinds: MEMORY_KINDS,
        contextPriorities: CONTEXT_PRIORITY,
        stores: runStore.health(),
      };
    },
  };

  return api;
}

// ── re-exports so consumers do not have to reach into internal paths ────────
export {
  // bounded execution (call 4)
  createBoundedAgent,
  BoundedAgentError,
  BOUNDED_ERROR_CODES,
  STRATEGIES,
  HARD_CEILINGS,
  resolveEnvelope,
  // config
  loadConfig,
  AGENT_PROFILES,
  BOUNDARIES,
  getAgentProfile,
  findAgentProfile,
  // runtime
  createAgentRun,
  createStateMachine,
  createBudgetTracker,
  STATES,
  TRANSITIONS,
  canTransition,
  STOP_REASONS,
  // models
  createProviderRegistry,
  createMockProvider,
  createOpenAiProvider,
  createAnthropicProvider,
  createLocalProvider,
  route,
  ROUTES,
  // tools
  createToolRegistry,
  createToolExecutor,
  createBuiltinTools,
  BUILTIN_TOOL_NAMES,
  // policy
  createPolicyKernel,
  createApprovalManager,
  APPROVAL_STATUS,
  DECISIONS,
  RULE_KINDS,
  DEFAULT_RULES,
  decideSvc03,
  decideSvc04,
  decideSvc06,
  // observability
  createEventBus,
  createTraceBuilder,
  traceFromEvents,
  createAuditWriter,
  AUDIT_TYPES,
  EVENT_TYPES,
  SPAN_TYPES,
  redact,
  // stores + memory
  createRunStore,
  createJsonlStore,
  createMemoryStore,
  MEMORY_SCOPES,
  // memory kinds (call 2)
  createKindedMemory,
  MEMORY_KIND,
  MEMORY_KINDS,
  RETRIEVAL_MODEL,
  // planning (call 2)
  createPlanner,
  STEP_STATUS,
  PLAN_STATUS,
  PlanError,
  // context (call 2)
  createContextManager,
  CONTEXT_PRIORITY,
  SUMMARIZER,
  // prompts (call 2)
  createPromptRenderer,
  AGENT_PROMPTS,
  PromptRenderError,
  // agents (call 2)
  loadAgent,
  loadAllAgents,
  listAgentIds,
  listSvcAgentIds,
  runAgentCase,
};
