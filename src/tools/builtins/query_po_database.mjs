/**
 * TOOL: query_po_database — read one purchase order.
 *
 * Deterministic and offline: reads `data/fixtures/po_database.json` (see that
 * file's `_provenance` block for how it was derived from
 * `evals/invoices_dataset.json`). A PO number that is absent returns
 * `{ found: false }` — that is the outcome case 08 of the SVC_03 dataset
 * depends on, and it must never be confused with an error.
 *
 * Read-only: riskLevel 'low', sideEffect 'read'.
 */

import { defineTool } from '../registry.mjs';

export const QUERY_PO_DATABASE = Object.freeze({
  name: 'query_po_database',
  description:
    'Look up a purchase order by number in the read-only PO database. Returns the PO record when it exists ' +
    'and { found: false } when it does not. A missing PO is never an error and must never be guessed at.',
  inputSchema: {
    type: 'object',
    properties: {
      poNumber: {
        type: 'string',
        pattern: '^#?[0-9]{1,12}$',
        description: 'PO number, with or without a leading "#" (e.g. "990" or "#990").',
      },
    },
    required: ['poNumber'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      poNumber: { type: 'string' },
      po: { type: 'object' },
    },
    required: ['found', 'poNumber'],
  },
  riskLevel: 'low',
  sideEffect: 'read',
  permissions: ['po:read'],
  dataAccess: ['finance/po'],
});

/** Normalise "PO #990", "#990" and "990" to the fixture's key form. */
export function normalizePoNumber(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[^0-9]/g, '');
  return digits || null;
}

export function createQueryPoDatabaseTool({ fixtures }) {
  return defineTool({
    ...QUERY_PO_DATABASE,
    async execute({ poNumber }) {
      const key = normalizePoNumber(poNumber);
      const database = fixtures.load('po_database');
      const po = key ? database.records?.[key] : undefined;

      if (!po) {
        return {
          found: false,
          poNumber: key,
          queriedAs: poNumber,
          reason: 'no matching purchase order in the PO database',
          source: 'data/fixtures/po_database.json',
        };
      }

      return { found: true, poNumber: key, po, source: 'data/fixtures/po_database.json' };
    },
  });
}

export default createQueryPoDatabaseTool;
