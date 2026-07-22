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
 * Revolut account-statement mapper (PROJECTPLAN.md §13.5 V5-P9). The Revolut CSV
 * export is comma-separated English with `YYYY-MM-DD HH:MM:SS` timestamps and
 * plain (`-9.99`) decimals:
 *
 *   Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,
 *     State,Balance
 *
 * `Amount` is the signed effect in the account `Currency` (which may be non-EUR —
 * an expense row carries its own currency, no FX). Only `COMPLETED` rows are real
 * money; `PENDING`/`REVERTED`/`DECLINED` rows are flagged as errors (excluded from
 * apply, reported). The `Fee` column is informational and not booked as a
 * separate row (expense tracking is not broker-grade reconciliation).
 */

const COLUMNS = [
  'type',
  'product',
  'started date',
  'completed date',
  'description',
  'amount',
  'fee',
  'currency',
  'state',
  'balance',
] as const;

export const revolutMapper: BankStatementMapper = {
  id: 'revolut',
  label: 'Revolut',

  // Signature: `Product` + `State` + `Amount` + `Currency` (the Revolut combo);
  // absence disqualifies (score 0). Otherwise the fraction of columns present.
  detect(csv: ParsedCsv): number {
    if (columnIndex(csv.header, 'product') < 0) return 0;
    if (columnIndex(csv.header, 'state') < 0) return 0;
    if (columnIndex(csv.header, 'amount') < 0) return 0;
    if (columnIndex(csv.header, 'currency') < 0) return 0;
    return headerCoverage(csv.header, COLUMNS);
  },

  map(csv: ParsedCsv): MappedExpenseLine[] {
    const type = columnIndex(csv.header, 'type');
    const started = columnIndex(csv.header, 'started date');
    const completed = columnIndex(csv.header, 'completed date');
    const description = columnIndex(csv.header, 'description');
    const amount = columnIndex(csv.header, 'amount');
    const currency = columnIndex(csv.header, 'currency');
    const state = columnIndex(csv.header, 'state');
    const cell = (record: CsvRecord, idx: number): string =>
      idx >= 0 ? (record.cells[idx] ?? '') : '';

    return csv.records.map((record): MappedExpenseLine => {
      const stateRaw = cell(record, state).trim().toUpperCase();
      if (stateRaw && stateRaw !== 'COMPLETED') {
        return {
          line: record.line,
          raw: record.raw,
          ok: false,
          error: `Transaction state is "${cell(record, state) || '(empty)'}" — only COMPLETED rows are imported.`,
        };
      }
      return buildExpenseRow({
        line: record.line,
        raw: record.raw,
        // Prefer the completion day (when it settled); fall back to the start.
        dateRaw: firstNonEmpty(cell(record, completed), cell(record, started)),
        amountRaw: cell(record, amount),
        currencyRaw: cell(record, currency),
        description: firstNonEmpty(cell(record, description), cell(record, type)),
      });
    });
  },
};
