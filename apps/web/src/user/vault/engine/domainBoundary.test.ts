import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ENGINE_ROOT = resolve(process.cwd(), 'src/user/vault/engine');

function source(file: string): string {
  return readFileSync(resolve(ENGINE_ROOT, file), 'utf8');
}

describe('E6 shared-domain money boundary', () => {
  it('keeps valuation, holdings, series and tax on audited domain imports', () => {
    const portfolio = source('portfolioEngine.ts');
    const tax = source('taxEngine.ts');
    const composition = source('composition.ts');

    expect(portfolio).toContain("from '@bettertrack/domain/cashLedger'");
    expect(portfolio).toContain("from '@bettertrack/domain/holdings'");
    expect(portfolio).toContain("from '@bettertrack/domain/seriesStats'");
    expect(tax).toContain("from '@bettertrack/domain/tax'");
    expect(composition).toContain("from '@bettertrack/domain/cashLedger'");
    expect(composition).toContain("from '@bettertrack/domain/tax'");
  });

  it('does not define local copies of the audited money primitives', () => {
    const production = [
      'portfolioEngine.ts',
      'taxEngine.ts',
      'composition.ts',
      'portfolioDocumentSet.ts',
    ]
      .map(source)
      .join('\n');
    const auditedSymbols = [
      'cashBalancesBySource',
      'netWorthSeries',
      'floorCents',
      'deriveHoldings',
      'reducePosition',
      'valueOverTime',
      'costBasisOverTime',
      'timeWeightedReturn',
      'computeSeriesStats',
      'settleAtYear',
      'settleDeYear',
      'deCarryPots',
      'dePotCategoryForAssetType',
    ];

    for (const symbol of auditedSymbols) {
      expect(production, symbol).not.toMatch(
        new RegExp(`(?:function|class|const|let|var)\\s+${symbol}\\b`),
      );
    }
    expect(production).not.toContain('apps/api/src/domain');
  });

  it('keeps statutory rates and percentage arithmetic out of composition', () => {
    const composition = source('composition.ts');

    // Figure addition is the §14 composition seam; cent normalization and all
    // offset/rate/allowance semantics must remain calls into packages/domain.
    expect(composition).not.toMatch(/\b(?:0\.275|0\.25|0\.055|1000|2000)\b/);
    expect(composition).not.toMatch(/(?:valueEur|amountEur)\s*[*/]/);
    expect(composition).not.toMatch(/[*/]\s*(?:valueEur|amountEur)/);
  });
});
