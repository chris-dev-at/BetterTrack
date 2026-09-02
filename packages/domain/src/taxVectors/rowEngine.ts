/**
 * Row-engine conformance vectors (#1512) — the committed truth table both tax
 * engines must reproduce for "which engine does this row settle under".
 *
 * The server (`apps/api/src/services/tax/countryState.ts`) and the paranoid
 * client (`apps/web/src/user/vault/engine/taxEngine.ts`) each classify frozen
 * rows against the living regime. Until this table existed the two were
 * hand-mirrored twins with nothing pinning them together; a divergence would
 * settle the same frozen row under different engines on the two sides —
 * exactly the silent-drift class the conformance-vector discipline exists to
 * prevent. Both suites replay EVERY vector below through their own classifier
 * and the shared domain oracle (`taxEngineForRow`), so the day either side
 * moves, that side's suite fails loudly.
 *
 * Like every module in this package it imports NOTHING (design r3 build
 * ruling); the mode/country vocabulary is spelled as literals and the web
 * replay suite parses them through the real contracts enums.
 *
 * READ THE EXPECTATIONS AS DATA, NOT AS A RULE. They are hand-listed on
 * purpose: a generated table would only re-state whichever classifier
 * generated it. The rules they encode (verified against both engines at the
 * time of writing):
 *
 *  1. A `manual_per_trade` row is a user-stated fact — `manual` under EVERY
 *     living regime (never derived, never refunded).
 *  2. A `country_specific` row's frozen country is narrowed FIRST, in every
 *     regime: legacy `null` is AT (V3-P4 rows), `AT`/`DE`/`FI` are themselves,
 *     anything else fails LOUD (#669 — an unwired country must never settle at
 *     AT rates by falling through).
 *  3. Under a living regime other than `manual`, every non-manual row is
 *     re-derived under that regime — its frozen mode/country is history.
 *  4. Under the `manual` living regime the row keeps its frozen engine:
 *     `none`/`null` → `none`, `country_specific` → its country, `custom` →
 *     `custom`.
 */

export type TaxRowEngineVectorMode = 'none' | 'manual_per_trade' | 'country_specific' | 'custom';

export type TaxRowEngineVectorEngine = 'none' | 'manual' | 'AT' | 'DE' | 'FI' | 'custom';

export interface TaxRowEngineVectorRow {
  taxMode: TaxRowEngineVectorMode | null;
  taxCountry: string | null;
}

export type TaxRowEngineVectorExpectation =
  | { engine: TaxRowEngineVectorEngine }
  | { throws: 'unsupported-country' };

export interface TaxRowEngineVector {
  /** Stable, human-readable id — quoted in failure messages on both sides. */
  id: string;
  row: TaxRowEngineVectorRow;
  living: TaxRowEngineVectorEngine;
  expected: TaxRowEngineVectorExpectation;
}

const LIVING_REGIMES: readonly TaxRowEngineVectorEngine[] = [
  'none',
  'manual',
  'AT',
  'DE',
  'FI',
  'custom',
];

/**
 * One frozen-row shape with its hand-listed outcome under each living regime,
 * in {@link LIVING_REGIMES} order: none, manual, AT, DE, FI, custom.
 */
interface RowFamily {
  label: string;
  row: TaxRowEngineVectorRow;
  outcomes: readonly [
    TaxRowEngineVectorExpectation,
    TaxRowEngineVectorExpectation,
    TaxRowEngineVectorExpectation,
    TaxRowEngineVectorExpectation,
    TaxRowEngineVectorExpectation,
    TaxRowEngineVectorExpectation,
  ];
}

const engine = (value: TaxRowEngineVectorEngine): TaxRowEngineVectorExpectation => ({
  engine: value,
});
const UNSUPPORTED: TaxRowEngineVectorExpectation = { throws: 'unsupported-country' };

const ROW_FAMILIES: readonly RowFamily[] = [
  {
    label: 'legacy buy row (null mode)',
    row: { taxMode: null, taxCountry: null },
    outcomes: [
      engine('none'),
      engine('none'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  {
    label: 'none-mode row',
    row: { taxMode: 'none', taxCountry: null },
    outcomes: [
      engine('none'),
      engine('none'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  {
    label: 'manual row',
    row: { taxMode: 'manual_per_trade', taxCountry: null },
    outcomes: [
      engine('manual'),
      engine('manual'),
      engine('manual'),
      engine('manual'),
      engine('manual'),
      engine('manual'),
    ],
  },
  {
    label: 'AT-frozen row',
    row: { taxMode: 'country_specific', taxCountry: 'AT' },
    outcomes: [
      engine('none'),
      engine('AT'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  {
    label: 'DE-frozen row',
    row: { taxMode: 'country_specific', taxCountry: 'DE' },
    outcomes: [
      engine('none'),
      engine('DE'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  {
    label: 'FI-frozen row',
    row: { taxMode: 'country_specific', taxCountry: 'FI' },
    outcomes: [
      engine('none'),
      engine('FI'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  {
    label: 'legacy V3-P4 country_specific row with a null country (settles as AT)',
    row: { taxMode: 'country_specific', taxCountry: null },
    outcomes: [
      engine('none'),
      engine('AT'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  {
    label: 'custom-frozen row',
    row: { taxMode: 'custom', taxCountry: null },
    outcomes: [
      engine('none'),
      engine('custom'),
      engine('AT'),
      engine('DE'),
      engine('FI'),
      engine('custom'),
    ],
  },
  // ── Negative space: the frozen country is narrowed before anything else,
  // so an unwired or mis-spelled country fails LOUD under EVERY regime — a
  // living AT regime must not paper over a row the server would refuse to
  // load (`rowEngineCountry` throws while `portfolioHasDeRows` scans rows).
  {
    label: 'country_specific row frozen under an unwired country (US)',
    row: { taxMode: 'country_specific', taxCountry: 'US' },
    outcomes: [UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED],
  },
  {
    label: 'country_specific row with a lower-case country code (never coerced)',
    row: { taxMode: 'country_specific', taxCountry: 'de' },
    outcomes: [UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED],
  },
  {
    label: 'country_specific row with a padded country code (never trimmed)',
    row: { taxMode: 'country_specific', taxCountry: 'AT ' },
    outcomes: [UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED],
  },
  {
    label: 'country_specific row with an empty country string (not the legacy null)',
    row: { taxMode: 'country_specific', taxCountry: '' },
    outcomes: [UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED],
  },
];

/** Every (row shape × living regime) pair, hand-expected. 12 families × 6 regimes. */
export const TAX_ROW_ENGINE_VECTORS: readonly TaxRowEngineVector[] = ROW_FAMILIES.flatMap(
  (family) =>
    LIVING_REGIMES.map((living, index) => ({
      id: `${family.label} / living ${living}`,
      row: { ...family.row },
      living,
      expected: family.outcomes[index]!,
    })),
);

/** The living regimes the table spans, in the order each family's outcomes are listed. */
export const TAX_ROW_ENGINE_VECTOR_LIVING_REGIMES = LIVING_REGIMES;
