import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  PARANOID_PURGED_TABLE_NAMES,
  PARANOID_VAULT_DOC_BUCKETS,
} from '../../../services/export/manifest';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  assertVaultedPortfolioCleartextCounts,
  assertVaultedPortfolioHasNoCleartext,
  assertVaultedPortfolioProbeCompleteness,
  probeVaultedPortfolioCleartext,
  VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY,
  VAULTED_PORTFOLIO_PROBE_TABLE_NAMES,
  VAULTED_PORTFOLIO_SERVER_RESIDUE_TABLE_NAMES,
  vaultedPortfolioStubName,
} from '../vaultedPortfolioProbe';
import {
  apiKeyRequestLog,
  apiKeys,
  assets,
  idempotencyKeys,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  mirrorChains,
  mirrorRows,
  portfolios,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  sharedItemActivityPrefs,
  transactions,
  vaults,
} from '../../schema';

// Deterministic TEST VECTOR identifiers and verifier-shaped strings. They are
// public fixtures, not credentials or production retirement material.
const TEST_VECTOR = {
  vaultId: '019c8180-0000-7000-8000-000000000001',
  headerDocId: '019c8180-0000-7000-8000-000000000002',
  commonDocId: '019c8180-0000-7000-8000-000000000003',
  portfolioId: '019c8180-0000-7000-8000-000000000004',
  assetId: '019c8180-0000-7000-8000-000000000005',
  transactionId: '019c8180-0000-7000-8000-000000000006',
  chainId: '019c8180-0000-7000-8000-000000000007',
  chainMemberId: '019c8180-0000-7000-8000-000000000008',
  mirrorId: '019c8180-0000-7000-8000-000000000009',
  mirrorLocalId: '019c8180-0000-7000-8000-000000000010',
  audienceId: '019c8180-0000-7000-8000-000000000011',
  audienceLinkId: '019c8180-0000-7000-8000-000000000012',
  commentId: '019c8180-0000-7000-8000-000000000013',
  itemReactionId: '019c8180-0000-7000-8000-000000000014',
  commentReactionId: '019c8180-0000-7000-8000-000000000015',
  apiKeyId: '019c8180-0000-7000-8000-000000000016',
  apiLogId: '019c8180-0000-7000-8000-000000000017',
  idempotencyId: '019c8180-0000-7000-8000-000000000018',
  idempotencyKey: '019c8180-0000-7000-8000-000000000019',
  retirementProofPublicKey: 'TEST VECTOR retirement public key',
  keyFingerprint: 'TEST-VECTOR-0001',
  apiTokenHash: 'TEST VECTOR API token hash',
  shareTokenHash: 'TEST VECTOR share token hash',
  requestHash: 'TEST VECTOR request body hash',
  executedAt: new Date('2026-08-21T10:00:00.000Z'),
} as const;

let h: TestHarness;
let userId: string;

beforeEach(async () => {
  h = await createTestApp();
  const user = await h.seedUser({
    email: 'vaulted-probe-vector@bettertrack.test',
    username: 'vaulted_probe_vector',
  });
  userId = user.id;
  await h.db.insert(vaults).values({
    id: TEST_VECTOR.vaultId,
    userId,
    name: 'TEST VECTOR vault',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: ['server'],
    retirementProofPublicKey: TEST_VECTOR.retirementProofPublicKey,
    keyFingerprint: TEST_VECTOR.keyFingerprint,
  });
  await h.db.insert(portfolios).values({
    id: TEST_VECTOR.portfolioId,
    userId,
    name: vaultedPortfolioStubName(TEST_VECTOR.portfolioId),
    vaultId: TEST_VECTOR.vaultId,
    vaultAlias: 'Locked TEST VECTOR',
  });
});

afterEach(async () => {
  await h.dispose();
});

describe('vaulted portfolio cleartext probe', () => {
  it('exhaustively classifies the legacy purge set and server-residue roster', () => {
    expect(() => assertVaultedPortfolioProbeCompleteness()).not.toThrow();
    expect(Object.keys(VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY).sort()).toEqual(
      [
        ...new Set([
          ...PARANOID_PURGED_TABLE_NAMES,
          ...VAULTED_PORTFOLIO_SERVER_RESIDUE_TABLE_NAMES,
        ]),
      ].sort(),
    );
    expect(VAULTED_PORTFOLIO_PROBE_TABLE_NAMES).toEqual(
      [
        ...new Set([
          ...Object.entries(PARANOID_VAULT_DOC_BUCKETS)
            .filter(([, bucket]) => bucket === 'portfolio')
            .map(([table]) => table),
          'api_key_request_log',
          ...VAULTED_PORTFOLIO_SERVER_RESIDUE_TABLE_NAMES,
        ]),
      ].sort(),
    );
    for (const [table, entry] of Object.entries(VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY)) {
      if (entry.kind === 'not-probed') {
        expect(entry.reason.trim().length, `${table} needs an exclusion reason`).toBeGreaterThan(0);
      }
    }
    expect(VAULTED_PORTFOLIO_CLEARTEXT_REGISTRY.portfolios).toMatchObject({
      kind: 'probe',
      scope: 'stub',
    });
    expect(vaultedPortfolioStubName(TEST_VECTOR.portfolioId)).toBe(
      `__vaulted_portfolio__:${TEST_VECTOR.portfolioId}`,
    );
  });

  it('accepts a clean locked stub and detects a forbidden direct cleartext row', async () => {
    const clean = await probeVaultedPortfolioCleartext(h.db, TEST_VECTOR.portfolioId);
    expect(clean).toEqual(
      Object.fromEntries(VAULTED_PORTFOLIO_PROBE_TABLE_NAMES.map((table) => [table, 0])),
    );
    expect(() => assertVaultedPortfolioCleartextCounts(clean)).not.toThrow();
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.portfolioId),
    ).resolves.toBeUndefined();

    await h.db.insert(assets).values({
      id: TEST_VECTOR.assetId,
      providerId: 'test-vector-provider',
      providerRef: 'test-vector-asset',
      type: 'stock',
      symbol: 'TVEC',
      name: 'TEST VECTOR Asset',
      currency: 'EUR',
    });
    await h.db.insert(transactions).values({
      id: TEST_VECTOR.transactionId,
      portfolioId: TEST_VECTOR.portfolioId,
      assetId: TEST_VECTOR.assetId,
      side: 'buy',
      quantity: '1',
      price: '100',
      fee: '0',
      executedAt: TEST_VECTOR.executedAt,
    });

    const leaked = await probeVaultedPortfolioCleartext(h.db, TEST_VECTOR.portfolioId);
    expect(leaked.transactions).toBe(1);
    expect(() => assertVaultedPortfolioCleartextCounts(leaked)).toThrow(
      'vaulted portfolio zero-cleartext probe failed: transactions=1',
    );
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.portfolioId),
    ).rejects.toThrow('transactions=1');
  });

  it('fails closed for a missing or content-bearing locked stub', async () => {
    await h.db
      .update(portfolios)
      .set({
        name: 'TEST VECTOR leaked true portfolio name',
        visibility: 'friends',
        sortOrder: 7,
        defaultPayFromCash: true,
        archivedAt: TEST_VECTOR.executedAt,
        kind: 'investment',
        vaultAlias: '',
      })
      .where(eq(portfolios.id, TEST_VECTOR.portfolioId));

    const unsafe = await probeVaultedPortfolioCleartext(h.db, TEST_VECTOR.portfolioId);
    expect(unsafe.portfolios).toBe(1);
    expect(() => assertVaultedPortfolioCleartextCounts(unsafe)).toThrow('portfolios=1');

    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, '019c8180-0000-7000-8000-000000000099'),
    ).rejects.toThrow('portfolios=1');
  });

  it('detects sharing, mirror, telemetry, and idempotency residue', async () => {
    const viewer = await h.seedUser({
      email: 'vaulted-probe-viewer@bettertrack.test',
      username: 'vaulted_probe_viewer',
    });
    await h.db.insert(mirrorChains).values({
      id: TEST_VECTOR.chainId,
      name: 'TEST VECTOR mirror chain',
      createdBy: userId,
      createdByUsername: 'vaulted_probe_vector',
    });
    await h.db.insert(mirrorChainMembers).values({
      id: TEST_VECTOR.chainMemberId,
      chainId: TEST_VECTOR.chainId,
      userId,
      username: 'vaulted_probe_vector',
      portfolioId: TEST_VECTOR.portfolioId,
      role: 'owner',
    });
    await h.db.insert(mirrorRows).values({
      chainId: TEST_VECTOR.chainId,
      kind: 'transaction',
      mirrorId: TEST_VECTOR.mirrorId,
      portfolioId: TEST_VECTOR.portfolioId,
      localId: TEST_VECTOR.mirrorLocalId,
      createdBy: userId,
      createdByUsername: 'vaulted_probe_vector',
    });
    await h.db.insert(shareAudiences).values({
      id: TEST_VECTOR.audienceId,
      ownerId: userId,
      kind: 'portfolio',
      subjectId: TEST_VECTOR.portfolioId,
      audience: 'all_friends',
    });
    await h.db.insert(shareAudienceMembers).values({
      audienceId: TEST_VECTOR.audienceId,
      friendId: viewer.id,
    });
    await h.db.insert(shareAudienceLinks).values({
      id: TEST_VECTOR.audienceLinkId,
      audienceId: TEST_VECTOR.audienceId,
      tokenHash: TEST_VECTOR.shareTokenHash,
    });
    await h.db.insert(sharedItemActivityPrefs).values({
      viewerId: viewer.id,
      kind: 'portfolio',
      subjectId: TEST_VECTOR.portfolioId,
    });
    await h.db.insert(itemFollows).values({
      userId: viewer.id,
      kind: 'portfolio',
      subjectId: TEST_VECTOR.portfolioId,
    });
    await h.db.insert(itemComments).values({
      id: TEST_VECTOR.commentId,
      kind: 'portfolio',
      subjectId: TEST_VECTOR.portfolioId,
      authorId: viewer.id,
      body: 'TEST VECTOR comment body',
    });
    await h.db.insert(itemReactions).values([
      {
        id: TEST_VECTOR.itemReactionId,
        userId: viewer.id,
        targetType: 'item',
        kind: 'portfolio',
        subjectId: TEST_VECTOR.portfolioId,
        emoji: '👍',
      },
      {
        id: TEST_VECTOR.commentReactionId,
        userId: viewer.id,
        targetType: 'comment',
        commentId: TEST_VECTOR.commentId,
        emoji: '❤️',
      },
    ]);
    await h.db.insert(apiKeys).values({
      id: TEST_VECTOR.apiKeyId,
      userId,
      name: 'TEST VECTOR key',
      tokenHash: TEST_VECTOR.apiTokenHash,
    });
    await h.db.insert(apiKeyRequestLog).values({
      id: TEST_VECTOR.apiLogId,
      keyId: TEST_VECTOR.apiKeyId,
      userId,
      method: 'GET',
      // TEST VECTOR: a child UUID must remain transitively attributable even
      // when the operational row does not carry the portfolio UUID itself.
      path: `/api/v1/social/comments/${TEST_VECTOR.commentId}/reactions`,
      status: 423,
    });
    await h.db.insert(idempotencyKeys).values({
      id: TEST_VECTOR.idempotencyId,
      userId,
      key: TEST_VECTOR.idempotencyKey,
      method: 'POST',
      path: '/api/v1/custom-assets',
      requestHash: TEST_VECTOR.requestHash,
      statusCode: 201,
      // TEST VECTOR: memoized response bytes are part of the zero-cleartext
      // surface even when the request path itself has no portfolio resource.
      responseBody: `{"portfolioId":"${TEST_VECTOR.portfolioId}"}`,
    });

    const leaked = await probeVaultedPortfolioCleartext(h.db, TEST_VECTOR.portfolioId);
    expect(leaked).toMatchObject({
      api_key_request_log: 1,
      idempotency_keys: 1,
      item_comments: 1,
      item_follows: 1,
      item_reactions: 2,
      mirror_chain_members: 1,
      mirror_rows: 1,
      portfolios: 0,
      share_audience_links: 1,
      share_audience_members: 1,
      share_audiences: 1,
      shared_item_activity_prefs: 1,
    });
    expect(() => assertVaultedPortfolioCleartextCounts(leaked)).toThrow('api_key_request_log=1');

    await h.db
      .update(mirrorChainMembers)
      .set({ status: 'left', endedAt: TEST_VECTOR.executedAt })
      .where(eq(mirrorChainMembers.id, TEST_VECTOR.chainMemberId));
    expect(
      (await probeVaultedPortfolioCleartext(h.db, TEST_VECTOR.portfolioId)).mirror_chain_members,
    ).toBe(0);
  });
});
