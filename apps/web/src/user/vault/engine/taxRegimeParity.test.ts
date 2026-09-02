import { describe, expect, it } from 'vitest';

import {
  taxCountrySchema,
  taxModeSchema,
  type CustomTaxParams,
  type TaxCountry,
  type TaxMode,
} from '@bettertrack/contracts';
import { taxEngineForRow } from '@bettertrack/domain/tax';
import {
  TAX_ROW_ENGINE_VECTOR_LIVING_REGIMES,
  TAX_ROW_ENGINE_VECTORS,
  type TaxRowEngineVectorEngine,
} from '@bettertrack/domain/taxVectors';

import { VaultMoneyEngineError } from './errors';
import { taxEngineOfRegime, taxRegimeForRow, type TaxRegime, type TaxRowRegimeFacts } from './taxEngine';

/**
 * #1512 — the committed row-engine truth table replayed through the CLIENT
 * classifier (`taxRegimeForRow`). The server replays the same vectors in
 * `apps/api/src/services/tax/__tests__/countryState.test.ts`; both delegate
 * to the domain `taxEngineForRow`, so this suite proves (a) the client mirror
 * reproduces every committed outcome and (b) the client's typed regime maps
 * one-to-one onto the shared engine vocabulary. The day either side moves,
 * that side's replay fails loudly instead of the two silently settling the
 * same frozen row under different engines.
 */

const CUSTOM_PARAMS: CustomTaxParams = {
  ratePct: 20,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'fifo',
};

function activeRegimeFor(engine: TaxRowEngineVectorEngine): TaxRegime {
  switch (engine) {
    case 'none':
      return { kind: 'none' };
    case 'manual':
      return { kind: 'manual' };
    case 'AT':
      return { kind: 'at' };
    case 'DE':
      return { kind: 'de' };
    case 'FI':
      return { kind: 'fi' };
    case 'custom':
      return { kind: 'custom', params: CUSTOM_PARAMS };
  }
}

function rowFor(vector: (typeof TAX_ROW_ENGINE_VECTORS)[number]): TaxRowRegimeFacts {
  return {
    taxMode: vector.row.taxMode as TaxMode | null,
    // The vectors deliberately include values OUTSIDE the contract enum; the
    // classifier must refuse them, so they are passed through untouched.
    taxCountry: vector.row.taxCountry as TaxCountry | null,
    taxParams: vector.row.taxMode === 'custom' ? CUSTOM_PARAMS : null,
  };
}

describe('taxRegimeForRow (shared #1512 classifier, client replay)', () => {
  it('speaks the contract vocabulary the vectors are written in', () => {
    // The vectors import nothing (domain purity); prove their literals are
    // the real contract enums so a renamed mode cannot leave them stale.
    for (const vector of TAX_ROW_ENGINE_VECTORS) {
      if (vector.row.taxMode !== null) {
        expect(taxModeSchema.safeParse(vector.row.taxMode).success, vector.id).toBe(true);
      }
      if ('engine' in vector.expected && vector.expected.engine.length === 2) {
        expect(taxCountrySchema.safeParse(vector.expected.engine).success, vector.id).toBe(true);
      }
    }
    expect(TAX_ROW_ENGINE_VECTOR_LIVING_REGIMES.map((engine) => taxEngineOfRegime(activeRegimeFor(engine)))).toEqual(
      [...TAX_ROW_ENGINE_VECTOR_LIVING_REGIMES],
    );
  });

  it.each(TAX_ROW_ENGINE_VECTORS.map((vector) => [vector.id, vector] as const))(
    'vector: %s',
    (_id, vector) => {
      const active = activeRegimeFor(vector.living);
      const row = rowFor(vector);
      if ('throws' in vector.expected) {
        let caught: unknown;
        try {
          taxRegimeForRow(row, active);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(VaultMoneyEngineError);
        expect((caught as VaultMoneyEngineError).failure).toMatchObject({
          code: 'TAX_MODE_UNSUPPORTED',
          retryable: false,
        });
        expect((caught as VaultMoneyEngineError).failure.message).toContain(
          String(vector.row.taxCountry),
        );
        return;
      }
      const regime = taxRegimeForRow(row, active);
      expect(taxEngineOfRegime(regime)).toBe(vector.expected.engine);
      // Cross-check against the domain oracle directly, so the client mapping
      // can never be "consistently wrong" with a stale copy of the rules.
      expect(taxEngineOfRegime(regime)).toBe(taxEngineForRow(vector.row, vector.living));
    },
  );

  it('carries the LIVING custom parameters onto a derivable row and the FROZEN ones onto a frozen row', () => {
    const living: TaxRegime = { kind: 'custom', params: CUSTOM_PARAMS };
    const frozenParams: CustomTaxParams = { ...CUSTOM_PARAMS, ratePct: 33, costBasis: 'moving-average' };
    const row: TaxRowRegimeFacts = {
      taxMode: 'custom',
      taxCountry: null,
      taxParams: frozenParams,
    };
    expect(taxRegimeForRow(row, living)).toEqual(living);
    expect(taxRegimeForRow(row, { kind: 'manual' })).toEqual({
      kind: 'custom',
      params: frozenParams,
    });
  });

  it('refuses a custom-frozen row with a malformed parameter snapshot under the manual regime', () => {
    expect(() =>
      taxRegimeForRow(
        { taxMode: 'custom', taxCountry: null, taxParams: { ratePct: 20 } },
        { kind: 'manual' },
      ),
    ).toThrow(VaultMoneyEngineError);
  });
});
