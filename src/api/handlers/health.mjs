/**
 * `GET /api/runtime/health` — storage, providers and version.
 *
 * The three things an operator needs before trusting anything else:
 *
 *   storage    the JSONL collections this runtime reads and writes: path, record
 *              count, corrupt-line count, readable. Read with the store's own
 *              tolerant reader, so a corrupt line is REPORTED rather than thrown.
 *   providers  availability, and whether a credential is present — as a boolean.
 *              A key is never returned, and `src/config/index.mjs` never reads
 *              one into a config value in the first place; `describe()` on the
 *              registry returns capabilities only.
 *   version    the runtime version of the object actually serving, plus the
 *              budget ceilings and the paths, so a health payload alone is
 *              enough to tell two deployments apart.
 *
 * A collection that cannot be read at all makes the endpoint a 503: a health
 * check that answers 200 while the run store is unreadable is worse than one
 * that fails loudly.
 */

import { serializeRuntimeIdentity } from '../serialize.mjs';

export function createHealthHandler({ runtime, apiVersion, now = () => Date.now() }) {
  return {
    get() {
      const collections = runtime.runStore.health();
      const unreadable = Object.entries(collections).filter(([, report]) => report.readable !== true);
      const corrupt = Object.entries(collections).filter(([, report]) => (report.corruptLines ?? 0) > 0);

      const providers = runtime.providers.describe().map((provider) => ({
        id: provider.id,
        available: provider.available === true,
        mock: provider.mock === true,
        deterministic: provider.deterministic === true,
        tools: provider.tools === true,
        json: provider.json === true,
        maxContextTokens: provider.maxContextTokens ?? null,
        /**
         * Presence, never the value — and deliberately NOT called
         * `credentialPresent`: `redact()` blanks the value of any key whose
         * words include a secret word, so a field named that way comes back as
         * the string `[REDACTED]` and a client can no longer tell `false` from
         * "withheld". The name is part of the contract; `configured` is a
         * boolean a client can rely on.
         */
        configured:
          provider.id === 'openai'
            ? runtime.config.providers.openai.apiKeyPresent
            : provider.id === 'anthropic'
              ? runtime.config.providers.anthropic.apiKeyPresent
              : provider.id === 'local'
                ? runtime.config.providers.local.configured
                : null,
      }));

      const checks = [
        {
          name: 'storage.readable',
          ok: unreadable.length === 0,
          detail: unreadable.length ? `unreadable: ${unreadable.map(([key]) => key).join(', ')}` : 'every collection is readable',
        },
        {
          name: 'storage.uncorrupted',
          ok: corrupt.length === 0,
          detail: corrupt.length ? `corrupt lines: ${corrupt.map(([key, report]) => `${key}=${report.corruptLines}`).join(', ')}` : 'no corrupt lines',
        },
        {
          name: 'provider.default.available',
          ok: runtime.providers.isAvailable(runtime.config.providers.defaultProvider),
          detail: `default provider "${runtime.config.providers.defaultProvider}"`,
        },
        {
          name: 'agents.loaded',
          ok: runtime.listAgents().length > 0,
          detail: `${runtime.listAgents().length} agent profile(s): ${runtime.listAgents().join(', ')}`,
        },
        {
          name: 'tools.registered',
          ok: runtime.registry.size > 0,
          detail: `${runtime.registry.size} tool(s) registered`,
        },
        {
          name: 'policy.rules',
          ok: runtime.policy.rules.length > 0,
          detail: `${runtime.policy.rules.length} rule(s); default decision ${runtime.policy.defaultDecision}`,
        },
      ];

      return {
        status: unreadable.length ? 503 : 200,
        body: {
          ok: checks.every((check) => check.ok),
          apiVersion,
          checkedAt: now(),
          checkedIso: new Date(now()).toISOString(),
          runtime: serializeRuntimeIdentity(runtime),
          storage: {
            dir: runtime.storageDir,
            readable: unreadable.length === 0,
            collections: Object.fromEntries(
              Object.entries(collections).map(([key, report]) => [
                key,
                {
                  path: report.path,
                  records: report.records,
                  corruptLines: report.corruptLines,
                  errors: report.errors,
                  readable: report.readable,
                  error: report.error,
                },
              ]),
            ),
          },
          providers,
          checks,
          note:
            'Credential PRESENCE is reported as a boolean. No key, token or authorization value is ever read ' +
            'into config, logged, persisted or returned by this API.',
        },
      };
    },
  };
}

export default createHealthHandler;
