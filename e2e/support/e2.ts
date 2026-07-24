/**
 * E2-specific e2e fixtures — comments/reactions + expense-budget gates
 * ([V5-P14][E2], #736).
 *
 * Two behaviors these specs drive have no *static* fixture that stays valid over
 * time, and one has no owner-facing UI seam:
 *
 *  - **Deterministic, current-month bank statement.** The V5-P9 budget evaluator
 *    ({@link ExpenseBudgetService.evaluate}) only sums the CURRENT calendar month
 *    (`YYYY-MM`, UTC) when it decides whether a budget is blown, and it runs off
 *    the live API clock in the running Playwright stack (no injected clock). A
 *    checked-in CSV with a fixed month would therefore stop firing the alert the
 *    moment the month rolls over. So {@link buildBankStatement} synthesizes a
 *    real Revolut export dated on the first of *this* month at run time — same
 *    header/column shape as the golden `revolut.csv` fixture, so it autodetects
 *    as Revolut and maps byte-for-byte the same way — and returns it alongside
 *    the exact totals the dashboard/budget must reconcile to. Deterministic per
 *    run, no external service, no sleeps.
 *
 *  - **Owner comment moderation.** Comments/reactions mount ONLY on the
 *    friend-shared read-only pages (`/social/shared-with-me/**`), which an item's
 *    OWNER cannot open for their own item (the shared read is friendship-gated
 *    and the owner is never their own friend). There is thus no owner-facing
 *    comment UI to click — but the DELETE endpoint authorizes the owner via
 *    `ownsSubject` (item-owner moderates any comment, §13.5 V5-P8). So the spec
 *    drives owner moderation through the owner's OWN authenticated session against
 *    the real production endpoints (the same `context.request` cookie-jar seam
 *    `alerts.spec.ts` uses for deterministic setup) and then proves the effect in
 *    the in-audience friend's real UI. No product-code change, no test endpoint.
 *
 * These helpers are pure fixtures/glue — they touch neither general e2e helpers
 * nor product code.
 */
import type { APIRequestContext } from '@playwright/test';

import { API_BASE_URL } from './config';

/** Mutating API calls need this header or the CSRF guard 403s them (see `alerts.spec.ts`). */
export const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' } as const;

/** Absolute `/api/v1` URL for a session-cookie-backed request-context call. */
export function apiV1(path: string): string {
  return `${API_BASE_URL}/api/v1${path}`;
}

/** One synthesized bank-statement expense row (a signed cash movement). */
export interface BankStatementRow {
  /** Merchant/memo the auto-categorization rules match against. */
  description: string;
  /** Positive magnitude in EUR; `direction` is derived from `sign`. */
  amount: number;
  sign: 'expense' | 'income';
}

export interface BankStatement {
  /** Playwright `setInputFiles` payload for the real `<input type=file>`. */
  file: { name: string; mimeType: string; buffer: Buffer };
  /** `YYYY-MM` period these rows fall in — the month the dashboard/budget read. */
  month: string;
  /** The grocery rows (all match the `spar` auto-rule). */
  groceries: BankStatementRow[];
  /** The single salary income row (no rule matches it — categorized by hand). */
  salary: BankStatementRow;
  /** Σ grocery magnitudes — the Groceries category spend to reconcile. */
  groceriesTotal: number;
  /** The salary magnitude — the month's income to reconcile. */
  salaryTotal: number;
  /** The Groceries budget target, deliberately below `groceriesTotal`. */
  budgetTarget: number;
  /** Rows that land (all grocery + salary rows) — the apply-summary count. */
  appliedCount: number;
}

/** The current calendar month `YYYY-MM` (UTC) — matches the server's period key. */
function currentMonthUtc(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Build a deterministic Revolut CSV for the current month plus the exact totals
 * it must reconcile to. Three grocery rows (all containing "SPAR", so the single
 * `contains spar → Groceries` rule auto-files them) summing to €300, one €2 000
 * salary credit, and a €200 Groceries budget the groceries overrun by design.
 * All rows are dated the 1st of the current month (always ≤ today, so never a
 * future-dated import) and carry distinct amounts so no two dedupe together.
 */
export function buildBankStatement(now: Date = new Date()): BankStatement {
  const month = currentMonthUtc(now);
  const day = `${month}-01`;
  const groceries: BankStatementRow[] = [
    { description: 'SPAR WIEN 4020', amount: 120, sign: 'expense' },
    { description: 'SPAR GRAZ 8010', amount: 100, sign: 'expense' },
    { description: 'SPAR LINZ 4030', amount: 80, sign: 'expense' },
  ];
  const salary: BankStatementRow = {
    description: 'ACME GMBH SALARY',
    amount: 2000,
    sign: 'income',
  };

  // Revolut export columns (see revolut mapper / golden `revolut.csv` fixture).
  const header =
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance';
  const toLine = (row: BankStatementRow, index: number): string => {
    const signed = (row.sign === 'expense' ? -row.amount : row.amount).toFixed(2);
    const ts = (hour: number) => `${day} ${String(hour).padStart(2, '0')}:00:00`;
    const kind = row.sign === 'income' ? 'TRANSFER' : 'CARD_PAYMENT';
    // A running balance column keeps the export realistic; it is informational
    // (the mapper ignores it), so any monotone value is fine.
    return [
      kind,
      'Current',
      ts(8 + index),
      ts(9 + index),
      row.description,
      signed,
      '0.00',
      'EUR',
      'COMPLETED',
      (1000 + index * 10).toFixed(2),
    ].join(',');
  };

  const rows = [...groceries, salary];
  const csv = [header, ...rows.map(toLine)].join('\n');
  const groceriesTotal = groceries.reduce((sum, r) => sum + r.amount, 0);

  return {
    file: { name: 'revolut-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') },
    month,
    groceries,
    salary,
    groceriesTotal,
    salaryTotal: salary.amount,
    budgetTarget: 200,
    appliedCount: rows.length,
  };
}

/** A comment as the item owner's `GET …/thread` returns it (fields we assert on). */
interface ThreadComment {
  id: string;
  author: { id: string; username: string };
  body: string;
}

/**
 * The comment ids currently on a portfolio's thread, read through the caller's
 * own session (the owner is authorized by ownership). Used to locate the exact
 * comment the owner then moderates.
 */
export async function ownerThreadComments(
  request: APIRequestContext,
  portfolioId: string,
): Promise<ThreadComment[]> {
  const res = await request.get(apiV1(`/social/items/portfolio/${portfolioId}/thread`));
  if (!res.ok()) throw new Error(`E2: owner thread read ${res.status()}: ${await res.text()}`);
  const body = (await res.json()) as { comments: ThreadComment[] };
  return body.comments;
}

/** Item-owner moderation: soft-delete one comment through the real DELETE endpoint. */
export async function ownerDeleteComment(
  request: APIRequestContext,
  commentId: string,
): Promise<void> {
  const res = await request.delete(apiV1(`/social/comments/${commentId}`), {
    headers: CSRF_HEADERS,
  });
  if (!res.ok()) throw new Error(`E2: owner delete ${res.status()}: ${await res.text()}`);
}
