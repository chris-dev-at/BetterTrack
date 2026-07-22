import { describe, expect, it } from 'vitest';

import type { PortfolioAsset, TaxYearReportResponse } from '@bettertrack/contracts';

import { splitCells } from '../../imports/csv';
import { serializeTaxYearReportCsv, taxReportCsvFilename } from '../taxReportCsv';

/**
 * Pure CSV serialization of a per-year tax report (V5-P4b, #583). The download
 * must show exactly the numbers the on-screen report renders (both an AT year
 * and a DE year incl. allowance/pot fields), parse cleanly with awkward asset
 * names, and stay valid when the year is empty.
 */

function asset(over: Partial<PortfolioAsset> = {}): PortfolioAsset {
  return {
    id: 'a1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock',
    isCustom: false,
    ...over,
  };
}

/** An AT-taxed year with one asset, one covered sell and one dividend. */
const AT_YEAR: TaxYearReportResponse = {
  year: 2026,
  summary: {
    year: 2026,
    realizedPnlEur: 350,
    dividendsGrossEur: 40,
    taxWithheldEur: 123.75,
    taxRefundedEur: 27.5,
    taxNetEur: 96.25,
  },
  positions: [
    {
      asset: asset(),
      realizedPnlEur: 350,
      dividendsGrossEur: 40,
      taxEur: 107.25,
      sells: [
        {
          transactionId: 't1',
          executedAt: '2026-03-04T10:00:00.000Z',
          quantity: 5,
          proceedsEur: 1000,
          costBasisEur: 650,
          realizedPnlEur: 350,
          taxMode: 'country_specific',
          taxAmountEur: 96.25,
        },
      ],
      dividends: [
        {
          dividendId: 'd1',
          executedAt: '2026-06-01T00:00:00.000Z',
          grossAmountEur: 40,
          taxMode: 'country_specific',
          taxAmountEur: 11,
        },
      ],
    },
  ],
};

/** A DE-taxed year carrying the German year-end block. */
const DE_YEAR: TaxYearReportResponse = {
  year: 2025,
  summary: {
    year: 2025,
    realizedPnlEur: 800,
    dividendsGrossEur: 100,
    taxWithheldEur: 150.25,
    taxRefundedEur: 0,
    taxNetEur: 150.25,
    de: {
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      aktienPotInEur: 200,
      aktienPotOutEur: 50,
      sonstigePotInEur: 0,
      sonstigePotOutEur: 0,
      kapestEur: 142.5,
      soliEur: 7.75,
    },
  },
  positions: [
    {
      asset: asset({ id: 'a2', symbol: 'SAP.DE', name: 'SAP SE', currency: 'EUR' }),
      realizedPnlEur: 800,
      dividendsGrossEur: 100,
      taxEur: 150.25,
      sells: [
        {
          transactionId: 't2',
          executedAt: '2025-09-10T09:30:00.000Z',
          quantity: 3,
          proceedsEur: 1200,
          costBasisEur: 400,
          realizedPnlEur: 800,
          taxMode: 'country_specific',
          taxAmountEur: 150.25,
        },
      ],
      dividends: [],
    },
  ],
};

/** One parsed section: `{ title, header: string[], rows: string[][] }`. */
interface Section {
  title: string;
  header: string[];
  rows: string[][];
}

/**
 * Parse the multi-section CSV back into sections. Blank lines separate
 * sections; each section starts with a `[<section-label>, <title>]` marker
 * row, then a column-header row, then data rows.
 */
function parseSections(csv: string): Section[] {
  const lines = csv.split(/\r\n|\n/);
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '' || lines[i] === undefined) {
      i++;
      continue;
    }
    const marker = splitCells(lines[i]!, ',');
    const title = marker[1] ?? '';
    i++;
    const header = i < lines.length ? splitCells(lines[i]!, ',') : [];
    i++;
    const rows: string[][] = [];
    while (i < lines.length && lines[i] !== '' && lines[i] !== undefined) {
      rows.push(splitCells(lines[i]!, ','));
      i++;
    }
    sections.push({ title, header, rows });
  }
  return sections;
}

function section(csv: string, title: string): Section {
  const found = parseSections(csv).find((s) => s.title === title);
  if (!found) throw new Error(`Section "${title}" not found`);
  return found;
}

describe('serializeTaxYearReportCsv', () => {
  it('exports every AT summary + drill-down number the on-screen report shows', () => {
    const csv = serializeTaxYearReportCsv(AT_YEAR, 'en');

    const summary = section(csv, 'Summary').rows[0]!;
    expect(summary).toEqual(['2026', '350.00', '40.00', '123.75', '27.50', '96.25']);

    const position = section(csv, 'Positions').rows[0]!;
    expect(position).toEqual(['AAPL', 'Apple Inc.', '350.00', '40.00', '107.25']);

    const sell = section(csv, 'Sells').rows[0]!;
    expect(sell).toEqual([
      'AAPL',
      'Apple Inc.',
      '2026-03-04',
      '5',
      '1000.00',
      '650.00',
      '350.00',
      'country_specific',
      '96.25',
    ]);

    const dividend = section(csv, 'Dividends').rows[0]!;
    expect(dividend).toEqual([
      'AAPL',
      'Apple Inc.',
      '2026-06-01',
      '40.00',
      'country_specific',
      '11.00',
    ]);

    // No DE block on an AT year (anti-bloat: absent, not zeroed).
    expect(parseSections(csv).some((s) => s.title === 'Germany (Abgeltungsteuer)')).toBe(false);
  });

  it('exports the DE year-end block with allowance + both loss pots + KapESt/Soli', () => {
    const csv = serializeTaxYearReportCsv(DE_YEAR, 'en');

    const de = section(csv, 'Germany (Abgeltungsteuer)');
    expect(de.header).toEqual([
      'Allowance used (EUR)',
      'Allowance remaining (EUR)',
      'Share-loss pot in (EUR)',
      'Share-loss pot out (EUR)',
      'Other-loss pot in (EUR)',
      'Other-loss pot out (EUR)',
      'KapESt (EUR)',
      'Soli (EUR)',
    ]);
    expect(de.rows[0]).toEqual([
      '1000.00',
      '0.00',
      '200.00',
      '50.00',
      '0.00',
      '0.00',
      '142.50',
      '7.75',
    ]);

    expect(section(csv, 'Summary').rows[0]).toEqual([
      '2025',
      '800.00',
      '100.00',
      '150.25',
      '0.00',
      '150.25',
    ]);
  });

  it('quotes and escapes asset names with commas and quotes (round-trips cleanly)', () => {
    const tricky = serializeTaxYearReportCsv(
      {
        ...AT_YEAR,
        positions: [
          {
            ...AT_YEAR.positions[0]!,
            asset: asset({ name: 'Berkshire Hathaway, "B" shares' }),
          },
        ],
      },
      'en',
    );

    // The raw line must quote the field and double the inner quotes.
    expect(tricky).toContain('"Berkshire Hathaway, ""B"" shares"');
    // …and it must survive a parse back to the exact original string.
    expect(section(tricky, 'Positions').rows[0]![1]).toBe('Berkshire Hathaway, "B" shares');
  });

  it('produces a valid empty-but-labeled CSV for an empty year', () => {
    const empty = serializeTaxYearReportCsv(
      {
        year: 2024,
        summary: {
          year: 2024,
          realizedPnlEur: 0,
          dividendsGrossEur: 0,
          taxWithheldEur: 0,
          taxRefundedEur: 0,
          taxNetEur: 0,
        },
        positions: [],
      },
      'en',
    );

    // Sections are still present and labeled, just with no data rows.
    expect(section(empty, 'Summary').rows[0]).toEqual([
      '2024',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
    ]);
    expect(section(empty, 'Positions').rows).toHaveLength(0);
    expect(section(empty, 'Sells').rows).toHaveLength(0);
    expect(section(empty, 'Dividends').rows).toHaveLength(0);
  });

  it('localizes headers to German while keeping identical numbers', () => {
    const en = serializeTaxYearReportCsv(AT_YEAR, 'en');
    const de = serializeTaxYearReportCsv(AT_YEAR, 'de');

    expect(section(de, 'Zusammenfassung').header).toEqual([
      'Jahr',
      'Realisierter G/V (EUR)',
      'Dividenden brutto (EUR)',
      'Einbehaltene Steuer (EUR)',
      'Erstattete Steuer (EUR)',
      'Netto-Steuer (EUR)',
    ]);
    // Same values under the German header as under the English one.
    expect(section(de, 'Zusammenfassung').rows[0]).toEqual(section(en, 'Summary').rows[0]);
  });

  it('appends the owner-mandated estimates disclaimer as a final section without breaking the data rows', () => {
    const csv = serializeTaxYearReportCsv(AT_YEAR, 'en');

    // The disclaimer rides in its own trailing labeled section…
    const disclaimer = section(csv, 'Disclaimer');
    expect(disclaimer.header[0]).toBe(
      'Estimates for your personal overview only — not tax advice, no guarantee of correctness, not a filing document.',
    );

    // …and the data sections above still parse to the exact same numbers.
    expect(section(csv, 'Summary').rows[0]).toEqual([
      '2026',
      '350.00',
      '40.00',
      '123.75',
      '27.50',
      '96.25',
    ]);
    expect(section(csv, 'Sells').rows[0]![0]).toBe('AAPL');
  });

  it('localizes the disclaimer section to German', () => {
    const de = serializeTaxYearReportCsv(AT_YEAR, 'de');
    expect(section(de, 'Haftungsausschluss').header[0]).toBe(
      'Schätzwerte nur für deine persönliche Übersicht — keine Steuerberatung, keine Gewähr für Richtigkeit, kein Dokument für die Steuererklärung.',
    );
  });

  it('names the download per year', () => {
    expect(taxReportCsvFilename(2026)).toBe('tax-report-2026.csv');
  });
});
