import { count, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { users, type UserRow } from '../schema';

export interface CreateUserInput {
  email: string;
  username: string;
  passwordHash: string;
  role?: 'user' | 'admin';
  status?: 'active' | 'disabled';
  mustChangePassword?: boolean;
  /** Register-form / applicant language; omit to accept the column default (en). */
  locale?: string;
  /**
   * Whether `passwordHash` is a real user-chosen credential (§13.4 V4-P4b). Omit
   * to accept the column default (`true`) — a Google-registered account passes
   * `false` so password login can never succeed and Google-unlink is refused.
   */
  hasUsablePassword?: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * All user SQL lives here (PROJECTPLAN.md §4.3). Email is normalised to
 * lowercase; username lookups are case-insensitive.
 */
export function createUserRepository(db: Database) {
  return {
    async findById(id: string): Promise<UserRow | undefined> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    },

    async findByIdentifier(identifier: string): Promise<UserRow | undefined> {
      const id = identifier.trim().toLowerCase();
      const [row] = await db
        .select()
        .from(users)
        .where(or(eq(users.email, id), sql`lower(${users.username}) = ${id}`))
        .limit(1);
      return row;
    },

    async findByEmail(email: string): Promise<UserRow | undefined> {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()))
        .limit(1);
      return row;
    },

    async findByUsername(username: string): Promise<UserRow | undefined> {
      const [row] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = ${username.trim().toLowerCase()}`)
        .limit(1);
      return row;
    },

    async create(input: CreateUserInput): Promise<UserRow> {
      const [row] = await db
        .insert(users)
        .values({
          email: input.email.trim().toLowerCase(),
          username: input.username.trim(),
          passwordHash: input.passwordHash,
          role: input.role ?? 'user',
          status: input.status ?? 'active',
          mustChangePassword: input.mustChangePassword ?? false,
          // Undefined lets Drizzle omit the column so its `en` default applies.
          ...(input.locale ? { locale: input.locale } : {}),
          // Omit to accept the `true` column default; Google accounts pass false.
          ...(input.hasUsablePassword === undefined
            ? {}
            : { hasUsablePassword: input.hasUsablePassword }),
        })
        .returning();
      if (!row) throw new Error('Failed to insert user');
      return row;
    },

    async updatePassword(
      id: string,
      passwordHash: string,
      mustChangePassword: boolean,
    ): Promise<void> {
      await db
        .update(users)
        // Setting any password makes it usable (§13.4 V4-P4b): a Google-only
        // account that later completes a password reset can then unlink Google.
        .set({ passwordHash, mustChangePassword, hasUsablePassword: true, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async setStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
      await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id));
    },

    /** Bulk status change for the admin list's bulk actions (§6.12, §13.2). */
    async setStatusMany(ids: string[], status: 'active' | 'disabled'): Promise<void> {
      if (ids.length === 0) return;
      await db.update(users).set({ status, updatedAt: new Date() }).where(inArray(users.id, ids));
    },

    /** Change the email (normalised to lowercase); caller enforces uniqueness. */
    async updateEmail(id: string, email: string): Promise<void> {
      await db
        .update(users)
        .set({ email: email.trim().toLowerCase(), updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Change the username (trimmed, case preserved); caller enforces uniqueness. */
    async updateUsername(id: string, username: string): Promise<void> {
      await db
        .update(users)
        .set({ username: username.trim(), updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Enable or change the PIN (§6.1): store the argon2id hash and flip on the flag. */
    async setPin(id: string, pinHash: string): Promise<void> {
      await db
        .update(users)
        .set({ pinHash, pinEnabled: true, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Disable the PIN (§6.1): clear both the hash and the flag together. */
    async clearPin(id: string): Promise<void> {
      await db
        .update(users)
        .set({ pinHash: null, pinEnabled: false, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Set the AFK auto-lock idle timeout in minutes; `null` = off (§6.1, §13.2). */
    async setPinLockIdleMinutes(id: string, minutes: number | null): Promise<void> {
      await db
        .update(users)
        .set({ pinLockIdleMinutes: minutes, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async setRole(id: string, role: 'user' | 'admin'): Promise<void> {
      await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, id));
    },

    /**
     * The user's default portfolio visibility (§6.9, §13.2 V2-P9) — applied when
     * a new portfolio is created. Defaults to `private` (also the column default,
     * so an unknown id reads `private`).
     */
    async getDefaultPortfolioVisibility(id: string): Promise<'private' | 'friends'> {
      const [row] = await db
        .select({ v: users.defaultPortfolioVisibility })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return row?.v ?? 'private';
    },

    /** Set the default portfolio visibility (§6.9, §13.2 V2-P9). */
    async setDefaultPortfolioVisibility(
      id: string,
      visibility: 'private' | 'friends',
    ): Promise<void> {
      await db
        .update(users)
        .set({ defaultPortfolioVisibility: visibility, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /**
     * Set (or clear) the per-user chat ban (§13.4 V4-P0d). The send path reads
     * this column fresh on every message, so a ban takes effect on the next send
     * and an unban restores sending instantly — there is no cached ban state.
     */
    async setChatBanned(id: string, banned: boolean): Promise<void> {
      await db
        .update(users)
        .set({ chatBanned: banned, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Whether the user shares their whole watchlist with friends (§6.9, §13.2 V2-P9). */
    async getWatchlistVisibility(id: string): Promise<'private' | 'friends'> {
      const [row] = await db
        .select({ v: users.watchlistVisibility })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return row?.v ?? 'private';
    },

    /** Turn watchlist friend-sharing on/off (§6.9, §13.2 V2-P9). */
    async setWatchlistVisibility(id: string, visibility: 'private' | 'friends'): Promise<void> {
      await db
        .update(users)
        .set({ watchlistVisibility: visibility, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Whether the user's price alerts are exposed to their followers (#455). */
    async getAlertsVisibleToFollowers(id: string): Promise<boolean> {
      const [row] = await db
        .select({ v: users.alertsVisibleToFollowers })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return row?.v ?? false;
    },

    /** Turn alert follower-sharing on/off (#455). Off stops follower delivery immediately. */
    async setAlertsVisibleToFollowers(id: string, visible: boolean): Promise<void> {
      await db
        .update(users)
        .set({ alertsVisibleToFollowers: visible, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    /** Set the user's UI-language preference (§13.3 V3-P1). */
    async setLocale(id: string, locale: string): Promise<void> {
      await db.update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, id));
    },

    /** Set the user's base currency (§5.4, §13.3 V3-P10d). */
    async setBaseCurrency(id: string, baseCurrency: string): Promise<void> {
      await db.update(users).set({ baseCurrency, updatedAt: new Date() }).where(eq(users.id, id));
    },

    /**
     * Set (or clear) the caller's curated profile icon id (§13.5 V5-P0c). The
     * service layer validates against the finite allow-list before calling; a
     * `null` clears the picked icon and returns the user to the deterministic
     * default the SPA renders.
     */
    async setProfileIcon(id: string, profileIcon: string | null): Promise<void> {
      await db.update(users).set({ profileIcon, updatedAt: new Date() }).where(eq(users.id, id));
    },

    /**
     * Patch the caller's quiet-hours window + timezone (§13.5 V5-P3). Only the
     * supplied fields are written; omitted ones keep their stored value.
     * `timezone: null` explicitly clears the zone (back to UTC). The contract
     * validates the minute bounds and the IANA name before this is reached.
     */
    async setQuietHours(
      id: string,
      patch: {
        enabled?: boolean;
        startMinute?: number;
        endMinute?: number;
        timezone?: string | null;
      },
    ): Promise<void> {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.enabled !== undefined) set.quietHoursEnabled = patch.enabled;
      if (patch.startMinute !== undefined) set.quietHoursStartMinute = patch.startMinute;
      if (patch.endMinute !== undefined) set.quietHoursEndMinute = patch.endMinute;
      if (patch.timezone !== undefined) set.timezone = patch.timezone;
      await db.update(users).set(set).where(eq(users.id, id));
    },

    /** Set the global notification mute (#368) — the dispatcher's kill switch. */
    async setNotificationsMuted(id: string, muted: boolean): Promise<void> {
      await db
        .update(users)
        .set({ notificationsMuted: muted, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async setLastLogin(id: string, when: Date): Promise<void> {
      await db
        .update(users)
        .set({ lastLoginAt: when, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async remove(id: string): Promise<void> {
      await db.delete(users).where(eq(users.id, id));
    },

    async list(search?: string): Promise<UserRow[]> {
      if (search && search.trim().length > 0) {
        const pattern = `%${search.trim()}%`;
        return db
          .select()
          .from(users)
          .where(or(ilike(users.email, pattern), ilike(users.username, pattern)))
          .orderBy(users.createdAt);
      }
      return db.select().from(users).orderBy(users.createdAt);
    },

    async counts(): Promise<{ total: number; disabled: number; activeRecentLogin: number }> {
      const since = new Date(Date.now() - THIRTY_DAYS_MS);
      const [total] = await db.select({ c: count() }).from(users);
      const [disabled] = await db
        .select({ c: count() })
        .from(users)
        .where(eq(users.status, 'disabled'));
      const [recent] = await db
        .select({ c: count() })
        .from(users)
        .where(gte(users.lastLoginAt, since));
      return {
        total: total?.c ?? 0,
        disabled: disabled?.c ?? 0,
        activeRecentLogin: recent?.c ?? 0,
      };
    },

    async countActiveAdmins(): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(users)
        .where(sql`${users.role} = 'admin' and ${users.status} = 'active'`);
      return row?.c ?? 0;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
