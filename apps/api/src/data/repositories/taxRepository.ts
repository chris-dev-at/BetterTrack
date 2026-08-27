import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { newId } from '../ids';
import { dividends, portfolioCashMovements, taxYearChanges, userTaxSettings } from '../schema';
import type { CashMovementRow, DividendRow, UserTaxSettingsRow } from '../schema';
import {
  insertCashMovementsInTransaction,
  lockPortfolioCashLedgerInTransaction,
  type NewCashMovement,
} from './cashMovementRepository';
import { stampMovementTags } from './cashSystemTagStamp';

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

export interface TaxYearChangeRecord {
  year: number;
  lastChangedAt: Date | null;
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

    /** Persisted change markers only; callers with their own year set map misses to null. */
    async listTaxYearChanges(userId: string): Promise<TaxYearChangeRecord[]> {
      const rows = await db
        .select({ year: taxYearChanges.year, lastChangedAt: taxYearChanges.lastChangedAt })
        .from(taxYearChanges)
        .where(eq(taxYearChanges.userId, userId))
        .orderBy(taxYearChanges.year);
      return rows;
    },

    /**
     * Account-wide documentation list. Source rows that predate the marker
     * feature remain visible with `lastChangedAt: null`; explicit tax-year
     * corrections use their attributed year instead of their posting date.
     * Locked-stub source rows are excluded from the server aggregate.
     */
    async listTaxYearDocumentation(userId: string): Promise<TaxYearChangeRecord[]> {
      const result = (await db.execute(sql`
        WITH source_years AS (
          SELECT
            EXTRACT(YEAR FROM t.executed_at AT TIME ZONE 'Europe/Vienna')::integer AS year,
            p.vault_id
          FROM transactions t
          JOIN portfolios p ON p.id = t.portfolio_id
          WHERE p.user_id = ${userId}
          UNION ALL
          SELECT
            EXTRACT(YEAR FROM d.executed_at AT TIME ZONE 'Europe/Vienna')::integer AS year,
            p.vault_id
          FROM dividends d
          JOIN portfolios p ON p.id = d.portfolio_id
          WHERE p.user_id = ${userId}
          UNION ALL
          SELECT
            COALESCE(
              m.tax_year,
              EXTRACT(YEAR FROM m.executed_at AT TIME ZONE 'Europe/Vienna')::integer
            ) AS year,
            p.vault_id
          FROM portfolio_cash_movements m
          JOIN portfolios p ON p.id = m.portfolio_id
          WHERE p.user_id = ${userId}
        ),
        years AS (
          SELECT source.year
          FROM source_years source
          WHERE source.vault_id IS NULL
          UNION
          SELECT c.year
          FROM tax_year_changes c
          WHERE c.user_id = ${userId}
            -- The marker is account-wide and has no portfolio FK. Suppress it
            -- only when current source evidence makes it vaulted-only; marker-
            -- only years (for deleted plain rows) retain their living-history
            -- contract. Move-in must retire vault-only markers as it purges the
            -- final source evidence.
            AND NOT (
              EXISTS (
                SELECT 1
                FROM source_years vaulted
                WHERE vaulted.year = c.year
                  AND vaulted.vault_id IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM source_years plain
                WHERE plain.year = c.year
                  AND plain.vault_id IS NULL
              )
            )
        )
        SELECT years.year, changes.last_changed_at AS "lastChangedAt"
        FROM years
        LEFT JOIN tax_year_changes changes
          ON changes.user_id = ${userId} AND changes.year = years.year
        ORDER BY years.year DESC
      `)) as unknown as
        | { rows?: Array<{ year: number | string; lastChangedAt: Date | string | null }> }
        | Array<{ year: number | string; lastChangedAt: Date | string | null }>;
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      return rows.map((row) => ({
        year: Number(row.year),
        lastChangedAt:
          row.lastChangedAt === null
            ? null
            : row.lastChangedAt instanceof Date
              ? row.lastChangedAt
              : new Date(row.lastChangedAt),
      }));
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
          // Auto-tagging (V5 cash fusion): the inflow becomes `dividend`, its
          // settlement legs `tax`, in the dividend's own transaction.
          await stampMovementTags(tx, portfolioId, movementRows);
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
     * Delete a dividend (its linked movements cascade via `dividend_id`) and
     * append every resulting tax correction in one advisory-locked database
     * transaction. The lock is acquired before the delete, matching the
     * reconciliation path and keeping its lock order deadlock-safe.
     */
    async deleteForPortfolioWithCorrections(
      portfolioId: string,
      id: string,
      corrections: readonly NewCashMovement[],
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        await lockPortfolioCashLedgerInTransaction(tx, portfolioId);
        const rows = await tx
          .delete(dividends)
          .where(and(eq(dividends.id, id), eq(dividends.portfolioId, portfolioId)))
          .returning({ id: dividends.id });
        if (rows.length === 0) return false;
        await insertCashMovementsInTransaction(tx, portfolioId, corrections);
        return true;
      });
    },
  };
}

export type TaxRepository = ReturnType<typeof createTaxRepository>;
