import { existsSync } from 'node:fs';

import { eq, inArray } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeVaultEnvelope,
  exportRequestResponseSchema,
  paranoidDisableResponseSchema,
  paranoidEnableResponseSchema,
  VAULT_CONTENT_CIPHER,
} from '@bettertrack/contracts';

import {
  alerts,
  assets,
  conglomeratePositions,
  conglomerates,
  exportJobs,
  friendGroupMembers,
  friendGroups,
  friendships,
  importBatches,
  importRows,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  mirrorChainInvites,
  mirrorChains,
  notifications,
  paranoidVaultHistory,
  paranoidVaults,
  portfolios,
  priceHistory,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  sharedItemActivityPrefs,
  transactions,
  userFollows,
  users,
  watchlists,
  workboardItems,
} from '../data/schema';
import type { ParanoidRehydrationService } from '../services/account/paranoidRehydrationService';
import type { ParanoidKilledCapability } from '../services/account/paranoidEnforcement';
import { createParanoidTransitionService } from '../services/account/paranoidTransitionService';
import type { AuditService } from '../services/audit/auditService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;
const KEY_ID = '018f0000-0000-7000-8000-00000000000a';
const DEVICE_ID = '018f0000-0000-7000-8000-00000000000b';
const WRITE_ID = '018f0000-0000-7000-8000-00000000000c';
const REHYDRATION_ID = '018f0000-0000-7000-8000-00000000000d';
const CHAIN_ID = '018f0000-0000-7000-8000-00000000000e';
const MEMBER_ID = '018f0000-0000-7000-8000-00000000000f';
const KEPT_ASSET_IDS = [
  '018f0000-0000-7000-8000-000000000020',
  '018f0000-0000-7000-8000-000000000022',
  '018f0000-0000-7000-8000-000000000024',
] as const;
const KEPT_VALUE_IDS = [
  '018f0000-0000-7000-8000-000000000021',
  '018f0000-0000-7000-8000-000000000023',
  '018f0000-0000-7000-8000-000000000025',
] as const;

let harness: TestHarness;
let importAfterApplyClaim: ((userId: string, batchId: string) => void | Promise<void>) | undefined;
let exportAfterCollect: ((jobId: string) => void | Promise<void>) | undefined;

beforeEach(async () => {
  importAfterApplyClaim = undefined;
  exportAfterCollect = undefined;
  harness = await createTestApp({
    importAfterApplyClaim: (userId, batchId) => importAfterApplyClaim?.(userId, batchId),
    exportAfterCollect: (jobId) => exportAfterCollect?.(jobId),
  });
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const result = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(result.status).toBe(200);
  return agent;
}

function envelope(vaultVersion: number, marker = vaultVersion): Buffer {
  return Buffer.from(
    encodeVaultEnvelope(
      {
        formatVersion: 1,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'aXYtOTZiaXQ=',
        keyId: KEY_ID,
        wrappedKeys: [
          {
            keyId: KEY_ID,
            kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
            wrappedVk: 'd3JhcHBlZA==',
          },
        ],
        vaultVersion,
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        writeId: WRITE_ID,
        writtenAt: '2026-07-26T10:00:00.000Z',
      },
      new Uint8Array([marker]),
    ),
  );
}

async function seedNormalAccount() {
  const user = await harness.seedUser({
    email: 'paranoid@bettertrack.test',
    username: 'paranoid_user',
    password: 'user-strong-password-1',
  });
  const [portfolio] = await harness.db
    .insert(portfolios)
    .values({ userId: user.id, name: 'Main' })
    .returning();
  const agent = await loginAgent(harness.app, user.email, user.password);
  return { user, portfolio: portfolio!, agent };
}

async function putServerVault(agent: Agent, version = 1) {
  const blob = envelope(version);
  const response = await agent
    .put('/api/v1/vault')
    .set(...XRW)
    .set(...OCTET)
    .set('If-None-Match', '*')
    .send(blob);
  expect(response.status).toBe(204);
  return blob;
}

async function stageServerVault(userId: string, version = 1) {
  const blob = envelope(version);
  await harness.db.insert(paranoidVaults).values({
    userId,
    version,
    formatVersion: 1,
    sizeBytes: blob.length,
    blob,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startPausedDriveEnable(userId: string) {
  const locked = deferred();
  const release = deferred();
  const transition = createParanoidTransitionService({
    db: harness.db,
    rehydration: {} as ParanoidRehydrationService,
    audit: { record: vi.fn(async () => {}) } as unknown as AuditService,
    async afterEnableStage(stage) {
      if (stage !== 'locked') return;
      locked.resolve();
      await release.promise;
    },
  });
  const enabling = transition.enable(userId, {
    mediaSet: ['drive'],
    vaultVersion: 1,
    driveAttestation: { verifiedRoundTrip: true, vaultVersion: 1 },
  });
  return { enabling, locked: locked.promise, release };
}

function pauseGuardedAction(targetId: string, capability: ParanoidKilledCapability) {
  const guard = harness.ctx.paranoidGuard;
  const original = guard.runAllowedMany.bind(guard);
  const entered = deferred();
  const release = deferred();
  let paused = false;
  guard.runAllowedMany = async <T>(
    userIds: readonly string[],
    guardedCapability: ParanoidKilledCapability,
    action: () => Promise<T>,
  ): Promise<T> =>
    original(userIds, guardedCapability, async () => {
      if (!paused && guardedCapability === capability && userIds.includes(targetId)) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return action();
    });
  return {
    entered: entered.promise,
    release,
    restore() {
      guard.runAllowedMany = original;
    },
  };
}

describe('public paranoid transitions', () => {
  it('enables atomically, enforces the registry, and disables idempotently', async () => {
    const { user, portfolio, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const [customAsset] = await harness.db
      .insert(assets)
      .values({
        providerId: 'manual',
        providerRef: `custom:${user.id}`,
        ownerId: user.id,
        type: 'custom',
        symbol: 'PRIVATE',
        name: 'Private asset',
        currency: 'EUR',
      })
      .returning();
    await harness.db.insert(priceHistory).values({
      assetId: customAsset!.id,
      date: '2026-07-25',
      close: '100',
    });
    await harness.db.insert(transactions).values({
      portfolioId: portfolio.id,
      assetId: customAsset!.id,
      side: 'buy',
      quantity: '1',
      price: '100',
      executedAt: new Date('2026-07-25T10:00:00.000Z'),
    });

    const enabledResponse = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(enabledResponse.status).toBe(200);
    const enabled = paranoidEnableResponseSchema.parse(enabledResponse.body);
    expect(enabled).toMatchObject({
      mode: 'paranoid',
      mediaSet: ['server'],
      vaultVersion: 1,
      idempotent: false,
    });

    const [account] = await harness.db.select().from(users).where(eq(users.id, user.id));
    expect(account).toMatchObject({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
      profilePublic: false,
    });
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
    expect(await harness.db.select().from(assets).where(eq(assets.ownerId, user.id))).toEqual([]);
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toHaveLength(1);

    const killed = await agent.get('/api/v1/portfolios');
    expect(killed.status).toBe(403);
    expect(killed.body.error.code).toBe('PARANOID_MODE');
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    const retryEnable = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(paranoidEnableResponseSchema.parse(retryEnable.body).idempotent).toBe(true);

    const disableRequest = {
      confirm: true,
      rehydrationId: REHYDRATION_ID,
      document: {
        schemaVersion: 1,
        entities: [
          {
            id: portfolio.id,
            kind: 'portfolio',
            rev: 1,
            editedAt: '2026-07-26T10:00:00.000Z',
            editedBy: DEVICE_ID,
            deletedAt: null,
            data: {
              userId: user.id,
              name: 'Main',
              visibility: 'private',
              sortOrder: 0,
              defaultPayFromCash: false,
              archivedAt: null,
            },
          },
        ],
        mergeLog: [],
      },
    };
    const disabledResponse = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(disableRequest);
    expect(disabledResponse.status, JSON.stringify(disabledResponse.body)).toBe(200);
    expect(paranoidDisableResponseSchema.parse(disabledResponse.body)).toMatchObject({
      mode: 'normal',
      rehydrationId: REHYDRATION_ID,
      idempotent: false,
    });
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);

    const retryDisable = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(disableRequest);
    expect(paranoidDisableResponseSchema.parse(retryDisable.body).idempotent).toBe(true);
    expect((await agent.get(`/api/v1/portfolios/${portfolio.id}`)).status).not.toBe(403);
  });

  it('hard-deletes and losslessly restores custom assets referenced by every kept surface', async () => {
    const { user, portfolio, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const customAssets = await harness.db
      .insert(assets)
      .values(
        KEPT_ASSET_IDS.map((id, index) => ({
          id,
          providerId: 'manual',
          providerRef: id,
          ownerId: user.id,
          type: 'custom' as const,
          symbol: ['HOME', 'IDEA', 'ALERT'][index]!,
          name: ['Private home', 'Private hypothesis', 'Private alert asset'][index]!,
          exchange: null,
          currency: 'EUR',
          meta: { category: 'other', smoothing: false },
        })),
      )
      .returning();
    await harness.db.insert(priceHistory).values(
      KEPT_ASSET_IDS.map((assetId, index) => ({
        assetId,
        date: '2026-07-25',
        close: String((index + 1) * 100),
      })),
    );
    const [watchlist] = await harness.db
      .insert(watchlists)
      .values({ userId: user.id, name: 'Private assets', isDefault: false })
      .returning();
    const [conglomerate] = await harness.db
      .insert(conglomerates)
      .values({
        ownerId: user.id,
        name: 'Hypothetical',
        status: 'draft',
        visibility: 'private',
      })
      .returning();
    const [workboardItem] = await harness.db
      .insert(workboardItems)
      .values({
        userId: user.id,
        watchlistId: watchlist!.id,
        assetId: KEPT_ASSET_IDS[0],
        sortOrder: 0,
        note: 'kept watchlist note',
      })
      .returning();
    const [position] = await harness.db
      .insert(conglomeratePositions)
      .values({
        conglomerateId: conglomerate!.id,
        assetId: KEPT_ASSET_IDS[1],
        weightPct: '100',
        sortOrder: 0,
      })
      .returning();
    const [alert] = await harness.db
      .insert(alerts)
      .values({
        userId: user.id,
        assetId: KEPT_ASSET_IDS[2],
        kind: 'price_above',
        threshold: '120',
        repeat: false,
        status: 'active',
      })
      .returning();

    const enabled = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

    expect(
      await harness.db
        .select()
        .from(workboardItems)
        .where(eq(workboardItems.id, workboardItem!.id)),
    ).toEqual([workboardItem]);
    expect(
      await harness.db
        .select()
        .from(conglomeratePositions)
        .where(eq(conglomeratePositions.id, position!.id)),
    ).toEqual([position]);
    expect(await harness.db.select().from(alerts).where(eq(alerts.id, alert!.id))).toEqual([alert]);
    expect(
      await harness.db
        .select()
        .from(assets)
        .where(inArray(assets.id, [...KEPT_ASSET_IDS])),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, [...KEPT_ASSET_IDS])),
    ).toEqual([]);

    const disabled = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send({
        confirm: true,
        rehydrationId: REHYDRATION_ID,
        document: {
          schemaVersion: 1,
          entities: [
            {
              id: portfolio.id,
              kind: 'portfolio',
              rev: 1,
              editedAt: '2026-07-26T10:00:00.000Z',
              editedBy: DEVICE_ID,
              deletedAt: null,
              data: {
                userId: user.id,
                name: 'Main',
                visibility: 'private',
                sortOrder: 0,
                defaultPayFromCash: false,
                archivedAt: null,
              },
            },
            ...customAssets.map((customAsset) => ({
              id: customAsset.id,
              kind: 'customAsset',
              rev: 1,
              editedAt: '2026-07-26T10:00:00.000Z',
              editedBy: DEVICE_ID,
              deletedAt: null,
              data: {
                providerId: customAsset.providerId,
                providerRef: customAsset.providerRef,
                ownerId: customAsset.ownerId,
                type: customAsset.type,
                symbol: customAsset.symbol,
                name: customAsset.name,
                exchange: customAsset.exchange,
                currency: customAsset.currency,
                meta: customAsset.meta,
                searchText: customAsset.searchText,
              },
            })),
            ...customAssets.map((customAsset, index) => ({
              id: KEPT_VALUE_IDS[index]!,
              kind: 'customAssetValue',
              rev: 1,
              editedAt: '2026-07-26T10:00:00.000Z',
              editedBy: DEVICE_ID,
              deletedAt: null,
              data: {
                assetId: customAsset.id,
                date: '2026-07-25',
                close: String((index + 1) * 100),
              },
            })),
          ],
          mergeLog: [],
        },
      });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);

    const restored = await harness.db
      .select()
      .from(assets)
      .where(inArray(assets.id, [...KEPT_ASSET_IDS]));
    expect(restored).toHaveLength(3);
    for (const customAsset of customAssets) {
      expect(restored).toContainEqual(customAsset);
    }
    expect(
      await harness.db
        .select()
        .from(workboardItems)
        .where(eq(workboardItems.id, workboardItem!.id)),
    ).toEqual([workboardItem]);
    expect(
      await harness.db
        .select()
        .from(conglomeratePositions)
        .where(eq(conglomeratePositions.id, position!.id)),
    ).toEqual([position]);
    expect(await harness.db.select().from(alerts).where(eq(alerts.id, alert!.id))).toEqual([alert]);
    expect(
      await harness.db
        .select()
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, [...KEPT_ASSET_IDS])),
    ).toHaveLength(3);
  });

  it('accepts a complete disable document above the regular 100 KiB JSON limit', async () => {
    const { user, portfolio, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const enabled = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(enabled.status).toBe(200);

    const customAssets = Array.from({ length: 160 }, (_, index) => {
      const id = `018f1000-0000-7000-8000-${String(index + 1000).padStart(12, '0')}`;
      return {
        id,
        kind: 'customAsset' as const,
        rev: 1,
        editedAt: '2026-07-26T10:00:00.000Z',
        editedBy: DEVICE_ID,
        deletedAt: null,
        data: {
          providerId: 'manual',
          providerRef: id,
          ownerId: user.id,
          type: 'custom' as const,
          symbol: `BULK${index}`,
          name: `Bulk restore asset ${index}`,
          exchange: null,
          currency: 'EUR',
          meta: { padding: 'x'.repeat(900) },
          searchText: null,
        },
      };
    });
    const requestBody = {
      confirm: true,
      rehydrationId: REHYDRATION_ID,
      document: {
        schemaVersion: 1 as const,
        entities: [
          {
            id: portfolio.id,
            kind: 'portfolio' as const,
            rev: 1,
            editedAt: '2026-07-26T10:00:00.000Z',
            editedBy: DEVICE_ID,
            deletedAt: null,
            data: {
              userId: user.id,
              name: 'Main',
              visibility: 'private' as const,
              sortOrder: 0,
              defaultPayFromCash: false,
              archivedAt: null,
            },
          },
          ...customAssets,
        ],
        mergeLog: [],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(requestBody))).toBeGreaterThan(100 * 1024);

    const disabled = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(requestBody);
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(await harness.db.select().from(assets).where(eq(assets.ownerId, user.id))).toHaveLength(
      customAssets.length,
    );
  });

  it('derives the disable transport limit from a raised vault size cap', async () => {
    const raisedCap = 17 * 1024 * 1024;
    harness = await createTestApp({
      env: { BT_VAULT_MAX_BYTES: String(raisedCap) },
    });
    const user = await harness.seedUser({
      email: 'raised-cap@bettertrack.test',
      username: 'raised_cap',
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const body = {
      confirm: true,
      padding: 'x'.repeat(16 * 1024 * 1024 + 1024),
    };

    const response = await agent
      .post('/api/v1/account/paranoid/disable')
      .set(...XRW)
      .send(body);
    // The runtime-sized parser accepted the body and strict contract validation
    // rejected it. The old hard-coded 16 MiB parser returned 413 before this.
    expect(response.status).toBe(400);
    expect(response.body.error.code).not.toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts exact Drive-only evidence and removes all BetterTrack vault bytes', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent, 1);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(envelope(2));
    expect(
      await harness.db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, user.id)),
    ).toHaveLength(1);

    const response = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({
        mediaSet: ['drive'],
        vaultVersion: 2,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 2 },
      });
    expect(response.status).toBe(200);
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, user.id)),
    ).toEqual([]);
    const [account] = await harness.db.select().from(users).where(eq(users.id, user.id));
    expect(account).toMatchObject({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['drive'],
      paranoidDriveAttestedVersion: 2,
    });

    const forbiddenWrite = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(3));
    expect(forbiddenWrite.status).toBe(403);
    expect(forbiddenWrite.body.error.code).toBe('PARANOID_MODE');
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, user.id)),
    ).toEqual([]);

    await harness.db.insert(paranoidVaultHistory).values({
      userId: user.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: 1,
      blob: Buffer.from([1]),
    });
    const inconsistentRetry = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({
        mediaSet: ['drive'],
        vaultVersion: 2,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 2 },
      });
    expect(inconsistentRetry.status).toBe(409);
    expect(inconsistentRetry.body.error.code).toBe('PARANOID_TRANSITION_CONFLICT');
  });

  it('rejects a server-vault write that was already waiting on a Drive-only enable', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const { enabling, locked, release } = startPausedDriveEnable(user.id);
    await locked;

    const writing = harness.ctx.paranoidVault
      .put({
        userId: user.id,
        expectedVersion: 1,
        blob: envelope(2),
      })
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    release.resolve();

    await expect(enabling).resolves.toMatchObject({ mode: 'paranoid' });
    expect((await writing).error).toMatchObject({ code: 'PARANOID_MODE' });
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, user.id)),
    ).toEqual([]);
  });

  it('keeps server-medium vault synchronization available after enable', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const enabled = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(enabled.status).toBe(200);

    const updated = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(envelope(2));
    expect(updated.status).toBe(204);
    expect(updated.headers.etag).toBe('"2"');
    expect(
      (
        await harness.db
          .select({ version: paranoidVaults.version })
          .from(paranoidVaults)
          .where(eq(paranoidVaults.userId, user.id))
      )[0],
    ).toEqual({ version: 2 });
  });

  it('revokes every outbound and inbound sharing edge while preserving kept account data', async () => {
    const { user, portfolio, agent } = await seedNormalAccount();
    const other = await harness.seedUser({
      email: 'friend@bettertrack.test',
      username: 'paranoid_friend',
    });
    await putServerVault(agent);
    await harness.db.update(users).set({ profilePublic: true }).where(eq(users.id, user.id));

    const [ownedAudience] = await harness.db
      .insert(shareAudiences)
      .values({
        ownerId: user.id,
        kind: 'portfolio',
        subjectId: portfolio.id,
        audience: 'specific_friends',
      })
      .returning();
    const [incomingAudience] = await harness.db
      .insert(shareAudiences)
      .values({
        ownerId: other.id,
        kind: 'watchlist',
        subjectId: '018f0000-0000-7000-8000-000000000101',
        audience: 'specific_friends',
      })
      .returning();
    await harness.db.insert(shareAudienceMembers).values([
      { audienceId: ownedAudience!.id, friendId: other.id },
      { audienceId: incomingAudience!.id, friendId: user.id },
    ]);
    await harness.db.insert(shareAudienceLinks).values({
      audienceId: ownedAudience!.id,
      tokenHash: 'owned-public-link-hash',
    });

    await harness.db.insert(userFollows).values([
      { followerId: user.id, followedId: other.id },
      { followerId: other.id, followedId: user.id },
    ]);
    await harness.db.insert(itemFollows).values([
      {
        userId: user.id,
        kind: 'watchlist',
        subjectId: incomingAudience!.subjectId,
      },
      { userId: other.id, kind: 'portfolio', subjectId: portfolio.id },
    ]);
    await harness.db.insert(sharedItemActivityPrefs).values([
      {
        viewerId: user.id,
        kind: 'watchlist',
        subjectId: incomingAudience!.subjectId,
      },
      { viewerId: other.id, kind: 'portfolio', subjectId: portfolio.id },
    ]);
    const [comment] = await harness.db
      .insert(itemComments)
      .values({
        kind: 'watchlist',
        subjectId: incomingAudience!.subjectId,
        authorId: user.id,
        body: 'remove me',
      })
      .returning();
    await harness.db.insert(itemReactions).values([
      {
        userId: user.id,
        targetType: 'item',
        kind: 'watchlist',
        subjectId: incomingAudience!.subjectId,
        emoji: '👍',
      },
      {
        userId: user.id,
        targetType: 'comment',
        commentId: comment!.id,
        emoji: '❤️',
      },
    ]);

    const [group] = await harness.db
      .insert(friendGroups)
      .values({ ownerId: other.id, name: 'Incoming group' })
      .returning();
    await harness.db.insert(friendGroupMembers).values({
      groupId: group!.id,
      memberId: user.id,
    });
    const [userA, userB] = [user.id, other.id].sort();
    await harness.db.insert(friendships).values({ userA: userA!, userB: userB! });
    await harness.db.insert(notifications).values({
      userId: user.id,
      type: 'friend.accepted',
      title: 'Kept',
      body: 'Byte-identical',
      payload: { marker: 'kept' },
    });
    const keptBefore = await harness.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id));

    const response = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(await harness.db.select().from(userFollows)).toEqual([]);
    expect(await harness.db.select().from(itemFollows)).toEqual([]);
    expect(await harness.db.select().from(sharedItemActivityPrefs)).toEqual([]);
    expect(
      await harness.db.select().from(itemComments).where(eq(itemComments.authorId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(itemReactions).where(eq(itemReactions.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(shareAudiences).where(eq(shareAudiences.ownerId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(shareAudienceMembers)
        .where(eq(shareAudienceMembers.friendId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(friendGroupMembers)
        .where(eq(friendGroupMembers.memberId, user.id)),
    ).toEqual([]);
    expect(await harness.db.select().from(shareAudienceLinks)).toEqual([]);
    expect(await harness.db.select().from(friendships)).toHaveLength(1);
    expect(
      await harness.db.select().from(notifications).where(eq(notifications.userId, user.id)),
    ).toEqual(keptBefore);
  });

  it('rejects malformed evidence before destructive work', async () => {
    const { user, agent } = await seedNormalAccount();
    const response = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({
        mediaSet: ['drive'],
        vaultVersion: 2,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 1 },
      });
    expect(response.status).toBe(400);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toHaveLength(1);
    expect((await harness.db.select().from(users).where(eq(users.id, user.id)))[0]).toMatchObject({
      privacyMode: 'normal',
    });
  });

  it('refuses every transition precondition before purging', async () => {
    const { user, portfolio, agent } = await seedNormalAccount();
    await putServerVault(agent);

    const [batch] = await harness.db
      .insert(importBatches)
      .values({
        ownerId: user.id,
        portfolioId: portfolio.id,
        brokerId: 'test',
        filename: 'pending.csv',
        status: 'pending',
      })
      .returning();
    const pendingImport = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(pendingImport.status).toBe(409);
    expect(pendingImport.body.error.code).toBe('PARANOID_IMPORT_IN_FLIGHT');
    await harness.db.delete(importBatches).where(eq(importBatches.id, batch!.id));

    const [exportJob] = await harness.db
      .insert(exportJobs)
      .values({ userId: user.id, status: 'pending' })
      .returning();
    const pendingExport = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(pendingExport.status).toBe(409);
    expect(pendingExport.body.error.code).toBe('PARANOID_EXPORT_IN_FLIGHT');
    await harness.db.delete(exportJobs).where(eq(exportJobs.id, exportJob!.id));

    await harness.db.insert(mirrorChains).values({
      id: CHAIN_ID,
      name: 'Group',
      createdBy: user.id,
      createdByUsername: user.username,
    });
    await harness.db.insert(mirrorChainMembers).values({
      id: MEMBER_ID,
      chainId: CHAIN_ID,
      userId: user.id,
      username: user.username,
      portfolioId: portfolio.id,
      role: 'owner',
      status: 'active',
    });
    const mirrorchain = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(mirrorchain.status).toBe(409);
    expect(mirrorchain.body.error.code).toBe('PARANOID_MIRRORCHAIN_ACTIVE');

    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toHaveLength(1);
    expect((await harness.db.select().from(users).where(eq(users.id, user.id)))[0]).toMatchObject({
      privacyMode: 'normal',
    });
  });

  it('serializes an already-claimed import apply before enable purges its writes', async () => {
    const { user, portfolio, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const [batch] = await harness.db
      .insert(importBatches)
      .values({
        ownerId: user.id,
        portfolioId: portfolio.id,
        brokerId: 'test',
        filename: 'applying.csv',
        status: 'pending',
      })
      .returning();
    await harness.db.insert(importRows).values({
      batchId: batch!.id,
      rowIndex: 1,
      raw: '2026-07-25,deposit,42',
      kind: 'deposit',
      flag: 'mapped',
      executedAt: new Date('2026-07-25T10:00:00.000Z'),
      amountEur: '42',
      currency: 'EUR',
      contentHash: 'applying-deposit',
    });

    const claimed = deferred();
    const releaseApply = deferred();
    importAfterApplyClaim = async (_userId, batchId) => {
      expect(batchId).toBe(batch!.id);
      const [row] = await harness.db
        .select({ status: importBatches.status })
        .from(importBatches)
        .where(eq(importBatches.id, batchId));
      expect(row?.status).toBe('applied');
      claimed.resolve();
      await releaseApply.promise;
    };

    const applying = harness.ctx.imports.applyBatch(user.id, batch!.id, {});
    await claimed.promise;
    const enabling = harness.ctx.paranoidTransitions.enable(user.id, {
      mediaSet: ['server'],
      vaultVersion: 1,
      driveAttestation: null,
    });
    releaseApply.resolve();

    const [applied, enabled] = await Promise.all([applying, enabling]);
    expect(applied.rows).toEqual([expect.objectContaining({ rowIndex: 1, result: 'applied' })]);
    expect(enabled.mode).toBe('paranoid');
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db.select().from(importBatches).where(eq(importBatches.ownerId, user.id)),
    ).toEqual([]);
  });

  it('serializes a failed export retry through mark-ready before enable retires it', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const [job] = await harness.db
      .insert(exportJobs)
      .values({ userId: user.id, status: 'failed', error: 'BUILD_FAILED' })
      .returning();
    const collected = deferred();
    const releaseBuild = deferred();
    exportAfterCollect = async (jobId) => {
      if (jobId !== job!.id) return;
      collected.resolve();
      await releaseBuild.promise;
    };

    const building = harness.ctx.dataExport.buildExport(job!.id);
    await collected.promise;
    const transition = createParanoidTransitionService({
      db: harness.db,
      rehydration: {} as ParanoidRehydrationService,
      audit: { record: vi.fn(async () => {}) } as unknown as AuditService,
    });
    const enabling = transition.enable(user.id, {
      mediaSet: ['server'],
      vaultVersion: 1,
      driveAttestation: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseBuild.resolve();

    await expect(building).resolves.toBeUndefined();
    await expect(enabling).resolves.toMatchObject({ mode: 'paranoid' });
    const [after] = await harness.db.select().from(exportJobs).where(eq(exportJobs.id, job!.id));
    expect(after).toMatchObject({
      status: 'failed',
      filePath: null,
      error: 'RETIRED_FOR_PARANOID_MODE',
    });
  });

  it('retires a ready normal-account cleartext export before enable can commit', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const { jobId, downloadToken } = exportRequestResponseSchema.parse(requested.body);
    const [before] = await harness.db.select().from(exportJobs).where(eq(exportJobs.id, jobId));
    expect(before).toMatchObject({ status: 'ready' });
    expect(before!.filePath).toBeTruthy();
    expect(existsSync(before!.filePath!)).toBe(true);

    const enabled = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: ['server'], vaultVersion: 1 });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

    expect(existsSync(before!.filePath!)).toBe(false);
    const [after] = await harness.db.select().from(exportJobs).where(eq(exportJobs.id, jobId));
    expect(after).toMatchObject({
      status: 'failed',
      filePath: null,
      fileSize: null,
      expiresAt: null,
      readyAt: null,
      error: 'RETIRED_FOR_PARANOID_MODE',
    });
    const download = await agent.get(
      `/api/v1/account/export/download?token=${encodeURIComponent(downloadToken)}`,
    );
    expect(download.status).toBe(404);
    expect(download.body.error.code).toBe('EXPORT_NOT_FOUND');
  });

  it('keeps the account normal when a cleartext export artifact cannot be retired', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    const { jobId } = exportRequestResponseSchema.parse(requested.body);
    const [before] = await harness.db.select().from(exportJobs).where(eq(exportJobs.id, jobId));
    expect(before).toMatchObject({ status: 'ready' });

    const transition = createParanoidTransitionService({
      db: harness.db,
      rehydration: {} as ParanoidRehydrationService,
      audit: { record: vi.fn(async () => {}) } as unknown as AuditService,
      prepareExportFile: vi.fn(async () => {
        throw new Error('injected unlink failure');
      }),
    });
    await expect(
      transition.enable(user.id, {
        mediaSet: ['server'],
        vaultVersion: 1,
        driveAttestation: null,
      }),
    ).rejects.toMatchObject({ code: 'TRANSITION_CONFLICT' });

    const [account] = await harness.db.select().from(users).where(eq(users.id, user.id));
    expect(account).toMatchObject({ privacyMode: 'normal' });
    expect((await harness.db.select().from(exportJobs).where(eq(exportJobs.id, jobId)))[0]).toEqual(
      before,
    );
    expect(existsSync(before!.filePath!)).toBe(true);
  });

  it.each(['locked', 'sharingRevoked', 'vaultPurged', 'modeEnabled'] as const)(
    'rolls every enable write back when the %s stage fails',
    async (failedStage) => {
      const { user, agent } = await seedNormalAccount();
      await putServerVault(agent);
      await harness.db.update(users).set({ profilePublic: true }).where(eq(users.id, user.id));
      const requested = await agent
        .post('/api/v1/account/export')
        .set(...XRW)
        .send({ password: user.password });
      const { jobId } = exportRequestResponseSchema.parse(requested.body);
      const [exportBefore] = await harness.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.id, jobId));
      expect(exportBefore).toMatchObject({ status: 'ready' });
      expect(existsSync(exportBefore!.filePath!)).toBe(true);

      const audit = { record: vi.fn(async () => {}) } as unknown as AuditService;
      const transition = createParanoidTransitionService({
        db: harness.db,
        rehydration: {} as ParanoidRehydrationService,
        audit,
        afterEnableStage(stage) {
          if (stage === failedStage) throw new Error(`injected ${failedStage} failure`);
        },
      });

      await expect(
        transition.enable(user.id, {
          mediaSet: ['server'],
          vaultVersion: 1,
          driveAttestation: null,
        }),
      ).rejects.toThrow(`injected ${failedStage} failure`);
      const [account] = await harness.db.select().from(users).where(eq(users.id, user.id));
      expect(account).toMatchObject({ privacyMode: 'normal', profilePublic: true });
      expect(
        await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
      ).toHaveLength(1);
      expect(
        await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
      ).toHaveLength(1);
      expect(
        (await harness.db.select().from(exportJobs).where(eq(exportJobs.id, jobId)))[0],
      ).toEqual(exportBefore);
      expect(existsSync(exportBefore!.filePath!)).toBe(true);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('serializes concurrent enables into one transition and one idempotent retry', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const transition = createParanoidTransitionService({
      db: harness.db,
      rehydration: {} as ParanoidRehydrationService,
      audit: { record: vi.fn(async () => {}) } as unknown as AuditService,
    });

    const results = await Promise.all([
      transition.enable(user.id, {
        mediaSet: ['server'],
        vaultVersion: 1,
        driveAttestation: null,
      }),
      transition.enable(user.id, {
        mediaSet: ['server'],
        vaultVersion: 1,
        driveAttestation: null,
      }),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
  });

  it('rejects a portfolio write that was waiting behind the enable lock', async () => {
    const { user, agent } = await seedNormalAccount();
    await putServerVault(agent);
    const locked = deferred();
    const releaseEnable = deferred();
    const transition = createParanoidTransitionService({
      db: harness.db,
      rehydration: {} as ParanoidRehydrationService,
      audit: { record: vi.fn(async () => {}) } as unknown as AuditService,
      async afterEnableStage(stage) {
        if (stage !== 'locked') return;
        locked.resolve();
        await releaseEnable.promise;
      },
    });

    const enabling = transition.enable(user.id, {
      mediaSet: ['server'],
      vaultVersion: 1,
      driveAttestation: null,
    });
    await locked.promise;
    const writeResult = harness.ctx.portfolio
      .createPortfolio(user.id, { name: 'Must not land' })
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    releaseEnable.resolve();

    await expect(enabling).resolves.toMatchObject({ mode: 'paranoid' });
    expect((await writeResult).error).toMatchObject({
      code: 'PARANOID_MODE',
    });
    expect(
      await harness.db.select().from(portfolios).where(eq(portfolios.userId, user.id)),
    ).toEqual([]);
  });

  it('holds affected target accounts across invite, comment, and public-profile writes', async () => {
    const mirrorActor = await harness.seedUser({
      email: 'mirror-actor@bettertrack.test',
      username: 'mirror_actor',
    });
    const mirrorTarget = await harness.seedUser({
      email: 'mirror-target@bettertrack.test',
      username: 'mirror_target',
    });
    const [mirrorUserA, mirrorUserB] = [mirrorActor.id, mirrorTarget.id].sort();
    await harness.db.insert(friendships).values({ userA: mirrorUserA!, userB: mirrorUserB! });
    const chain = await harness.ctx.mirror.createChain(mirrorActor.id, 'Target lock');
    await stageServerVault(mirrorTarget.id);

    const mirrorGate = pauseGuardedAction(mirrorTarget.id, 'mirrorchain');
    const inviting = harness.ctx.mirror.inviteMember(
      mirrorActor.id,
      chain.chainId,
      mirrorTarget.id,
    );
    await mirrorGate.entered;
    const mirrorEnable = startPausedDriveEnable(mirrorTarget.id);
    let mirrorEnableLocked = false;
    void mirrorEnable.locked.then(() => {
      mirrorEnableLocked = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mirrorEnableLocked).toBe(false);
    mirrorGate.release.resolve();
    await expect(inviting).resolves.toBeUndefined();
    await mirrorEnable.locked;
    mirrorEnable.release.resolve();
    await expect(mirrorEnable.enabling).resolves.toMatchObject({ mode: 'paranoid' });
    mirrorGate.restore();
    expect(
      await harness.db
        .select({ status: mirrorChainInvites.status })
        .from(mirrorChainInvites)
        .where(eq(mirrorChainInvites.toUser, mirrorTarget.id)),
    ).toEqual([{ status: 'revoked' }]);

    const commentOwner = await harness.seedUser({
      email: 'comment-owner@bettertrack.test',
      username: 'comment_owner',
    });
    const commenter = await harness.seedUser({
      email: 'commenter@bettertrack.test',
      username: 'commenter',
    });
    const [commentUserA, commentUserB] = [commentOwner.id, commenter.id].sort();
    await harness.db.insert(friendships).values({ userA: commentUserA!, userB: commentUserB! });
    const [sharedPortfolio] = await harness.db
      .insert(portfolios)
      .values({ userId: commentOwner.id, name: 'Shared before enable' })
      .returning();
    const [audience] = await harness.db
      .insert(shareAudiences)
      .values({
        ownerId: commentOwner.id,
        kind: 'portfolio',
        subjectId: sharedPortfolio!.id,
        audience: 'specific_friends',
      })
      .returning();
    await harness.db
      .insert(shareAudienceMembers)
      .values({ audienceId: audience!.id, friendId: commenter.id });
    await stageServerVault(commentOwner.id);

    const commentGate = pauseGuardedAction(commentOwner.id, 'sharing');
    const commenting = harness.ctx.comments.addComment(
      commenter.id,
      'portfolio',
      sharedPortfolio!.id,
      'Must finish before enable',
    );
    await commentGate.entered;
    const commentEnable = startPausedDriveEnable(commentOwner.id);
    let commentEnableLocked = false;
    void commentEnable.locked.then(() => {
      commentEnableLocked = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(commentEnableLocked).toBe(false);
    commentGate.release.resolve();
    await expect(commenting).resolves.toMatchObject({ body: 'Must finish before enable' });
    await commentEnable.locked;
    commentEnable.release.resolve();
    await expect(commentEnable.enabling).resolves.toMatchObject({ mode: 'paranoid' });
    commentGate.restore();
    expect(
      await harness.db
        .select()
        .from(itemComments)
        .where(eq(itemComments.subjectId, sharedPortfolio!.id)),
    ).toEqual([]);

    const profileTarget = await harness.seedUser({
      email: 'profile-target@bettertrack.test',
      username: 'profile_target',
    });
    await stageServerVault(profileTarget.id);
    const profileGate = pauseGuardedAction(profileTarget.id, 'publicProfile');
    const publishing = harness.ctx.social.updateProfileSettings(profileTarget.id, {
      isPublic: true,
      acknowledgePublic: true,
    });
    await profileGate.entered;
    const profileEnable = startPausedDriveEnable(profileTarget.id);
    let profileEnableLocked = false;
    void profileEnable.locked.then(() => {
      profileEnableLocked = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(profileEnableLocked).toBe(false);
    profileGate.release.resolve();
    await expect(publishing).resolves.toMatchObject({ isPublic: true });
    await profileEnable.locked;
    profileEnable.release.resolve();
    await expect(profileEnable.enabling).resolves.toMatchObject({ mode: 'paranoid' });
    profileGate.restore();
    expect(
      (
        await harness.db
          .select({ profilePublic: users.profilePublic })
          .from(users)
          .where(eq(users.id, profileTarget.id))
      )[0],
    ).toEqual({ profilePublic: false });
  });
});
