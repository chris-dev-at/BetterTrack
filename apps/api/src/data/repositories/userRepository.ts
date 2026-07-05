import { count, eq, gte, ilike, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { users, type UserRow } from '../schema';

export interface CreateUserInput {
  email: string;
  username: string;
  passwordHash: string;
  role?: 'user' | 'admin';
  status?: 'active' | 'disabled';
  mustChangePassword?: boolean;
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
        .set({ passwordHash, mustChangePassword, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async setStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
      await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id));
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
