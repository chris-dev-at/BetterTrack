import { desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { registrationRequests, type RegistrationRequestRow } from '../schema';

export interface CreateRegistrationRequestInput {
  email: string;
  username: string;
  passwordHash: string;
  locale: string;
}

/**
 * Approval-queue SQL (PROJECTPLAN.md §6.12, §13.4 V4-P4a). A pending application
 * is NOT a `users` row — it lives here until an admin approves or rejects it.
 */
export function createRegistrationRequestRepository(db: Database) {
  return {
    async create(input: CreateRegistrationRequestInput): Promise<RegistrationRequestRow> {
      const [row] = await db
        .insert(registrationRequests)
        .values({
          email: input.email.trim().toLowerCase(),
          username: input.username.trim(),
          passwordHash: input.passwordHash,
          locale: input.locale,
        })
        .returning();
      if (!row) throw new Error('Failed to insert registration request');
      return row;
    },

    async findById(id: string): Promise<RegistrationRequestRow | undefined> {
      const [row] = await db
        .select()
        .from(registrationRequests)
        .where(eq(registrationRequests.id, id))
        .limit(1);
      return row;
    },

    async findByEmail(email: string): Promise<RegistrationRequestRow | undefined> {
      const [row] = await db
        .select()
        .from(registrationRequests)
        .where(eq(registrationRequests.email, email.trim().toLowerCase()))
        .limit(1);
      return row;
    },

    async findByUsername(username: string): Promise<RegistrationRequestRow | undefined> {
      const [row] = await db
        .select()
        .from(registrationRequests)
        .where(sql`lower(${registrationRequests.username}) = ${username.trim().toLowerCase()}`)
        .limit(1);
      return row;
    },

    async listAll(): Promise<RegistrationRequestRow[]> {
      return db.select().from(registrationRequests).orderBy(desc(registrationRequests.createdAt));
    },

    async remove(id: string): Promise<void> {
      await db.delete(registrationRequests).where(eq(registrationRequests.id, id));
    },

    async count(): Promise<number> {
      const rows = await db.select({ id: registrationRequests.id }).from(registrationRequests);
      return rows.length;
    },
  };
}

export type RegistrationRequestRepository = ReturnType<typeof createRegistrationRequestRepository>;
