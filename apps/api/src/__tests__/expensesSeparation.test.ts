import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Strict-separation regression (PROJECTPLAN.md §13.5 V5-P9 acceptance #2 /
 * done-when "portfolio surfaces are byte-identical with the feature unused").
 *
 * The guarantee is STRUCTURAL: the expense module imports nothing from the
 * portfolio / domain money-math / tax layers, so it *cannot* alter their
 * behaviour — the portfolio surfaces are byte-identical whether or not a user
 * ever records an expense. This test freezes that boundary: if a future change
 * makes the expense module reach into portfolio/tax/domain code, it fails here
 * instead of silently coupling the two worlds.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..');

/** Every source file the expense feature owns on the API side. */
const EXPENSE_FILES = [
  'services/expenses/expenseService.ts',
  'data/repositories/expenseRepository.ts',
  'http/routes/expensesRoutes.ts',
];

/** Import-specifier fragments that would breach the portfolio/tax/domain wall. */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  '/domain/', // pure money-math (holdings, backtest, tax, allocation, cashLedger)
  'services/tax',
  'services/portfolio',
  'services/currency',
  'services/backtest',
  'portfolioRepository',
  'transactionRepository',
  'cashMovementRepository',
  'cashSourceRepository',
  'taxRepository',
  'dividend',
  'portfolioSnapshot',
];

function read(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8');
}

/** Every module specifier the file imports (comments are ignored — specifiers only). */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('expense module — strict separation from portfolio money (AC #2)', () => {
  it.each(EXPENSE_FILES)('%s imports nothing from portfolio/tax/domain', (rel) => {
    const specifiers = importSpecifiers(read(rel));
    for (const spec of specifiers) {
      for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
        expect(
          spec.includes(fragment),
          `${rel} imports "${spec}" which breaches the wall (contains "${fragment}")`,
        ).toBe(false);
      }
    }
  });

  it('the expense repository only imports expense tables from the schema', () => {
    const source = read('data/repositories/expenseRepository.ts');
    // Isolate the `import { … } from '../schema'` binding block.
    const match = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/schema['"]/);
    expect(match, 'expected a schema import in expenseRepository').toBeTruthy();
    const bindings = match![1]!
      .split(',')
      .map((b) => b.replace(/\btype\b/, '').trim())
      .filter(Boolean);
    expect(bindings.length).toBeGreaterThan(0);
    // Every schema binding is an expense table/type — so the repository provably
    // cannot query a portfolio/tax table (an unimported table can't be referenced).
    for (const binding of bindings) {
      expect(
        binding.toLowerCase().startsWith('expense'),
        `expenseRepository imports non-expense schema symbol "${binding}"`,
      ).toBe(true);
    }
  });
});
