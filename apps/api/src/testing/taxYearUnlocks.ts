import type { Database } from '../data/db';
import * as schema from '../data/schema';

/**
 * Test helper — amendment mode (§16 2026-08-07).
 *
 * Elapsed Vienna tax years LOCK against mutations (409 `TAX_YEAR_LOCKED`)
 * until the user explicitly unlocks them. Suites that seed or mutate
 * HISTORICAL fixtures (backdated trades, dividends, cash movements) opt into
 * amendment mode here — exactly the state the machinery under test operates
 * in for a real user who ran the unlock ritual. The lock gate itself, and the
 * ritual, are pinned by `taxYearLock.test.ts`; never call this there.
 */
export async function unlockTaxYears(
  db: Database,
  userId: string,
  years: readonly number[],
): Promise<void> {
  await db
    .insert(schema.taxYearUnlocks)
    .values(years.map((year) => ({ userId, year })))
    .onConflictDoNothing();
}

/** The pragmatic "this fixture spans recent history" range (2015 … current year). */
export async function unlockRecentTaxYears(db: Database, userId: string): Promise<void> {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let year = 2015; year < current; year += 1) years.push(year);
  await unlockTaxYears(db, userId, years);
}
