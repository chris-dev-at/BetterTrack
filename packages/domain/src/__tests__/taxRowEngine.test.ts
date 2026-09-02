import { describe, expect, it } from 'vitest';

import {
  costBasisStrategyForEngine,
  frozenTaxCountryEngine,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  taxEngineForRow,
  TaxRowClassificationError,
  type TaxRowEngine,
} from '../tax';
import { TAX_ROW_ENGINE_VECTOR_LIVING_REGIMES, TAX_ROW_ENGINE_VECTORS } from '../taxVectors';

/**
 * The single row-engine classifier (#1512) — the oracle both the server
 * (`countryState.rowTaxEngine`) and the paranoid client (`taxRegimeForRow`)
 * delegate to. Its truth table is the committed vector set; this suite proves
 * the domain function reproduces it and pins the negative space that must
 * never be coerced into a supported engine.
 */

describe('taxEngineForRow (shared classifier)', () => {
  it('spans every living regime with every row family exactly once', () => {
    expect(TAX_ROW_ENGINE_VECTOR_LIVING_REGIMES).toEqual([
      'none',
      'manual',
      'AT',
      'DE',
      'FI',
      'custom',
    ]);
    expect(TAX_ROW_ENGINE_VECTORS).toHaveLength(12 * 6);
    expect(new Set(TAX_ROW_ENGINE_VECTORS.map((vector) => vector.id)).size).toBe(
      TAX_ROW_ENGINE_VECTORS.length,
    );
  });

  it.each(TAX_ROW_ENGINE_VECTORS.map((vector) => [vector.id, vector] as const))(
    'reproduces the committed vector: %s',
    (_id, vector) => {
      if ('throws' in vector.expected) {
        expect(() => taxEngineForRow(vector.row, vector.living)).toThrow(TaxRowClassificationError);
        return;
      }
      expect(taxEngineForRow(vector.row, vector.living)).toBe(vector.expected.engine);
    },
  );

  it('names the offending country in the classification error and never falls through to AT', () => {
    expect(() => taxEngineForRow({ taxMode: 'country_specific', taxCountry: 'US' }, 'AT')).toThrow(
      /"US"/,
    );
    let caught: unknown;
    try {
      taxEngineForRow({ taxMode: 'country_specific', taxCountry: 'de' }, 'manual');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaxRowClassificationError);
    expect((caught as TaxRowClassificationError).taxCountry).toBe('de');
    expect((caught as TaxRowClassificationError).name).toBe('TaxRowClassificationError');
  });

  it('rejects an unknown frozen mode rather than guessing an engine', () => {
    expect(() =>
      taxEngineForRow({ taxMode: 'flat_rate' as unknown as 'none', taxCountry: null }, 'manual'),
    ).toThrow(TaxRowClassificationError);
  });
});

describe('frozenTaxCountryEngine', () => {
  it('maps the three shipped countries to themselves and legacy null to AT', () => {
    expect(frozenTaxCountryEngine(null)).toBe(TAX_COUNTRY_AT);
    expect(frozenTaxCountryEngine('AT')).toBe(TAX_COUNTRY_AT);
    expect(frozenTaxCountryEngine('DE')).toBe(TAX_COUNTRY_DE);
    expect(frozenTaxCountryEngine('FI')).toBe(TAX_COUNTRY_FI);
  });

  it.each(['US', 'de', 'AT ', '', 'FI\n', 'DEU'])('fails LOUD on %j', (country) => {
    expect(() => frozenTaxCountryEngine(country)).toThrow(TaxRowClassificationError);
  });
});

describe('costBasisStrategyForEngine', () => {
  const cases: Array<[TaxRowEngine, 'fifo' | 'moving-average']> = [
    ['AT', 'moving-average'],
    ['DE', 'fifo'],
    ['FI', 'fifo'],
    ['none', 'moving-average'],
    ['manual', 'moving-average'],
  ];
  it.each(cases)('%s → %s without custom parameters', (engineKind, strategy) => {
    expect(costBasisStrategyForEngine(engineKind, null)).toBe(strategy);
  });

  it('takes the custom basis from the parameter snapshot and refuses a custom row without one', () => {
    expect(costBasisStrategyForEngine('custom', { costBasis: 'fifo' })).toBe('fifo');
    expect(costBasisStrategyForEngine('custom', { costBasis: 'moving-average' })).toBe(
      'moving-average',
    );
    expect(() => costBasisStrategyForEngine('custom', null)).toThrow(TaxRowClassificationError);
  });
});
