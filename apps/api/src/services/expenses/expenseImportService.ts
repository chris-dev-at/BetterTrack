import { createHash } from 'node:crypto';

import type {
  ExpenseBankListResponse,
  ExpenseDirection,
  ExpenseImportApplyResponse,
  ExpenseImportApplyRow,
  ExpenseImportCounts,
  ExpenseImportOverride,
  ExpenseImportPreviewResponse,
  ExpenseImportPreviewRow,
} from '@bettertrack/contracts';
import { IMPORT_MAX_ROWS, importSourceTag } from '@bettertrack/contracts';

import { badRequest } from '../../errors';
import type {
  ExpenseCategoryRepository,
  ExpenseRuleRepository,
  ExpenseTransactionRepository,
  InsertImportedExpenseInput,
} from '../../data/repositories/expenseRepository';
import { parseCsv, type ParsedCsv } from '../imports/csv';
import { createBankMapperRegistry, type BankStatementMapper } from '../imports/expenseBank';
import { categorizeByRules } from './ruleEngine';

/**
 * Bank-statement CSV import (PROJECTPLAN.md §13.5 V5-P9, issue 2/3). Upload →
 * autodetect (or pick) the bank → a staged preview (per-row `new`/`duplicate`/
 * `error` flag + the rule engine's suggested category) → an explicit apply that
 * books the rows into `expense_transactions`, stamped `import:<bank>`.
 *
 * STATELESS by design — P9 owns no import staging table (a column would need a
 * migration this issue must not add). The preview persists nothing; apply
 * re-parses the same re-uploaded file (so amounts/dates stay server-authoritative,
 * never client-echoed money) and leans on the `UNIQUE(user, dedup_hash)` key so a
 * re-import of an already-applied file writes nothing.
 *
 * Strictly separate from portfolio money — like the rest of the expense area it
 * imports no `domain/**`, tax or portfolio surface (the P9 mandate).
 */

export interface ExpenseImportServiceDeps {
  categories: ExpenseCategoryRepository;
  transactions: ExpenseTransactionRepository;
  rules: ExpenseRuleRepository;
  mappers: readonly BankStatementMapper[];
}

export interface ExpenseImportPreviewInput {
  content: string;
  filename: string;
  /** Manual bank override; omitted → autodetect. */
  bankId?: string;
}

export interface ExpenseImportApplyInput extends ExpenseImportPreviewInput {
  /** Preview-time category overrides (matched by the deterministic physical row index). */
  overrides?: ExpenseImportOverride[];
}

export interface ExpenseImportService {
  /** The supported bank mappers, for the manual picker. */
  listBanks(): ExpenseBankListResponse;
  /** Parse + normalize + auto-categorize + flag duplicates — persists nothing. */
  preview(userId: string, input: ExpenseImportPreviewInput): Promise<ExpenseImportPreviewResponse>;
  /** Re-parse + apply the non-duplicate rows in one transaction; per-row outcomes. */
  apply(userId: string, input: ExpenseImportApplyInput): Promise<ExpenseImportApplyResponse>;
}

const CATEGORY_REF_INVALID = () =>
  badRequest('Referenced category not found.', 'EXPENSE_CATEGORY_REF_NOT_FOUND');

/**
 * Cent-canonical decimal so `5`, `5.0` and `5.00` hash identically (mirrors the
 * broker `contentHash.canonicalAmount`, kept LOCAL so the strictly-separate
 * expense area never imports the domain money-math `contentHash.ts` pulls in).
 */
function canonicalAmount(value: number): string {
  const fixed = value.toFixed(2);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

/** Trim + collapse whitespace + lowercase so trivial memo reformatting still dedupes. */
function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The idempotency key for one imported bank row: `date+direction+amount+currency+
 * description`, sha-256 hex. Deterministic from the file, so a re-import produces
 * the same hash and the UNIQUE(user, dedup_hash) key skips it. (Two genuinely
 * distinct rows identical on all five fields — e.g. two same-day identical coffees
 * — collide and the second is treated as a duplicate; the same accepted trade-off
 * as the broker `contentHash`.)
 */
export function expenseDedupHash(row: {
  bookedOn: string;
  direction: ExpenseDirection;
  amount: number;
  currency: string;
  description: string;
}): string {
  const key = [
    row.bookedOn,
    row.direction,
    canonicalAmount(row.amount),
    row.currency.toUpperCase(),
    normalizeDescription(row.description),
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

export function createExpenseImportService(deps: ExpenseImportServiceDeps): ExpenseImportService {
  const { categories, transactions, rules } = deps;
  const registry = createBankMapperRegistry(deps.mappers);

  /** Shared parse + row guards + mapper resolution for preview and apply. */
  function parseAndResolve(input: ExpenseImportPreviewInput): {
    csv: ParsedCsv;
    mapper: BankStatementMapper;
  } {
    const csv = parseCsv(input.content);
    if (!csv.header || csv.records.length === 0) {
      throw badRequest('The file contains no data rows.', 'EXPENSE_IMPORT_EMPTY');
    }
    if (csv.records.length > IMPORT_MAX_ROWS) {
      throw badRequest(
        `The file has more than ${IMPORT_MAX_ROWS} rows — split it and import in parts.`,
        'EXPENSE_IMPORT_TOO_MANY_ROWS',
      );
    }
    let mapper: BankStatementMapper | null;
    if (input.bankId !== undefined) {
      mapper = registry.byId(input.bankId);
      if (!mapper) throw badRequest('Unknown bank.', 'EXPENSE_IMPORT_BANK_UNKNOWN');
    } else {
      mapper = registry.detect(csv);
      if (!mapper) {
        throw badRequest(
          'This file does not match any supported bank export — pick the bank manually.',
          'EXPENSE_IMPORT_BANK_UNRECOGNIZED',
        );
      }
    }
    return { csv, mapper };
  }

  return {
    listBanks() {
      return { banks: registry.list() };
    },

    async preview(userId, input) {
      const { csv, mapper } = parseAndResolve(input);
      const mapped = mapper.map(csv);

      const categoryRecords = await categories.listForOwner(userId);
      const categoryName = new Map(categoryRecords.map((c) => [c.id, c.name]));
      const ruleRecords = await rules.listForOwner(userId);
      const existing = await transactions.dedupHashesForOwner(userId);
      const seen = new Set<string>();

      const rows: ExpenseImportPreviewRow[] = mapped.map((line) => {
        if (!line.ok) {
          return {
            rowIndex: line.line,
            raw: line.raw,
            flag: 'error',
            message: line.error,
            bookedOn: null,
            direction: null,
            amount: null,
            currency: null,
            description: null,
            categoryId: null,
            categoryName: null,
          };
        }
        const row = line.row;
        const hash = expenseDedupHash(row);
        const duplicate = existing.has(hash) || seen.has(hash);
        seen.add(hash);
        // Only suggest a category for rows that will actually import.
        const categoryId = duplicate ? null : categorizeByRules(row.description, ruleRecords);
        return {
          rowIndex: line.line,
          raw: line.raw,
          flag: duplicate ? 'duplicate' : 'new',
          message: null,
          bookedOn: row.bookedOn,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
          description: row.description,
          categoryId,
          categoryName: categoryId ? (categoryName.get(categoryId) ?? null) : null,
        };
      });

      const counts: ExpenseImportCounts = { total: rows.length, new: 0, duplicate: 0, error: 0 };
      for (const row of rows) counts[row.flag] += 1;

      return {
        bankId: mapper.id,
        bankLabel: mapper.label,
        filename: input.filename,
        counts,
        rows,
      };
    },

    async apply(userId, input) {
      const { csv, mapper } = parseAndResolve(input);
      const mapped = mapper.map(csv);

      // Validate every user override up front (uniform 400, never an IDOR probe)
      // and index them by the deterministic physical row line.
      const owned = new Set((await categories.listForOwner(userId)).map((c) => c.id));
      const overrideByRow = new Map<number, string | null>();
      for (const override of input.overrides ?? []) {
        if (override.categoryId !== null && !owned.has(override.categoryId)) {
          throw CATEGORY_REF_INVALID();
        }
        overrideByRow.set(override.rowIndex, override.categoryId);
      }

      const ruleRecords = await rules.listForOwner(userId);
      const existing = await transactions.dedupHashesForOwner(userId);
      const seen = new Set<string>();
      const source = importSourceTag(mapper.id);

      interface PendingOutcome {
        rowIndex: number;
        result: ExpenseImportApplyRow['result'];
        message: string | null;
        /** Set only for rows queued to insert — reconciled against what landed. */
        hash?: string;
      }
      const outcomes: PendingOutcome[] = [];
      const toInsert: InsertImportedExpenseInput[] = [];

      for (const line of mapped) {
        if (!line.ok) {
          outcomes.push({ rowIndex: line.line, result: 'skipped_error', message: line.error });
          continue;
        }
        const row = line.row;
        const hash = expenseDedupHash(row);
        if (existing.has(hash) || seen.has(hash)) {
          outcomes.push({
            rowIndex: line.line,
            result: 'skipped_duplicate',
            message: 'An identical row already exists.',
          });
          continue;
        }
        seen.add(hash);
        const categoryId = overrideByRow.has(line.line)
          ? (overrideByRow.get(line.line) ?? null)
          : categorizeByRules(row.description, ruleRecords);
        toInsert.push({
          categoryId,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
          bookedOn: row.bookedOn,
          description: row.description,
          source,
          dedupHash: hash,
        });
        outcomes.push({ rowIndex: line.line, result: 'applied', message: null, hash });
      }

      const inserted = await transactions.insertImported(userId, toInsert);
      // Any row we queued whose hash did not land lost a race to a concurrent
      // apply — report it as a duplicate rather than claim it applied.
      for (const outcome of outcomes) {
        if (outcome.result === 'applied' && outcome.hash && !inserted.has(outcome.hash)) {
          outcome.result = 'skipped_duplicate';
          outcome.message = 'An identical row was recorded since this preview was created.';
        }
      }

      let applied = 0;
      let duplicate = 0;
      let error = 0;
      for (const outcome of outcomes) {
        if (outcome.result === 'applied') applied += 1;
        else if (outcome.result === 'skipped_duplicate') duplicate += 1;
        else error += 1;
      }

      return {
        bankId: mapper.id,
        bankLabel: mapper.label,
        applied,
        duplicate,
        error,
        rows: outcomes.map((o) => ({ rowIndex: o.rowIndex, result: o.result, message: o.message })),
      };
    },
  };
}
