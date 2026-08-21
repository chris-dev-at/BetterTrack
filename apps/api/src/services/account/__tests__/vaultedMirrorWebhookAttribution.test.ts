import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../data/schema';
import { createMirrorchainRepository } from '../../../data/repositories/mirrorchainRepository';
import { createParanoidEnforcementRepository } from '../../../data/repositories/paranoidEnforcementRepository';
import type { MirrorNotificationEvent } from '../../../events';
import { bindParanoidJob, type JobDefinition } from '../../../jobs';
import type { WebhookDeliveryJob } from '../../webhooks';
import { createTestApp } from '../../../testing/createTestApp';
import {
  isVaultedPortfolioContentEventAllowed,
  type VaultedMirrorMemberPortfolioSubject,
  type VaultedPortfolioWebhookSubjects,
} from '../vaultedPortfolioEnforcement';

// Deterministic TEST VECTOR identities are public fixtures, never credentials
// or production vault material.
const VECTOR = {
  chainId: '019c86a0-0000-7000-8000-000000000001',
  recipientId: '019c86a0-0000-7000-8000-000000000002',
  actorId: '019c86a0-0000-7000-8000-000000000003',
  ownerId: '019c86a0-0000-7000-8000-000000000004',
  subjectId: '019c86a0-0000-7000-8000-000000000005',
  portfolioId: '019c86a0-0000-7000-8000-000000000006',
  vaultId: '019c86a0-0000-7000-8000-000000000007',
  formerVaultId: '019c86a0-0000-7000-8000-000000000008',
  formerHeaderDocId: '019c86a0-0000-7000-8000-000000000009',
  formerCommonDocId: '019c86a0-0000-7000-8000-00000000000a',
  memberVaultId: '019c86a0-0000-7000-8000-00000000000b',
  memberHeaderDocId: '019c86a0-0000-7000-8000-00000000000c',
  memberCommonDocId: '019c86a0-0000-7000-8000-00000000000d',
} as const;

const MIRROR_WEBHOOK_TYPES: readonly MirrorNotificationEvent['type'][] = [
  'mirror.invite',
  'mirror.member_joined',
  'mirror.member_left',
  'mirror.member_removed',
  'mirror.removed',
  'mirror.ownership_transferred',
  'mirror.chain_dissolved',
  'mirror.sync_stalled',
];

function mirrorEvent(
  type: MirrorNotificationEvent['type'],
  overrides: Partial<MirrorNotificationEvent> = {},
): MirrorNotificationEvent {
  return {
    type,
    userId: VECTOR.recipientId,
    chainId: VECTOR.chainId,
    chainName: 'TEST VECTOR mirror chain',
    actorId: VECTOR.actorId,
    ownerId: VECTOR.ownerId,
    subjectUserIds: [VECTOR.subjectId, VECTOR.ownerId],
    actorUsername: 'test_vector_actor',
    refId: `TEST-VECTOR:${type}`,
    occurredAt: '2026-08-21T10:00:00.000Z',
    ...overrides,
  };
}

const plainMemberPortfolio: VaultedMirrorMemberPortfolioSubject = {
  memberUserId: VECTOR.ownerId,
  memberPortfolioId: VECTOR.portfolioId,
  portfolio: { exists: true, userId: VECTOR.ownerId, vaultId: null },
};

function subjects(
  mirrorMemberPortfolios?: VaultedPortfolioWebhookSubjects['mirrorMemberPortfolios'],
): VaultedPortfolioWebhookSubjects {
  return {
    portfolioSubject: async () => ({ exists: false, userId: null, vaultId: null }),
    ...(mirrorMemberPortfolios ? { mirrorMemberPortfolios } : {}),
  };
}

describe('vaulted mirror webhook attribution', () => {
  it.each(MIRROR_WEBHOOK_TYPES)(
    'attributes %s to the exact deduplicated event-principal set',
    async (type) => {
      const resolve = vi.fn(async () => [plainMemberPortfolio]);

      await expect(
        isVaultedPortfolioContentEventAllowed(mirrorEvent(type), subjects(resolve)),
      ).resolves.toBe(true);
      expect(resolve).toHaveBeenCalledWith(VECTOR.chainId, [
        VECTOR.recipientId,
        VECTOR.actorId,
        VECTOR.ownerId,
        VECTOR.subjectId,
      ]);
    },
  );

  it.each([
    ['no matching member', []],
    ['half-detached member', [{ ...plainMemberPortfolio, memberPortfolioId: null }]],
    [
      'missing portfolio',
      [
        {
          ...plainMemberPortfolio,
          portfolio: { exists: false, userId: null, vaultId: null },
        },
      ],
    ],
    [
      'ownership mismatch',
      [
        {
          ...plainMemberPortfolio,
          portfolio: { exists: true, userId: VECTOR.subjectId, vaultId: null },
        },
      ],
    ],
    [
      'vaulted portfolio',
      [
        {
          ...plainMemberPortfolio,
          portfolio: { exists: true, userId: VECTOR.ownerId, vaultId: VECTOR.vaultId },
        },
      ],
    ],
  ] as const)('fails closed for a %s', async (_label, resolved) => {
    await expect(
      isVaultedPortfolioContentEventAllowed(
        mirrorEvent('mirror.sync_stalled'),
        subjects(async () => resolved),
      ),
    ).resolves.toBe(false);
  });

  it('fails closed when the mirror resolver is absent', async () => {
    await expect(
      isVaultedPortfolioContentEventAllowed(mirrorEvent('mirror.invite'), subjects()),
    ).resolves.toBe(false);
  });

  it('runs the queued-delivery recheck inside the existing principal lock', async () => {
    const delivered: WebhookDeliveryJob[] = [];
    let insidePrincipalLock = false;
    let vaulted = false;
    const definition = {
      name: 'webhooks.deliver',
      async handler(job) {
        delivered.push(job.data);
      },
    } as JobDefinition<'webhooks.deliver'>;
    const event = mirrorEvent('mirror.member_removed');
    const guarded = bindParanoidJob(definition, {
      mode: 'event',
      runIfAllowed: async (userIds, action) => {
        expect(userIds).toEqual([
          VECTOR.recipientId,
          VECTOR.actorId,
          VECTOR.ownerId,
          VECTOR.subjectId,
        ]);
        insidePrincipalLock = true;
        try {
          await action();
        } finally {
          insidePrincipalLock = false;
        }
        return true;
      },
      isEventAllowed: (candidate) =>
        isVaultedPortfolioContentEventAllowed(
          candidate,
          subjects(async () => {
            expect(insidePrincipalLock).toBe(true);
            return [
              vaulted
                ? {
                    ...plainMemberPortfolio,
                    portfolio: {
                      exists: true,
                      userId: VECTOR.ownerId,
                      vaultId: VECTOR.vaultId,
                    },
                  }
                : plainMemberPortfolio,
            ];
          }),
        ),
    });
    const job = (refId: string) =>
      ({
        data: {
          subscriptionId: 'TEST-VECTOR-subscription',
          deliveryId: `TEST-VECTOR-delivery:${refId}`,
          event: { ...event, refId },
        },
      }) as never;

    await guarded.handler(job('plain'), { logger: { info: vi.fn() } } as never);
    vaulted = true;
    await guarded.handler(job('vaulted'), { logger: { info: vi.fn() } } as never);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.event).toMatchObject({ refId: 'plain' });
  });

  it('delivers a plain current/stale membership but skips it after that relevant copy vaults', async () => {
    const delivered: Array<{ type: string; data: Record<string, unknown> }> = [];
    const h = await createTestApp({
      webhookTransport: {
        async send(request) {
          delivered.push(JSON.parse(request.body) as (typeof delivered)[number]);
          return { ok: true, status: 200 };
        },
      },
    });
    const owner = await h.seedUser({
      email: 'mirror-webhook-owner@bettertrack.test',
      username: 'mirror_webhook_owner',
    });
    const member = await h.seedUser({
      email: 'mirror-webhook-member@bettertrack.test',
      username: 'mirror_webhook_member',
    });
    const former = await h.seedUser({
      email: 'mirror-webhook-former@bettertrack.test',
      username: 'mirror_webhook_former',
    });
    const ownerPortfolioId = await h.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await h.ctx.mirror.convertToChain(owner.id, ownerPortfolioId, {
      name: 'TEST VECTOR mirror webhook chain',
    });
    const memberCopy = await h.ctx.mirror.attachMemberCopy(chain.id, member.id);
    const formerCopy = await h.ctx.mirror.attachMemberCopy(chain.id, former.id);
    const mirrorRepo = createMirrorchainRepository(h.db);
    const formerMembership = await mirrorRepo.findActiveMembership(chain.id, former.id);
    await mirrorRepo.endMembership(formerMembership!.id, 'left', new Date('2026-08-20T00:00:00Z'));

    await h.db.insert(schema.vaults).values({
      id: VECTOR.formerVaultId,
      userId: former.id,
      name: 'TEST VECTOR unrelated former-member vault',
      headerDocId: VECTOR.formerHeaderDocId,
      commonDocId: VECTOR.formerCommonDocId,
      media: ['server'],
      retirementProofPublicKey: 'TEST VECTOR former-member public verifier',
      keyFingerprint: 'TEST-VECTOR-MIRROR-WEBHOOK-FORMER',
    });
    await h.db
      .update(schema.portfolios)
      .set({ vaultId: VECTOR.formerVaultId, vaultAlias: 'TEST VECTOR unrelated locked fork' })
      .where(eq(schema.portfolios.id, formerCopy.portfolioId));

    await h.ctx.webhooks.create({
      userId: member.id,
      url: 'https://receiver.test/mirror-vault-attribution',
      eventTypes: ['mirror.sync_stalled', 'mirror.removed'],
    });
    const currentEvent = mirrorEvent('mirror.sync_stalled', {
      userId: member.id,
      chainId: chain.id,
      chainName: chain.name,
      actorId: member.id,
      ownerId: owner.id,
      subjectUserIds: [member.id],
      refId: 'TEST-VECTOR:current-plain',
    });
    const subjectsRepo = createParanoidEnforcementRepository(h.db);
    await expect(
      isVaultedPortfolioContentEventAllowed(
        currentEvent,
        subjects((chainId, principalUserIds) =>
          subjectsRepo.mirrorMemberPortfolios(chainId, principalUserIds),
        ),
      ),
    ).resolves.toBe(true);
    expect(await h.ctx.webhooks.list(member.id)).toHaveLength(1);
    await h.ctx.webhookBridge.handleEvent(currentEvent);

    const memberMembership = await mirrorRepo.findActiveMembership(chain.id, member.id);
    await mirrorRepo.endMembership(
      memberMembership!.id,
      'removed',
      new Date('2026-08-21T00:00:00Z'),
    );
    const removedEvent = mirrorEvent('mirror.removed', {
      userId: member.id,
      chainId: chain.id,
      chainName: chain.name,
      actorId: owner.id,
      ownerId: owner.id,
      subjectUserIds: [member.id],
      refId: 'TEST-VECTOR:stale-plain',
    });
    await h.ctx.webhookBridge.handleEvent(removedEvent);

    await h.db.insert(schema.vaults).values({
      id: VECTOR.memberVaultId,
      userId: member.id,
      name: 'TEST VECTOR relevant stale-member vault',
      headerDocId: VECTOR.memberHeaderDocId,
      commonDocId: VECTOR.memberCommonDocId,
      media: ['server'],
      retirementProofPublicKey: 'TEST VECTOR stale-member public verifier',
      keyFingerprint: 'TEST-VECTOR-MIRROR-WEBHOOK-MEMBER',
    });
    await h.db
      .update(schema.portfolios)
      .set({ vaultId: VECTOR.memberVaultId, vaultAlias: 'TEST VECTOR relevant locked fork' })
      .where(eq(schema.portfolios.id, memberCopy.portfolioId));
    await h.ctx.webhookBridge.handleEvent({
      ...removedEvent,
      refId: 'TEST-VECTOR:stale-vaulted',
    });

    expect(delivered.map(({ type }) => type)).toEqual(['mirror.sync_stalled', 'mirror.removed']);
    expect(delivered.map(({ data }) => data.refId)).toEqual([
      'TEST-VECTOR:current-plain',
      'TEST-VECTOR:stale-plain',
    ]);

    const resolved = await subjectsRepo.mirrorMemberPortfolios(chain.id, [member.id, owner.id]);
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberUserId: member.id,
          memberPortfolioId: memberCopy.portfolioId,
          portfolio: expect.objectContaining({ vaultId: VECTOR.memberVaultId }),
        }),
        expect.objectContaining({
          memberUserId: owner.id,
          memberPortfolioId: ownerPortfolioId,
          portfolio: expect.objectContaining({ vaultId: null }),
        }),
      ]),
    );
  });
});
