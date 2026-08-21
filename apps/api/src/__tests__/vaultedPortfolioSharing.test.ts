import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

// Deterministic TEST VECTOR identifiers and verifier-shaped strings. They are
// public fixtures, not credentials or production retirement material.
const TEST_VECTOR = {
  vaultId: '019c8190-0000-7000-8000-000000000001',
  headerDocId: '019c8190-0000-7000-8000-000000000002',
  commonDocId: '019c8190-0000-7000-8000-000000000003',
  retirementProofPublicKey: 'TEST VECTOR sharing retirement public key',
  keyFingerprint: 'TEST-VECTOR-SHARING-0001',
} as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(response.status).toBe(200);
  return agent;
}

async function befriend(from: Agent, to: Agent, toUsername: string): Promise<void> {
  const sent = await from
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: toUsername });
  expect(sent.status).toBe(202);
  const inbox = await to.get('/api/v1/social/requests');
  const requestId = inbox.body.incoming[0]?.id as string;
  expect(requestId).toBeTruthy();
  const accepted = await to
    .post(`/api/v1/social/requests/${requestId}/accept`)
    .set(...XRW)
    .send();
  expect(accepted.status).toBe(200);
}

async function makePublic(agent: Agent, portfolioId: string): Promise<string> {
  const response = await agent
    .put(`/api/v1/social/audience/portfolio/${portfolioId}`)
    .set(...XRW)
    .send({
      audience: 'public_link',
      acknowledgePublic: true,
      confirmWiden: true,
    });
  expect(response.status).toBe(200);
  expect(response.body.link?.token).toEqual(expect.any(String));
  return response.body.link.token as string;
}

async function attachPortfolioToTestVault(userId: string, portfolioId: string): Promise<void> {
  await harness.db.insert(schema.vaults).values({
    id: TEST_VECTOR.vaultId,
    userId,
    name: 'TEST VECTOR sharing vault',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: ['server'],
    retirementProofPublicKey: TEST_VECTOR.retirementProofPublicKey,
    keyFingerprint: TEST_VECTOR.keyFingerprint,
  });
  await harness.db
    .update(schema.portfolios)
    .set({ vaultId: TEST_VECTOR.vaultId, vaultAlias: 'Locked sharing stub' })
    .where(eq(schema.portfolios.id, portfolioId));
}

describe('vaulted portfolio sharing exclusion (paranoid E2)', () => {
  it('hides only the locked stub from every aggregate/public read and leaves its plain sibling unchanged', async () => {
    const alice = await harness.seedUser({
      email: 'vault-sharing-alice@bettertrack.test',
      username: 'vault_sharing_alice',
    });
    const bob = await harness.seedUser({
      email: 'vault-sharing-bob@bettertrack.test',
      username: 'vault_sharing_bob',
    });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, bob.username);

    const initialPortfolios = await aliceAgent.get('/api/v1/portfolios');
    expect(initialPortfolios.status).toBe(200);
    const vaultedPortfolioId = initialPortfolios.body.portfolios.find(
      (portfolio: { isDefault: boolean }) => portfolio.isDefault,
    ).id as string;
    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Plain sibling' });
    expect(created.status).toBe(201);
    const plainPortfolioId = created.body.portfolio.id as string;

    const vaultedToken = await makePublic(aliceAgent, vaultedPortfolioId);
    const plainToken = await makePublic(aliceAgent, plainPortfolioId);
    const profileEnabled = await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });
    expect(profileEnabled.status).toBe(200);
    for (const subjectId of [vaultedPortfolioId, plainPortfolioId]) {
      const followed = await bobAgent
        .post('/api/v1/social/item-follows')
        .set(...XRW)
        .send({ kind: 'portfolio', subjectId });
      expect(followed.status).toBe(202);
    }

    // Capture the plain sibling before the other portfolio is attached to a
    // vault. These exact bytes must survive the same-account vault transition.
    const beforeMine = await aliceAgent.get('/api/v1/social/my-shared');
    const beforeShared = await bobAgent.get('/api/v1/social/shared');
    const beforeProfile = await request(harness.app).get(
      `/api/v1/social/profiles/${alice.username}`,
    );
    const beforeFollows = await bobAgent.get('/api/v1/social/item-follows');
    const beforePlainMine = beforeMine.body.portfolios.find(
      (portfolio: { portfolioId: string }) => portfolio.portfolioId === plainPortfolioId,
    );
    const beforePlainShared = beforeShared.body.portfolios.find(
      (portfolio: { portfolioId: string }) => portfolio.portfolioId === plainPortfolioId,
    );
    const beforePlainProfile = beforeProfile.body.portfolios.find(
      (portfolio: { portfolioId: string }) => portfolio.portfolioId === plainPortfolioId,
    );
    const beforePlainFollow = beforeFollows.body.items.find(
      (item: { subjectId: string }) => item.subjectId === plainPortfolioId,
    );

    await attachPortfolioToTestVault(alice.id, vaultedPortfolioId);

    const refusedAudience = await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${vaultedPortfolioId}`)
      .set(...XRW)
      .send({ audience: 'all_friends', confirmWiden: true });
    expect(refusedAudience.status).toBe(403);
    expect(refusedAudience.body.error.code).toBe('VAULTED_PORTFOLIO');
    const plainAudience = await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${plainPortfolioId}`)
      .set(...XRW)
      .send({ audience: 'public_link', acknowledgePublic: true, confirmWiden: true });
    expect(plainAudience.status).toBe(200);

    const mine = await aliceAgent.get('/api/v1/social/my-shared');
    expect(mine.status).toBe(200);
    expect(mine.body.portfolios).toEqual([beforePlainMine]);

    const shared = await bobAgent.get('/api/v1/social/shared');
    expect(shared.status).toBe(200);
    expect(shared.body.portfolios).toEqual([beforePlainShared]);
    expect((await bobAgent.get(`/api/v1/social/shared/${vaultedPortfolioId}`)).status).toBe(404);
    expect((await bobAgent.get(`/api/v1/social/shared/${plainPortfolioId}`)).status).toBe(200);

    const profile = await request(harness.app).get(`/api/v1/social/profiles/${alice.username}`);
    expect(profile.status).toBe(200);
    expect(profile.body.portfolios).toEqual([beforePlainProfile]);
    expect(
      (
        await request(harness.app).get(
          `/api/v1/social/profiles/${alice.username}/portfolio/${vaultedPortfolioId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app).get(
          `/api/v1/social/profiles/${alice.username}/portfolio/${plainPortfolioId}`,
        )
      ).status,
    ).toBe(200);

    expect((await request(harness.app).get(`/api/v1/social/links/${vaultedToken}`)).status).toBe(
      404,
    );
    expect((await request(harness.app).get(`/api/v1/social/links/${plainToken}`)).status).toBe(200);

    const followed = await bobAgent.get('/api/v1/social/item-follows');
    expect(followed.status).toBe(200);
    expect(followed.body.items).toEqual([beforePlainFollow]);
  });

  it('refuses vaulted portfolio threads and new chat shares while omitting stale chip references', async () => {
    const alice = await harness.seedUser({
      email: 'vault-social-boundary-alice@bettertrack.test',
      username: 'vault_social_boundary_alice',
    });
    const bob = await harness.seedUser({
      email: 'vault-social-boundary-bob@bettertrack.test',
      username: 'vault_social_boundary_bob',
    });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, bob.username);

    const portfolioList = await aliceAgent.get('/api/v1/portfolios');
    const vaultedPortfolioId = portfolioList.body.portfolios.find(
      (portfolio: { isDefault: boolean }) => portfolio.isDefault,
    ).id as string;
    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Plain social sibling' });
    expect(created.status).toBe(201);
    const plainPortfolioId = created.body.portfolio.id as string;
    await makePublic(aliceAgent, vaultedPortfolioId);
    await makePublic(aliceAgent, plainPortfolioId);

    const ownerComment = await aliceAgent
      .post(`/api/v1/social/items/portfolio/${vaultedPortfolioId}/comments`)
      .set(...XRW)
      .send({ body: 'TEST VECTOR owner comment' });
    expect(ownerComment.status).toBe(201);
    const friendComment = await bobAgent
      .post(`/api/v1/social/items/portfolio/${vaultedPortfolioId}/comments`)
      .set(...XRW)
      .send({ body: 'TEST VECTOR friend comment' });
    expect(friendComment.status).toBe(201);

    const opened = await aliceAgent
      .post('/api/v1/chat/conversations')
      .set(...XRW)
      .send({ userId: bob.id });
    expect(opened.status).toBe(201);
    const conversationId = opened.body.conversation.id as string;
    const plainChipMessage = await aliceAgent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ chip: { kind: 'portfolio', subjectId: plainPortfolioId } });
    expect(plainChipMessage.status).toBe(201);
    const vaultedChipMessage = await aliceAgent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ chip: { kind: 'portfolio', subjectId: vaultedPortfolioId } });
    expect(vaultedChipMessage.status).toBe(201);
    const beforeThread = await bobAgent.get(
      `/api/v1/chat/conversations/${conversationId}/messages`,
    );
    const beforePlainMessage = beforeThread.body.messages.find(
      (message: { id: string }) => message.id === plainChipMessage.body.message.id,
    );

    await attachPortfolioToTestVault(alice.id, vaultedPortfolioId);

    const ownerThreadOperations: Array<() => Promise<unknown>> = [
      () => harness.ctx.comments.getThread(alice.id, 'portfolio', vaultedPortfolioId),
      () =>
        harness.ctx.comments.addComment(
          alice.id,
          'portfolio',
          vaultedPortfolioId,
          'must not persist',
        ),
      () =>
        harness.ctx.comments.toggleItemReaction(alice.id, 'portfolio', vaultedPortfolioId, '🔥'),
      () => harness.ctx.comments.toggleCommentReaction(alice.id, ownerComment.body.id, '👍'),
      () => harness.ctx.comments.deleteComment(alice.id, ownerComment.body.id),
    ];
    for (const operation of ownerThreadOperations) {
      await expect(operation()).rejects.toMatchObject({ code: 'VAULTED_PORTFOLIO' });
    }
    await expect(
      harness.ctx.comments.getThread(bob.id, 'portfolio', vaultedPortfolioId),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(
      harness.ctx.comments.deleteComment(bob.id, friendComment.body.id),
    ).rejects.toMatchObject({ statusCode: 404, code: 'COMMENT_NOT_FOUND' });

    const plainComment = await aliceAgent
      .post(`/api/v1/social/items/portfolio/${plainPortfolioId}/comments`)
      .set(...XRW)
      .send({ body: 'Plain sibling still comments' });
    expect(plainComment.status).toBe(201);

    const afterThread = await bobAgent.get(`/api/v1/chat/conversations/${conversationId}/messages`);
    expect(afterThread.status).toBe(200);
    const hiddenVaultedMessage = afterThread.body.messages.find(
      (message: { id: string }) => message.id === vaultedChipMessage.body.message.id,
    );
    const unchangedPlainMessage = afterThread.body.messages.find(
      (message: { id: string }) => message.id === plainChipMessage.body.message.id,
    );
    expect(hiddenVaultedMessage.chip).toBeNull();
    expect(unchangedPlainMessage).toEqual(beforePlainMessage);

    const conversationList = await bobAgent.get('/api/v1/chat/conversations');
    expect(conversationList.status).toBe(200);
    expect(
      conversationList.body.conversations.find(
        (conversation: { id: string }) => conversation.id === conversationId,
      ).lastMessage.chipKind,
    ).toBeNull();

    const ownerThread = await aliceAgent.get(
      `/api/v1/chat/conversations/${conversationId}/messages`,
    );
    expect(
      ownerThread.body.messages.find(
        (message: { id: string }) => message.id === vaultedChipMessage.body.message.id,
      ).chip,
    ).toBeNull();

    const refusedChip = await aliceAgent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ chip: { kind: 'portfolio', subjectId: vaultedPortfolioId } });
    expect(refusedChip.status).toBe(403);
    expect(refusedChip.body.error.code).toBe('VAULTED_PORTFOLIO');

    const plainChip = await aliceAgent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ chip: { kind: 'portfolio', subjectId: plainPortfolioId } });
    expect(plainChip.status).toBe(201);
    expect(plainChip.body.message.chip).toMatchObject({
      kind: 'portfolio',
      subjectId: plainPortfolioId,
      viewable: true,
    });
  });
});
