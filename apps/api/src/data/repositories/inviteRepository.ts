import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';

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

    /**
     * One bounded page of invites, newest first (V5-P2, #1814 — this used to
     * return every invite ever issued, and nothing prunes the table). The `id`
     * tiebreak keeps the window stable across pages when two invites share a
     * creation timestamp.
     */
    async listPage(params: {
      limit: number;
      offset: number;
    }): Promise<{ rows: InviteRow[]; total: number }> {
      const rows = await db
        .select()
        .from(invites)
        .orderBy(desc(invites.createdAt), desc(invites.id))
        .limit(params.limit)
        .offset(params.offset);
      const [totalRow] = await db.select({ value: count() }).from(invites);
      return { rows, total: totalRow?.value ?? 0 };
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
