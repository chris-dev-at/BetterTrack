import { describe, expect, it } from 'vitest';

import { EXPORT_TABLE_CLASSIFICATION, EXPORTED_ENTITY_NAMES, schemaTableNames } from '../manifest';

/**
 * Completeness sweep vs the Drizzle schema (§13.4 V4-P6a "done-when", #494). The
 * classification map MUST cover every schema table exactly once — so a future
 * user-owned table breaks this test until it is exported or explicitly
 * allow-listed with a reason. Also pins the two tables the acceptance criteria
 * call out by name (cash-source movements + tax rows).
 */
describe('account-export completeness', () => {
  const tables = schemaTableNames();

  it('classifies every schema table (no gaps)', () => {
    const missing = tables.filter((t) => !(t in EXPORT_TABLE_CLASSIFICATION));
    expect(missing, `unclassified tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale classification entries', () => {
    const known = new Set(tables);
    const stale = Object.keys(EXPORT_TABLE_CLASSIFICATION).filter((t) => !known.has(t));
    expect(stale, `classification names a non-existent table: ${stale.join(', ')}`).toEqual([]);
  });

  it('every skipped table states a non-empty reason', () => {
    for (const [table, c] of Object.entries(EXPORT_TABLE_CLASSIFICATION)) {
      if (c.kind === 'skip') {
        expect(c.reason.trim().length, `${table} skipped with an empty reason`).toBeGreaterThan(0);
      }
    }
  });

  it('exports cash-source movements and tax rows (named in the acceptance criteria)', () => {
    expect(EXPORT_TABLE_CLASSIFICATION['portfolio_cash_movements']).toEqual({
      kind: 'export',
      entity: 'cashMovements',
    });
    expect(EXPORT_TABLE_CLASSIFICATION['user_tax_settings']).toEqual({
      kind: 'export',
      entity: 'taxSettings',
    });
  });

  it('exports every portfolio-owned ledger table + custom assets', () => {
    for (const table of [
      'portfolios',
      'transactions',
      'portfolio_cash_sources',
      'dividends',
      'assets',
      'price_history',
    ]) {
      expect(EXPORT_TABLE_CLASSIFICATION[table]?.kind, `${table} should be exported`).toBe(
        'export',
      );
    }
  });

  it('the exported-entity name list is derived from the classification', () => {
    const fromMap = new Set(
      Object.values(EXPORT_TABLE_CLASSIFICATION)
        .filter((c) => c.kind === 'export')
        .map((c) => (c as { entity: string }).entity),
    );
    expect(new Set(EXPORTED_ENTITY_NAMES)).toEqual(fromMap);
  });
});
