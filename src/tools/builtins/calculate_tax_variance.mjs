/**
 * TOOL: calculate_tax_variance — real arithmetic, no model.
 *
 * `variance = actualTax - expectedTax`, rounded to cents. A variance is never
 * rounded down to zero: 0.01 is a variance, because the SVC_03 policy requires
 * `variance == 0` for autonomous approval and the dataset's case 12 pins
 * exactly that.
 *
 * Pure and side-effect free: same inputs, same numbers, every time.
 */

import { defineTool } from '../registry.mjs';

export const CALCULATE_TAX_VARIANCE = Object.freeze({
  name: 'calculate_tax_variance',
  description:
    'Compute the tax variance between the tax expected on the purchase order and the tax billed on the ' +
    'invoice. Returns variance = actualTax - expectedTax in dollars rounded to cents. Any non-zero variance, ' +
    'however small, must escalate to a human.',
  inputSchema: {
    type: 'object',
    properties: {
      expectedTax: { type: 'number', minimum: 0, description: 'Tax amount expected from the PO, in dollars.' },
      actualTax: { type: 'number', minimum: 0, description: 'Tax amount billed on the invoice, in dollars.' },
    },
    required: ['expectedTax', 'actualTax'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      variance: { type: 'number' },
      expectedTax: { type: 'number' },
      actualTax: { type: 'number' },
      varianceIsZero: { type: 'boolean' },
      direction: { type: 'string' },
    },
    required: ['variance', 'varianceIsZero'],
  },
  riskLevel: 'low',
  sideEffect: 'none',
  permissions: ['invoice:read'],
  dataAccess: ['finance/invoice'],
});

/** Round to cents without binary-float drift (0.1 + 0.2 style errors). */
export function roundCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function computeTaxVariance({ expectedTax, actualTax }) {
  const variance = roundCents(actualTax - expectedTax);
  return {
    variance,
    expectedTax: roundCents(expectedTax),
    actualTax: roundCents(actualTax),
    absVariance: Math.abs(variance),
    // Strictly zero. The SVC_03 boundary is "variance == 0", so 0.01 of
    // floating-point noise must not be swallowed by a tolerance.
    varianceIsZero: variance === 0,
    direction: variance > 0 ? 'overbilled' : variance < 0 ? 'underbilled' : 'exact',
    toleranceApplied: 0,
  };
}

export function createCalculateTaxVarianceTool() {
  return defineTool({
    ...CALCULATE_TAX_VARIANCE,
    async execute({ expectedTax, actualTax }) {
      return computeTaxVariance({ expectedTax, actualTax });
    },
  });
}

export default createCalculateTaxVarianceTool;
