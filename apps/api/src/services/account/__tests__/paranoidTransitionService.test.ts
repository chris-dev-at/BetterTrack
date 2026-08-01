import { join as joinPath } from 'node:path';

import { and, eq, or } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  paranoidDisableRequestSchema,
  paranoidDisableResponseSchema,
  paranoidEnableResponseSchema,
  type ParanoidDisableRequest,
  type ParanoidEnableRequest,
} from '@bettertrack/contracts';

import { withParanoidTransitionTransaction } from '../../../data/repositories/paranoidTransitionRepository';
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
import { hashToken } from '../../crypto/tokens';
import { liveRingKey } from '../../liveMode/ringBuffer';
import type { AuditService } from '../../audit/auditService';
import type { ParanoidDiscardReauth } from '../paranoidDiscardReauth';
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
const RESTORED_SOURCE_ID = '018f0000-0000-7000-8000-000000000505';
const EDITED_AT = '2026-07-24T10:00:00.000Z';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

/**
 * These harnesses drive enable / admin metadata only. The discard gate is a
 * REQUIRED dependency (a composition that forgets it must not typecheck), so
 * they supply one that fails loudly if a path ever reaches it unexpectedly.
 */
function neverReachedDiscardReauth(): ParanoidDiscardReauth {
  return {
    verify: async () => {
      throw new Error('these tests never take the discard exit');
    },
  };
}

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

/**
 * A server-medium enable body carrying a FRESH capture token. Real callers read
 * it before the migration; a test that seeds rows and then enables has to read
 * it after seeding for the same reason — the token is a compare-and-swap over
 * exactly the rows the purge destroys.
 */
async function serverEnable(userId: string, vaultVersion = 1): Promise<ParanoidEnableRequest> {
  const { revision } = await harness.ctx.paranoidTransitions.normalDataRevision(userId);
  return {
    mediaSet: ['server'],
    vaultVersion,
    driveAttestation: null,
    normalDataRevision: revision,
  };
}

/** Drive-only evidence with a fresh capture token. */
async function driveEnable(userId: string, vaultVersion: number): Promise<ParanoidEnableRequest> {
  const { revision } = await harness.ctx.paranoidTransitions.normalDataRevision(userId);
  return {
    mediaSet: ['drive'],
    vaultVersion,
    driveAttestation: { verifiedRoundTrip: true, vaultVersion },
    normalDataRevision: revision,
  };
}

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
      mirrorProvenance: [],
    },
  };
}

/**
 * A restore document that carries a cash ledger: portfolio + its single active
 * main source + one deposit, keyed by the ids the capture would have read. Used
 * to prove that a row which survived a refused enable makes it back out through
 * disable, under its own identity.
 */
function cashRestoreRequest(userId: string, movementId: string): ParanoidDisableRequest {
  // Parsed through the strict contract rather than cast: a mis-shaped entity
  // fails here instead of as an opaque 400.
  const entity = (id: string, kind: string, data: Record<string, unknown>) => ({
    id,
    kind,
    rev: 0,
    editedAt: EDITED_AT,
    editedBy: userId,
    deletedAt: null,
    data,
  });
  return paranoidDisableRequestSchema.parse({
    confirm: true,
    rehydrationId: REHYDRATION_ID,
    document: {
      schemaVersion: 1,
      entities: [
        entity(RESTORED_PORTFOLIO_ID, 'portfolio', {
          userId,
          name: 'Restored',
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
        }),
        // The seeded custom asset's opaque identity survives the purge, so the
        // restore has to account for it (live row or tombstone) like any real
        // capture would.
        entity(ASSET_ID, 'customAsset', {
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
        }),
        entity(RESTORED_SOURCE_ID, 'cashSource', {
          portfolioId: RESTORED_PORTFOLIO_ID,
          name: 'Main',
          type: 'cash',
          isMain: true,
          archivedAt: null,
          createdAt: EDITED_AT,
        }),
        entity(movementId, 'cashMovement', {
          portfolioId: RESTORED_PORTFOLIO_ID,
          sourceId: RESTORED_SOURCE_ID,
          kind: 'deposit',
          amountEur: '750',
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-31T09:00:00.000Z',
          note: 'salary booked during media verification',
          source: 'standing-order',
          dedupHash: null,
          originalCurrency: null,
          createdAt: EDITED_AT,
        }),
      ],
      mergeLog: [],
      mirrorProvenance: [],
    },
  });
}

/**
 * The account-deletion rung the `discard` exit carries: typed username + a
 * server-verified credential. Spread into the request body.
 */
function discardCredential(user: SeededUser) {
  return { confirmUsername: user.username, password: user.password };
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
  it('refuses the enable when a money row lands after the capture, and never loses it', async () => {
    /*
     * The window the capture↔commit CAS closes. The wizard reads the whole
     * account, encrypts it, writes both media and READ-VERIFIES them — all
     * lock-free, seconds to minutes — before it reaches the enable transaction.
     * A write inside that window (a second session, or the daily standing-order
     * worker booking a period) is absent from the encrypted document, and the
     * purge below hard-deletes it while disable restores from that document
     * ALONE. Here the write is injected exactly where a media verification would
     * be: after the capture, before the commit.
     */
    const user = await harness.seedUser();
    const { portfolioId } = await seedNormalGraph(user);
    const agent = await login(user);
    const captured = await serverEnable(user.id);

    const [source] = await harness.db
      .select()
      .from(portfolioCashSources)
      .where(eq(portfolioCashSources.portfolioId, portfolioId));
    const [injected] = await harness.db
      .insert(portfolioCashMovements)
      .values({
        portfolioId,
        sourceId: source!.id,
        kind: 'deposit',
        amountEur: '750',
        executedAt: new Date('2026-07-31T09:00:00.000Z'),
        note: 'salary booked during media verification',
        source: 'standing-order',
      })
      .returning();

    const refused = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send(captured);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe('PARANOID_NORMAL_DATA_CHANGED');

    // Nothing was destroyed: the account is still normal and every row —
    // including the injected one — is exactly where it was.
    expect((await accountState(user.id))?.privacyMode).toBe('normal');
    expect(
      await harness.db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ).toHaveLength(2);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toHaveLength(1);

    // Re-capturing (what the wizard does on retry) now includes the injected
    // row, so the same enable commits — and the row survives the round trip out
    // the other side, which is the property the refusal protects.
    const recaptured = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send(await serverEnable(user.id));
    expect(recaptured.status, JSON.stringify(recaptured.body)).toBe(200);
    expect(
      await harness.db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ).toEqual([]);

    const restored = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(cashRestoreRequest(user.id, injected!.id));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const movements = await harness.db
      .select()
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.id, injected!.id));
    expect(movements).toMatchObject([
      { amountEur: '750.000000', note: 'salary booked during media verification' },
    ]);
  });

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
      .send(await serverEnable(user.id));
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

    const noCsrf = await agent
      .post('/api/v1/account/paranoid/enable')
      .send(await serverEnable(user.id));
    expect(noCsrf.status).toBe(403);
    expect((await accountState(user.id))?.privacyMode).toBe('normal');

    const unknownField = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ ...(await serverEnable(user.id)), unsupported: true });
    expect(unknownField.status).toBe(400);

    const stale = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send(await serverEnable(user.id, 2));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PARANOID_MEDIA_NOT_READY');

    const malformedDrive = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({
        ...(await driveEnable(user.id, 1)),
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

    const response = await harness.ctx.paranoidTransitions.enable(
      user.id,
      await driveEnable(user.id, 2),
    );
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
    const driveOnly: ParanoidEnableRequest = await driveEnable(user.id, 2);
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
        .send(await serverEnable(user.id));
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

    await harness.ctx.paranoidTransitions.enable(user.id, await serverEnable(user.id));

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

  it('spends the widened restore body bound only on an account that can restore', async () => {
    // `app.ts` defers the global 100 KiB parser for this one path, so the route
    // picks the parser itself — the first point where `privacyMode` is known. A
    // normal account has nothing to restore and must not be able to make the
    // process buffer and JSON.parse a multi-MiB document per request.
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    const agent = await login(user);
    const oversize = {
      confirm: true,
      rehydrationId: REHYDRATION_ID,
      padding: 'x'.repeat(200 * 1024),
    };

    const rejected = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(oversize);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(413);
    expect(rejected.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await accountState(user.id))?.privacyMode).toBe('normal');

    // Paranoid: the same body is buffered, and the answer comes from the strict
    // contract instead of the parser — the restore path is never 413-trapped.
    await expect(
      harness.ctx.paranoidTransitions.enable(user.id, await serverEnable(user.id)),
    ).resolves.toMatchObject({ mode: 'paranoid' });
    const buffered = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(oversize);
    expect(buffered.status, JSON.stringify(buffered.body)).toBe(400);
    expect(buffered.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('disables through the strict public payload and resumes idempotently', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    const agent = await login(user);
    await expect(
      harness.ctx.paranoidTransitions.enable(user.id, await serverEnable(user.id)),
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

  it('discards an unrecoverable vault into an empty normal account, but only when asked explicitly', async () => {
    // docs/paranoid-design.md §3 — "lost key ⇒ lost data … the only
    // server-side recovery is destruction". The unlock gate's Start-fresh is
    // the entry point: a client that cannot decrypt restores nothing and says
    // so with an explicit flag.
    const user = await harness.seedUser();
    const { watchlistId } = await seedNormalGraph(user);
    const agent = await login(user);
    await expect(
      harness.ctx.paranoidTransitions.enable(user.id, await serverEnable(user.id)),
    ).resolves.toMatchObject({ mode: 'paranoid' });
    const emptyDocument = { schemaVersion: 1, entities: [], mergeLog: [] };

    // A client that merely LOST its rows still fails the ordinary restore
    // invariants — an empty graph is never read as consent to destroy.
    const silent = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send({ confirm: true, rehydrationId: REHYDRATION_ID, document: emptyDocument });
    expect(silent.status).toBe(400);
    expect(silent.body.error.code).toBe('PARANOID_REHYDRATION_INVALID');
    expect((await accountState(user.id))?.privacyMode).toBe('paranoid');

    // …and a discard may not smuggle rows back in.
    const mixed = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send({
        ...discardCredential(user),
        confirm: true,
        discard: true,
        rehydrationId: REHYDRATION_ID,
        document: disableRequest(user.id).document,
      });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.code).toBe('PARANOID_REHYDRATION_INVALID');
    expect((await accountState(user.id))?.privacyMode).toBe('paranoid');

    const response = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send({
        ...discardCredential(user),
        confirm: true,
        discard: true,
        rehydrationId: REHYDRATION_ID,
        document: emptyDocument,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(paranoidDisableResponseSchema.parse(response.body)).toMatchObject({
      mode: 'normal',
      idempotent: false,
    });
    expect((await accountState(user.id))?.privacyMode).toBe('normal');
    // The vault and every row it held are gone; the retained identity claim
    // that no document could account for is retired with it.
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(assetIdentities).where(eq(assetIdentities.id, ASSET_ID)),
    ).toEqual([]);
    // … while everything that was never in the vault survives untouched.
    expect(
      await harness.db.select().from(watchlists).where(eq(watchlists.id, watchlistId)),
    ).toHaveLength(1);
    const [audit] = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'account.paranoid_disabled'));
    expect(audit?.meta).toEqual({
      rehydrationId: REHYDRATION_ID,
      idempotent: false,
      discard: true,
    });
  });

  it('re-authenticates the irreversible discard server-side, exactly like account deletion', async () => {
    // A live session is NOT authorization to destroy an unrecoverable vault:
    // the typed username and the credential are both verified here, so a
    // hijacked session cannot wipe the account with one POST past the client
    // form. The restoring disable is unaffected — it hands the rows back.
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    const agent = await login(user);
    await expect(
      harness.ctx.paranoidTransitions.enable(user.id, await serverEnable(user.id)),
    ).resolves.toMatchObject({ mode: 'paranoid' });
    const emptyDocument = { schemaVersion: 1, entities: [], mergeLog: [] };
    const discard = (extra: Record<string, unknown>) =>
      agent
        .post('/api/v1/account/paranoid/disable')
        .set(...XRW)
        .send({
          confirm: true,
          discard: true,
          rehydrationId: REHYDRATION_ID,
          document: emptyDocument,
          ...extra,
        });

    // No credential at all — refused by the contract before any work.
    const bare = await discard({});
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('VALIDATION_ERROR');

    // Username typed, credential missing.
    const noCredential = await discard({ confirmUsername: user.username });
    expect(noCredential.status).toBe(400);
    expect(noCredential.body.error.code).toBe('VALIDATION_ERROR');

    // Wrong username, correct password.
    const wrongName = await discard({ confirmUsername: 'someone-else', password: user.password });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.code).toBe('CONFIRMATION_MISMATCH');

    // Correct username, wrong password.
    const wrongPassword = await discard({
      confirmUsername: user.username,
      password: 'not-the-password',
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');

    // Nothing was destroyed by any of the four attempts.
    expect((await accountState(user.id))?.privacyMode).toBe('paranoid');
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toHaveLength(1);
    const failures = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'account.paranoid_discard_fail'));
    expect(failures).toHaveLength(1);

    // The full rung passes.
    const accepted = await discard(discardCredential(user));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await accountState(user.id))?.privacyMode).toBe('normal');
  });

  it('serializes simultaneous equivalent enables into one commit and one idempotent retry', async () => {
    const user = await harness.seedUser();
    await seedNormalGraph(user);
    // ONE body for both callers: they race the same capture token, exactly like
    // two tabs finishing the same wizard.
    const body = await serverEnable(user.id);
    const results = await Promise.all([
      harness.ctx.paranoidTransitions.enable(user.id, body),
      harness.ctx.paranoidTransitions.enable(user.id, body),
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
    await harness.ctx.paranoidTransitions.enable(user.id, await serverEnable(user.id));
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

describe('severed-fork provenance capture read', () => {
  it('exposes only the caller’s own ended fork, never an active chain or a co-member', async () => {
    const owner = await harness.seedUser({
      email: 'capture-owner@bettertrack.test',
      username: 'capture-owner',
    });
    const member = await harness.seedUser({
      email: 'capture-member@bettertrack.test',
      username: 'capture-member',
    });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId, {
      name: 'Capture chain',
    });
    const { portfolioId: forkPortfolioId } = await harness.ctx.mirror.attachMemberCopy(
      chain.id,
      member.id,
    );
    await harness.ctx.mirror.replicateChain(chain.id);

    // While the membership is ACTIVE the map stays server-side and invisible.
    await expect(harness.ctx.paranoidTransitions.forkProvenance(member.id)).resolves.toEqual({
      provenance: [],
    });
    await expect(harness.ctx.paranoidTransitions.forkProvenance(owner.id)).resolves.toEqual({
      provenance: [],
    });

    await harness.ctx.mirror.removeMember(owner.id, chain.id, member.id);
    const [membership] = await harness.db
      .select()
      .from(mirrorChainMembers)
      .where(
        and(eq(mirrorChainMembers.chainId, chain.id), eq(mirrorChainMembers.userId, member.id)),
      );
    const captured = await harness.ctx.paranoidTransitions.forkProvenance(member.id);
    expect(captured.provenance.length).toBeGreaterThan(0);
    for (const entry of captured.provenance) {
      expect(entry.chainId).toBe(chain.id);
      expect(entry.portfolioId).toBe(forkPortfolioId);
      // The ENDED tombstone that owns this copy — the row restore-time validation
      // takes its watermark from, and the caller's own membership only.
      expect(entry.membershipId).toBe(membership!.id);
      // Only the six contract fields — no `createdBy`/`createdByUsername`.
      expect(Object.keys(entry).sort()).toEqual([
        'chainId',
        'kind',
        'localId',
        'membershipId',
        'mirrorId',
        'portfolioId',
      ]);
    }
    // The still-active owner sees nothing, and the departed member's read never
    // reaches into the owner's copy.
    await expect(harness.ctx.paranoidTransitions.forkProvenance(owner.id)).resolves.toEqual({
      provenance: [],
    });
    expect(captured.provenance.some((entry) => entry.portfolioId === ownerPortfolioId)).toBe(false);
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
      discardReauth: neverReachedDiscardReauth(),
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
        discardReauth: neverReachedDiscardReauth(),
        afterEnableStage(stage) {
          if (stage === failureStage) throw new Error(`injected ${stage}`);
        },
      });

      await expect(service.enable(user.id, await serverEnable(user.id))).rejects.toThrow(
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

describe('enable rollback at an outcome-ambiguous commit', () => {
  it('keeps the archive retired and answers a stale download 404, never a 500', async () => {
    const user = await harness.seedUser();
    const { portfolioId } = await seedNormalGraph(user);

    // A ready export archive whose file is staged for retirement by the enable.
    const downloadToken = 'stale-archive-download-token';
    const missingArchive = joinPath(harness.ctx.config.dataExport.dir, `${user.id}-retired.zip`);
    const [exportRow] = await harness.db
      .insert(exportJobs)
      .values({
        userId: user.id,
        status: 'ready',
        filePath: missingArchive,
        fileSize: 4096,
        downloadTokenHash: hashToken(downloadToken),
        readyAt: new Date(EDITED_AT),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();

    // Both declared seams, driven together: `prepareExportFile` makes the staged
    // retirement observable without touching the disk, and
    // `withTransitionTransaction` fails the COMMIT after the whole body — the one
    // outcome-ambiguous shape the real transaction can take, and the only way to
    // reach the ordering `permanentlyRetirePrepared()` deliberately allows.
    const retirement: string[] = [];
    const base = {
      db: harness.db,
      rehydration: {
        rehydrate: async () => {
          throw new Error('enable never rehydrates');
        },
      } satisfies ParanoidRehydrationService,
      audit: { record: async () => undefined } as unknown as AuditService,
      discardReauth: neverReachedDiscardReauth(),
      prepareExportFile: async (artifact: { id: string; filePath: string }) => {
        retirement.push(`prepare:${artifact.id}`);
        return {
          rollback: async () => void retirement.push('rollback'),
          commit: async () => void retirement.push('commit'),
        };
      },
    };
    const failing = createParanoidTransitionService({
      ...base,
      withTransitionTransaction: async (db, userId, run) =>
        withParanoidTransitionTransaction(db, userId, async (tx) => {
          await run(tx);
          throw new Error('injected commit failure');
        }),
    });

    await expect(failing.enable(user.id, await serverEnable(user.id))).rejects.toThrow(
      'injected commit failure',
    );

    // The archive is gone for good — an unlink that has started is never undone,
    // because neither PostgreSQL nor the filesystem can report this outcome
    // reliably. The DB, in contrast, rolled ALL the way back.
    expect(retirement).toEqual([`prepare:${exportRow!.id}`, 'commit']);
    expect((await accountState(user.id))?.privacyMode).toBe('normal');
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.id, portfolioId)),
    ).toHaveLength(1);
    const [rolledBack] = await harness.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, exportRow!.id));
    expect(rolledBack!.status).toBe('ready');
    expect(rolledBack!.error).toBeNull();
    // The retained pointer is what makes the next enable retry safe (it re-stages
    // deterministically) — and it is also a pointer to bytes that no longer exist.
    expect(rolledBack!.filePath).toBe(missingArchive);

    // So the download path must fail CLOSED on the same opaque 404 as an expired or
    // foreign token rather than 500 on ENOENT while streaming.
    await expect(
      harness.ctx.dataExport.withDownload({ userId: user.id, token: downloadToken }, async () => {
        throw new Error('a missing archive is never streamed');
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'EXPORT_NOT_FOUND' });

    // And a retry of the same enable — same evidence, a healthy transaction this
    // time — still completes: the staged name is deterministic, so re-preparing an
    // artifact whose file is already gone is a no-op rather than a hard conflict.
    const retried = await createParanoidTransitionService(base).enable(
      user.id,
      await serverEnable(user.id),
    );
    expect(retried.mode).toBe('paranoid');
    expect(retried.idempotent).toBe(false);
    expect(retirement).toEqual([
      `prepare:${exportRow!.id}`,
      'commit',
      `prepare:${exportRow!.id}`,
      'commit',
    ]);
  });
});
