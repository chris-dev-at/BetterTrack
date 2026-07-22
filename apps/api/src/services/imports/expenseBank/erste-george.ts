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
 * Erste Bank / George account-statement mapper (PROJECTPLAN.md §13.5 V5-P9). The
 * George web export is a semicolon-separated German CSV:
 *
 *   Buchungsdatum;Valutadatum;Partnername;Verwendungszweck;Betrag;Währung
 *
 * Dates are `DD.MM.YYYY` (or ISO), amounts German notation (`-38,20` / `2.500,00`)
 * whose sign gives the direction. `Partnername` (the counterparty) is the primary
 * description, falling back to `Verwendungszweck` (the purpose text). Distinct
 * from the SECURITIES `george` broker mapper — that one carries ISIN/Stück/Kurs;
 * this account export carries Partnername/Verwendungszweck, so they never
 * cross-detect.
 */

const COLUMNS = [
  'buchungsdatum',
  'valutadatum',
  'partnername',
  'verwendungszweck',
  'betrag',
  'währung',
] as const;

export const ersteGeorgeMapper: BankStatementMapper = {
  id: 'erste_george',
  label: 'Erste / George',

  // Signature columns unique to the George account export (Partnername +
  // Verwendungszweck); their absence disqualifies (score 0) so an ELBA/N26/
  // Revolut file never resolves here. Otherwise the fraction of columns present.
  detect(csv: ParsedCsv): number {
    if (columnIndex(csv.header, 'partnername') < 0) return 0;
    if (columnIndex(csv.header, 'verwendungszweck') < 0) return 0;
    if (columnIndex(csv.header, 'betrag') < 0) return 0;
    return headerCoverage(csv.header, COLUMNS);
  },

  map(csv: ParsedCsv): MappedExpenseLine[] {
    const date = columnIndex(csv.header, 'buchungsdatum');
    const payee = columnIndex(csv.header, 'partnername');
    const purpose = columnIndex(csv.header, 'verwendungszweck');
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
        description: firstNonEmpty(cell(record, payee), cell(record, purpose)),
      }),
    );
  },
};
