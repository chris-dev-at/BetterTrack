import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../../data/db';
import { paranoidV1WipeReceipts } from '../../data/schema';

/**
 * PARANOID E9 — §17 step 3, the one-time fresh-start notice.
 *
 *   "Notice: affected accounts get a one-time in-app notice at next login —
 *    'Paranoid mode has a new shape; the old paranoid data was retired with the
 *    old system' — with the create-a-vault CTA. No conversion ceremony, no
 *    legacy passphrase prompt."
 *
 * The notice is owed exactly while the account's `paranoid_v1_wipe_receipts` row
 * has a null `notice_acknowledged_at`. Only an account the §17 wipe actually
 * retired has such a row, so "affected accounts" needs no flag of its own and an
 * account that was always `normal` cannot be shown the notice — there is nothing
 * to read. That is why the receipt carries the state instead of a column on
 * `users`: the wipe already writes exactly one row per affected account, and the
 * §19 deletion train can drop the v1 surface without disturbing it.
 *
 * Both operations are caller-scoped by construction — neither takes an id from a
 * request — so there is no ownership check to forget.
 */

export interface ParanoidFreshStartNotice {
  /** True while the account still owes the one-time notice. */
  pending: boolean;
  /** When the §17 wipe retired this account, or null if it never did. */
  wipedAt: string | null;
}

export interface ParanoidFreshStartNoticeService {
  status(userId: string): Promise<ParanoidFreshStartNotice>;
  acknowledge(userId: string): Promise<ParanoidFreshStartNotice>;
}

export function createParanoidFreshStartNoticeService(
  db: Database,
): ParanoidFreshStartNoticeService {
  async function status(userId: string): Promise<ParanoidFreshStartNotice> {
    const rows = await db
      .select({
        wipedAt: paranoidV1WipeReceipts.wipedAt,
        acknowledgedAt: paranoidV1WipeReceipts.noticeAcknowledgedAt,
      })
      .from(paranoidV1WipeReceipts)
      .where(eq(paranoidV1WipeReceipts.userId, userId));

    const receipt = rows[0];
    if (!receipt) return { pending: false, wipedAt: null };
    return {
      pending: receipt.acknowledgedAt === null,
      wipedAt: receipt.wipedAt.toISOString(),
    };
  }

  return {
    status,
    async acknowledge(userId: string): Promise<ParanoidFreshStartNotice> {
      // Set-once: the `IS NULL` guard is the idempotency key, so a replay (a
      // double-click, a retried request) never moves the timestamp and never
      // re-shows the notice. A missing receipt updates nothing and reports
      // "nothing owed", which is the truthful answer for a normal account.
      await db
        .update(paranoidV1WipeReceipts)
        .set({ noticeAcknowledgedAt: new Date() })
        .where(
          and(
            eq(paranoidV1WipeReceipts.userId, userId),
            isNull(paranoidV1WipeReceipts.noticeAcknowledgedAt),
          ),
        );
      return status(userId);
    },
  };
}
