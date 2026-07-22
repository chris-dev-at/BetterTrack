import type { CsvRecord, ParsedCsv } from '../csv';
import {
  buildExpenseRow,
  columnIndex,
  firstNonEmpty,
  headerCoverage,
  type BankStatementMapper,
  type MappedExpenseLine,
} from './types';

/**
 * Raiffeisen ELBA account-statement mapper (PROJECTPLAN.md §13.5 V5-P9). The ELBA
 * export is a semicolon-separated German CSV:
 *
 *   Kontonummer;Buchungsdatum;Valutadatum;Buchungstext;Betrag;Währung
 *
 * Dates are `DD.MM.YYYY` (or ISO), amounts German notation whose sign gives the
 * direction. `Buchungstext` is the memo the rules match against. Its `Buchungstext`
 * / `Kontonummer` columns are ELBA-only — George uses Partnername/Verwendungszweck
 * instead — so the two Austrian exports never cross-detect.
 */

const COLUMNS = [
  'kontonummer',
  'buchungsdatum',
  'valutadatum',
  'buchungstext',
  'betrag',
  'währung',
] as const;

export const raiffeisenElbaMapper: BankStatementMapper = {
  id: 'raiffeisen_elba',
  label: 'Raiffeisen ELBA',

  // Signature: `Buchungstext` (the ELBA-only memo column) + `Buchungsdatum` +
  // `Betrag`; absence disqualifies (score 0). Otherwise the fraction present.
  detect(csv: ParsedCsv): number {
    if (columnIndex(csv.header, 'buchungstext') < 0) return 0;
    if (columnIndex(csv.header, 'buchungsdatum') < 0) return 0;
    if (columnIndex(csv.header, 'betrag') < 0) return 0;
    return headerCoverage(csv.header, COLUMNS);
  },

  map(csv: ParsedCsv): MappedExpenseLine[] {
    const date = columnIndex(csv.header, 'buchungsdatum');
    const text = columnIndex(csv.header, 'buchungstext');
    const amount = columnIndex(csv.header, 'betrag');
    const currency = columnIndex(csv.header, 'währung');
    const cell = (record: CsvRecord, idx: number): string =>
      idx >= 0 ? (record.cells[idx] ?? '') : '';

    return csv.records.map((record) =>
      buildExpenseRow({
        line: record.line,
        raw: record.raw,
        dateRaw: cell(record, date),
        amountRaw: cell(record, amount),
        currencyRaw: cell(record, currency),
        description: firstNonEmpty(cell(record, text)),
      }),
    );
  },
};
