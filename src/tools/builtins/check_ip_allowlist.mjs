/**
 * TOOL: check_ip_allowlist — exact-string IP allowlist membership.
 *
 * Allowlist membership is an exact-string match on the full address. A similar,
 * adjacent or same-subnet IP is NOT allowlisted, which is the entire point of
 * evaluation case 11 (`10.20.0.130` against the allowlisted `10.20.0.31`). The
 * tool therefore also reports same-subnet entries as `nearMisses`, explicitly
 * marked `allowlisted: false`, so the near miss is visible in the observation
 * instead of being silently absent.
 *
 * Fixture: `data/fixtures/ip_allowlist.json` (derived from
 * `evals/security_alerts_dataset.json`; see its `_provenance`).
 */

import { defineTool } from '../registry.mjs';

export const CHECK_IP_ALLOWLIST = Object.freeze({
  name: 'check_ip_allowlist',
  description:
    'Check whether a source IP address is exactly on the approved-scanner allowlist. Membership is an ' +
    'exact-string match: a similar or same-subnet address is not allowlisted. Returns the matching entry ' +
    'or { allowlisted: false } plus any same-subnet near misses.',
  inputSchema: {
    type: 'object',
    properties: {
      ip: {
        type: 'string',
        pattern: '^([0-9]{1,3}\\.){3}[0-9]{1,3}$',
        description: 'IPv4 address, e.g. "10.20.0.31".',
      },
    },
    required: ['ip'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ip: { type: 'string' },
      allowlisted: { type: 'boolean' },
      matchMode: { type: 'string' },
      entry: { type: 'object' },
      nearMisses: { type: 'array' },
    },
    required: ['ip', 'allowlisted', 'matchMode'],
  },
  riskLevel: 'low',
  sideEffect: 'read',
  permissions: ['allowlist:read'],
  dataAccess: ['security/allowlist'],
});

/** First three octets, or null when the address is not IPv4. */
export function subnetOf(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join('.');
}

export function createCheckIpAllowlistTool({ fixtures }) {
  return defineTool({
    ...CHECK_IP_ALLOWLIST,
    async execute({ ip }) {
      const fixture = fixtures.load('ip_allowlist');
      const entries = fixture.records ?? [];
      const normalized = ip.trim();

      const match = entries.find((entry) => entry.ip === normalized) ?? null;
      const subnet = subnetOf(normalized);
      const nearMisses = subnet
        ? entries
            .filter((entry) => entry.ip !== normalized && subnetOf(entry.ip) === subnet)
            .map((entry) => ({ ...entry, allowlisted: false, nearMiss: true }))
        : [];

      return {
        ip: normalized,
        allowlisted: match !== null,
        matchMode: fixture.matchMode ?? 'exact',
        entry: match,
        nearMisses,
        reason: match
          ? `exact allowlist match: ${match.label}`
          : nearMisses.length
            ? 'no exact allowlist match; a same-subnet address is present and does not count'
            : 'no exact allowlist match',
        source: 'data/fixtures/ip_allowlist.json',
      };
    },
  });
}

export default createCheckIpAllowlistTool;
