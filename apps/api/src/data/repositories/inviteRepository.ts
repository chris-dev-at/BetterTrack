import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import type { Database } from '../db';
import { invites, type InviteRow } from '../schema';

export interface CreateInviteInput {
  email: string;
  tokenHash: string;
  createdBy: string;
  expiresAt: Date;
}

export function createInviteRepository(db: Database) {
  return {
    async create(input: CreateInviteInput): Promise<InviteRow> {
      const [row] = await db
        .insert(invites)
        .values({
          email: input.email.trim().toLowerCase(),
          tokenHash: input.tokenHash,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error('Failed to insert invite');
      return row;
    },

    async findByTokenHash(tokenHash: string): Promise<InviteRow | undefined> {
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    async findById(id: string): Promise<InviteRow | undefined> {
      const [row] = await db.select().from(invites).where(eq(invites.id, id)).limit(1);
      return row;
    },

    async markUsed(id: string, when: Date): Promise<void> {
      await db.update(invites).set({ usedAt: when }).where(eq(invites.id, id));
    },

    async revoke(id: string, when: Date): Promise<void> {
      await db.update(invites).set({ revokedAt: when }).where(eq(invites.id, id));
    },

    async listAll(): Promise<InviteRow[]> {
      return db.select().from(invites).orderBy(desc(invites.createdAt));
    },

    async pendingCount(): Promise<number> {
      const rows = await db
        .select({ id: invites.id })
        .from(invites)
        .where(
          and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())),
        );
      return rows.length;
    },
  };
}

export type InviteRepository = ReturnType<typeof createInviteRepository>;
