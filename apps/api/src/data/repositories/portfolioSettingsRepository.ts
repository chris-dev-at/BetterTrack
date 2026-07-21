import { and, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { portfolioSettings } from '../schema';

/**
 * Per-portfolio setting overrides (issue #636). The thin generic seam over the
 * `portfolio_settings` key/jsonb table — the OVERRIDE layer of the scoping
 * cascade `effective = portfolio override ?? user default ?? system default`.
 *
 * Deliberately untyped in the value: this repository stores/returns raw jsonb so
 * ANY scopeable setting can share it without a migration. Each consuming service
 * owns its key and validates the value against its own contract at the edge (the
 * tax service parses the `'tax'` key through `taxSettingsResponseSchema`). Reads
 * are portfolio-scoped; the calling service authorises portfolio ownership
 * first, mirroring the other repositories.
 */
export function createPortfolioSettingsRepository(db: Database) {
  return {
    /** The raw override value for one (portfolio, key), or null when inheriting. */
    async getSetting(portfolioId: string, key: string): Promise<unknown | null> {
      const rows = await db
        .select({ value: portfolioSettings.value })
        .from(portfolioSettings)
        .where(and(eq(portfolioSettings.portfolioId, portfolioId), eq(portfolioSettings.key, key)))
        .limit(1);
      const row = rows[0];
      return row ? row.value : null;
    },

    /** Pin (upsert) an override value for one (portfolio, key). */
    async setSetting(portfolioId: string, key: string, value: unknown): Promise<void> {
      await db
        .insert(portfolioSettings)
        .values({ portfolioId, key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [portfolioSettings.portfolioId, portfolioSettings.key],
          set: { value, updatedAt: new Date() },
        });
    },

    /** Drop the override for one (portfolio, key) — reset-to-default (idempotent). */
    async deleteSetting(portfolioId: string, key: string): Promise<void> {
      await db
        .delete(portfolioSettings)
        .where(and(eq(portfolioSettings.portfolioId, portfolioId), eq(portfolioSettings.key, key)));
    },
  };
}

export type PortfolioSettingsRepository = ReturnType<typeof createPortfolioSettingsRepository>;
