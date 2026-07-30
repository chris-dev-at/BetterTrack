import { eq, or } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  paranoidDisableResponseSchema,
  paranoidEnableResponseSchema,
  type ParanoidDisableRequest,
  type ParanoidEnableRequest,
} from '@bettertrack/contracts';

import { createShareAudienceRepository } from '../../../data/repositories/shareAudienceRepository';
import {
  assetIdentities,
  assets,
  auditLog,
  exportJobs,
  friendships,
  importBatches,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  mirrorChains,
  paranoidRehydrationReceipts,
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
  paranoidVaultServerCandidates,
  paranoidVaults,
  portfolioCashMovements,
  portfolioCashSources,
  portfolios,
  priceHistory,
  shareAudienceMembers,
  shareAudiences,
  transactions,
  userFollows,
  users,
  watchlists,
  workboardItems,
} from '../../../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../../../testing/createTestApp';
import { liveRingKey } from '../../liveMode/ringBuffer';
import type { AuditService } from '../../audit/auditService';
import type { ParanoidRehydrationService } from '../paranoidRehydrationService';
import {
  createParanoidTransitionService,
  type ParanoidEnableStage,
} from '../paranoidTransitionService';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const ASSET_ID = '018f0000-0000-7000-8000-000000000501';
const RESTORED_PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000502';
const REHYDRATION_ID = '018f0000-0000-7000-8000-000000000503';
const OTHER_REHYDRATION_ID = '018f0000-0000-7000-8000-000000000504';
const EDITED_AT = '2026-07-24T10:00:00.000Z';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function login(user: SeededUser): Promise<Agent> {
  const agent = request.agent(harness.app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status).toBe(200);
  return agent;
}

async function seedNormalGraph(
  user: SeededUser,
  options: { vaultVersion?: number } = {},
): Promise<{ portfolioId: string; watchlistId: string }> {
  const [portfolio] = await harness.db
    .insert(portfolios)
    .values({ userId: user.id, name: 'Main' })
    .returning();
  if (!portfolio) throw new Error('expected portfolio');
  const [source] = await harness.db
    .insert(portfolioCashSources)
    .values({ portfolioId: portfolio.id, name: 'Main', type: 'cash', isMain: true })
    .returning();
  if (!source) throw new Error('expected cash source');
  await harness.db.insert(assets).values({
    id: ASSET_ID,
    providerId: 'manual',
    providerRef: ASSET_ID,
    ownerId: user.id,
    type: 'custom',
    symbol: 'HOME',
    name: 'House',
    exchange: null,
    currency: 'EUR',
    meta: { category: 'other', smoothing: false },
  });
  await harness.db.insert(priceHistory).values({
    assetId: ASSET_ID,
    date: '2026-07-23',
    close: '250000.00',
  });
  await harness.db.insert(transactions).values({
    portfolioId: portfolio.id,
    assetId: ASSET_ID,
    side: 'buy',
    quantity: '1',
    price: '250000',
    fee: '0',
    executedAt: new Date(EDITED_AT),
  });
  await harness.db.insert(portfolioCashMovements).values({
    portfolioId: portfolio.id,
    sourceId: source.id,
    kind: 'deposit',
    amountEur: '250000',
    executedAt: new Date(EDITED_AT),
  });
  const [watchlist] = await harness.db
    .insert(watchlists)
    .values({ userId: user.id, name: 'Kept private list', isDefault: true })
    .returning();
  if (!watchlist) throw new Error('expected watchlist');
  await harness.db.insert(workboardItems).values({
    userId: user.id,
    watchlistId: watchlist.id,
    assetId: ASSET_ID,
    sortOrder: 0,
    note: 'kept reference',
  });
  await harness.db
    .update(users)
    .set({
      profilePublic: true,
      watchlistVisibility: 'friends',
      defaultPortfolioVisibility: 'friends',
      alertsVisibleToFollowers: true,
    })
    .where(eq(users.id, user.id));

  const vaultVersion = options.vaultVersion ?? 1;
  const blob = Buffer.from(`opaque-vault-${vaultVersion}`);
  await harness.db.insert(paranoidVaults).values({
    userId: user.id,
    version: vaultVersion,
    formatVersion: 1,
    sizeBytes: blob.byteLength,
    blob,
  });
  return { portfolioId: portfolio.id, watchlistId: watchlist.id };
}

const serverEnable = (vaultVersion = 1): ParanoidEnableRequest => ({
  mediaSet: ['server'],
  vaultVersion,
  driveAttestation: null,
});

function disableRequest(userId: string, rehydrationId = REHYDRATION_ID): ParanoidDisableRequest {
  return {
    confirm: true,
    rehydrationId,
    document: {
      schemaVersion: 1,
      entities: [
        {
          id: RESTORED_PORTFOLIO_ID,
          kind: 'portfolio',
          rev: 0,
          editedAt: EDITED_AT,
          editedBy: userId,
          deletedAt: null,
          data: {
            userId,
            name: 'Restored',
            visibility: 'private',
            sortOrder: 0,
            defaultPayFromCash: false,
            archivedAt: null,
          },
        },
        {
          id: ASSET_ID,
          kind: 'customAsset',
          rev: 0,
          editedAt: EDITED_AT,
          editedBy: userId,
          deletedAt: null,
          data: {
            providerId: 'manual',
            providerRef: ASSET_ID,
            ownerId: userId,
            type: 'custom',
            symbol: 'HOME',
            name: 'House',
            exchange: null,
            currency: 'EUR',
            meta: { category: 'other', smoothing: false, recategorize: false },
            searchText: "'home':1 'house':2",
          },
        },
      ],
      mergeLog: [],
    },
  };
}

async function accountState(userId: string) {
  const [account] = await harness.db
    .select({
      privacyMode: users.privacyMode,
      profilePublic: users.profilePublic,
      mediaSet: users.paranoidMediaSet,
      driveVersion: users.paranoidDriveAttestedVersion,
    })
    .from(users)
    .where(eq(users.id, userId));
  return account;
}

describe('paranoid public transitions', () => {
  it('enables atomically, purges cleartext/caches, and preserves kept identity rows', async () => {
    const user = await harness.seedUser();
    const { portfolioId, watchlistId } = await seedNormalGraph(user);
    const [watchlistBefore] = await harness.db
      .select()
      .from(watchlists)
      .where(eq(watchlists.id, watchlistId));
    await Promise.all([
      harness.ctx.redis.set(`mkt:fresh:manual:${ASSET_ID}:quote:spot`, 'private quote'),
      harness.ctx.redis.set(`mkt:stale:manual:${ASSET_ID}:history:MAX@1mo`, 'private history'),
      harness.ctx.redis.set(`mkt:neg:manual:${ASSET_ID}:meta:profile`, 'private miss'),
      harness.ctx.redis.set(`mkt:lock:manual:${ASSET_ID}:quote:spot`, 'private lock'),
      harness.ctx.redis.set(`backtest:preview:${user.id}:private`, 'private result'),
      harness.ctx.redis.set(`backtest:compare:${user.id}:private`, 'private comparison'),
      harness.ctx.redis.set(liveRingKey(ASSET_ID), 'private frame'),
    ]);
    const agent = await login(user);

    const response = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send(serverEnable());
    expect(response.status).toBe(200);
    expect(paranoidEnableResponseSchema.parse(response.body)).toMatchObject({
      mode: 'paranoid',
      mediaSet: ['server'],
      vaultVersion: 1,
      idempotent: false,
    });

    expect(await accountState(user.id)).toEqual({
      privacyMode: 'paranoid',
      profilePublic: false,
      mediaSet: ['server'],
      driveVersion: null,
    });
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
    expect(await harness.db.select().from(assets).where(eq(assets.ownerId, user.id))).toEqual([]);
    expect(
      await harness.db.select().from(priceHistory).where(eq(priceHistory.assetId, ASSET_ID)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ).toEqual([]);

    // The detached UUID claim and private workboard reference are approved
    // server-side identity/config rows, and remain byte-for-byte unchanged.
    expect(
      await harness.db.select().from(assetIdentities).where(eq(assetIdentities.id, ASSET_ID)),
    ).toEqual([{ id: ASSET_ID, ownerId: user.id }]);
    expect(
      await harness.db.select().from(workboardItems).where(eq(workboardItems.assetId, ASSET_ID)),
    ).toHaveLength(1);
    expect(
      await harness.db.select().from(watchlists).where(eq(watchlists.id, watchlistId)),
    ).toEqual([watchlistBefore]);
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toHaveLength(1);
    await expect(
      Promise.all([
        harness.ctx.redis.get(`mkt:fresh:manual:${ASSET_ID}:quote:spot`),
        harness.ctx.redis.get(`mkt:stale:manual:${ASSET_ID}:history:MAX@1mo`),
        harness.ctx.redis.get(`mkt:neg:manual:${ASSET_ID}:meta:profile`),
        harness.ctx.redis.get(`mkt:lock:manual:${ASSET_ID}:quote:spot`),
        harness.ctx.redis.get(`backtest:preview:${user.id}:private`),
        harness.ctx.redis.get(`backtest:compare:${user.id}:private`),
        harness.ctx.redis.get(liveRingKey(ASSET_ID)),
      ]),
    ).resolves.toEqual([null, null, null, null, null, null, null]);
    const [audit] = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'account.paranoid_enabled'));
    expect(audit).toMatchObject({
      actorId: user.id,
      targetId: user.id,
      meta: { mediaSet: ['server'], vaultVersion: 1, idempotent: false },
    });
    expect(JSON.stringify(audit)).not.toMatch(/House|250000|opaque-vault/i);
  });

  it('requires CSRF and strict supported media evidence', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    const agent = await login(user);

    const noCsrf = await agent.post('/api/v1/account/paranoid/enable').send(serverEnable());
    expect(noCsrf.status).toBe(403);
    expect((await accountState(user.id))?.privacyMode).toBe('normal');

    const unknownField = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ ...serverEnable(), unsupported: true });
    expect(unknownField.status).toBe(400);

    const stale = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send(serverEnable(2));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PARANOID_MEDIA_NOT_READY');

    const malformedDrive = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({
        mediaSet: ['drive'],
        vaultVersion: 1,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 2 },
      });
    expect(malformedDrive.status).toBe(400);
    expect((await accountState(user.id))?.privacyMode).toBe('normal');
  });

  it('leaves zero vault or portfolio bytes for exact Drive-only evidence', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user, { vaultVersion: 2 });
    await harness.db.insert(paranoidVaultHistory).values({
      userId: user.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: 7,
      blob: Buffer.from('history'),
    });
    await harness.db.insert(paranoidVaultServerCandidates).values({
      userId: user.id,
      version: 3,
      formatVersion: 1,
      sizeBytes: 9,
      blob: Buffer.from('candidate'),
      expiresAt: new Date('2026-07-24T11:00:00.000Z'),
    });
    await harness.db.insert(paranoidVaultRetired).values({
      userId: user.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: 7,
      blob: Buffer.from('retired'),
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
    });
    await harness.db.insert(paranoidVaultRetirements).values({
      userId: user.id,
      retiredVersion: 1,
      retirementProofPublicKey: 'public-verifier-only',
    });
    await harness.db.insert(paranoidRehydrationReceipts).values({
      userId: user.id,
      rehydrationId: OTHER_REHYDRATION_ID,
    });

    const response = await harness.ctx.paranoidTransitions.enable(user.id, {
      mediaSet: ['drive'],
      vaultVersion: 2,
      driveAttestation: { verifiedRoundTrip: true, vaultVersion: 2 },
    });
    expect(response).toMatchObject({ mode: 'paranoid', mediaSet: ['drive'] });
    expect(await accountState(user.id)).toMatchObject({
      privacyMode: 'paranoid',
      mediaSet: ['drive'],
      driveVersion: 2,
    });
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultRetired)
        .where(eq(paranoidVaultRetired.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultRetirements)
        .where(eq(paranoidVaultRetirements.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidRehydrationReceipts)
        .where(eq(paranoidRehydrationReceipts.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
  });

  it('keeps the gated retired-server recovery set across an idempotent enable retry', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user, { vaultVersion: 2 });
    const driveOnly: ParanoidEnableRequest = {
      mediaSet: ['drive'],
      vaultVersion: 2,
      driveAttestation: { verifiedRoundTrip: true, vaultVersion: 2 },
    };
    const first = await harness.ctx.paranoidTransitions.enable(user.id, driveOnly);
    expect(first.idempotent).toBe(false);

    // PD3a's media switch retires the server medium NON-destructively: the blob
    // and its history move into paranoid_vault_retired behind the signed purge
    // gate (matching version + Ed25519 proof + retention window), which is
    // exactly why paranoid_vaults/history are empty afterwards.
    await harness.db.insert(paranoidVaultRetired).values({
      userId: user.id,
      version: 2,
      formatVersion: 1,
      sizeBytes: 7,
      blob: Buffer.from('retired'),
      createdAt: new Date('2026-07-29T10:00:00.000Z'),
    });
    await harness.db.insert(paranoidVaultRetirements).values({
      userId: user.id,
      retiredVersion: 2,
      retirementProofPublicKey: 'public-verifier-only',
    });
    await harness.db.insert(paranoidVaultServerCandidates).values({
      userId: user.id,
      version: 3,
      formatVersion: 1,
      sizeBytes: 9,
      blob: Buffer.from('candidate'),
      expiresAt: new Date('2026-07-31T11:00:00.000Z'),
    });

    // A replay of the original enable passes every retry guard, so it must not
    // destroy the user's last readable copy behind "nothing changed".
    const retry = await harness.ctx.paranoidTransitions.enable(user.id, driveOnly);
    expect(retry.idempotent).toBe(true);

    expect(
      await harness.db
        .select()
        .from(paranoidVaultRetired)
        .where(eq(paranoidVaultRetired.userId, user.id)),
    ).toMatchObject([{ version: 2, sizeBytes: 7 }]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultRetirements)
        .where(eq(paranoidVaultRetirements.userId, user.id)),
    ).toMatchObject([{ retiredVersion: 2, retirementProofPublicKey: 'public-verifier-only' }]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, user.id)),
    ).toMatchObject([{ version: 3 }]);
    expect(await accountState(user.id)).toMatchObject({
      privacyMode: 'paranoid',
      mediaSet: ['drive'],
      driveVersion: 2,
    });
  });

  it('refuses every transition precondition before destructive work', async () => {
    const user = await harness.seedUser();
    const { portfolioId } = await seedNormalGraph(user);
    const agent = await login(user);
    const expectRefusal = async (code: string) => {
      const response = await agent
        .post('/api/v1/account/paranoid/enable')
        .set(...XRW)
        .send(serverEnable());
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(code);
      expect((await accountState(user.id))?.privacyMode).toBe('normal');
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.id, portfolioId)),
      ).toHaveLength(1);
    };

    const [chain] = await harness.db
      .insert(mirrorChains)
      .values({ name: 'Blocking chain', createdBy: user.id, createdByUsername: user.username })
      .returning();
    await harness.db.insert(mirrorChainMembers).values({
      chainId: chain!.id,
      userId: user.id,
      username: user.username,
      portfolioId,
      role: 'owner',
    });
    await expectRefusal('PARANOID_MIRRORCHAIN_ACTIVE');
    await harness.db.delete(mirrorChainMembers).where(eq(mirrorChainMembers.chainId, chain!.id));
    await harness.db.delete(mirrorChains).where(eq(mirrorChains.id, chain!.id));

    const [batch] = await harness.db
      .insert(importBatches)
      .values({
        ownerId: user.id,
        portfolioId,
        brokerId: 'test',
        filename: 'pending.csv',
      })
      .returning();
    await expectRefusal('PARANOID_IMPORT_IN_FLIGHT');
    await harness.db.delete(importBatches).where(eq(importBatches.id, batch!.id));

    const [pendingExport] = await harness.db
      .insert(exportJobs)
      .values({ userId: user.id, downloadTokenHash: 'pending-hash' })
      .returning();
    await expectRefusal('PARANOID_EXPORT_IN_FLIGHT');
    await harness.db.delete(exportJobs).where(eq(exportJobs.id, pendingExport!.id));
  });

  it('revokes sharing in both directions while preserving friendship and chat-capable identity', async () => {
    const user = await harness.seedUser({
      email: 'paranoid@bettertrack.test',
      username: 'paranoid-user',
    });
    const friend = await harness.seedUser({
      email: 'friend@bettertrack.test',
      username: 'friend-user',
    });
    const { portfolioId } = await seedNormalGraph(user);
    const [friendPortfolio] = await harness.db
      .insert(portfolios)
      .values({ userId: friend.id, name: 'Friend portfolio' })
      .returning();
    const [userA, userB] = [user.id, friend.id].sort();
    await harness.db.insert(friendships).values({ userA: userA!, userB: userB! });
    const [outbound] = await harness.db
      .insert(shareAudiences)
      .values({
        ownerId: user.id,
        kind: 'portfolio',
        subjectId: portfolioId,
        audience: 'all_friends',
      })
      .returning();
    const [inbound] = await harness.db
      .insert(shareAudiences)
      .values({
        ownerId: friend.id,
        kind: 'portfolio',
        subjectId: friendPortfolio!.id,
        audience: 'all_friends',
      })
      .returning();
    await harness.db.insert(userFollows).values([
      { followerId: user.id, followedId: friend.id },
      { followerId: friend.id, followedId: user.id },
    ]);
    await harness.db.insert(itemFollows).values([
      { userId: user.id, kind: 'portfolio', subjectId: friendPortfolio!.id },
      { userId: friend.id, kind: 'portfolio', subjectId: portfolioId },
    ]);
    await harness.db.insert(itemComments).values([
      {
        kind: 'portfolio',
        subjectId: friendPortfolio!.id,
        authorId: user.id,
        body: 'authored by transitioning user',
      },
      {
        kind: 'portfolio',
        subjectId: portfolioId,
        authorId: friend.id,
        body: 'on transitioning user item',
      },
    ]);
    await harness.db.insert(itemReactions).values([
      {
        userId: user.id,
        targetType: 'item',
        kind: 'portfolio',
        subjectId: friendPortfolio!.id,
        emoji: '👍',
      },
      {
        userId: friend.id,
        targetType: 'item',
        kind: 'portfolio',
        subjectId: portfolioId,
        emoji: '❤️',
      },
    ]);

    await harness.ctx.paranoidTransitions.enable(user.id, serverEnable());

    expect(
      await harness.db.select().from(friendships).where(eq(friendships.userA, userA!)),
    ).toHaveLength(1);
    expect(
      await harness.db.select().from(shareAudiences).where(eq(shareAudiences.id, outbound!.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(shareAudiences).where(eq(shareAudiences.id, inbound!.id)),
    ).toHaveLength(1);
    expect(
      await harness.db
        .select()
        .from(shareAudienceMembers)
        .where(eq(shareAudienceMembers.audienceId, inbound!.id)),
    ).toEqual([{ audienceId: inbound!.id, friendId: user.id }]);
    expect(
      await harness.db
        .select()
        .from(userFollows)
        .where(or(eq(userFollows.followerId, user.id), eq(userFollows.followedId, user.id))),
    ).toEqual([]);
    expect(await harness.db.select().from(itemComments)).toEqual([]);
    expect(await harness.db.select().from(itemReactions)).toEqual([]);
    expect(await harness.db.select().from(itemFollows)).toEqual([]);
    expect(
      await createShareAudienceRepository(harness.db).authorizePortfolioRead(
        user.id,
        friendPortfolio!.id,
      ),
    ).toBeUndefined();
  });

  it('disables through the strict public payload and resumes idempotently', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    const agent = await login(user);
    await expect(
      harness.ctx.paranoidTransitions.enable(user.id, serverEnable()),
    ).resolves.toMatchObject({ mode: 'paranoid' });
    const body = disableRequest(user.id);

    const missingConfirm = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send({ rehydrationId: body.rehydrationId, document: body.document });
    expect(missingConfirm.status).toBe(400);
    expect((await accountState(user.id))?.privacyMode).toBe('paranoid');

    const first = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(body);
    expect(first.status).toBe(200);
    expect(paranoidDisableResponseSchema.parse(first.body)).toMatchObject({
      mode: 'normal',
      rehydrationId: REHYDRATION_ID,
      idempotent: false,
    });
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.id, RESTORED_PORTFOLIO_ID)),
    ).toHaveLength(1);
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);

    const retry = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(body);
    expect(retry.status).toBe(200);
    expect(paranoidDisableResponseSchema.parse(retry.body).idempotent).toBe(true);

    const conflict = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(disableRequest(user.id, OTHER_REHYDRATION_ID));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('PARANOID_TRANSITION_CONFLICT');
    const disableAudits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'account.paranoid_disabled'));
    expect(disableAudits).toHaveLength(2);
    expect(disableAudits.map((entry) => entry.meta)).toEqual(
      expect.arrayContaining([
        { rehydrationId: REHYDRATION_ID, idempotent: false },
        { rehydrationId: REHYDRATION_ID, idempotent: true },
      ]),
    );
  });

  it('serializes simultaneous equivalent enables into one commit and one idempotent retry', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    const results = await Promise.all([
      harness.ctx.paranoidTransitions.enable(user.id, serverEnable()),
      harness.ctx.paranoidTransitions.enable(user.id, serverEnable()),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect((await accountState(user.id))?.privacyMode).toBe('paranoid');
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
  });

  it('serializes simultaneous equivalent disables into one restore and one idempotent retry', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    await harness.ctx.paranoidTransitions.enable(user.id, serverEnable());
    const body = disableRequest(user.id);

    const results = await Promise.all([
      harness.ctx.paranoidTransitions.disable(user.id, body),
      harness.ctx.paranoidTransitions.disable(user.id, body),
    ]);

    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect((await accountState(user.id))?.privacyMode).toBe('normal');
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.id, RESTORED_PORTFOLIO_ID)),
    ).toHaveLength(1);
    expect(await harness.db.select().from(assets).where(eq(assets.id, ASSET_ID))).toHaveLength(1);
  });
});

describe('admin metadata batching', () => {
  it('costs the same number of reads for a whole page as for one account', async () => {
    const accounts = [];
    for (const index of [0, 1, 2, 3]) {
      accounts.push(
        await harness.seedUser({
          email: `batch-${index}@bt.test`,
          username: `batch_${index}`,
        }),
      );
    }
    const service = createParanoidTransitionService({
      db: harness.db,
      lockDb: harness.db,
      rehydration: {
        rehydrate: async () => {
          throw new Error('metadata reads never rehydrate');
        },
      } satisfies ParanoidRehydrationService,
      audit: { record: async () => undefined } as unknown as AuditService,
    });

    // The list path must take ONE privacy lock and a fixed set of queries. A
    // per-user fan-out (one lock + three reads each) exhausts the connection
    // pool in production, where each lock reserves a pooled connection.
    const reads = vi.spyOn(harness.db, 'select');
    const page = await service.adminMetadataMany(accounts.map((account) => account.id));
    const pageReads = reads.mock.calls.length;
    reads.mockClear();
    const single = await service.adminMetadataMany([accounts[0]!.id]);
    const singleReads = reads.mock.calls.length;
    reads.mockRestore();

    expect(page.size).toBe(accounts.length);
    expect(single.size).toBe(1);
    expect(singleReads).toBeGreaterThan(0);
    expect(pageReads).toBe(singleReads);
    expect(await service.adminMetadata(accounts[0]!.id)).toMatchObject({ privacyMode: 'normal' });
    expect(await service.adminMetadata('018f0000-0000-7000-8000-0000000005ff')).toBeNull();
  });
});

describe.each<ParanoidEnableStage>(['locked', 'sharingRevoked', 'vaultPurged', 'modeEnabled'])(
  'enable rollback at %s',
  (failureStage) => {
    it('leaves mode, ciphertext, and cleartext graph intact', async () => {
      const user = await harness.seedUser();
      const { portfolioId } = await seedNormalGraph(user);
      const service = createParanoidTransitionService({
        db: harness.db,
        rehydration: {
          rehydrate: async () => {
            throw new Error('enable rollback tests never invoke rehydration');
          },
        } satisfies ParanoidRehydrationService,
        audit: {
          record: async () => undefined,
        } as unknown as AuditService,
        afterEnableStage(stage) {
          if (stage === failureStage) throw new Error(`injected ${stage}`);
        },
      });

      await expect(service.enable(user.id, serverEnable())).rejects.toThrow(
        `injected ${failureStage}`,
      );
      expect((await accountState(user.id))?.privacyMode).toBe('normal');
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.id, portfolioId)),
      ).toHaveLength(1);
      expect(await harness.db.select().from(assets).where(eq(assets.id, ASSET_ID))).toHaveLength(1);
      expect(
        await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
      ).toHaveLength(1);
    });
  },
);
