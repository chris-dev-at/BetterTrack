import { generateKeyPairSync } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  encodeVaultDocEnvelope,
  PER_VAULT_ERROR_CODES,
  PORTFOLIO_VAULT_TRANSITION_ERROR_CODES,
  VAULT_CONTENT_CIPHER,
  type VaultDocKind,
} from '@bettertrack/contracts';

import { newId } from '../data/ids';
import { portfolioVaultTransitionStates, portfolios, vaultBlobs, vaults } from '../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * #1610 — a vault deletion must never leave a portfolio's open capture bound to
 * a vault that no longer exists. Before the fix `DELETE /vaults/:id` checked
 * only member portfolios and the retirement gate, the FK-less
 * `portfolio_vault_transition_states.capture_vault_id` kept pointing at the
 * deleted row, and every later capture renewal (the first step of a move-in)
 * threw a plain Error: a permanent 500 for that portfolio.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;

// Deterministic TEST VECTORS: syntactically valid UUIDs/AEAD-header strings.
// They are public format fixtures, not credentials or production key material.
const KEY_ID = '018f0000-0000-7000-8000-000000161001';
const DEVICE_ID = '018f0000-0000-7000-8000-000000161002';
const ACCOUNT_BINDING = 'B'.repeat(43);
const FINGERPRINT = 'Abcdef0123456789';
const ATTESTED_AT = new Date('2026-10-01T12:00:00.000Z');
const LONG_EXPIRED_AT = new Date('2000-01-01T00:00:00.000Z');

type Agent = ReturnType<typeof request.agent>;

let h: TestHarness;

beforeEach(async () => {
  h = await createTestApp();
});

async function login(app: Application, user: SeededUser): Promise<Agent> {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password })
    .expect(200);
  return agent;
}

function proofPublicKey(): string {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64url');
}

function envelope(vaultId: string, docId: string, docKind: VaultDocKind, docVersion = 1): Buffer {
  return Buffer.from(
    encodeVaultDocEnvelope(
      {
        formatVersion: 2,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'AA',
        keyId: KEY_ID,
        keySlots: [{ keyId: KEY_ID, slot: 'seed-v1', wrappedKc: 'opaque-wrapped-kc' }],
        vaultId,
        docId,
        docKind,
        accountBinding: ACCOUNT_BINDING,
        docVersion,
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        writeId: newId(),
        writtenAt: '2026-10-01T12:00:00.000Z',
      },
      new Uint8Array([0, 255, 16, 10]),
    ),
  );
}

/** A server-medium vault whose full-set proof is current, so a capture may bind to it. */
async function createAttestedVault(agent: Agent, name: string) {
  const response = await agent
    .post('/api/v1/vaults')
    .set(...XRW)
    .send({
      name,
      headerDocId: newId(),
      commonDocId: newId(),
      media: ['server'],
      driveConnectionId: null,
      keyFingerprint: FINGERPRINT,
      retirementProofPublicKey: proofPublicKey(),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const vaultId = (response.body.vault as { id: string }).id;
  await h.db
    .update(vaults)
    .set({ mediaAttestedAt: ATTESTED_AT, mediaAttestedDriveConnectionId: null })
    .where(eq(vaults.id, vaultId));
  return vaultId;
}

async function createPortfolio(user: SeededUser, name: string): Promise<string> {
  const [row] = await h.db.insert(portfolios).values({ userId: user.id, name }).returning();
  if (!row) throw new Error('portfolio insert failed');
  return row.id;
}

/**
 * The first steps of the real move-in protocol: open the capture window
 * (revision read), hold a current full-set proof for the target vault (a
 * renewal withdraws it, so the client re-attests), and stage the prospective
 * portfolio document there, which binds `capture_vault_id` to the vault.
 */
async function stageMoveIn(agent: Agent, portfolioId: string, vaultId: string): Promise<void> {
  const revision = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
  expect(revision.status, JSON.stringify(revision.body)).toBe(200);
  await h.db
    .update(vaults)
    .set({ mediaAttestedAt: ATTESTED_AT, mediaAttestedDriveConnectionId: null })
    .where(eq(vaults.id, vaultId));
  const staged = await agent
    .put(`/api/v1/vaults/${vaultId}/docs/${portfolioId}`)
    .set(...XRW)
    .set(...OCTET)
    .set('If-None-Match', '*')
    .send(envelope(vaultId, portfolioId, 'portfolio'));
  expect(staged.status, JSON.stringify(staged.body)).toBe(204);
  expect(await captureOf(portfolioId)).toMatchObject({ captureVaultId: vaultId });
}

async function captureOf(portfolioId: string) {
  const [row] = await h.db
    .select()
    .from(portfolioVaultTransitionStates)
    .where(eq(portfolioVaultTransitionStates.portfolioId, portfolioId));
  return row ?? null;
}

async function expireCapture(portfolioId: string): Promise<void> {
  await h.db
    .update(portfolioVaultTransitionStates)
    .set({ captureExpiresAt: LONG_EXPIRED_AT })
    .where(eq(portfolioVaultTransitionStates.portfolioId, portfolioId));
}

function deleteVault(agent: Agent, user: SeededUser, vaultId: string) {
  return agent
    .delete(`/api/v1/vaults/${vaultId}`)
    .set(...XRW)
    .send({ stepUp: { password: user.password } });
}

async function vaultExists(vaultId: string): Promise<boolean> {
  const [row] = await h.db.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, vaultId));
  return row !== undefined;
}

async function prospectiveDoc(vaultId: string, portfolioId: string) {
  const [row] = await h.db
    .select()
    .from(vaultBlobs)
    .where(and(eq(vaultBlobs.vaultId, vaultId), eq(vaultBlobs.docId, portfolioId)));
  return row ?? null;
}

describe('#1610 vault deletion vs a portfolio capture bound to it', () => {
  it('refuses to delete a vault a live move-in is staging into, and the move continues', async () => {
    const user = await h.seedUser({ email: 'c1610-live@bt.test', username: 'c1610_live' });
    const agent = await login(h.app, user);
    const vaultId = await createAttestedVault(agent, 'Live capture vault');
    const portfolioId = await createPortfolio(user, 'Moving in');
    await createPortfolio(user, 'Keeps the account non-empty');
    await stageMoveIn(agent, portfolioId, vaultId);
    const bound = await captureOf(portfolioId);

    const refused = await deleteVault(agent, user, vaultId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe(PER_VAULT_ERROR_CODES.deleteMoveInPending);
    expect(refused.body.error.details).toEqual({ portfolioIds: [portfolioId] });
    // Fail-closed: nothing moved. The vault, its staged document and the
    // capture binding are exactly what the in-flight move-in left.
    expect(await vaultExists(vaultId)).toBe(true);
    expect(await prospectiveDoc(vaultId, portfolioId)).not.toBeNull();
    expect(await captureOf(portfolioId)).toEqual(bound);

    // The move can continue: the capture renews and re-stages into the vault.
    await stageMoveIn(agent, portfolioId, vaultId);
  });

  it('deletes a vault whose bound capture expired and drops the binding in the same commit', async () => {
    const user = await h.seedUser({ email: 'c1610-expired@bt.test', username: 'c1610_expired' });
    const agent = await login(h.app, user);
    const vaultId = await createAttestedVault(agent, 'Expired capture vault');
    const portfolioId = await createPortfolio(user, 'Abandoned move-in');
    await createPortfolio(user, 'Keeps the account non-empty');
    await stageMoveIn(agent, portfolioId, vaultId);
    await expireCapture(portfolioId);

    const deleted = await deleteVault(agent, user, vaultId);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await vaultExists(vaultId)).toBe(false);
    // No dangling pointer survives the delete.
    expect(await captureOf(portfolioId)).toMatchObject({
      captureVaultId: null,
      captureMediaAttestedAt: null,
      captureMediaAttestedDriveConnectionId: null,
    });

    // (a) the move-in can start over (this read was the permanent 500) …
    const reopened = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const otherVaultId = await createAttestedVault(agent, 'Second home');
    await stageMoveIn(agent, portfolioId, otherVaultId);
    // (b) … and the portfolio can still be deleted outright.
    await expireCapture(portfolioId);
    expect((await deleteVault(agent, user, otherVaultId)).status).toBe(200);
    const removed = await agent.delete(`/api/v1/portfolios/${portfolioId}`).set(...XRW);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
  });

  it('leaves a capture bound to a DIFFERENT vault untouched', async () => {
    const user = await h.seedUser({ email: 'c1610-sibling@bt.test', username: 'c1610_sibling' });
    const agent = await login(h.app, user);
    const deletedVaultId = await createAttestedVault(agent, 'Vault being deleted');
    const otherVaultId = await createAttestedVault(agent, 'Vault with a live move-in');
    const expiredPortfolioId = await createPortfolio(user, 'Expired into the deleted vault');
    const livePortfolioId = await createPortfolio(user, 'Live into the other vault');
    await stageMoveIn(agent, expiredPortfolioId, deletedVaultId);
    await expireCapture(expiredPortfolioId);
    await stageMoveIn(agent, livePortfolioId, otherVaultId);
    const otherBinding = await captureOf(livePortfolioId);
    const [otherVaultBefore] = await h.db.select().from(vaults).where(eq(vaults.id, otherVaultId));
    const otherDocBefore = await prospectiveDoc(otherVaultId, livePortfolioId);

    const deleted = await deleteVault(agent, user, deletedVaultId);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

    expect(await captureOf(expiredPortfolioId)).toMatchObject({ captureVaultId: null });
    expect(await captureOf(livePortfolioId)).toEqual(otherBinding);
    const [otherVaultAfter] = await h.db.select().from(vaults).where(eq(vaults.id, otherVaultId));
    expect(otherVaultAfter).toEqual(otherVaultBefore);
    expect(await prospectiveDoc(otherVaultId, livePortfolioId)).toEqual(otherDocBefore);
  });

  it('does not let another account’s binding to this vault block the delete or be rewritten', async () => {
    const owner = await h.seedUser({ email: 'c1610-owner@bt.test', username: 'c1610_owner' });
    const stranger = await h.seedUser({ email: 'c1610-other@bt.test', username: 'c1610_other' });
    const agent = await login(h.app, owner);
    const vaultId = await createAttestedVault(agent, 'Owner vault');
    const strangerPortfolioId = await createPortfolio(stranger, 'Stranger portfolio');
    // Not producible by any conforming writer (every binder is owner-scoped);
    // seeded to prove the owner's delete never reads or rewrites a foreign row.
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: strangerPortfolioId,
      userId: stranger.id,
      captureRevision: 'c1610-foreign-test-vector',
      captureExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      captureVaultId: vaultId,
      captureMediaAttestedAt: ATTESTED_AT,
    });
    const strangerRowBefore = await captureOf(strangerPortfolioId);

    const deleted = await deleteVault(agent, owner, vaultId);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await captureOf(strangerPortfolioId)).toEqual(strangerRowBefore);
  });

  it('re-opens a capture still bound to a vault deleted before this fix', async () => {
    const user = await h.seedUser({ email: 'c1610-legacy@bt.test', username: 'c1610_legacy' });
    const agent = await login(h.app, user);
    const portfolioId = await createPortfolio(user, 'Stranded by an old deletion');
    await createPortfolio(user, 'Keeps the account non-empty');
    // The exact row an old `DELETE /vaults/:id` left behind: a binding to a
    // vault id that no longer exists anywhere. Every vault-keyed row (blobs,
    // history, candidates, retirements) cascaded with that vault.
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId,
      userId: user.id,
      captureRevision: 'c1610-legacy-test-vector',
      captureExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      captureVaultId: newId(),
      captureMediaAttestedAt: ATTESTED_AT,
    });

    const reopened = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(await captureOf(portfolioId)).toMatchObject({
      captureVaultId: null,
      captureMediaAttestedAt: null,
    });
    const vaultId = await createAttestedVault(agent, 'Fresh vault');
    await stageMoveIn(agent, portfolioId, vaultId);
  });

  it('refuses a capture bound to a vault another account owns with a typed 409 and no mutation', async () => {
    const owner = await h.seedUser({ email: 'c1610-foreign@bt.test', username: 'c1610_foreign' });
    const stranger = await h.seedUser({ email: 'c1610-victim@bt.test', username: 'c1610_victim' });
    const strangerAgent = await login(h.app, stranger);
    const strangerVaultId = await createAttestedVault(strangerAgent, 'Stranger vault');
    const strangerPortfolioId = await createPortfolio(stranger, 'Stranger move-in');
    await createPortfolio(stranger, 'Keeps the stranger non-empty');
    await stageMoveIn(strangerAgent, strangerPortfolioId, strangerVaultId);
    const [strangerVaultBefore] = await h.db
      .select()
      .from(vaults)
      .where(eq(vaults.id, strangerVaultId));
    const strangerDocBefore = await prospectiveDoc(strangerVaultId, strangerPortfolioId);

    const agent = await login(h.app, owner);
    const portfolioId = await createPortfolio(owner, 'Tampered binding');
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId,
      userId: owner.id,
      captureRevision: 'c1610-tampered-test-vector',
      captureExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      captureVaultId: strangerVaultId,
      captureMediaAttestedAt: ATTESTED_AT,
    });
    const ownerRowBefore = await captureOf(portfolioId);

    const refused = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe(
      PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.captureBindingInvalid,
    );
    expect(await captureOf(portfolioId)).toEqual(ownerRowBefore);
    const [strangerVaultAfter] = await h.db
      .select()
      .from(vaults)
      .where(eq(vaults.id, strangerVaultId));
    expect(strangerVaultAfter).toEqual(strangerVaultBefore);
    expect(await prospectiveDoc(strangerVaultId, strangerPortfolioId)).toEqual(strangerDocBefore);
  });

  it('refuses to delete a portfolio whose move-in is still staged, then releases an expired one', async () => {
    const user = await h.seedUser({ email: 'c1610-pdelete@bt.test', username: 'c1610_pdelete' });
    const agent = await login(h.app, user);
    const vaultId = await createAttestedVault(agent, 'Staging vault');
    const portfolioId = await createPortfolio(user, 'Deleted mid-move');
    await createPortfolio(user, 'Keeps the account non-empty');
    await stageMoveIn(agent, portfolioId, vaultId);
    // The client re-attests the full set (now including the staged document)
    // before it would commit; a release must withdraw that proof again.
    await h.db
      .update(vaults)
      .set({ mediaAttestedAt: ATTESTED_AT, mediaAttestedDriveConnectionId: null })
      .where(eq(vaults.id, vaultId));

    // Before #1610 this was a 500: the staged row's NO ACTION portfolio FK
    // refused the bare DELETE at COMMIT.
    const refused = await agent.delete(`/api/v1/portfolios/${portfolioId}`).set(...XRW);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe(PER_VAULT_ERROR_CODES.deleteMoveInPending);
    expect(refused.body.error.details).toEqual({ portfolioIds: [portfolioId] });
    expect(await prospectiveDoc(vaultId, portfolioId)).not.toBeNull();
    const [stillThere] = await h.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));
    expect(stillThere).toBeDefined();

    await expireCapture(portfolioId);
    const removed = await agent.delete(`/api/v1/portfolios/${portfolioId}`).set(...XRW);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(await prospectiveDoc(vaultId, portfolioId)).toBeNull();
    expect(await captureOf(portfolioId)).toBeNull();
    const [vaultAfter] = await h.db.select().from(vaults).where(eq(vaults.id, vaultId));
    expect(vaultAfter).toMatchObject({
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
    });
  });
});
