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
 * N26 account-statement mapper (PROJECTPLAN.md §13.5 V5-P9). The N26 CSV export is
 * comma-separated English with ISO dates and plain (`-42.50`) decimals:
 *
 *   Date,Payee,Account number,Transaction type,Payment reference,Amount (EUR),
 *     Amount (Foreign Currency),Type Foreign Currency,Exchange Rate
 *
 * `Amount (EUR)` is the signed EUR effect (spend negative, income positive) — the
 * booked amount is always in EUR (the foreign-currency columns are informational,
 * ignored). `Payee` is the primary description, falling back to the payment
 * reference then the transaction type.
 */

const COLUMNS = [
  'date',
  'payee',
  'account number',
  'transaction type',
  'payment reference',
  'amount (eur)',
  'amount (foreign currency)',
  'type foreign currency',
  'exchange rate',
] as const;

export const n26Mapper: BankStatementMapper = {
  id: 'n26',
  label: 'N26',

  // Signature: the `Amount (EUR)` column (N26-only) + `Date` + `Payee`; absence
  // disqualifies (score 0). Otherwise the fraction of columns present.
  detect(csv: ParsedCsv): number {
    if (columnIndex(csv.header, 'amount (eur)') < 0) return 0;
    if (columnIndex(csv.header, 'date') < 0) return 0;
    if (columnIndex(csv.header, 'payee') < 0) return 0;
    return headerCoverage(csv.header, COLUMNS);
  },

  map(csv: ParsedCsv): MappedExpenseLine[] {
    const date = columnIndex(csv.header, 'date');
    const payee = columnIndex(csv.header, 'payee');
    const type = columnIndex(csv.header, 'transaction type');
    const reference = columnIndex(csv.header, 'payment reference');
    const amount = columnIndex(csv.header, 'amount (eur)');
    const cell = (record: CsvRecord, idx: number): string =>
      idx >= 0 ? (record.cells[idx] ?? '') : '';

    return csv.records.map((record) =>
      buildExpenseRow({
        line: record.line,
        raw: record.raw,
        dateRaw: cell(record, date),
        amountRaw: cell(record, amount),
        // The N26 `Amount (EUR)` column is always EUR.
        currencyRaw: 'EUR',
        description: firstNonEmpty(
          cell(record, payee),
          cell(record, reference),
          cell(record, type),
        ),
      }),
    );
  },
};
