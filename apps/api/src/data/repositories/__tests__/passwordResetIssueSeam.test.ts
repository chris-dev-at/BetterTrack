import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createPasswordResetTokenRepository } from '../passwordResetTokenRepository';
import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * `issueOrEqualize(…, onIssued)` is a "run this inside the issue transaction"
 * seam on a security-path repository (§16 2026-09-16). It exists so the known
 * branch's `password.reset_requested` audit commits on the connection the
 * request already holds instead of acquiring a second one — the asymmetry that
 * made response time an account-existence oracle under a saturated pool (§6.1).
 *
 * A seam like that is only safe while its contract holds, so these tests pin the
 * contract itself rather than the caller that uses it:
 *
 * 1. the callback really is inside the transaction (its writes commit with the
 *    token, and roll back with it);
 * 2. a throwing callback takes the token down with it — no orphaned token whose
 *    audit row never landed;
 * 3. the no-account branch never reaches it, so nothing extra can be smuggled
 *    into the lock on the branch that must stay cheap.
 */
const AUDIT_ACTION = 'password.reset_requested';

function tokenInput(userId: string, tokenHash: string) {
  return { userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
}

async function tokensFor(harness: TestHarness, userId: string) {
  return harness.db
    .select()
    .from(schema.passwordResetTokens)
    .where(eq(schema.passwordResetTokens.userId, userId));
}

async function auditRowsFor(harness: TestHarness, userId: string) {
  return harness.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, userId));
}

describe('passwordResetTokenRepository.issueOrEqualize onIssued seam', () => {
  it('runs the callback inside the issue transaction, so its write commits with the token', async () => {
    const harness = await createTestApp();
    try {
      const user = await harness.seedUser();
      const repo = createPasswordResetTokenRepository(harness.db);

      const row = await repo.issueOrEqualize(
        tokenInput(user.id, 'hash-committed'),
        user.email,
        async (tx) => {
          await tx
            .insert(schema.auditLog)
            .values({ action: AUDIT_ACTION, targetType: 'user', targetId: user.id });
        },
      );

      expect(row?.tokenHash).toBe('hash-committed');
      // The SAME inserting transaction id on both rows is the property — not
      // merely "both rows exist", which a second pooled write satisfies too.
      const [tokenXmin] = await harness.db
        .select({ xmin: sql<string>`xmin::text` })
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.userId, user.id));
      const [auditXmin] = await harness.db
        .select({ xmin: sql<string>`xmin::text` })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, user.id));
      expect(tokenXmin?.xmin).toBeTruthy();
      expect(auditXmin?.xmin).toBe(tokenXmin?.xmin);
    } finally {
      await harness.dispose();
    }
  });

  it('rolls the token back when the callback throws', async () => {
    const harness = await createTestApp();
    try {
      const user = await harness.seedUser();
      const repo = createPasswordResetTokenRepository(harness.db);

      await expect(
        repo.issueOrEqualize(tokenInput(user.id, 'hash-rolled-back'), user.email, async (tx) => {
          await tx
            .insert(schema.auditLog)
            .values({ action: AUDIT_ACTION, targetType: 'user', targetId: user.id });
          throw new Error('audit write failed');
        }),
      ).rejects.toThrow('audit write failed');

      // Neither half survives: no token claiming an un-audited issue, and no
      // audit row claiming a link that was never handed out.
      expect(await tokensFor(harness, user.id)).toHaveLength(0);
      expect(await auditRowsFor(harness, user.id)).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });

  it('never reaches the callback on the no-account branch', async () => {
    const harness = await createTestApp();
    try {
      let calls = 0;
      const repo = createPasswordResetTokenRepository(harness.db);

      const row = await repo.issueOrEqualize(null, 'nobody-here@test.dev', async () => {
        calls += 1;
      });

      expect(row).toBeNull();
      expect(calls).toBe(0);
    } finally {
      await harness.dispose();
    }
  });
});
