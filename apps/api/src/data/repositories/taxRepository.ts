import { and, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { newId } from '../ids';
import { dividends, portfolioCashMovements, userTaxSettings } from '../schema';
import type { CashMovementRow, DividendRow, UserTaxSettingsRow } from '../schema';
import type { NewCashMovement } from './cashMovementRepository';

/**
 * Tax-engine persistence (V3-P4, §13.3, issue #331): the per-user tax-mode
 * setting (Settings → Taxes) and the dividend rows with their atomically
 * written cash movements. Everything else the engine touches lives in its
 * existing home — transactions keep their tax columns in
 * `transactionRepository`, settlements are ordinary `portfolio_cash_movements`
 * rows — so this repository stays a thin seam over the two genuinely new
 * tables. All computation (cost basis, year pools, settlement deltas) lives in
 * `domain/tax`; all orchestration in `services/tax`.
 *
 * Reads are scoped to ids the service has already authorised (portfolio
 * ownership precedes every call), mirroring the other repositories.
 */

type TaxMode = UserTaxSettingsRow['mode'];

/** The per-user tax setting; a missing row IS `none` mode (additive default). */
export interface UserTaxSettingsRecord {
  mode: TaxMode;
  country: string | null;
  /** Manual mode's default (V5-P4c): amount OR rate, never both; null = none. */
  manualDefaultAmountEur: number | null;
  manualDefaultRatePct: number | null;
  /** The custom engine's parameter set (V5-P4c); present exactly in `custom` mode. */
  customParams: unknown;
}

/** A dividend with its money columns parsed to `number` (DB stores `numeric`). */
export interface DividendRecord {
  id: string;
  portfolioId: string;
  assetId: string;
  cashSourceId: string;
  grossAmountEur: number;
  executedAt: Date;
  note: string | null;
  /** Tax facts frozen at recording time (§16 2026-07-08). */
  taxMode: TaxMode;
  taxCountry: string | null;
  taxAmountEur: number | null;
  /** Custom-mode parameter snapshot (V5-P4c); null on non-custom rows. */
  taxParams: unknown;
  /** Source tag (V5-P0c): how this dividend entered the ledger; `manual` for hand entry. */
  source: string;
  createdAt: Date;
}

/** Fields for one dividend insert; money values arrive as `number`s. */
export interface NewDividend {
  assetId: string;
  cashSourceId: string;
  grossAmountEur: number;
  executedAt: Date;
  note: string | null;
  taxMode: TaxMode;
  taxCountry: string | null;
  taxAmountEur: number | null;
  /** Custom-mode parameter snapshot (V5-P4c); omit/null on non-custom rows. */
  taxParams?: unknown;
  /** Source tag (V5-P0c); defaults to `manual`. Its cash movements inherit it. */
  source?: string;
}

function toRecord(row: DividendRow): DividendRecord {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    assetId: row.assetId,
    cashSourceId: row.cashSourceId,
    grossAmountEur: Number(row.grossAmountEur),
    executedAt: row.executedAt,
    note: row.note ?? null,
    taxMode: row.taxMode,
    taxCountry: row.taxCountry ?? null,
    taxAmountEur: row.taxAmountEur === null ? null : Number(row.taxAmountEur),
    taxParams: row.taxParams ?? null,
    source: row.source,
    createdAt: row.createdAt,
  };
}

/** Row → record for the settings table (numeric columns parsed to `number`). */
function toSettingsRecord(row: UserTaxSettingsRow): UserTaxSettingsRecord {
  return {
    mode: row.mode,
    country: row.country ?? null,
    manualDefaultAmountEur:
      row.manualDefaultAmountEur === null ? null : Number(row.manualDefaultAmountEur),
    manualDefaultRatePct:
      row.manualDefaultRatePct === null ? null : Number(row.manualDefaultRatePct),
    customParams: row.customParams ?? null,
  };
}

export function createTaxRepository(db: Database) {
  return {
    /** The user's tax setting, or null when never set (= `none` mode). */
    async getUserTaxSettings(userId: string): Promise<UserTaxSettingsRecord | null> {
      const rows = await db
        .select()
        .from(userTaxSettings)
        .where(eq(userTaxSettings.userId, userId))
        .limit(1);
      const row = rows[0];
      return row ? toSettingsRecord(row) : null;
    },

    /** Upsert the user's tax setting (mode-dependent fields move together, CHECK-enforced). */
    async setUserTaxSettings(
      userId: string,
      settings: UserTaxSettingsRecord,
    ): Promise<UserTaxSettingsRecord> {
      const values = {
        mode: settings.mode,
        country: settings.country,
        manualDefaultAmountEur:
          settings.manualDefaultAmountEur === null ? null : String(settings.manualDefaultAmountEur),
        manualDefaultRatePct:
          settings.manualDefaultRatePct === null ? null : String(settings.manualDefaultRatePct),
        customParams: settings.customParams ?? null,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(userTaxSettings)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: userTaxSettings.userId, set: values })
        .returning();
      if (!row) throw new Error('Tax settings upsert returned no row');
      return toSettingsRecord(row);
    },

    /**
     * Insert a dividend **atomically** with its cash movements (the gross
     * `dividend` inflow and, when taxed, its settlement — plus any year
     * corrections): one DB transaction, so a mid-write failure can never leave
     * a dividend without its inflow or a half-settled year behind. The
     * dividend id is minted app-side so the movements can reference it within
     * the same transaction; movements arrive WITHOUT `dividendId` and are
     * linked here exactly when `linkDividend` marks them.
     */
    async insertDividend(
      portfolioId: string,
      dividend: NewDividend,
      movements: readonly (NewCashMovement & { linkDividend?: boolean })[],
    ): Promise<{ dividend: DividendRecord; movements: CashMovementRow[] }> {
      const dividendId = newId();
      return db.transaction(async (tx) => {
        const [row] = await (tx as unknown as Database)
          .insert(dividends)
          .values({
            id: dividendId,
            portfolioId,
            assetId: dividend.assetId,
            cashSourceId: dividend.cashSourceId,
            grossAmountEur: String(dividend.grossAmountEur),
            executedAt: dividend.executedAt,
            note: dividend.note,
            taxMode: dividend.taxMode,
            taxCountry: dividend.taxCountry,
            taxAmountEur: dividend.taxAmountEur === null ? null : String(dividend.taxAmountEur),
            taxParams: dividend.taxParams ?? null,
            source: dividend.source ?? 'manual',
          })
          .returning();
        if (!row) throw new Error('Dividend insert returned no row');
        let movementRows: CashMovementRow[] = [];
        if (movements.length > 0) {
          movementRows = await tx
            .insert(portfolioCashMovements)
            .values(
              movements.map((m) => ({
                portfolioId,
                sourceId: m.sourceId,
                kind: m.kind,
                amountEur: String(m.amountEur),
                transactionId: m.transactionId ?? null,
                dividendId: m.linkDividend ? dividendId : null,
                taxYear: m.taxYear ?? null,
                executedAt: m.executedAt,
                note: m.note,
                // A dividend's movements carry the dividend's source (V5-P0c).
                source: m.source ?? dividend.source ?? 'manual',
              })),
            )
            .returning();
        }
        return { dividend: toRecord(row), movements: movementRows };
      });
    },

    /** Every dividend of a portfolio, chronological (`executed_at` then id). */
    async listForPortfolio(portfolioId: string): Promise<DividendRecord[]> {
      const rows = await db
        .select()
        .from(dividends)
        .where(eq(dividends.portfolioId, portfolioId))
        .orderBy(dividends.executedAt, dividends.id);
      return rows.map(toRecord);
    },

    /** A single dividend scoped to its portfolio, else null (no IDOR). */
    async findByIdForPortfolio(portfolioId: string, id: string): Promise<DividendRecord | null> {
      const rows = await db
        .select()
        .from(dividends)
        .where(and(eq(dividends.id, id), eq(dividends.portfolioId, portfolioId)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    /**
     * Delete a dividend (its movements cascade via `dividend_id`). The caller
     * has already authorised the portfolio and re-checked ledger solvency.
     */
    async deleteForPortfolio(portfolioId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(dividends)
        .where(and(eq(dividends.id, id), eq(dividends.portfolioId, portfolioId)))
        .returning({ id: dividends.id });
      return rows.length > 0;
    },
  };
}

export type TaxRepository = ReturnType<typeof createTaxRepository>;
