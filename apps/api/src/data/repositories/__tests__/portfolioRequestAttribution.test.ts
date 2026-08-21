import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  apiKeyRequestLog,
  apiKeys,
  idempotencyKeys,
  importBatches,
  portfolios,
  vaults,
} from '../../schema';
import { createIdempotencyKeyRepository } from '../idempotencyKeyRepository';
import { stripPortfolioRequestAttribution } from '../portfolioRequestAttribution';

// Deterministic TEST VECTOR identities and verifier-shaped values. They are
// public fixtures, not bearer credentials, vault keys, or encrypted content.
const VECTOR = {
  apiKeyId: '019c81b0-0000-7000-8000-000000000001',
  batchId: '019c81b0-0000-7000-8000-000000000002',
  idempotencyId: '019c81b0-0000-7000-8000-000000000003',
  vaultId: '019c81b0-0000-7000-8000-000000000004',
  headerDocId: '019c81b0-0000-7000-8000-000000000005',
  commonDocId: '019c81b0-0000-7000-8000-000000000006',
} as const;

let h: TestHarness;

beforeEach(async () => {
  h = await createTestApp();
});

afterEach(async () => {
  await h.ctx.redis.quit?.();
});

async function seedImportVector() {
  const user = await h.seedUser({
    email: 'request-attribution-vector@bettertrack.test',
    username: 'request_attribution_vector',
  });
  const portfolioId = await h.ctx.portfolio.getDefaultPortfolioId(user.id);
  await h.db.insert(apiKeys).values({
    id: VECTOR.apiKeyId,
    userId: user.id,
    name: 'TEST VECTOR request-attribution key',
    tokenHash: 'TEST VECTOR request-attribution hash',
  });
  await h.db.insert(importBatches).values({
    id: VECTOR.batchId,
    ownerId: user.id,
    portfolioId,
    brokerId: 'test-vector-broker',
    filename: 'test-vector.csv',
  });
  return { userId: user.id, portfolioId };
}

describe('portfolio request attribution', () => {
  it('persists an internal child-resource marker but keeps the audit wire path unchanged', async () => {
    const { userId, portfolioId } = await seedImportVector();
    const path = `/imports/${VECTOR.batchId}/apply`;

    await h.ctx.apiKeys.recordRequest({
      keyId: VECTOR.apiKeyId,
      userId,
      method: 'POST',
      path,
      status: 200,
    });

    const [stored] = await h.db
      .select()
      .from(apiKeyRequestLog)
      .where(eq(apiKeyRequestLog.keyId, VECTOR.apiKeyId));
    expect(stored?.path).toBe(`${path}/_portfolio/${portfolioId}`);
    expect(stripPortfolioRequestAttribution(stored!.path)).toBe(path);

    const audit = await h.ctx.apiKeys.keyAudit(VECTOR.apiKeyId);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.path).toBe(path);
    expect(JSON.stringify(audit)).not.toContain('/_portfolio/');
  });

  it('attributes an idempotency claim and suppresses a later claim for the vaulted target', async () => {
    const { userId, portfolioId } = await seedImportVector();
    const repo = createIdempotencyKeyRepository(h.db, h.db);
    const path = `/api/v1/imports/${VECTOR.batchId}/apply`;
    const first = await repo.claim(
      {
        userId,
        key: VECTOR.idempotencyId,
        method: 'POST',
        path,
        requestHash: 'TEST VECTOR request hash',
      },
      new Date('2026-08-19T10:00:00.000Z'),
    );
    expect(first.won).toBe(true);

    const [stored] = await h.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, userId));
    expect(stored?.path).toBe(`${path}/_portfolio/${portfolioId}`);
    expect(stripPortfolioRequestAttribution(stored!.path)).toBe(path);

    await h.db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
    await h.db.insert(vaults).values({
      id: VECTOR.vaultId,
      userId,
      name: 'TEST VECTOR vault',
      headerDocId: VECTOR.headerDocId,
      commonDocId: VECTOR.commonDocId,
      media: ['server'],
      retirementProofPublicKey: 'TEST VECTOR retirement verifier',
      keyFingerprint: 'TEST-VECTOR-ATTRIBUTION',
    });
    await h.db
      .update(portfolios)
      .set({ vaultId: VECTOR.vaultId })
      .where(eq(portfolios.id, portfolioId));

    await expect(
      repo.claim(
        {
          userId,
          key: '019c81b0-0000-7000-8000-000000000007',
          method: 'POST',
          path,
          requestHash: 'TEST VECTOR request hash after move-in',
        },
        new Date('2026-08-19T10:00:00.000Z'),
      ),
    ).resolves.toEqual({ won: false, suppressed: true });
    await expect(
      h.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, userId)),
    ).resolves.toEqual([]);
  });
});
