/**
 * Central runtime configuration.
 *
 * Real implementation. Everything is derived from an explicit `env` object
 * (default `process.env`) plus optional overrides, so tests can build a fully
 * isolated runtime without touching the real environment.
 *
 * Two rules this module enforces:
 *
 * 1. **No secrets are read into config values that get logged.** Only the
 *    *presence* of an API key is recorded (`apiKeyPresent: true`), never the
 *    key itself. The providers read the key from `env` at call time.
 * 2. **Policy boundaries are not configurable.** `loadConfig().policy` exposes
 *    the frozen `BOUNDARIES` for inspection only; there is no env var, no
 *    override and no default that widens an SVC ceiling. See
 *    `src/config/agents.mjs`.
 */

import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOUNDARIES } from './agents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root — `src/config/` -> repo root. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Default budget ceilings. Overridable per runtime via `overrides.budgets`. */
export const DEFAULT_BUDGETS = Object.freeze({
  /** max planner/act iterations in one run */
  maxIterations: 12,
  /** wall-clock ceiling for one run, milliseconds */
  wallClockMs: 120_000,
  /** total model tokens (prompt + completion) for one run */
  maxTokens: 120_000,
  /** max tool invocations in one run */
  maxToolCalls: 24,
  /** max identical (tool + canonical args) repeats before LOOP_DETECTED */
  maxRepeatedToolCalls: 3,
  /** max identical tool *name* repeats regardless of args */
  maxSameToolCalls: 12,
});

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Provider ids the router may select. */
export const PROVIDER_IDS = Object.freeze(['mock', 'openai', 'anthropic', 'local']);

function readInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function readString(env, key, fallback) {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : String(raw);
}

/** Resolve a possibly-relative storage path against the repo root. */
function resolveStorageDir(env, overrides) {
  const raw = overrides.storageDir ?? readString(env, 'AGENT_STORAGE_DIR', resolve(REPO_ROOT, 'data', 'state'));
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

/**
 * Build a runtime config.
 *
 * @param {object} [env]             environment bag (default `process.env`)
 * @param {object} [overrides]       explicit overrides; wins over env
 * @param {object} [overrides.budgets]
 * @param {string} [overrides.storageDir]
 * @param {string} [overrides.fixturesDir]
 * @param {string} [overrides.defaultProvider]
 * @param {string} [overrides.mockScript]  not read here — reserved for tests
 * @returns {object} frozen config
 */
export function loadConfig(env = process.env, overrides = {}) {
  const budgets = Object.freeze({
    ...DEFAULT_BUDGETS,
    ...(overrides.budgets || {}),
    maxIterations: readInt(env, 'AGENT_MAX_ITERATIONS', overrides.budgets?.maxIterations ?? DEFAULT_BUDGETS.maxIterations),
    wallClockMs: readInt(env, 'AGENT_WALL_CLOCK_MS', overrides.budgets?.wallClockMs ?? DEFAULT_BUDGETS.wallClockMs),
    maxTokens: readInt(env, 'AGENT_MAX_TOKENS', overrides.budgets?.maxTokens ?? DEFAULT_BUDGETS.maxTokens),
    maxToolCalls: readInt(env, 'AGENT_MAX_TOOL_CALLS', overrides.budgets?.maxToolCalls ?? DEFAULT_BUDGETS.maxToolCalls),
    maxRepeatedToolCalls: readInt(
      env,
      'AGENT_MAX_REPEATED_TOOL_CALLS',
      overrides.budgets?.maxRepeatedToolCalls ?? DEFAULT_BUDGETS.maxRepeatedToolCalls,
    ),
    maxSameToolCalls: readInt(
      env,
      'AGENT_MAX_SAME_TOOL_CALLS',
      overrides.budgets?.maxSameToolCalls ?? DEFAULT_BUDGETS.maxSameToolCalls,
    ),
  });

  const config = {
    env: readString(env, 'NODE_ENV', 'development'),
    storageDir: resolveStorageDir(env, overrides),
    fixturesDir: overrides.fixturesDir ?? resolve(REPO_ROOT, 'data', 'fixtures'),
    repoRoot: REPO_ROOT,

    budgets,
    toolTimeoutMs: readInt(env, 'AGENT_TOOL_TIMEOUT_MS', overrides.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS),
    approvalTtlMs: readInt(env, 'AGENT_APPROVAL_TTL_MS', overrides.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS),

    /**
     * Provider selection. `defaultProvider` is a *preference handed to the
     * router*; the router still validates capability and context size and
     * fails closed with PROVIDER_UNAVAILABLE if nothing qualifies.
     */
    providers: Object.freeze({
      defaultProvider: readString(env, 'AGENT_DEFAULT_PROVIDER', overrides.defaultProvider ?? 'mock'),
      preference: readString(env, 'AGENT_PROVIDER_PREFERENCE', overrides.providerPreference ?? 'balanced'),
      openai: Object.freeze({
        apiKeyPresent: Boolean(env.OPENAI_API_KEY),
        baseUrl: readString(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        defaultModel: readString(env, 'OPENAI_MODEL', 'gpt-4o-mini'),
      }),
      anthropic: Object.freeze({
        apiKeyPresent: Boolean(env.ANTHROPIC_API_KEY),
        baseUrl: readString(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
        defaultModel: readString(env, 'ANTHROPIC_MODEL', 'claude-sonnet-4-5'),
        apiVersion: readString(env, 'ANTHROPIC_VERSION', '2023-06-01'),
      }),
      local: Object.freeze({
        baseUrl: readString(env, 'LOCAL_MODEL_BASE_URL', ''),
        defaultModel: readString(env, 'LOCAL_MODEL_NAME', 'llama3.1:8b'),
        configured: Boolean(readString(env, 'LOCAL_MODEL_BASE_URL', '')),
      }),
    }),

    observability: Object.freeze({
      logLevel: readString(env, 'AGENT_LOG_LEVEL', 'info'),
      /** write events to stdout as well as the JSONL sink */
      echoEvents: readBool(env, 'AGENT_ECHO_EVENTS', false),
    }),

    /** Frozen, informational. Not overridable from env — see module docstring. */
    policy: BOUNDARIES,

    runtimeVersion: '0.2.0', // kept in step with RUNTIME_VERSION in src/index.mjs
  };

  return Object.freeze(config);
}

/** Process-wide default config. Safe at import time: env reads only. */
export const defaultConfig = loadConfig();
