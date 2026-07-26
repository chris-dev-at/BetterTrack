import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeVaultEnvelope,
  paranoidDisableResponseSchema,
  paranoidEnableResponseSchema,
  VAULT_CONTENT_CIPHER,
} from '@bettertrack/contracts';

import {
  assets,
  exportJobs,
  friendGroupMembers,
  friendGroups,
  friendships,
  importBatches,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
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
} from '../data/schema';
import type { ParanoidRehydrationService } from '../services/account/paranoidRehydrationService';
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

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
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

  it.each(['locked', 'sharingRevoked', 'vaultPurged', 'modeEnabled'] as const)(
    'rolls every enable write back when the %s stage fails',
    async (failedStage) => {
      const { user, agent } = await seedNormalAccount();
      await putServerVault(agent);
      await harness.db.update(users).set({ profilePublic: true }).where(eq(users.id, user.id));

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
});
