import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';
import type { Application } from 'express';
import postgres from 'postgres';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  encodeVaultDocEnvelope,
  encodeVaultEnvelope,
  readVaultDocServerHeader,
  PER_VAULT_ERROR_CODES,
  serializePerVaultRetiredServerPurgeTranscript,
  serializeVaultRetirementVersionSet,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  VAULT_CONTENT_CIPHER,
  type PerVaultMediaDocAttestation,
  type PerVaultMediaTransitionRequest,
  type PerVaultServerCandidateReadback,
  type VaultDocKind,
} from '@bettertrack/contracts';

import { newId } from '../data/ids';
import { createPortfolioVaultTransitionTransactionRepository } from '../data/repositories/portfolioVaultTransitionRepository';
import { createVaultBlobRepository } from '../data/repositories/vaultBlobRepository';
import { createVaultRepository } from '../data/repositories/vaultRepository';
import type { Database } from '../data/db';
import {
  auditLog,
  driveConnections,
  portfolioVaultTransitionStates,
  portfolios,
  vaultBlobs,
  vaultBlobHistory,
  vaultRetired,
  vaultRetirements,
  vaultServerCandidates,
  vaults,
} from '../data/schema';
import { generateTotpCode, TOTP_STEP_SECONDS } from '../services/auth/totp';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;
const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Deterministic TEST VECTORS: syntactically valid UUIDs/AEAD-header strings.
// They are public format fixtures, not credentials or production key material.
const HEADER_DOC_ID = '018f0000-0000-7000-8000-000000000101';
const COMMON_DOC_ID = '018f0000-0000-7000-8000-000000000102';
const DEVICE_ID = '018f0000-0000-7000-8000-000000000103';
const KEY_ID = '018f0000-0000-7000-8000-000000000104';
const TRANSITION_ID = '018f0000-0000-7000-8000-000000000105';
const UNKNOWN_DOC_ID = '018f0000-0000-7000-8000-000000000109';
const WRITE_IDS = [
  '018f0000-0000-7000-8000-000000000111',
  '018f0000-0000-7000-8000-000000000112',
  '018f0000-0000-7000-8000-000000000113',
  '018f0000-0000-7000-8000-000000000114',
] as const;
const ACCOUNT_BINDING = 'A'.repeat(43);
const FINGERPRINT = 'Abcdef0123456789';
const CAPTURE_REVISION = 'prospective-capture-revision-test-vector';
const CAPTURE_ATTESTED_AT = new Date('2026-08-20T12:00:00.000Z');
const CAPTURE_EXPIRES_AT = new Date('2099-08-20T12:00:00.000Z');
const CAPTURE_EXPIRED_AT = new Date('2000-08-20T12:00:00.000Z');

type Agent = ReturnType<typeof request.agent>;

let h: TestHarness;

beforeEach(async () => {
  h = await createTestApp();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface DatabaseLockWait {
  pid: number;
  query: string;
  waitEvent: string | null;
}

async function waitForVaultRowLockWaiters(
  observer: ReturnType<typeof postgres>,
  minimum: number,
): Promise<DatabaseLockWait[]> {
  const deadline = Date.now() + 4_000;
  let observed: DatabaseLockWait[] = [];
  while (Date.now() < deadline) {
    observed = await observer<DatabaseLockWait[]>`
      SELECT pid, query, wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const vaultWaiters = observed.filter(
      (row) => /from\s+"?vaults"?/iu.test(row.query) && /for update/iu.test(row.query),
    );
    if (new Set(vaultWaiters.map(({ pid }) => pid)).size >= minimum) return vaultWaiters;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${minimum} vault row-lock waiters; observed ${JSON.stringify(
      observed.map(({ pid, query, waitEvent }) => ({ pid, query, waitEvent })),
    )}`,
  );
}

async function login(app: Application, user: SeededUser): Promise<Agent> {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password })
    .expect(200);
  return agent;
}

async function enrollTotp(agent: Agent) {
  const { secret } = twoFactorEnrollResponseSchema.parse(
    (await agent.post('/api/v1/auth/2fa/enroll').set(...XRW)).body,
  );
  const confirmed = await agent
    .post('/api/v1/auth/2fa/confirm')
    .set(...XRW)
    .send({ code: generateTotpCode(secret) });
  const { recoveryCodes } = twoFactorMethodEnabledResponseSchema.parse(confirmed.body);
  return { secret, recoveryCodes: recoveryCodes! };
}

async function loginWithTotp(user: SeededUser, secret: string): Promise<Agent> {
  const agent = request.agent(h.app);
  const pending = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  await agent
    .post('/api/v1/auth/2fa/verify')
    .set(...XRW)
    .send({ pendingToken: pending.body.pendingToken, code: generateTotpCode(secret) })
    .expect(200);
  return agent;
}

function proofKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

function expiredPurgeChallenge(
  secret: string,
  payload: {
    userId: string;
    vaultId: string;
    generation: number;
    versionSetHash: string;
  },
): string {
  // Deterministic TEST VECTOR payload for the production HMAC envelope. It is
  // deliberately expired and carries no credential or production secret.
  const purpose = 'per-vault-retired-purge';
  const encoded = Buffer.from(
    JSON.stringify({ purpose, ...payload, expiresAt: 1, nonce: 'expired-test-vector' }),
  ).toString('base64url');
  const mac = createHmac('sha256', secret).update(`${purpose}.${encoded}`).digest('base64url');
  return `${encoded}.${mac}`;
}

function envelope(input: {
  vaultId: string;
  docId: string;
  docKind: VaultDocKind;
  docVersion: number;
  writeId?: string;
  ciphertext?: Uint8Array;
}): Buffer {
  return Buffer.from(
    encodeVaultDocEnvelope(
      {
        formatVersion: 2,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'AA',
        keyId: KEY_ID,
        keySlots: [{ keyId: KEY_ID, slot: 'seed-v1', wrappedKc: 'opaque-wrapped-kc' }],
        vaultId: input.vaultId,
        docId: input.docId,
        docKind: input.docKind,
        accountBinding: ACCOUNT_BINDING,
        docVersion: input.docVersion,
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        writeId: input.writeId ?? WRITE_IDS[input.docVersion - 1] ?? newId(),
        writtenAt: '2026-08-20T12:00:00.000Z',
      },
      // Deliberately not JSON or ciphertext with a recognizable structure. The
      // server must round-trip these payload bytes without attempting to parse.
      input.ciphertext ?? new Uint8Array([0, 255, 19, 7, 222, 1]),
    ),
  );
}

function envelopeAtSize(
  targetBytes: number,
  input: Omit<Parameters<typeof envelope>[0], 'ciphertext'>,
): Buffer {
  const base = envelope({ ...input, ciphertext: new Uint8Array() });
  if (base.length > targetBytes) throw new Error('test cap is smaller than the envelope header');
  return envelope({ ...input, ciphertext: new Uint8Array(targetBytes - base.length) });
}

async function createVault(input: {
  user: SeededUser;
  agent: Agent;
  media?: ('server' | 'drive')[];
  driveConnectionId?: string | null;
  headerDocId?: string;
  commonDocId?: string;
  name?: string;
  publicKey?: string;
}) {
  const media = input.media ?? ['server'];
  const key = input.publicKey ?? proofKeys().publicKey;
  const response = await input.agent
    .post('/api/v1/vaults')
    .set(...XRW)
    .send({
      name: input.name ?? 'Primary vault',
      headerDocId: input.headerDocId ?? HEADER_DOC_ID,
      commonDocId: input.commonDocId ?? COMMON_DOC_ID,
      media,
      driveConnectionId: input.driveConnectionId ?? null,
      keyFingerprint: FINGERPRINT,
      retirementProofPublicKey: key,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.vault as {
    id: string;
    headerDocId: string;
    commonDocId: string;
    mediaAttestedAt: string | null;
  };
}

async function putDoc(
  agent: Agent,
  vaultId: string,
  docId: string,
  blob: Buffer,
  precondition: { create?: true; version?: number },
) {
  let call = agent
    .put(`/api/v1/vaults/${vaultId}/docs/${docId}`)
    .set(...XRW)
    .set(...OCTET);
  call = precondition.create
    ? call.set('If-None-Match', '*')
    : call.set('If-Match', `"${precondition.version}"`);
  return call.send(blob);
}

describe('E1 vault config CRUD', () => {
  it('lists, reads, renames, and returns stable config/Drive/local refusals', async () => {
    const user = await h.seedUser({ email: 'e1-config@bt.test', username: 'e1_config' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent, name: 'Config alpha' });

    const list = await agent.get('/api/v1/vaults');
    expect(list.status).toBe(200);
    expect(list.body.vaults.map((item: { id: string }) => item.id)).toEqual([vault.id]);
    const read = await agent.get(`/api/v1/vaults/${vault.id}`);
    expect(read.status).toBe(200);
    expect(read.body.vault.name).toBe('Config alpha');
    const renamed = await agent
      .patch(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ name: 'Config beta' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.vault.name).toBe('Config beta');

    const duplicate = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({
        name: 'Config beta',
        headerDocId: newId(),
        commonDocId: newId(),
        media: ['server'],
        driveConnectionId: null,
        keyFingerprint: FINGERPRINT,
        retirementProofPublicKey: proofKeys().publicKey,
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('VAULT_NAME_CONFLICT');

    const local = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({
        name: 'Reserved local',
        headerDocId: newId(),
        commonDocId: newId(),
        media: ['local'],
        driveConnectionId: null,
        keyFingerprint: FINGERPRINT,
        retirementProofPublicKey: proofKeys().publicKey,
      });
    expect(local.status).toBe(400);
    expect(local.body.error.code).toBe('VAULT_MEDIA_RESERVED');

    const missingDrive = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({
        name: 'Missing Drive',
        headerDocId: newId(),
        commonDocId: newId(),
        media: ['drive'],
        driveConnectionId: newId(),
        keyFingerprint: FINGERPRINT,
        retirementProofPublicKey: proofKeys().publicKey,
      });
    expect(missingDrive.status).toBe(409);
    expect(missingDrive.body.error.code).toBe('VAULT_DRIVE_BINDING_INVALID');
  });

  it('refuses singleton ids colliding with an owned portfolio before they can create a permanent partial set', async () => {
    const user = await h.seedUser({
      email: 'e1-config-owned-id@bt.test',
      username: 'e1_config_owned_id',
    });
    const agent = await login(h.app, user);
    const [ownedPortfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Owned singleton-collision probe' })
      .returning();
    if (!ownedPortfolio) throw new Error('portfolio insert failed');

    for (const field of ['headerDocId', 'commonDocId'] as const) {
      const singletonIds = { headerDocId: newId(), commonDocId: newId() };
      singletonIds[field] = ownedPortfolio.id;
      const rejected = await agent
        .post('/api/v1/vaults')
        .set(...XRW)
        .send({
          name: `Owned UUID collision ${field}`,
          ...singletonIds,
          media: ['server'],
          driveConnectionId: null,
          keyFingerprint: FINGERPRINT,
          retirementProofPublicKey: proofKeys().publicKey,
        });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe('VAULT_PORTFOLIO_BINDING_MISMATCH');
    }

    const [stored] = await h.db
      .select({ value: count() })
      .from(vaults)
      .where(eq(vaults.userId, user.id));
    expect(Number(stored?.value ?? 0)).toBe(0);
  });
});

describe('E1 per-vault blind document CAS', () => {
  it('creates, replays idempotently, conflicts without mutation, and exposes bounded history', async () => {
    const user = await h.seedUser({ email: 'e1-cas@bt.test', username: 'e1_cas' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const v1 = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
    });

    const created = await putDoc(agent, vault.id, vault.headerDocId, v1, { create: true });
    expect(created.status).toBe(204);
    expect(created.headers.etag).toBe('"1"');

    const replay = await putDoc(agent, vault.id, vault.headerDocId, v1, { create: true });
    expect(replay.status).toBe(204);
    expect(replay.headers.etag).toBe('"1"');

    const read = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    expect(Buffer.from(read.body as Buffer)).toEqual(v1);

    const v2 = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 2,
    });
    expect((await putDoc(agent, vault.id, vault.headerDocId, v2, { version: 1 })).status).toBe(204);

    const stale = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 3,
    });
    const rejected = await putDoc(agent, vault.id, vault.headerDocId, stale, { version: 1 });
    expect(rejected.status).toBe(412);
    expect(rejected.body.currentVersion).toBe(2);
    expect(rejected.body.error.code).toBe('VAULT_PRECONDITION_FAILED');
    const currentAfterConflict = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(currentAfterConflict.status).toBe(200);
    expect(currentAfterConflict.headers.etag).toBe('"2"');
    expect(Buffer.from(currentAfterConflict.body as Buffer)).toEqual(v2);

    const history = await agent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`);
    expect(history.status).toBe(200);
    expect(history.body.items.map((item: { version: number }) => item.version)).toEqual([1]);
    const historical = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history/1`)
      .responseType('blob');
    expect(historical.status).toBe(200);
    expect(Buffer.from(historical.body as Buffer)).toEqual(v1);

    // Replay did not create an extra archive row.
    const [historyCount] = await h.db.select({ value: count() }).from(vaultBlobHistory);
    expect(Number(historyCount?.value ?? 0)).toBe(1);
  });

  it('keeps a retained writeId replay idempotent after the document advances', async () => {
    const user = await h.seedUser({
      email: 'e1-replay-cycle@bt.test',
      username: 'e1_replay_cycle',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const initial = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: newId(),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, initial, { create: true })).status,
    ).toBe(204);

    const replayWriteId = newId();
    const replayedWrite = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 2,
      writeId: replayWriteId,
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, replayedWrite, { version: 1 })).status,
    ).toBe(204);

    const advanced = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 3,
      writeId: newId(),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, advanced, { version: 2 })).status,
    ).toBe(204);
    const [beforeReplay] = await h.db.select({ value: count() }).from(vaultBlobHistory);

    // Even with a currently-satisfied If-Match, the retained
    // (vaultId, docId, writeId) receipt makes this a no-op, not a second write.
    const replay = await putDoc(agent, vault.id, vault.headerDocId, replayedWrite, { version: 3 });
    expect(replay.status).toBe(204);
    expect(replay.headers.etag).toBe('"3"');
    const current = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(Buffer.from(current.body as Buffer)).toEqual(advanced);
    const [afterReplay] = await h.db.select({ value: count() }).from(vaultBlobHistory);
    expect(Number(afterReplay?.value ?? 0)).toBe(Number(beforeReplay?.value ?? 0));
  });

  it('enforces R1 and URL/header addressing without inserting a row', async () => {
    const user = await h.seedUser({ email: 'e1-r1@bt.test', username: 'e1_r1' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const [unboundPortfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Unbound R1 stub' })
      .returning();
    if (!unboundPortfolio) throw new Error('portfolio insert failed');
    const unrelatedPortfolioId = unboundPortfolio.id;
    const mismatched = envelope({
      vaultId: vault.id,
      docId: unrelatedPortfolioId,
      docKind: 'portfolio',
      docVersion: 1,
    });
    const response = await putDoc(agent, vault.id, unrelatedPortfolioId, mismatched, {
      create: true,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('VAULT_PORTFOLIO_BINDING_MISMATCH');

    const otherVault = await createVault({
      user,
      agent,
      name: 'Other membership',
      headerDocId: newId(),
      commonDocId: newId(),
    });
    const [otherMember] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Other vault stub', vaultId: otherVault.id })
      .returning();
    if (!otherMember) throw new Error('portfolio insert failed');
    const wrongVaultMember = envelope({
      vaultId: vault.id,
      docId: otherMember.id,
      docKind: 'portfolio',
      docVersion: 1,
    });
    const wrongVaultResponse = await putDoc(agent, vault.id, otherMember.id, wrongVaultMember, {
      create: true,
    });
    expect(wrongVaultResponse.status).toBe(409);
    expect(wrongVaultResponse.body.error.code).toBe('VAULT_PORTFOLIO_BINDING_MISMATCH');

    const wrongAddress = envelope({
      vaultId: newId(),
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
    });
    const addressResponse = await putDoc(agent, vault.id, vault.headerDocId, wrongAddress, {
      create: true,
    });
    expect(addressResponse.status).toBe(400);
    expect(addressResponse.body.error.code).toBe('VAULT_DOC_ADDRESS_MISMATCH');

    const [stored] = await h.db.select({ value: count() }).from(vaultBlobs);
    expect(Number(stored?.value ?? 0)).toBe(0);
  });

  it('binds a live captured normal portfolio on successful CAS and gates all blob reads by the capture window', async () => {
    const user = await h.seedUser({
      email: 'e1-prospective-cas@bt.test',
      username: 'e1_prospective_cas',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    await h.db
      .update(vaults)
      .set({
        mediaAttestedAt: CAPTURE_ATTESTED_AT,
        mediaAttestedDriveConnectionId: null,
      })
      .where(eq(vaults.id, vault.id));
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Prospective CAS portfolio' })
      .returning();
    if (!portfolio) throw new Error('portfolio insert failed');
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: portfolio.id,
      userId: user.id,
      captureRevision: CAPTURE_REVISION,
      captureExpiresAt: CAPTURE_EXPIRES_AT,
    });

    const repository = createVaultBlobRepository(h.db);
    const firstBlob = envelope({
      vaultId: vault.id,
      docId: portfolio.id,
      docKind: 'portfolio',
      docVersion: 1,
      writeId: WRITE_IDS[0],
    });
    const first = await repository.compareAndSwap({
      userId: user.id,
      vaultId: vault.id,
      docId: portfolio.id,
      header: readVaultDocServerHeader(firstBlob),
      expectedVersion: null,
      blob: firstBlob,
      retention: { maxVersions: 10, maxAgeMs: 30 * 24 * 60 * 60 * 1_000 },
      now: CAPTURE_ATTESTED_AT,
    });
    expect(first.status).toBe('ok');

    const [boundCapture] = await h.db
      .select()
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, portfolio.id));
    expect(boundCapture).toMatchObject({
      captureVaultId: vault.id,
      captureMediaAttestedAt: CAPTURE_ATTESTED_AT,
      captureMediaAttestedDriveConnectionId: null,
    });
    const [writtenVault] = await h.db.select().from(vaults).where(eq(vaults.id, vault.id));
    expect(writtenVault?.mediaAttestedAt).toBeNull();
    const [stored] = await h.db.select().from(vaultBlobs).where(eq(vaultBlobs.docId, portfolio.id));
    expect(stored).toMatchObject({
      vaultId: vault.id,
      docKind: 'portfolio',
      portfolioId: portfolio.id,
    });

    const secondBlob = envelope({
      vaultId: vault.id,
      docId: portfolio.id,
      docKind: 'portfolio',
      docVersion: 2,
      writeId: WRITE_IDS[1],
    });
    const second = await repository.compareAndSwap({
      userId: user.id,
      vaultId: vault.id,
      docId: portfolio.id,
      header: readVaultDocServerHeader(secondBlob),
      expectedVersion: 1,
      blob: secondBlob,
      retention: { maxVersions: 10, maxAgeMs: 30 * 24 * 60 * 60 * 1_000 },
      now: new Date(CAPTURE_ATTESTED_AT.getTime() + 1_000),
    });
    expect(second.status).toBe('ok');
    expect((await repository.readCurrent(user.id, vault.id, portfolio.id)).status).toBe('ok');
    const liveHistory = await repository.listHistory({
      userId: user.id,
      vaultId: vault.id,
      docId: portfolio.id,
    });
    expect(liveHistory).toMatchObject({
      status: 'ok',
      value: { items: [{ version: 1 }] },
    });
    expect((await repository.getHistory(user.id, vault.id, portfolio.id, 1)).status).toBe('ok');

    await h.db
      .update(portfolioVaultTransitionStates)
      .set({ captureExpiresAt: CAPTURE_EXPIRED_AT })
      .where(eq(portfolioVaultTransitionStates.portfolioId, portfolio.id));
    expect(await repository.readCurrent(user.id, vault.id, portfolio.id)).toEqual({
      status: 'not_found',
    });
    expect(
      await repository.listHistory({ userId: user.id, vaultId: vault.id, docId: portfolio.id }),
    ).toEqual({ status: 'not_found' });
    expect(await repository.getHistory(user.id, vault.id, portfolio.id, 1)).toEqual({
      status: 'not_found',
    });
  });

  it('keeps capture binding and vault freshness untouched on every prospective refusal', async () => {
    const user = await h.seedUser({
      email: 'e1-prospective-refusals@bt.test',
      username: 'e1_prospective_refusals',
    });
    const agent = await login(h.app, user);
    const verifiedVault = await createVault({ user, agent, name: 'Verified target' });
    const unverifiedVault = await createVault({
      user,
      agent,
      name: 'Unverified target',
      headerDocId: newId(),
      commonDocId: newId(),
    });
    await h.db
      .update(vaults)
      .set({
        mediaAttestedAt: CAPTURE_ATTESTED_AT,
        mediaAttestedDriveConnectionId: null,
      })
      .where(eq(vaults.id, verifiedVault.id));
    const inserted = await h.db
      .insert(portfolios)
      .values([
        { userId: user.id, name: 'Missing capture' },
        { userId: user.id, name: 'Expired capture' },
        { userId: user.id, name: 'Unverified capture' },
        { userId: user.id, name: 'Other-vault capture' },
        { userId: user.id, name: 'Failed-precondition capture' },
      ])
      .returning();
    const [missing, expired, unverified, otherVault, failedPrecondition] = inserted;
    if (!missing || !expired || !unverified || !otherVault || !failedPrecondition) {
      throw new Error('portfolio insert failed');
    }
    await h.db.insert(portfolioVaultTransitionStates).values([
      {
        portfolioId: expired.id,
        userId: user.id,
        captureRevision: `${CAPTURE_REVISION}-expired`,
        captureExpiresAt: CAPTURE_EXPIRED_AT,
      },
      {
        portfolioId: unverified.id,
        userId: user.id,
        captureRevision: `${CAPTURE_REVISION}-unverified`,
        captureExpiresAt: CAPTURE_EXPIRES_AT,
      },
      {
        portfolioId: otherVault.id,
        userId: user.id,
        captureRevision: `${CAPTURE_REVISION}-other-vault`,
        captureExpiresAt: CAPTURE_EXPIRES_AT,
        captureVaultId: verifiedVault.id,
        captureMediaAttestedAt: CAPTURE_ATTESTED_AT,
      },
      {
        portfolioId: failedPrecondition.id,
        userId: user.id,
        captureRevision: `${CAPTURE_REVISION}-failed-precondition`,
        captureExpiresAt: CAPTURE_EXPIRES_AT,
      },
    ]);
    const repository = createVaultBlobRepository(h.db);
    const write = async (
      portfolioId: string,
      vaultId: string,
      expectedVersion: number | null = null,
    ) => {
      const blob = envelope({
        vaultId,
        docId: portfolioId,
        docKind: 'portfolio',
        docVersion: 1,
        writeId: newId(),
      });
      return repository.compareAndSwap({
        userId: user.id,
        vaultId,
        docId: portfolioId,
        header: readVaultDocServerHeader(blob),
        expectedVersion,
        blob,
        retention: { maxVersions: 10, maxAgeMs: 30 * 24 * 60 * 60 * 1_000 },
        now: CAPTURE_ATTESTED_AT,
      });
    };

    expect(await write(missing.id, verifiedVault.id)).toEqual({
      status: 'portfolio_binding_mismatch',
    });
    expect(await write(expired.id, verifiedVault.id)).toEqual({
      status: 'portfolio_binding_mismatch',
    });
    expect(await write(unverified.id, unverifiedVault.id)).toEqual({
      status: 'portfolio_binding_mismatch',
    });
    expect(await write(otherVault.id, unverifiedVault.id)).toEqual({
      status: 'portfolio_binding_mismatch',
    });
    expect(await write(failedPrecondition.id, verifiedVault.id, 7)).toEqual({
      status: 'precondition_failed',
      currentVersion: null,
      reason: 'stale',
    });

    const captures = await h.db.select().from(portfolioVaultTransitionStates);
    expect(
      captures.find(({ portfolioId }) => portfolioId === expired.id)?.captureVaultId,
    ).toBeNull();
    expect(
      captures.find(({ portfolioId }) => portfolioId === unverified.id)?.captureVaultId,
    ).toBeNull();
    expect(
      captures.find(({ portfolioId }) => portfolioId === failedPrecondition.id)?.captureVaultId,
    ).toBeNull();
    expect(captures.find(({ portfolioId }) => portfolioId === otherVault.id)).toMatchObject({
      captureVaultId: verifiedVault.id,
      captureMediaAttestedAt: CAPTURE_ATTESTED_AT,
    });
    const [stillFresh] = await h.db.select().from(vaults).where(eq(vaults.id, verifiedVault.id));
    expect(stillFresh?.mediaAttestedAt).toEqual(CAPTURE_ATTESTED_AT);
    expect(Number((await h.db.select({ value: count() }).from(vaultBlobs))[0]?.value)).toBe(0);
  });

  it('binds a Drive-only candidate capture, gates its readback, and includes it in the exact promotion roster', async () => {
    const user = await h.seedUser({
      email: 'e1-prospective-candidate@bt.test',
      username: 'e1_prospective_candidate',
    });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-prospective-candidate-sub',
        email: 'prospective-candidate@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
    });
    await h.db
      .update(vaults)
      .set({
        mediaAttestedAt: CAPTURE_ATTESTED_AT,
        mediaAttestedDriveConnectionId: connection.id,
      })
      .where(eq(vaults.id, vault.id));
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Prospective candidate portfolio' })
      .returning();
    if (!portfolio) throw new Error('portfolio insert failed');
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: portfolio.id,
      userId: user.id,
      captureRevision: `${CAPTURE_REVISION}-candidate`,
      captureExpiresAt: CAPTURE_EXPIRES_AT,
    });
    const transitionId = newId();
    const docs = [
      { docId: portfolio.id, docKind: 'portfolio' as const, writeId: WRITE_IDS[2] },
      { docId: vault.headerDocId, docKind: 'header' as const, writeId: WRITE_IDS[0] },
      { docId: vault.commonDocId, docKind: 'common' as const, writeId: WRITE_IDS[1] },
    ].map((doc) => ({
      ...doc,
      blob: envelope({
        vaultId: vault.id,
        docId: doc.docId,
        docKind: doc.docKind,
        docVersion: 1,
        writeId: doc.writeId,
      }),
    }));
    const staged = [] as Array<{ candidateId: string; docId: string }>;
    for (const doc of docs) {
      const response = await agent
        .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${doc.docId}`)
        .set(...XRW)
        .set(...OCTET)
        .send(doc.blob);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      staged.push({ candidateId: response.body.candidateId as string, docId: doc.docId });
    }
    const [boundCapture] = await h.db
      .select()
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, portfolio.id));
    expect(boundCapture).toMatchObject({
      captureVaultId: vault.id,
      captureMediaAttestedAt: CAPTURE_ATTESTED_AT,
      captureMediaAttestedDriveConnectionId: connection.id,
    });
    const [invalidatedVault] = await h.db.select().from(vaults).where(eq(vaults.id, vault.id));
    expect(invalidatedVault).toMatchObject({
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
    });

    await h.db
      .update(portfolioVaultTransitionStates)
      .set({ captureExpiresAt: CAPTURE_EXPIRED_AT })
      .where(eq(portfolioVaultTransitionStates.portfolioId, portfolio.id));
    const expiredReadback = await agent.get(
      `/api/v1/vaults/${vault.id}/media/server-candidate/${staged[0]!.candidateId}`,
    );
    expect(expiredReadback.status).toBe(404);
    await h.db
      .update(portfolioVaultTransitionStates)
      .set({ captureExpiresAt: CAPTURE_EXPIRES_AT })
      .where(eq(portfolioVaultTransitionStates.portfolioId, portfolio.id));

    const readbacks: PerVaultServerCandidateReadback[] = [];
    for (const candidate of staged) {
      const read = await agent
        .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${candidate.candidateId}`)
        .responseType('blob');
      expect(read.status).toBe(200);
      readbacks.push({
        candidateId: candidate.candidateId,
        docId: candidate.docId,
        readback: read.headers['x-bettertrack-vault-candidate-readback'] as string,
      });
    }
    const promoted = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId,
        expected: {
          media: ['drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive', 'server'], driveConnectionId: connection.id },
        verification: { kind: 'server-candidates', readbacks },
      });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    const promotedRows = await h.db
      .select()
      .from(vaultBlobs)
      .where(eq(vaultBlobs.vaultId, vault.id));
    expect(promotedRows).toHaveLength(3);
    expect(promotedRows.find(({ docId }) => docId === portfolio.id)).toMatchObject({
      docKind: 'portfolio',
      portfolioId: portfolio.id,
    });
  });

  /**
   * #1491 at the route a real recovery would take. The repository proves the
   * rows survive the destructive commit; this proves the OWNER can still fetch
   * their ciphertext through `GET /media/server-candidate/:candidateId`
   * afterwards — that read is gated by `expectedDoc`, which changes meaning at
   * the exact moment of the move-in (prospective capture → committed member),
   * so it is the part that could silently regress and leave "recoverable" true
   * only for someone with database access.
   */
  it('still serves the retained candidate to the owner after the move-in commits, and stops at the TTL (#1491)', async () => {
    const user = await h.seedUser({
      email: 'e1-retained-candidate@bt.test',
      username: 'e1_retained_candidate',
    });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-retained-candidate-sub',
        email: 'retained-candidate@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
    });
    await h.db
      .update(vaults)
      .set({
        mediaAttestedAt: CAPTURE_ATTESTED_AT,
        mediaAttestedDriveConnectionId: connection.id,
      })
      .where(eq(vaults.id, vault.id));
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Retained candidate portfolio' })
      .returning();
    if (!portfolio) throw new Error('portfolio insert failed');
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: portfolio.id,
      userId: user.id,
      captureRevision: `${CAPTURE_REVISION}-retained`,
      captureExpiresAt: CAPTURE_EXPIRES_AT,
    });
    const transitionId = newId();
    const portfolioBlob = envelope({
      vaultId: vault.id,
      docId: portfolio.id,
      docKind: 'portfolio',
      docVersion: 1,
      writeId: WRITE_IDS[2],
    });
    const staged = await agent
      .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${portfolio.id}`)
      .set(...XRW)
      .set(...OCTET)
      .send(portfolioBlob);
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    const candidateId = staged.body.candidateId as string;

    // The destructive commit: the portfolio becomes a locked member and the
    // server-readable copy is gone. Pre-#1491 this deleted the staged batch.
    await h.db
      .update(portfolios)
      .set({ vaultId: vault.id, vaultAlias: 'Retained candidate' })
      .where(eq(portfolios.id, portfolio.id));
    await createPortfolioVaultTransitionTransactionRepository(h.db).completeMoveIn({
      userId: user.id,
      portfolioId: portfolio.id,
      vaultId: vault.id,
      docVersion: 1,
      lifecycleGeneration: 1,
      retiredCustomAssetIds: [],
      completedAt: new Date(),
    });

    const recovered = await agent
      .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${candidateId}`)
      .responseType('blob');
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(Buffer.from(recovered.body).equals(portfolioBlob)).toBe(true);
    expect(recovered.headers['x-bettertrack-vault-candidate-id']).toBe(candidateId);
    // Ciphertext only, and never presented as the vault's storage: the vault
    // still reports Drive as its only medium, with the rows as inactive.
    const media = await agent.get(`/api/v1/vaults/${vault.id}/media`);
    expect(media.status).toBe(200);
    expect(media.body.media).toEqual(['drive']);
    expect(media.body.server.disposition).toBe('inactive-candidates');

    // The honest boundary at the route too: past `expires_at` the recovery is
    // gone, with the same not-found the route gives an unknown candidate.
    await h.db
      .update(vaultServerCandidates)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(vaultServerCandidates.id, candidateId));
    const expired = await agent.get(
      `/api/v1/vaults/${vault.id}/media/server-candidate/${candidateId}`,
    );
    expect(expired.status).toBe(404);
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultServerCandidates)
            .where(eq(vaultServerCandidates.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(0);
  });

  it('uses the registered doc-kind guard so a header address cannot borrow the 8MiB portfolio cap', async () => {
    h = await createTestApp({
      env: {
        BT_VAULT_MAX_BYTES_HEADER: '1024',
        BT_VAULT_MAX_BYTES_COMMON: '1280',
        BT_VAULT_MAX_BYTES_PORTFOLIO: '1536',
      },
    });
    const user = await h.seedUser({
      email: 'e1-kind-cap-guard@bt.test',
      username: 'e1_kind_cap_guard',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const disguisedHeader = envelopeAtSize(1400, {
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'portfolio',
      docVersion: 1,
      writeId: newId(),
    });

    const rejected = await putDoc(agent, vault.id, vault.headerDocId, disguisedHeader, {
      create: true,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VAULT_DOC_KIND_MISMATCH');
    const [stored] = await h.db.select({ value: count() }).from(vaultBlobs);
    expect(Number(stored?.value ?? 0)).toBe(0);
  });

  it('rejects a replayed writeId with different bytes and preserves the committed blob', async () => {
    const user = await h.seedUser({
      email: 'e1-write-id-bytes@bt.test',
      username: 'e1_write_id_bytes',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const writeId = newId();
    const committed = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId,
      ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, committed, { create: true })).status,
    ).toBe(204);
    const alteredReplay = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId,
      ciphertext: new Uint8Array([0xba, 0xad, 0xf0, 0x0d]),
    });

    const rejected = await putDoc(agent, vault.id, vault.headerDocId, alteredReplay, {
      version: 1,
    });
    expect(rejected.status).toBe(412);
    // Terminal, not stale (#1498): retrying these bytes under this writeId can
    // never be accepted, so the code differs from the retryable CAS miss.
    expect(rejected.body.error.code).toBe(PER_VAULT_ERROR_CODES.writeIdReplayed);
    const current = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(current.status).toBe(200);
    expect(Buffer.from(current.body as Buffer)).toEqual(committed);
  });

  it('separates the retryable and terminal 412 codes and still converges an identical replay', async () => {
    // #1498: both CAS refusals stay 412, but a client must be able to tell
    // "re-read, re-merge, retry" from "this writeId is spent" without a local
    // (vaultId, docId, writeId) -> sha256(bytes) ledger of its own.
    const user = await h.seedUser({ email: 'e1-412-split@bt.test', username: 'e1_412_split' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const writeId = newId();
    const committed = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId,
      ciphertext: new Uint8Array([0x11, 0x22]),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, committed, { create: true })).status,
    ).toBe(204);

    // 1. Stale precondition — a fresh writeId that simply lost the race. The
    // client re-reads `currentVersion`, re-merges and its retry can succeed.
    const stale = await putDoc(
      agent,
      vault.id,
      vault.headerDocId,
      envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: 2,
        writeId: newId(),
        ciphertext: new Uint8Array([0x33, 0x44]),
      }),
      { version: 9 },
    );
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe(PER_VAULT_ERROR_CODES.preconditionFailed);
    expect(stale.body.currentVersion).toBe(1);

    // 2. Replayed writeId, different bytes — terminal. No retry of this exact
    // request can ever be accepted, and the message says why.
    const replayed = await putDoc(
      agent,
      vault.id,
      vault.headerDocId,
      envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: 2,
        writeId,
        ciphertext: new Uint8Array([0x55, 0x66]),
      }),
      { version: 1 },
    );
    expect(replayed.status).toBe(412);
    expect(replayed.body.error.code).toBe(PER_VAULT_ERROR_CODES.writeIdReplayed);
    expect(replayed.body.currentVersion).toBe(1);
    expect(replayed.body.error.message).toContain('mint a new writeId');

    // The whole point: one status, two codes. Conflating them is the retry loop.
    expect(replayed.body.error.code).not.toBe(stale.body.error.code);

    // 3. Replaying the SAME writeId with byte-identical content is not an error
    // at all — it converges on the committed version.
    const identical = await putDoc(agent, vault.id, vault.headerDocId, committed, { version: 1 });
    expect(identical.status).toBe(204);
    expect(identical.headers.etag).toBe('"1"');

    // 4. And the retryable case really is retryable: re-read, re-merge onto the
    // reported currentVersion, retry with a fresh writeId — accepted.
    const merged = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 2,
      writeId: newId(),
      ciphertext: new Uint8Array([0x33, 0x44]),
    });
    const retried = await putDoc(agent, vault.id, vault.headerDocId, merged, {
      version: stale.body.currentVersion as number,
    });
    expect(retried.status).toBe(204);
    const current = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(Buffer.from(current.body as Buffer)).toEqual(merged);
  });

  it('never stores two byte strings for one docVersion while preserving non-linear distinct versions', async () => {
    const user = await h.seedUser({
      email: 'e1-doc-version-bytes@bt.test',
      username: 'e1_doc_version_bytes',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const versionOne = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: newId(),
      ciphertext: new Uint8Array([0x01, 0xa1]),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, versionOne, { create: true })).status,
    ).toBe(204);

    // TEST VECTOR: a fresh writeId does not authorize different bytes under
    // the current pair's already-used client docVersion.
    const currentCollision = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: newId(),
      ciphertext: new Uint8Array([0x01, 0xb2]),
    });
    const refusedCurrent = await putDoc(agent, vault.id, vault.headerDocId, currentCollision, {
      version: 1,
    });
    expect(refusedCurrent.status).toBe(412);
    expect(refusedCurrent.body.error.code).toBe('VAULT_PRECONDITION_FAILED');
    expect(Number((await h.db.select({ value: count() }).from(vaultBlobHistory))[0]?.value)).toBe(
      0,
    );

    const versionTwo = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 2,
      writeId: newId(),
      ciphertext: new Uint8Array([0x02, 0xa1]),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, versionTwo, { version: 1 })).status,
    ).toBe(204);

    // The same invariant applies after the original pair enters history.
    const historyCollision = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: newId(),
      ciphertext: new Uint8Array([0x01, 0xc3]),
    });
    const refusedHistory = await putDoc(agent, vault.id, vault.headerDocId, historyCollision, {
      version: 2,
    });
    expect(refusedHistory.status).toBe(412);
    expect(refusedHistory.body.error.code).toBe('VAULT_PRECONDITION_FAILED');
    const historical = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history/1`)
      .responseType('blob');
    expect(Buffer.from(historical.body as Buffer)).toEqual(versionOne);

    // Non-linear ordering is still valid when each distinct token names only
    // one byte string: 2 -> 7 -> 3 is accepted through ordinary CAS.
    const versionSeven = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 7,
      writeId: newId(),
      ciphertext: new Uint8Array([0x07]),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, versionSeven, { version: 2 })).status,
    ).toBe(204);
    const versionThree = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 3,
      writeId: newId(),
      ciphertext: new Uint8Array([0x03]),
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, versionThree, { version: 7 })).status,
    ).toBe(204);
  });

  it('requires a document precondition before entering CAS', async () => {
    const user = await h.seedUser({
      email: 'e1-precondition-required@bt.test',
      username: 'e1_precondition_required',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const blob = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
    });

    const rejected = await agent
      .put(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .set(...XRW)
      .set(...OCTET)
      .send(blob);
    expect(rejected.status).toBe(428);
    expect(rejected.body.error.code).toBe('VAULT_PRECONDITION_REQUIRED');
    const [stored] = await h.db.select({ value: count() }).from(vaultBlobs);
    expect(Number(stored?.value ?? 0)).toBe(0);
  });

  it('stores a newer format without server-side version gating or payload parsing', async () => {
    const user = await h.seedUser({ email: 'e1-future@bt.test', username: 'e1_future' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const future = Buffer.from(
      encodeVaultEnvelope(
        {
          formatVersion: 99,
          docVersion: 1,
          vaultId: vault.id,
          docId: vault.headerDocId,
          docKind: 'header',
          writeId: WRITE_IDS[0],
          futureHeaderField: { intentionally: 'unknown' },
        },
        new Uint8Array([0xff, 0x00, 0xfe, 0x7b, 0x00]),
      ),
    );
    const stored = await putDoc(agent, vault.id, vault.headerDocId, future, { create: true });
    expect(stored.status).toBe(204);
    const read = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(Buffer.from(read.body as Buffer)).toEqual(future);
  });

  it('accepts non-linear client docVersions and defends retirement from legacy byte ambiguity', async () => {
    const user = await h.seedUser({ email: 'e1-doc-version@bt.test', username: 'e1_doc_version' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const writeSeven = newId();
    const clientVersionSeven = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 7,
      writeId: writeSeven,
    });
    const created = await putDoc(agent, vault.id, vault.headerDocId, clientVersionSeven, {
      create: true,
    });
    expect(created.status).toBe(204);
    expect(created.headers.etag).toBe('"7"');

    const writeThree = newId();
    const clientVersionThree = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 3,
      writeId: writeThree,
    });
    const replaced = await putDoc(agent, vault.id, vault.headerDocId, clientVersionThree, {
      version: 7,
    });
    expect(replaced.status).toBe(204);
    expect(replaced.headers.etag).toBe('"3"');
    const read = await agent
      .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
      .responseType('blob');
    expect(Buffer.from(read.body as Buffer)).toEqual(clientVersionThree);

    // A numeric bounce remains legal only for a token that has not already
    // named different bytes in this document.
    const writeSevenAgain = newId();
    const clientVersionSevenAgain = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 7,
      writeId: writeSevenAgain,
    });
    const refusedReuse = await putDoc(agent, vault.id, vault.headerDocId, clientVersionSevenAgain, {
      version: 3,
    });
    expect(refusedReuse.status).toBe(412);
    expect(refusedReuse.body.error.code).toBe('VAULT_PRECONDITION_FAILED');

    const commonWrite = newId();
    const common = envelope({
      vaultId: vault.id,
      docId: vault.commonDocId,
      docKind: 'common',
      docVersion: 1,
      writeId: commonWrite,
    });
    expect(
      (await putDoc(agent, vault.id, vault.commonDocId, common, { create: true })).status,
    ).toBe(204);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-doc-version-drive-sub',
        email: 'doc-version-drive@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    await h.db
      .update(vaults)
      .set({ media: ['server', 'drive'], driveConnectionId: connection.id })
      .where(eq(vaults.id, vault.id));

    // TEST VECTOR: model a legacy pre-invariant current row that collides with
    // retained v7 bytes. Retirement keeps its deepest defensive refusal even
    // though live CAS can no longer manufacture this state.
    await h.db
      .update(vaultBlobs)
      .set({
        version: 7,
        formatVersion: 2,
        sizeBytes: clientVersionSevenAgain.length,
        blob: clientVersionSevenAgain,
      })
      .where(and(eq(vaultBlobs.vaultId, vault.id), eq(vaultBlobs.docId, vault.headerDocId)));
    const ambiguousRetirement = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: newId(),
        expected: {
          media: ['server', 'drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive'], driveConnectionId: connection.id },
        verification: {
          kind: 'drive',
          driveConnectionId: connection.id,
          docs: [
            { docId: vault.headerDocId, docVersion: 7, writeId: writeSevenAgain },
            { docId: vault.commonDocId, docVersion: 1, writeId: commonWrite },
          ],
        },
      });
    expect(ambiguousRetirement.status).toBe(409);
    expect(ambiguousRetirement.body.error.code).toBe('VAULT_RETIRED_SERVER_CONFLICT');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetirements))[0]?.value)).toBe(
      0,
    );

    await h.db
      .update(vaultBlobs)
      .set({
        version: 3,
        formatVersion: 2,
        sizeBytes: clientVersionThree.length,
        blob: clientVersionThree,
      })
      .where(and(eq(vaultBlobs.vaultId, vault.id), eq(vaultBlobs.docId, vault.headerDocId)));

    const clientVersionEight = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 8,
      writeId: newId(),
    });
    expect(
      (
        await putDoc(agent, vault.id, vault.headerDocId, clientVersionEight, {
          version: 3,
        })
      ).status,
    ).toBe(204);
    const history = await agent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`);
    expect(history.body.items.map((item: { version: number }) => item.version)).toEqual([7, 3]);
  });

  it('honors all three env-tunable per-kind byte caps at the exact boundary', async () => {
    h = await createTestApp({
      env: {
        BT_VAULT_MAX_BYTES_HEADER: '1024',
        BT_VAULT_MAX_BYTES_COMMON: '1280',
        BT_VAULT_MAX_BYTES_PORTFOLIO: '1536',
      },
    });
    const user = await h.seedUser({ email: 'e1-caps@bt.test', username: 'e1_caps' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Locked cap stub', vaultId: vault.id })
      .returning();
    if (!portfolio) throw new Error('portfolio insert failed');

    const docs = [
      { docId: vault.headerDocId, docKind: 'header' as const, cap: 1024 },
      { docId: vault.commonDocId, docKind: 'common' as const, cap: 1280 },
      { docId: portfolio.id, docKind: 'portfolio' as const, cap: 1536 },
    ];
    for (const doc of docs) {
      const under = envelopeAtSize(doc.cap - 1, {
        vaultId: vault.id,
        docId: doc.docId,
        docKind: doc.docKind,
        docVersion: 1,
        writeId: newId(),
      });
      expect((await putDoc(agent, vault.id, doc.docId, under, { create: true })).status).toBe(204);
      const over = envelopeAtSize(doc.cap + 1, {
        vaultId: vault.id,
        docId: doc.docId,
        docKind: doc.docKind,
        docVersion: 2,
        writeId: newId(),
      });
      const rejected = await putDoc(agent, vault.id, doc.docId, over, { version: 1 });
      expect(rejected.status).toBe(413);
      expect(rejected.body.error.code).toBe('VAULT_TOO_LARGE');
    }
  });

  it('prunes per-doc history to the configured depth', async () => {
    h = await createTestApp({ env: { BT_VAULT_HISTORY_MAX_VERSIONS: '1' } });
    const user = await h.seedUser({ email: 'e1-prune@bt.test', username: 'e1_prune' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    for (let version = 1; version <= 3; version += 1) {
      const blob = envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: version,
      });
      const response = await putDoc(
        agent,
        vault.id,
        vault.headerDocId,
        blob,
        version === 1 ? { create: true } : { version: version - 1 },
      );
      expect(response.status).toBe(204);
    }
    const history = await agent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`);
    expect(history.body.items.map((item: { version: number }) => item.version)).toEqual([2]);
  });

  it('prunes by supersession recency rather than client docVersion order', async () => {
    h = await createTestApp({
      env: {
        BT_VAULT_HISTORY_MAX_VERSIONS: '1',
        BT_VAULT_HISTORY_MAX_AGE_DAYS: '3650',
      },
    });
    const user = await h.seedUser({ email: 'e1-prune-nonlinear@bt.test', username: 'e1_prune_nl' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const write = async (docVersion: number, expectedVersion: number | null) => {
      const blob = envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion,
        writeId: newId(),
      });
      return putDoc(
        agent,
        vault.id,
        vault.headerDocId,
        blob,
        expectedVersion === null ? { create: true } : { version: expectedVersion },
      );
    };
    expect((await write(7, null)).status).toBe(204);
    expect((await write(3, 7)).status).toBe(204);
    // Deterministic TEST VECTOR: old enough to establish ordering, but inside
    // this test's 10-year age window so only depth pruning can remove it.
    await h.db
      .update(vaultBlobHistory)
      .set({ createdAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(vaultBlobHistory.version, 7));
    expect((await write(9, 3)).status).toBe(204);

    const history = await agent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`);
    expect(history.body.items.map((item: { version: number }) => item.version)).toEqual([3]);
  });

  it('prunes a per-doc history version after the configured age window', async () => {
    h = await createTestApp({
      env: { BT_VAULT_HISTORY_MAX_VERSIONS: '10', BT_VAULT_HISTORY_MAX_AGE_DAYS: '1' },
    });
    const user = await h.seedUser({ email: 'e1-age@bt.test', username: 'e1_age' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    for (let version = 1; version <= 2; version += 1) {
      const blob = envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: version,
      });
      expect(
        (
          await putDoc(
            agent,
            vault.id,
            vault.headerDocId,
            blob,
            version === 1 ? { create: true } : { version: 1 },
          )
        ).status,
      ).toBe(204);
      if (version === 1) {
        // A long-lived current version is still young history when superseded.
        await h.db
          .update(vaultBlobs)
          .set({ updatedAt: new Date('2020-01-01T00:00:00.000Z') })
          .where(eq(vaultBlobs.docId, vault.headerDocId));
      }
    }
    const newlySuperseded = await agent.get(
      `/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`,
    );
    expect(newlySuperseded.body.items.map((item: { version: number }) => item.version)).toEqual([
      1,
    ]);
    await h.db
      .update(vaultBlobHistory)
      .set({ createdAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(vaultBlobHistory.version, 1));
    const v3 = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 3,
    });
    expect((await putDoc(agent, vault.id, vault.headerDocId, v3, { version: 2 })).status).toBe(204);
    const history = await agent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`);
    expect(history.body.items.map((item: { version: number }) => item.version)).toEqual([2]);
  });

  it.skipIf(!REAL_DATABASE_URL)(
    'serializes overlapping doc CAS transactions so a stale writer cannot overwrite the winner',
    async () => {
      if (!REAL_DATABASE_URL) throw new Error('Real Postgres is required for the row-lock test');
      const user = await h.seedUser({ email: 'e1-cas-lock@bt.test', username: 'e1_cas_lock' });
      const agent = await login(h.app, user);
      const vault = await createVault({ user, agent });
      const v1 = envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: 1,
        writeId: newId(),
      });
      expect((await putDoc(agent, vault.id, vault.headerDocId, v1, { create: true })).status).toBe(
        204,
      );
      const contenders = [
        envelope({
          vaultId: vault.id,
          docId: vault.headerDocId,
          docKind: 'header',
          docVersion: 2,
          writeId: newId(),
          ciphertext: new Uint8Array([0xa1]),
        }),
        envelope({
          vaultId: vault.id,
          docId: vault.headerDocId,
          docKind: 'header',
          docVersion: 3,
          writeId: newId(),
          ciphertext: new Uint8Array([0xb2]),
        }),
      ];
      const controller = postgres(REAL_DATABASE_URL, { max: 1 });
      const observer = postgres(REAL_DATABASE_URL, { max: 1 });
      const lockReady = deferred();
      const releaseLock = deferred();
      let first: ReturnType<typeof putDoc> | undefined;
      let second: ReturnType<typeof putDoc> | undefined;
      const lockOwner = controller.begin(async (transaction) => {
        await transaction`SELECT id FROM vaults WHERE id = ${vault.id} FOR UPDATE`;
        lockReady.resolve();
        await releaseLock.promise;
      });

      try {
        await Promise.race([
          lockReady.promise,
          lockOwner.then(() => {
            throw new Error('Vault row-lock owner exited before acquiring the test lock');
          }),
        ]);
        first = putDoc(agent, vault.id, vault.headerDocId, contenders[0]!, { version: 1 });
        await waitForVaultRowLockWaiters(observer, 1);
        second = putDoc(agent, vault.id, vault.headerDocId, contenders[1]!, { version: 1 });
        const waiters = await waitForVaultRowLockWaiters(observer, 2);
        expect(new Set(waiters.map(({ pid }) => pid)).size).toBeGreaterThanOrEqual(2);
        releaseLock.resolve();
        await lockOwner;
        const responses = await Promise.all([first!, second!]);
        expect(responses.map(({ status }) => status).sort()).toEqual([204, 412]);
        const winnerIndex = responses.findIndex(({ status }) => status === 204);
        const rejected = responses.find(({ status }) => status === 412)!;
        expect(rejected.body.error.code).toBe('VAULT_PRECONDITION_FAILED');
        const current = await agent
          .get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`)
          .responseType('blob');
        expect(Buffer.from(current.body as Buffer)).toEqual(contenders[winnerIndex]);
        const history = await h.db
          .select()
          .from(vaultBlobHistory)
          .where(eq(vaultBlobHistory.vaultId, vault.id));
        expect(history).toHaveLength(1);
        expect(history[0]?.blob).toEqual(v1);
      } finally {
        releaseLock.resolve();
        await Promise.allSettled([
          lockOwner,
          first ?? Promise.resolve(),
          second ?? Promise.resolve(),
        ]);
        await Promise.all([controller.end(), observer.end()]);
      }
    },
    15_000,
  );
});

describe('E1 R3/R4 media transitions and purge', () => {
  it('refreshes unchanged server-backed selections from the exact active roster', async () => {
    const user = await h.seedUser({
      email: 'e1-server-attestation-refresh@bt.test',
      username: 'e1_server_attestation_refresh',
    });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    const docs = [
      {
        docId: vault.headerDocId,
        docKind: 'header' as const,
        docVersion: 1,
        writeId: WRITE_IDS[0],
      },
      {
        docId: vault.commonDocId,
        docKind: 'common' as const,
        docVersion: 1,
        writeId: WRITE_IDS[1],
      },
    ].map((doc) => ({ ...doc, blob: envelope({ vaultId: vault.id, ...doc }) }));
    for (const doc of docs) {
      expect((await putDoc(agent, vault.id, doc.docId, doc.blob, { create: true })).status).toBe(
        204,
      );
    }

    const refresh = {
      transitionId: newId(),
      expected: { media: ['server'], driveConnectionId: null, mediaAttestedAt: null },
      next: { media: ['server'], driveConnectionId: null },
      verification: {
        kind: 'server',
        docs: docs.map(({ docId, docVersion, writeId }) => ({
          docId,
          docVersion,
          writeId,
        })),
      },
    } as const;
    const first = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(refresh);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      media: ['server'],
      driveConnectionId: null,
      mediaAttestedAt: expect.any(String),
      mediaAttestedDriveConnectionId: null,
    });

    const replay = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(refresh);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toEqual(first.body);

    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-server-drive-attestation-refresh-sub',
        email: 'server-drive-attestation-refresh@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    await h.db
      .update(vaults)
      .set({
        media: ['server', 'drive'],
        driveConnectionId: connection.id,
        mediaAttestedAt: null,
        mediaAttestedDriveConnectionId: null,
      })
      .where(eq(vaults.id, vault.id));
    const serverDrive = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: newId(),
        expected: {
          media: ['server', 'drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['server', 'drive'], driveConnectionId: connection.id },
        verification: {
          kind: 'drive',
          driveConnectionId: connection.id,
          docs: refresh.verification.docs,
        },
      });
    expect(serverDrive.status, JSON.stringify(serverDrive.body)).toBe(200);
    expect(serverDrive.body).toMatchObject({
      media: ['server', 'drive'],
      driveConnectionId: connection.id,
      mediaAttestedAt: expect.any(String),
      mediaAttestedDriveConnectionId: connection.id,
    });
  });

  it('refreshes Drive-only move-in candidates without promoting or deleting them', async () => {
    const user = await h.seedUser({
      email: 'e1-drive-attestation-refresh@bt.test',
      username: 'e1_drive_attestation_refresh',
    });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-drive-attestation-refresh-sub',
        email: 'drive-attestation-refresh@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
    });
    await h.db
      .update(vaults)
      .set({
        mediaAttestedAt: CAPTURE_ATTESTED_AT,
        mediaAttestedDriveConnectionId: connection.id,
      })
      .where(eq(vaults.id, vault.id));
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Drive refresh prospective portfolio' })
      .returning();
    if (!portfolio) throw new Error('portfolio insert failed');
    await h.db.insert(portfolioVaultTransitionStates).values({
      portfolioId: portfolio.id,
      userId: user.id,
      captureRevision: `${CAPTURE_REVISION}-drive-refresh`,
      captureExpiresAt: CAPTURE_EXPIRES_AT,
    });

    const transitionId = newId();
    // The prospective portfolio goes first: that write binds the capture, after
    // which the exact candidate roster includes all three required documents.
    const docs = [
      {
        docId: portfolio.id,
        docKind: 'portfolio' as const,
        docVersion: 3,
        writeId: WRITE_IDS[2],
      },
      {
        docId: vault.headerDocId,
        docKind: 'header' as const,
        docVersion: 2,
        writeId: WRITE_IDS[0],
      },
      {
        docId: vault.commonDocId,
        docKind: 'common' as const,
        docVersion: 2,
        writeId: WRITE_IDS[1],
      },
    ].map((doc) => ({ ...doc, blob: envelope({ vaultId: vault.id, ...doc }) }));
    for (const [index, doc] of docs.entries()) {
      const staged = await agent
        .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${doc.docId}`)
        .set(...XRW)
        .set(...OCTET)
        .send(doc.blob);
      expect(staged.status, JSON.stringify(staged.body)).toBe(200);
      if (index === 0) {
        const [boundCapture] = await h.db
          .select({
            captureVaultId: portfolioVaultTransitionStates.captureVaultId,
            captureMediaAttestedAt: portfolioVaultTransitionStates.captureMediaAttestedAt,
            captureMediaAttestedDriveConnectionId:
              portfolioVaultTransitionStates.captureMediaAttestedDriveConnectionId,
          })
          .from(portfolioVaultTransitionStates)
          .where(eq(portfolioVaultTransitionStates.portfolioId, portfolio.id));
        expect(boundCapture).toEqual({
          captureVaultId: vault.id,
          captureMediaAttestedAt: CAPTURE_ATTESTED_AT,
          captureMediaAttestedDriveConnectionId: connection.id,
        });
        const [invalidatedVault] = await h.db
          .select({
            mediaAttestedAt: vaults.mediaAttestedAt,
            mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
          })
          .from(vaults)
          .where(eq(vaults.id, vault.id));
        expect(invalidatedVault).toEqual({
          mediaAttestedAt: null,
          mediaAttestedDriveConnectionId: null,
        });
      }
    }
    const attestations = docs.map(({ docId, docVersion, writeId }) => ({
      docId,
      docVersion,
      writeId,
    }));
    const refresh = {
      transitionId,
      expected: {
        media: ['drive'],
        driveConnectionId: connection.id,
        mediaAttestedAt: null,
      },
      next: { media: ['drive'], driveConnectionId: connection.id },
      verification: {
        kind: 'drive',
        driveConnectionId: connection.id,
        docs: attestations,
      },
    } as const;

    const crossedBatch = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({ ...refresh, transitionId: newId() });
    expect(crossedBatch.status).toBe(412);
    expect(crossedBatch.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');

    const staleDocs = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...refresh,
        verification: {
          ...refresh.verification,
          docs: attestations.map((doc) =>
            doc.docId === portfolio.id ? { ...doc, writeId: newId() } : doc,
          ),
        },
      });
    expect(staleDocs.status).toBe(412);
    expect(staleDocs.body.error.code).toBe('VAULT_MEDIA_VERIFICATION_FAILED');

    const first = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(refresh);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      media: ['drive'],
      driveConnectionId: connection.id,
      mediaAttestedAt: expect.any(String),
      mediaAttestedDriveConnectionId: connection.id,
      server: { disposition: 'inactive-candidates' },
    });
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultServerCandidates)
            .where(eq(vaultServerCandidates.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(3);

    const replay = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(refresh);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultServerCandidates)
            .where(eq(vaultServerCandidates.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(3);

    const changedHeader = docs.find(({ docKind }) => docKind === 'header')!;
    const [attestationBeforeCandidateReplay] = await h.db
      .select({
        mediaAttestedAt: vaults.mediaAttestedAt,
        mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
      })
      .from(vaults)
      .where(eq(vaults.id, vault.id));
    const candidateReplay = await agent
      .put(
        `/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${changedHeader.docId}`,
      )
      .set(...XRW)
      .set(...OCTET)
      .send(changedHeader.blob);
    expect(candidateReplay.status, JSON.stringify(candidateReplay.body)).toBe(200);
    const [attestationAfterCandidateReplay] = await h.db
      .select({
        mediaAttestedAt: vaults.mediaAttestedAt,
        mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
      })
      .from(vaults)
      .where(eq(vaults.id, vault.id));
    expect(attestationAfterCandidateReplay).toEqual(attestationBeforeCandidateReplay);

    const changedWriteId = newId();
    const changedCandidate = await agent
      .put(
        `/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${changedHeader.docId}`,
      )
      .set(...XRW)
      .set(...OCTET)
      .send(
        envelope({
          vaultId: vault.id,
          docId: changedHeader.docId,
          docKind: 'header',
          docVersion: changedHeader.docVersion + 1,
          writeId: changedWriteId,
        }),
      );
    expect(changedCandidate.status, JSON.stringify(changedCandidate.body)).toBe(200);
    const [staleVault] = await h.db
      .select({
        mediaAttestedAt: vaults.mediaAttestedAt,
        mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
      })
      .from(vaults)
      .where(eq(vaults.id, vault.id));
    expect(staleVault).toEqual({
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
    });
    const staleReplay = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(refresh);
    expect(staleReplay.status).toBe(412);
    expect(staleReplay.body.error.code).toBe('VAULT_MEDIA_VERIFICATION_FAILED');
  });

  it('refuses a partial transition, stamps a complete batch, retires, and preserves forged/stale purges', async () => {
    const user = await h.seedUser({ email: 'e1-media@bt.test', username: 'e1_media' });
    const agent = await login(h.app, user);
    const keys = proofKeys();
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-media-google-sub',
        email: 'drive@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
      publicKey: keys.publicKey,
    });
    await h.db
      .update(vaults)
      .set({
        mediaAttestedAt: CAPTURE_ATTESTED_AT,
        mediaAttestedDriveConnectionId: connection.id,
      })
      .where(eq(vaults.id, vault.id));
    const headerBlob = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: WRITE_IDS[0],
    });
    const commonBlob = envelope({
      vaultId: vault.id,
      docId: vault.commonDocId,
      docKind: 'common',
      docVersion: 1,
      writeId: WRITE_IDS[1],
    });

    const stagedHeader = await agent
      .put(
        `/api/v1/vaults/${vault.id}/media/server-candidate/${TRANSITION_ID}/docs/${vault.headerDocId}`,
      )
      .set(...XRW)
      .set(...OCTET)
      .send(headerBlob);
    expect(stagedHeader.status).toBe(200);
    const [stillAttested] = await h.db
      .select({
        mediaAttestedAt: vaults.mediaAttestedAt,
        mediaAttestedDriveConnectionId: vaults.mediaAttestedDriveConnectionId,
      })
      .from(vaults)
      .where(eq(vaults.id, vault.id));
    expect(stillAttested).toEqual({
      mediaAttestedAt: CAPTURE_ATTESTED_AT,
      mediaAttestedDriveConnectionId: connection.id,
    });
    const readHeader = await agent
      .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${stagedHeader.body.candidateId}`)
      .responseType('blob');
    expect(Buffer.from(readHeader.body as Buffer)).toEqual(headerBlob);

    const transitionBase = {
      transitionId: TRANSITION_ID,
      expected: {
        media: ['drive'],
        driveConnectionId: connection.id,
        mediaAttestedAt: CAPTURE_ATTESTED_AT.toISOString(),
      },
      next: { media: ['drive', 'server'], driveConnectionId: connection.id },
    };
    const partial = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...transitionBase,
        verification: {
          kind: 'server-candidates',
          readbacks: [
            {
              candidateId: stagedHeader.body.candidateId,
              docId: vault.headerDocId,
              readback: readHeader.headers['x-bettertrack-vault-candidate-readback'],
            },
          ],
        },
      });
    expect(partial.status).toBe(412);
    expect(partial.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');

    const stagedCommon = await agent
      .put(
        `/api/v1/vaults/${vault.id}/media/server-candidate/${TRANSITION_ID}/docs/${vault.commonDocId}`,
      )
      .set(...XRW)
      .set(...OCTET)
      .send(commonBlob);
    expect(stagedCommon.status).toBe(200);
    const readCommon = await agent
      .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${stagedCommon.body.candidateId}`)
      .responseType('blob');
    const promoted = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...transitionBase,
        verification: {
          kind: 'server-candidates',
          readbacks: [
            {
              candidateId: stagedHeader.body.candidateId,
              docId: vault.headerDocId,
              readback: readHeader.headers['x-bettertrack-vault-candidate-readback'],
            },
            {
              candidateId: stagedCommon.body.candidateId,
              docId: vault.commonDocId,
              readback: readCommon.headers['x-bettertrack-vault-candidate-readback'],
            },
          ],
        },
      });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.mediaAttestedAt).toEqual(expect.any(String));
    expect(promoted.body.mediaAttestedDriveConnectionId).toBe(connection.id);

    // R2 TEST VECTOR: docVersion is client merge state, not a server
    // monotonicity signal. Retire and later purge a set whose current header
    // is v3 even though its retained history contains the numerically newer v7.
    const writeSeven = newId();
    const headerSeven = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 7,
      writeId: writeSeven,
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, headerSeven, { version: 1 })).status,
    ).toBe(204);
    const writeThree = newId();
    const headerThree = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 3,
      writeId: writeThree,
    });
    expect(
      (await putDoc(agent, vault.id, vault.headerDocId, headerThree, { version: 7 })).status,
    ).toBe(204);

    const docs: PerVaultMediaDocAttestation[] = [
      { docId: vault.headerDocId, docVersion: 3, writeId: writeThree },
      { docId: vault.commonDocId, docVersion: 1, writeId: WRITE_IDS[1] },
    ];
    const retirementRequest = {
      transitionId: newId(),
      expected: {
        media: ['drive', 'server'],
        driveConnectionId: connection.id,
        mediaAttestedAt: null,
      },
      next: { media: ['drive'], driveConnectionId: connection.id },
      verification: { kind: 'drive', driveConnectionId: connection.id, docs },
    };
    const retired = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(retirementRequest);
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.server.retirement.generation).toBe(1);
    const retiredRowCount = 4;
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(
      retiredRowCount,
    );
    const retriedRetirement = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send(retirementRequest);
    expect(retriedRetirement.status, JSON.stringify(retriedRetirement.body)).toBe(200);
    expect(retriedRetirement.body.server.retirement).toEqual(retired.body.server.retirement);
    const identity = {
      vaultId: vault.id,
      generation: retired.body.server.retirement.generation as number,
      versionSetHash: retired.body.server.retirement.versionSetHash as string,
    };
    expect(identity.versionSetHash).toBe(
      createHash('sha256')
        .update(
          serializeVaultRetirementVersionSet([
            { docId: vault.headerDocId, docVersion: 1 },
            { docId: vault.headerDocId, docVersion: 7 },
            { docId: vault.headerDocId, docVersion: 3 },
            { docId: vault.commonDocId, docVersion: 1 },
          ]),
        )
        .digest('base64url'),
    );

    const challenge = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge/challenge`)
      .set(...XRW)
      .send(identity);
    expect(challenge.status).toBe(200);
    const unsigned = {
      ...identity,
      observedDocs: docs,
      challenge: challenge.body.challenge as string,
      signature: 'A'.repeat(86),
    };
    const validSignature = sign(
      null,
      Buffer.from(serializePerVaultRetiredServerPurgeTranscript(unsigned)),
      keys.privateKey,
    ).toString('base64url');
    const partialUnsigned = { ...unsigned, observedDocs: [docs[0]!] };
    const partialSignature = sign(
      null,
      Buffer.from(serializePerVaultRetiredServerPurgeTranscript(partialUnsigned)),
      keys.privateKey,
    ).toString('base64url');
    const incompleteReadback = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...partialUnsigned, signature: partialSignature });
    expect(incompleteReadback.status).toBe(412);
    expect(incompleteReadback.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(
      retiredRowCount,
    );

    const wrongRosterUnsigned = {
      ...unsigned,
      observedDocs: [docs[0]!, { ...docs[1]!, docId: UNKNOWN_DOC_ID }],
    };
    const wrongRosterSignature = sign(
      null,
      Buffer.from(serializePerVaultRetiredServerPurgeTranscript(wrongRosterUnsigned)),
      keys.privateKey,
    ).toString('base64url');
    const wrongRoster = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...wrongRosterUnsigned, signature: wrongRosterSignature });
    expect(wrongRoster.status).toBe(412);
    expect(wrongRoster.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(
      retiredRowCount,
    );

    const retained = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...unsigned, signature: validSignature });
    expect(retained.status).toBe(409);
    expect(retained.body.error.code).toBe('VAULT_RETIRED_SERVER_RETENTION');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(
      retiredRowCount,
    );

    // Deterministic TEST VECTOR: old enough to clear §7 retention while the
    // already-issued short-lived challenge remains valid.
    await h.db
      .update(vaultRetirements)
      .set({ retiredAt: new Date('2026-08-01T00:00:00.000Z') })
      .where(eq(vaultRetirements.vaultId, vault.id));

    const forged = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send(unsigned);
    expect(forged.status).toBe(412);
    expect(forged.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_INVALID');

    const expiredChallenge = expiredPurgeChallenge(h.ctx.config.sessionSecrets[0]!, {
      userId: user.id,
      ...identity,
    });
    const expiredUnsigned = { ...unsigned, challenge: expiredChallenge };
    const expiredSignature = sign(
      null,
      Buffer.from(serializePerVaultRetiredServerPurgeTranscript(expiredUnsigned)),
      keys.privateKey,
    ).toString('base64url');
    const expired = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...expiredUnsigned, signature: expiredSignature });
    expect(expired.status).toBe(412);
    expect(expired.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_INVALID');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(
      retiredRowCount,
    );

    const stale = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...unsigned, generation: identity.generation + 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');
    const staleHash = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...unsigned, versionSetHash: 'B'.repeat(43) });
    expect(staleHash.status).toBe(409);
    expect(staleHash.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(
      retiredRowCount,
    );
    const purged = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({
        vaultId: vault.id,
        generation: identity.generation,
        versionSetHash: identity.versionSetHash,
        observedDocs: docs,
        challenge: challenge.body.challenge,
        signature: validSignature,
      });
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(0);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetirements))[0]?.value)).toBe(
      0,
    );
    const deletedAfterPurge = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(deletedAfterPurge.status, JSON.stringify(deletedAfterPurge.body)).toBe(200);
  });

  it('rotates the candidate receipt on re-stage so an old candidateId cannot satisfy transition', async () => {
    const user = await h.seedUser({
      email: 'e1-candidate-restage@bt.test',
      username: 'e1_candidate_restage',
    });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-candidate-restage-google-sub',
        email: 'candidate-restage@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
    });
    const transitionId = newId();
    const stage = (docId: string, blob: Buffer) =>
      agent
        .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${docId}`)
        .set(...XRW)
        .set(...OCTET)
        .send(blob);
    const read = (candidateId: string) =>
      agent
        .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${candidateId}`)
        .responseType('blob');

    const oldHeader = await stage(
      vault.headerDocId,
      envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: 1,
        writeId: newId(),
      }),
    );
    expect(oldHeader.status).toBe(200);
    const oldReadback = await read(oldHeader.body.candidateId as string);
    expect(oldReadback.status).toBe(200);

    const replacementHeader = await stage(
      vault.headerDocId,
      envelope({
        vaultId: vault.id,
        docId: vault.headerDocId,
        docKind: 'header',
        docVersion: 2,
        writeId: newId(),
      }),
    );
    expect(replacementHeader.status).toBe(200);
    expect(replacementHeader.body.candidateId).not.toBe(oldHeader.body.candidateId);
    const replacementReadback = await read(replacementHeader.body.candidateId as string);
    expect(replacementReadback.status).toBe(200);

    const stagedCommon = await stage(
      vault.commonDocId,
      envelope({
        vaultId: vault.id,
        docId: vault.commonDocId,
        docKind: 'common',
        docVersion: 1,
        writeId: newId(),
      }),
    );
    expect(stagedCommon.status).toBe(200);
    const commonReadback = await read(stagedCommon.body.candidateId as string);
    expect(commonReadback.status).toBe(200);

    const rejected = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId,
        expected: {
          media: ['drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive', 'server'], driveConnectionId: connection.id },
        verification: {
          kind: 'server-candidates',
          readbacks: [
            {
              candidateId: oldHeader.body.candidateId,
              docId: vault.headerDocId,
              readback: oldReadback.headers['x-bettertrack-vault-candidate-readback'],
            },
            {
              candidateId: stagedCommon.body.candidateId,
              docId: vault.commonDocId,
              readback: commonReadback.headers['x-bettertrack-vault-candidate-readback'],
            },
          ],
        },
      });
    expect(rejected.status).toBe(412);
    expect(rejected.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');
    const state = await agent.get(`/api/v1/vaults/${vault.id}/media`);
    expect(state.body.media).toEqual(['drive']);
    expect(
      state.body.server.candidates.map(({ candidateId }: { candidateId: string }) => candidateId),
    ).toContain(replacementHeader.body.candidateId);
  });

  it('refuses server re-add while retired rows exist so purge remains reachable before promotion', async () => {
    const user = await h.seedUser({
      email: 'e1-retire-before-readd@bt.test',
      username: 'e1_retire_before_readd',
    });
    const agent = await login(h.app, user);
    const keys = proofKeys();
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-retire-before-readd-google-sub',
        email: 'retire-before-readd@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['server', 'drive'],
      driveConnectionId: connection.id,
      publicKey: keys.publicKey,
    });
    const docs = [
      {
        docId: vault.headerDocId,
        docKind: 'header' as const,
        docVersion: 1,
        writeId: newId(),
      },
      {
        docId: vault.commonDocId,
        docKind: 'common' as const,
        docVersion: 1,
        writeId: newId(),
      },
    ].map((doc) => ({ ...doc, blob: envelope({ vaultId: vault.id, ...doc }) }));
    for (const doc of docs) {
      expect((await putDoc(agent, vault.id, doc.docId, doc.blob, { create: true })).status).toBe(
        204,
      );
    }
    const retired = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: newId(),
        expected: {
          media: ['server', 'drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive'], driveConnectionId: connection.id },
        verification: {
          kind: 'drive',
          driveConnectionId: connection.id,
          docs: docs.map(({ docId, docVersion, writeId }) => ({
            docId,
            docVersion,
            writeId,
          })),
        },
      });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);

    const transitionId = newId();
    const readbacks: PerVaultServerCandidateReadback[] = [];
    for (const doc of docs) {
      const staged = await agent
        .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${doc.docId}`)
        .set(...XRW)
        .set(...OCTET)
        .send(doc.blob);
      expect(staged.status).toBe(200);
      const readback = await agent
        .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${staged.body.candidateId}`)
        .responseType('blob');
      expect(readback.status).toBe(200);
      readbacks.push({
        candidateId: staged.body.candidateId as string,
        docId: doc.docId,
        readback: readback.headers['x-bettertrack-vault-candidate-readback'] as string,
      });
    }

    const refused = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId,
        expected: {
          media: ['drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: retired.body.mediaAttestedAt,
        },
        next: { media: ['drive', 'server'], driveConnectionId: connection.id },
        verification: { kind: 'server-candidates', readbacks },
      });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('VAULT_RETIREMENT_PENDING');
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultServerCandidates)
            .where(eq(vaultServerCandidates.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(0);
    const state = await agent.get(`/api/v1/vaults/${vault.id}/media`);
    expect(state.body.media).toEqual(['drive']);
    expect(state.body.server.retirement).toEqual(retired.body.server.retirement);
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultRetired)
            .where(eq(vaultRetired.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(2);

    // Deterministic TEST VECTOR: old enough to clear §7 retention while the
    // challenge issued immediately below remains valid.
    await h.db
      .update(vaultRetirements)
      .set({ retiredAt: new Date('2026-08-01T00:00:00.000Z') })
      .where(eq(vaultRetirements.vaultId, vault.id));
    const identity = {
      vaultId: vault.id,
      generation: retired.body.server.retirement.generation as number,
      versionSetHash: retired.body.server.retirement.versionSetHash as string,
    };
    const challenge = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge/challenge`)
      .set(...XRW)
      .send(identity);
    expect(challenge.status).toBe(200);
    const unsigned = {
      ...identity,
      observedDocs: docs.map(({ docId, docVersion, writeId }) => ({
        docId,
        docVersion,
        writeId,
      })),
      challenge: challenge.body.challenge as string,
      signature: 'A'.repeat(86),
    };
    const purged = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(serializePerVaultRetiredServerPurgeTranscript(unsigned)),
          keys.privateKey,
        ).toString('base64url'),
      });
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultRetirements)
            .where(eq(vaultRetirements.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(0);
  });

  it('binds every portfolio doc to one transition and rejects stale full-set facts', async () => {
    const user = await h.seedUser({
      email: 'e1-media-roster@bt.test',
      username: 'e1_media_roster',
    });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-media-roster-google-sub',
        email: 'roster-drive@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      name: 'Portfolio roster transition',
      media: ['drive'],
      driveConnectionId: connection.id,
      headerDocId: newId(),
      commonDocId: newId(),
    });
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Locked roster member', vaultId: vault.id })
      .returning();
    if (!portfolio) throw new Error('portfolio insert failed');

    const docs = [
      {
        docId: vault.headerDocId,
        docKind: 'header' as const,
        docVersion: 1,
        writeId: newId(),
      },
      {
        docId: vault.commonDocId,
        docKind: 'common' as const,
        docVersion: 1,
        writeId: newId(),
      },
      {
        docId: portfolio.id,
        docKind: 'portfolio' as const,
        docVersion: 1,
        writeId: newId(),
      },
    ].map((doc) => ({ ...doc, blob: envelope({ vaultId: vault.id, ...doc }) }));
    const transitionId = newId();
    const receipts: PerVaultServerCandidateReadback[] = [];
    for (const doc of docs) {
      const staged = await agent
        .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${doc.docId}`)
        .set(...XRW)
        .set(...OCTET)
        .send(doc.blob);
      expect(staged.status, JSON.stringify(staged.body)).toBe(200);
      const readback = await agent
        .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${staged.body.candidateId}`)
        .responseType('blob');
      expect(readback.status).toBe(200);
      expect(Buffer.from(readback.body as Buffer)).toEqual(doc.blob);
      receipts.push({
        candidateId: staged.body.candidateId as string,
        docId: doc.docId,
        readback: readback.headers['x-bettertrack-vault-candidate-readback'] as string,
      });
    }
    const transition = {
      transitionId,
      expected: { media: ['drive'], driveConnectionId: connection.id, mediaAttestedAt: null },
      next: { media: ['drive', 'server'], driveConnectionId: connection.id },
    };

    const missingPortfolio = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...transition,
        verification: { kind: 'server-candidates', readbacks: receipts.slice(0, 2) },
      });
    expect(missingPortfolio.status).toBe(412);
    expect(missingPortfolio.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');

    const crossedBatch = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...transition,
        transitionId: newId(),
        verification: { kind: 'server-candidates', readbacks: receipts },
      });
    expect(crossedBatch.status).toBe(412);
    expect(crossedBatch.body.error.code).toBe('VAULT_MEDIA_PARTIAL_SET');
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultBlobs)
            .where(eq(vaultBlobs.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(0);

    const promoted = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...transition,
        verification: { kind: 'server-candidates', readbacks: receipts },
      });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.mediaAttestedAt).toEqual(expect.any(String));
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultBlobs)
            .where(eq(vaultBlobs.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(3);

    const attestations = docs.map(({ docId, docVersion, writeId }) => ({
      docId,
      docVersion,
      writeId,
    }));
    const removal = {
      transitionId: newId(),
      expected: {
        media: ['drive', 'server'],
        driveConnectionId: connection.id,
        mediaAttestedAt: promoted.body.mediaAttestedAt as string,
      },
      next: { media: ['drive'], driveConnectionId: connection.id },
    };
    const staleFacts = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...removal,
        verification: {
          kind: 'drive',
          driveConnectionId: connection.id,
          docs: attestations.map((doc) =>
            doc.docId === portfolio.id ? { ...doc, writeId: newId() } : doc,
          ),
        },
      });
    expect(staleFacts.status).toBe(412);
    expect(staleFacts.body.error.code).toBe('VAULT_MEDIA_VERIFICATION_FAILED');
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultBlobs)
            .where(eq(vaultBlobs.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(3);

    const retired = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        ...removal,
        verification: { kind: 'drive', driveConnectionId: connection.id, docs: attestations },
      });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.server.retirement.generation).toBe(1);
    expect(
      Number(
        (
          await h.db
            .select({ value: count() })
            .from(vaultRetired)
            .where(eq(vaultRetired.vaultId, vault.id))
        )[0]?.value,
      ),
    ).toBe(3);
  });

  it('adds and removes Drive, replaces its connection, and replays each committed edge', async () => {
    const user = await h.seedUser({ email: 'e1-media-edges@bt.test', username: 'e1_media_edges' });
    const agent = await login(h.app, user);
    const [driveY, driveZ] = await h.db
      .insert(driveConnections)
      .values([
        {
          userId: user.id,
          googleSub: 'e1-media-edge-drive-y',
          email: 'drive-y@example.test',
        },
        {
          userId: user.id,
          googleSub: 'e1-media-edge-drive-z',
          email: 'drive-z@example.test',
        },
      ])
      .returning();
    if (!driveY || !driveZ) throw new Error('Drive connection insert failed');

    const serverVault = await createVault({
      user,
      agent,
      name: 'Server media edges',
    });
    const activeDocs: Array<
      PerVaultMediaDocAttestation & { docKind: 'header' | 'common'; blob: Buffer }
    > = [
      {
        docId: serverVault.headerDocId,
        docKind: 'header',
        docVersion: 1,
        writeId: newId(),
        blob: Buffer.alloc(0),
      },
      {
        docId: serverVault.commonDocId,
        docKind: 'common',
        docVersion: 1,
        writeId: newId(),
        blob: Buffer.alloc(0),
      },
    ];
    for (const doc of activeDocs) {
      doc.blob = envelope({ vaultId: serverVault.id, ...doc });
      expect(
        (await putDoc(agent, serverVault.id, doc.docId, doc.blob, { create: true })).status,
      ).toBe(204);
    }
    const attestations = activeDocs.map(({ docId, docVersion, writeId }) => ({
      docId,
      docVersion,
      writeId,
    }));

    const addDriveRequest = {
      transitionId: newId(),
      expected: { media: ['server'], driveConnectionId: null, mediaAttestedAt: null },
      next: { media: ['server', 'drive'], driveConnectionId: driveY.id },
      verification: { kind: 'drive', driveConnectionId: driveY.id, docs: attestations },
    };
    const added = await agent
      .patch(`/api/v1/vaults/${serverVault.id}/media`)
      .set(...XRW)
      .send(addDriveRequest);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body).toMatchObject({
      media: ['server', 'drive'],
      driveConnectionId: driveY.id,
      mediaAttestedDriveConnectionId: driveY.id,
    });
    const addedReplay = await agent
      .patch(`/api/v1/vaults/${serverVault.id}/media`)
      .set(...XRW)
      .send(addDriveRequest);
    expect(addedReplay.status, JSON.stringify(addedReplay.body)).toBe(200);
    expect(addedReplay.body).toEqual(added.body);

    const removeDriveRequest = {
      transitionId: newId(),
      expected: {
        media: ['server', 'drive'],
        driveConnectionId: driveY.id,
        mediaAttestedAt: added.body.mediaAttestedAt as string,
      },
      next: { media: ['server'], driveConnectionId: null },
      verification: { kind: 'server', docs: attestations },
    };
    const removed = await agent
      .patch(`/api/v1/vaults/${serverVault.id}/media`)
      .set(...XRW)
      .send(removeDriveRequest);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({
      media: ['server'],
      driveConnectionId: null,
      mediaAttestedDriveConnectionId: null,
    });
    const removedReplay = await agent
      .patch(`/api/v1/vaults/${serverVault.id}/media`)
      .set(...XRW)
      .send(removeDriveRequest);
    expect(removedReplay.status, JSON.stringify(removedReplay.body)).toBe(200);
    expect(removedReplay.body).toEqual(removed.body);

    const driveVault = await createVault({
      user,
      agent,
      name: 'Drive replacement edge',
      media: ['drive'],
      driveConnectionId: driveY.id,
      headerDocId: newId(),
      commonDocId: newId(),
    });
    const driveDocs: PerVaultMediaDocAttestation[] = [
      { docId: driveVault.headerDocId, docVersion: 1, writeId: newId() },
      { docId: driveVault.commonDocId, docVersion: 1, writeId: newId() },
    ];
    const replaceDriveRequest = {
      transitionId: newId(),
      expected: { media: ['drive'], driveConnectionId: driveY.id, mediaAttestedAt: null },
      next: { media: ['drive'], driveConnectionId: driveZ.id },
      verification: { kind: 'drive', driveConnectionId: driveZ.id, docs: driveDocs },
    };
    const replaced = await agent
      .patch(`/api/v1/vaults/${driveVault.id}/media`)
      .set(...XRW)
      .send(replaceDriveRequest);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toMatchObject({
      media: ['drive'],
      driveConnectionId: driveZ.id,
      mediaAttestedDriveConnectionId: driveZ.id,
    });
    const replacedReplay = await agent
      .patch(`/api/v1/vaults/${driveVault.id}/media`)
      .set(...XRW)
      .send(replaceDriveRequest);
    expect(replacedReplay.status, JSON.stringify(replacedReplay.body)).toBe(200);
    expect(replacedReplay.body).toEqual(replaced.body);
  });

  it('refuses removal of the last medium and the reserved local medium', async () => {
    const user = await h.seedUser({ email: 'e1-last@bt.test', username: 'e1_last' });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({ userId: user.id, googleSub: 'last-medium-sub', email: 'last@example.test' })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
    });
    const response = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: TRANSITION_ID,
        expected: {
          media: ['drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: [], driveConnectionId: null },
        verification: { kind: 'server', docs: [] },
      });
    expect(response.status).toBe(400);

    const reserved = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: newId(),
        expected: {
          media: ['drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive', 'local'], driveConnectionId: connection.id },
        verification: { kind: 'drive', driveConnectionId: connection.id, docs: [] },
      });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.code).toBe('VAULT_MEDIA_RESERVED');

    const reservedExpected = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: newId(),
        expected: {
          media: ['drive', 'local'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive'], driveConnectionId: connection.id },
        verification: { kind: 'drive', driveConnectionId: connection.id, docs: [] },
      });
    expect(reservedExpected.status).toBe(400);
    expect(reservedExpected.body.error.code).toBe('VAULT_MEDIA_RESERVED');
  });

  it('keeps generations monotonic, never numeric-gates re-add, and uses the pinned purge key', async () => {
    const user = await h.seedUser({ email: 'e1-rollback@bt.test', username: 'e1_rollback' });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-rollback-google-sub',
        email: 'rollback@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const keys = proofKeys();
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
      publicKey: keys.publicKey,
    });
    const retiredHeader = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 2,
      writeId: WRITE_IDS[1],
    });
    const retiredCommon = envelope({
      vaultId: vault.id,
      docId: vault.commonDocId,
      docKind: 'common',
      docVersion: 2,
      writeId: WRITE_IDS[2],
    });
    await h.db.insert(vaultRetired).values([
      {
        vaultId: vault.id,
        docId: vault.headerDocId,
        version: 2,
        formatVersion: 2,
        sizeBytes: retiredHeader.length,
        blob: retiredHeader,
        createdAt: new Date('2026-08-19T12:00:00.000Z'),
      },
      {
        vaultId: vault.id,
        docId: vault.commonDocId,
        version: 2,
        formatVersion: 2,
        sizeBytes: retiredCommon.length,
        blob: retiredCommon,
        createdAt: new Date('2026-08-19T12:00:00.000Z'),
      },
    ]);
    await h.db.insert(vaultRetirements).values({
      vaultId: vault.id,
      retirementProofPublicKey: keys.publicKey,
      generation: 1,
      retiredAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await h.db.update(vaults).set({ retirementGeneration: 1 }).where(eq(vaults.id, vault.id));

    const generationOneState = await agent.get(`/api/v1/vaults/${vault.id}/media`);
    expect(generationOneState.status).toBe(200);
    const generationOneIdentity = {
      vaultId: vault.id,
      generation: generationOneState.body.server.retirement.generation as number,
      versionSetHash: generationOneState.body.server.retirement.versionSetHash as string,
    };
    const generationOneChallenge = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge/challenge`)
      .set(...XRW)
      .send(generationOneIdentity);
    expect(generationOneChallenge.status).toBe(200);
    const generationOneUnsigned = {
      ...generationOneIdentity,
      observedDocs: [
        { docId: vault.headerDocId, docVersion: 2, writeId: WRITE_IDS[1] },
        { docId: vault.commonDocId, docVersion: 2, writeId: WRITE_IDS[2] },
      ],
      challenge: generationOneChallenge.body.challenge as string,
      signature: 'A'.repeat(86),
    };
    const generationOneRequest = {
      ...generationOneUnsigned,
      signature: sign(
        null,
        Buffer.from(serializePerVaultRetiredServerPurgeTranscript(generationOneUnsigned)),
        keys.privateKey,
      ).toString('base64url'),
    };
    const generationOnePurge = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send(generationOneRequest);
    expect(generationOnePurge.status, JSON.stringify(generationOnePurge.body)).toBe(200);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetirements))[0]?.value)).toBe(
      0,
    );
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(0);

    const transitionId = newId();
    const staleHeader = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: WRITE_IDS[0],
    });
    const freshCommon = envelope({
      vaultId: vault.id,
      docId: vault.commonDocId,
      docKind: 'common',
      docVersion: 3,
      writeId: WRITE_IDS[3],
    });
    const receipts: PerVaultServerCandidateReadback[] = [];
    for (const [docId, blob] of [
      [vault.headerDocId, staleHeader],
      [vault.commonDocId, freshCommon],
    ] as const) {
      const staged = await agent
        .put(`/api/v1/vaults/${vault.id}/media/server-candidate/${transitionId}/docs/${docId}`)
        .set(...XRW)
        .set(...OCTET)
        .send(blob);
      expect(staged.status).toBe(200);
      const read = await agent
        .get(`/api/v1/vaults/${vault.id}/media/server-candidate/${staged.body.candidateId}`)
        .responseType('blob');
      receipts.push({
        candidateId: staged.body.candidateId as string,
        docId,
        readback: read.headers['x-bettertrack-vault-candidate-readback'] as string,
      });
    }

    const promoted = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId,
        expected: {
          media: ['drive'],
          driveConnectionId: connection.id,
          mediaAttestedAt: null,
        },
        next: { media: ['drive', 'server'], driveConnectionId: connection.id },
        verification: { kind: 'server-candidates', readbacks: receipts },
      });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.media).toEqual(['drive', 'server']);
    expect(Number((await h.db.select({ value: count() }).from(vaultBlobs))[0]?.value)).toBe(2);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(0);
    expect(
      Number((await h.db.select({ value: count() }).from(vaultServerCandidates))[0]?.value),
    ).toBe(0);

    const currentDocs: PerVaultMediaDocAttestation[] = [
      { docId: vault.headerDocId, docVersion: 1, writeId: WRITE_IDS[0] },
      { docId: vault.commonDocId, docVersion: 3, writeId: WRITE_IDS[3] },
    ];
    const generationTwoRetirement = await agent
      .patch(`/api/v1/vaults/${vault.id}/media`)
      .set(...XRW)
      .send({
        transitionId: newId(),
        expected: {
          media: ['drive', 'server'],
          driveConnectionId: connection.id,
          mediaAttestedAt: promoted.body.mediaAttestedAt,
        },
        next: { media: ['drive'], driveConnectionId: connection.id },
        verification: {
          kind: 'drive',
          driveConnectionId: connection.id,
          docs: currentDocs,
        },
      });
    expect(generationTwoRetirement.status, JSON.stringify(generationTwoRetirement.body)).toBe(200);
    expect(generationTwoRetirement.body.server.retirement.generation).toBe(2);
    const [generationTwoRow] = await h.db
      .select()
      .from(vaultRetirements)
      .where(eq(vaultRetirements.vaultId, vault.id));
    expect(generationTwoRow?.generation).toBe(2);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(2);

    const staleGenerationReplay = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send(generationOneRequest);
    expect(staleGenerationReplay.status).toBe(409);
    expect(staleGenerationReplay.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(2);

    // The current config key is deliberately rotated after retirement. The
    // generation-2 proof must still use the verifier pinned in its retirement row.
    const rotatedKeys = proofKeys();
    await h.db
      .update(vaults)
      .set({ retirementProofPublicKey: rotatedKeys.publicKey })
      .where(eq(vaults.id, vault.id));
    await h.db
      .update(vaultRetirements)
      .set({ retiredAt: new Date('2026-08-01T00:00:00.000Z') })
      .where(eq(vaultRetirements.vaultId, vault.id));
    const generationTwoIdentity = {
      vaultId: vault.id,
      generation: generationTwoRetirement.body.server.retirement.generation as number,
      versionSetHash: generationTwoRetirement.body.server.retirement.versionSetHash as string,
    };
    const generationTwoChallenge = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge/challenge`)
      .set(...XRW)
      .send(generationTwoIdentity);
    expect(generationTwoChallenge.status).toBe(200);
    const generationTwoUnsigned = {
      ...generationTwoIdentity,
      observedDocs: currentDocs,
      challenge: generationTwoChallenge.body.challenge as string,
      signature: 'A'.repeat(86),
    };
    const signatureFromCurrentConfig = sign(
      null,
      Buffer.from(serializePerVaultRetiredServerPurgeTranscript(generationTwoUnsigned)),
      rotatedKeys.privateKey,
    ).toString('base64url');
    const wrongCurrentKey = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...generationTwoUnsigned, signature: signatureFromCurrentConfig });
    expect(wrongCurrentKey.status).toBe(412);
    expect(wrongCurrentKey.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_INVALID');
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(2);

    const signatureFromPinnedKey = sign(
      null,
      Buffer.from(serializePerVaultRetiredServerPurgeTranscript(generationTwoUnsigned)),
      keys.privateKey,
    ).toString('base64url');
    const pinnedKeyPurge = await agent
      .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
      .set(...XRW)
      .send({ ...generationTwoUnsigned, signature: signatureFromPinnedKey });
    expect(pinnedKeyPurge.status, JSON.stringify(pinnedKeyPurge.body)).toBe(200);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetired))[0]?.value)).toBe(0);
    expect(Number((await h.db.select({ value: count() }).from(vaultRetirements))[0]?.value)).toBe(
      0,
    );
  });

  it('maps legacy NULL-transition candidates to a stable refusal on both read paths', async () => {
    const user = await h.seedUser({
      email: 'e1-legacy-candidate@bt.test',
      username: 'e1_legacy_candidate',
    });
    const agent = await login(h.app, user);
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-legacy-candidate-google-sub',
        email: 'legacy-candidate@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');
    const vault = await createVault({
      user,
      agent,
      media: ['drive'],
      driveConnectionId: connection.id,
    });
    const blob = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
    });
    const [legacy] = await h.db
      .insert(vaultServerCandidates)
      .values({
        transitionId: null,
        vaultId: vault.id,
        docId: vault.headerDocId,
        version: 1,
        formatVersion: 2,
        sizeBytes: blob.length,
        blob,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!legacy) throw new Error('legacy candidate insert failed');

    for (const path of [
      `/api/v1/vaults/${vault.id}/media`,
      `/api/v1/vaults/${vault.id}/media/server-candidate/${legacy.id}`,
    ]) {
      const refused = await agent.get(path);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');
    }
  });
});

describe('E1 ownership, deletion gates, and limiter', () => {
  it('returns not-found for a foreign vault across every id-addressed route', async () => {
    const owner = await h.seedUser({ email: 'e1-owner@bt.test', username: 'e1_owner' });
    const ownerAgent = await login(h.app, owner);
    const vault = await createVault({ user: owner, agent: ownerAgent });
    const blob = envelope({
      vaultId: vault.id,
      docId: vault.headerDocId,
      docKind: 'header',
      docVersion: 1,
    });
    await putDoc(ownerAgent, vault.id, vault.headerDocId, blob, { create: true });
    const [ownerPortfolio] = await h.db
      .insert(portfolios)
      .values({ userId: owner.id, name: 'Foreign owned stub', vaultId: vault.id })
      .returning();
    if (!ownerPortfolio) throw new Error('portfolio insert failed');
    const ownerPortfolioBlob = envelope({
      vaultId: vault.id,
      docId: ownerPortfolio.id,
      docKind: 'portfolio',
      docVersion: 1,
    });
    expect(
      (await putDoc(ownerAgent, vault.id, ownerPortfolio.id, ownerPortfolioBlob, { create: true }))
        .status,
    ).toBe(204);
    const [candidate] = await h.db
      .insert(vaultServerCandidates)
      .values({
        transitionId: TRANSITION_ID,
        vaultId: vault.id,
        docId: vault.headerDocId,
        version: 1,
        formatVersion: 2,
        sizeBytes: blob.length,
        blob,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!candidate) throw new Error('candidate insert failed');

    const stranger = await h.seedUser({
      email: 'e1-stranger@bt.test',
      username: 'e1_stranger',
    });
    const strangerAgent = await login(h.app, stranger);
    const targetDriveId = newId();
    const calls = [
      () => strangerAgent.get(`/api/v1/vaults/${vault.id}`),
      () =>
        strangerAgent
          .patch(`/api/v1/vaults/${vault.id}`)
          .set(...XRW)
          .send({ name: 'Nope' }),
      () =>
        strangerAgent
          .delete(`/api/v1/vaults/${vault.id}`)
          .set(...XRW)
          .send({ stepUp: { password: stranger.password } }),
      () => strangerAgent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}`),
      () => strangerAgent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history`),
      () => strangerAgent.get(`/api/v1/vaults/${vault.id}/docs/${vault.headerDocId}/history/1`),
      () => strangerAgent.get(`/api/v1/vaults/${vault.id}/media`),
      () =>
        strangerAgent
          .patch(`/api/v1/vaults/${vault.id}/media`)
          .set(...XRW)
          .send({
            transitionId: TRANSITION_ID,
            expected: { media: ['server'], driveConnectionId: null, mediaAttestedAt: null },
            next: { media: ['server', 'drive'], driveConnectionId: targetDriveId },
            verification: { kind: 'drive', driveConnectionId: targetDriveId, docs: [] },
          }),
      () => strangerAgent.get(`/api/v1/vaults/${vault.id}/media/server-candidate/${candidate.id}`),
      () =>
        strangerAgent
          .post(`/api/v1/vaults/${vault.id}/media/retired/purge/challenge`)
          .set(...XRW)
          .send({ vaultId: vault.id, generation: 1, versionSetHash: 'A'.repeat(43) }),
      () =>
        strangerAgent
          .post(`/api/v1/vaults/${vault.id}/media/retired/purge`)
          .set(...XRW)
          .send({
            vaultId: vault.id,
            generation: 1,
            versionSetHash: 'A'.repeat(43),
            observedDocs: [],
            challenge: 'A'.repeat(32),
            signature: 'A'.repeat(86),
          }),
      () =>
        strangerAgent
          .put(
            `/api/v1/vaults/${vault.id}/media/server-candidate/${TRANSITION_ID}/docs/${vault.headerDocId}`,
          )
          .set(...XRW)
          .set(...OCTET)
          .send(blob),
      () => putDoc(strangerAgent, vault.id, vault.headerDocId, blob, { create: true }),
    ];
    const responses = [];
    for (const call of calls) responses.push(await call());
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: responses.length }, () => 404),
    );
    const list = await strangerAgent.get('/api/v1/vaults');
    expect(list.body.vaults).toEqual([]);

    const [strangerDrive] = await h.db
      .insert(driveConnections)
      .values({
        userId: stranger.id,
        googleSub: 'e1-foreign-doc-drive-sub',
        email: 'foreign-doc-drive@example.test',
      })
      .returning();
    if (!strangerDrive) throw new Error('connection insert failed');
    const strangerVault = await createVault({
      user: stranger,
      agent: strangerAgent,
      name: 'Stranger owned Drive vault',
      media: ['drive'],
      driveConnectionId: strangerDrive.id,
      headerDocId: newId(),
      commonDocId: newId(),
    });
    const foreignDocBlob = envelope({
      vaultId: strangerVault.id,
      docId: ownerPortfolio.id,
      docKind: 'portfolio',
      docVersion: 1,
    });
    const foreignDocCalls = [
      () => strangerAgent.get(`/api/v1/vaults/${strangerVault.id}/docs/${ownerPortfolio.id}`),
      () =>
        putDoc(strangerAgent, strangerVault.id, ownerPortfolio.id, foreignDocBlob, {
          create: true,
        }),
      () =>
        strangerAgent.get(`/api/v1/vaults/${strangerVault.id}/docs/${ownerPortfolio.id}/history`),
      () =>
        strangerAgent.get(`/api/v1/vaults/${strangerVault.id}/docs/${ownerPortfolio.id}/history/1`),
      () =>
        strangerAgent
          .put(
            `/api/v1/vaults/${strangerVault.id}/media/server-candidate/${newId()}/docs/${ownerPortfolio.id}`,
          )
          .set(...XRW)
          .set(...OCTET)
          .send(foreignDocBlob),
    ];
    const foreignDocResponses = [];
    for (const call of foreignDocCalls) foreignDocResponses.push(await call());
    expect(foreignDocResponses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404,
    ]);
  });

  it('performs delete step-up before revealing whether the vault exists', async () => {
    const user = await h.seedUser({
      email: 'e1-delete-existence@bt.test',
      username: 'e1_delete_existence',
    });
    const agent = await login(h.app, user);
    const unknownVaultId = newId();

    const unverified = await agent
      .delete(`/api/v1/vaults/${unknownVaultId}`)
      .set(...XRW)
      .send({ stepUp: { password: 'definitely-wrong' } });
    expect(unverified.status).toBe(401);
    expect(unverified.body.error.code).toBe('INVALID_CREDENTIALS');

    const verified = await agent
      .delete(`/api/v1/vaults/${unknownVaultId}`)
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(verified.status).toBe(404);
    expect(verified.body.error.code).toBe('VAULT_NOT_FOUND');
  });

  it('requires step-up, refuses portfolio + retirement gates, and then deletes', async () => {
    const user = await h.seedUser({ email: 'e1-delete@bt.test', username: 'e1_delete' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });

    const missing = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({});
    expect(missing.status).toBe(400);

    const unenrolledFactor = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { code: '123456' } });
    expect(unenrolledFactor.status).toBe(401);
    expect(unenrolledFactor.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');

    const wrong = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: 'definitely-wrong' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const failedAudit = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vault.delete_reauth_fail'));
    expect(failedAudit).toHaveLength(2);

    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Delete gate stub', vaultId: vault.id })
      .returning();
    const invalidWhileReferenced = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: 'still-definitely-wrong' } });
    expect(invalidWhileReferenced.status).toBe(401);
    expect(invalidWhileReferenced.body.error.code).toBe('INVALID_CREDENTIALS');
    const referenced = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(referenced.status).toBe(409);
    expect(referenced.body.error.code).toBe('VAULT_REFERENCED_BY_PORTFOLIO');
    await h.db.update(portfolios).set({ vaultId: null }).where(eq(portfolios.id, portfolio!.id));

    await h.db.insert(vaultRetirements).values({
      vaultId: vault.id,
      retirementProofPublicKey: proofKeys().publicKey,
      generation: 1,
    });
    const gated = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(gated.status).toBe(409);
    expect(gated.body.error.code).toBe('VAULT_RETIREMENT_PENDING');
    await h.db.delete(vaultRetirements).where(eq(vaultRetirements.vaultId, vault.id));

    const deleted = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
  });

  it('accepts fresh TOTP and one-time recovery-code delete step-up', async () => {
    const totpUser = await h.seedUser({ email: 'e1-totp@bt.test', username: 'e1_totp' });
    const enrollmentAgent = await login(h.app, totpUser);
    const totpVault = await createVault({ user: totpUser, agent: enrollmentAgent });
    const totp = await enrollTotp(enrollmentAgent);
    const totpAgent = await loginWithTotp(totpUser, totp.secret);
    const totpDelete = await totpAgent
      .delete(`/api/v1/vaults/${totpVault.id}`)
      .set(...XRW)
      .send({
        stepUp: {
          code: generateTotpCode(totp.secret, Date.now() + TOTP_STEP_SECONDS * 1000),
        },
      });
    expect(totpDelete.status, JSON.stringify(totpDelete.body)).toBe(200);

    // A fresh harness is intentional: enrollment invalidates all sessions and
    // the singleton test DB lifecycle cannot host two live harnesses at once.
    h = await createTestApp();
    const recoveryUser = await h.seedUser({
      email: 'e1-recovery@bt.test',
      username: 'e1_recovery',
    });
    const recoveryEnrollmentAgent = await login(h.app, recoveryUser);
    const recoveryVault = await createVault({
      user: recoveryUser,
      agent: recoveryEnrollmentAgent,
    });
    const replayVault = await createVault({
      user: recoveryUser,
      agent: recoveryEnrollmentAgent,
      name: 'Recovery replay vault',
      headerDocId: newId(),
      commonDocId: newId(),
    });
    const recovery = await enrollTotp(recoveryEnrollmentAgent);
    const recoveryAgent = await loginWithTotp(recoveryUser, recovery.secret);
    const recoveryDelete = await recoveryAgent
      .delete(`/api/v1/vaults/${recoveryVault.id}`)
      .set(...XRW)
      .send({ stepUp: { recoveryCode: recovery.recoveryCodes[0] } });
    expect(recoveryDelete.status, JSON.stringify(recoveryDelete.body)).toBe(200);
    const replayedRecoveryCode = await recoveryAgent
      .delete(`/api/v1/vaults/${replayVault.id}`)
      .set(...XRW)
      .send({ stepUp: { recoveryCode: recovery.recoveryCodes[0] } });
    expect(replayedRecoveryCode.status).toBe(401);
    expect(replayedRecoveryCode.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
  });

  it('progressively throttles wrong delete credentials and audits the failures', async () => {
    const user = await h.seedUser({ email: 'e1-throttle@bt.test', username: 'e1_throttle' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    // The verifier closes over this schedule object. Lowering its test-only
    // allowance proves the same production progressive limiter without 11 hashes.
    h.ctx.config.rateLimits.loginAccount.limit = 2;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await agent
        .delete(`/api/v1/vaults/${vault.id}`)
        .set(...XRW)
        .send({ stepUp: { password: 'wrong-password' } });
      expect(response.status).toBe(401);
    }
    const tripped = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: 'wrong-password' } });
    expect(tripped.status).toBe(429);
    const correctWhileCooling = await agent
      .delete(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(correctWhileCooling.status).toBe(429);
    const audits = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vault.delete_reauth_fail'));
    expect(audits).toHaveLength(3);
  });

  it('maps a deferred portfolio FK raised at COMMIT to the stable referenced result', async () => {
    const user = await h.seedUser({ email: 'e1-commit-fk@bt.test', username: 'e1_commit_fk' });
    const [vault] = await h.db
      .insert(vaults)
      .values({
        userId: user.id,
        name: 'Commit FK vault',
        headerDocId: HEADER_DOC_ID,
        commonDocId: COMMON_DOC_ID,
        media: ['server'],
        retirementProofPublicKey: proofKeys().publicKey,
        keyFingerprint: FINGERPRINT,
      })
      .returning();
    const result = await createVaultRepository(h.db).delete({
      userId: user.id,
      vaultId: vault!.id,
      verifyStepUp: async (_auth, tx) => {
        await tx
          .insert(portfolios)
          .values({ userId: user.id, name: 'Late deferred reference', vaultId: vault!.id });
      },
    });
    expect(result).toEqual({ status: 'referenced' });
  });

  it('maps a deferred blob/stub FK raised at COMMIT and rolls the write back', async () => {
    const user = await h.seedUser({ email: 'e1-blob-commit-fk@bt.test', username: 'e1_blob_fk' });
    const [vault] = await h.db
      .insert(vaults)
      .values({
        userId: user.id,
        name: 'Blob commit FK vault',
        headerDocId: HEADER_DOC_ID,
        commonDocId: COMMON_DOC_ID,
        media: ['server'],
        retirementProofPublicKey: proofKeys().publicKey,
        keyFingerprint: FINGERPRINT,
      })
      .returning();
    const [portfolio] = await h.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Deferred blob stub', vaultId: vault!.id })
      .returning();
    const blob = envelope({
      vaultId: vault!.id,
      docId: portfolio!.id,
      docKind: 'portfolio',
      docVersion: 1,
    });

    // PostgreSQL checks this DEFERRABLE FK after the transaction callback.
    // Inject that exact commit boundary so the repository's outer catch—not
    // an in-callback branch—is what maps the stable R1 refusal.
    const commitFailingDb = {
      transaction: (callback: (rawTx: unknown) => Promise<unknown>) =>
        h.db.transaction(async (rawTx) => {
          await callback(rawTx);
          throw {
            code: '23503',
            constraint: 'vault_blobs_portfolio_id_portfolios_id_fk',
          };
        }),
    } as unknown as Database;
    const result = await createVaultBlobRepository(commitFailingDb).compareAndSwap({
      userId: user.id,
      vaultId: vault!.id,
      docId: portfolio!.id,
      header: readVaultDocServerHeader(blob),
      expectedVersion: null,
      blob,
      retention: { maxVersions: 10, maxAgeMs: 30 * 24 * 60 * 60 * 1_000 },
      now: new Date('2026-08-20T12:00:00.000Z'),
    });
    expect(result).toEqual({ status: 'portfolio_binding_mismatch' });
    expect(Number((await h.db.select({ value: count() }).from(vaultBlobs))[0]?.value)).toBe(0);
  });

  it('maps deferred Drive FKs raised at COMMIT and rolls config/media writes back', async () => {
    const user = await h.seedUser({ email: 'e1-drive-commit-fk@bt.test', username: 'e1_drive_fk' });
    const [connection] = await h.db
      .insert(driveConnections)
      .values({
        userId: user.id,
        googleSub: 'e1-drive-commit-fk-sub',
        email: 'drive-commit-fk@example.test',
      })
      .returning();
    if (!connection) throw new Error('connection insert failed');

    // PostgreSQL reports these DEFERRABLE constraints after the repository's
    // callback returns. Proxy every other database operation to the real test
    // database so transitionMedia can also construct its owner-scoped 4xx state.
    const failAtCommit = (constraint: string): Database =>
      new Proxy(h.db, {
        get(target, property) {
          if (property === 'transaction') {
            return (callback: (rawTx: unknown) => Promise<unknown>) =>
              h.db.transaction(async (rawTx) => {
                await callback(rawTx);
                throw { code: '23503', constraint };
              });
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    const createResult = await createVaultRepository(
      failAtCommit('vaults_drive_connection_id_drive_connections_id_fk'),
    ).create({
      userId: user.id,
      name: 'Deferred Drive create',
      headerDocId: newId(),
      commonDocId: newId(),
      media: ['drive'],
      driveConnectionId: connection.id,
      retirementProofPublicKey: proofKeys().publicKey,
      keyFingerprint: FINGERPRINT,
    });
    expect(createResult).toEqual({ status: 'drive_not_found' });
    expect(Number((await h.db.select({ value: count() }).from(vaults))[0]?.value)).toBe(0);

    const headerDocId = newId();
    const commonDocId = newId();
    const [vault] = await h.db
      .insert(vaults)
      .values({
        userId: user.id,
        name: 'Deferred Drive transition',
        headerDocId,
        commonDocId,
        media: ['server'],
        retirementProofPublicKey: proofKeys().publicKey,
        keyFingerprint: FINGERPRINT,
      })
      .returning();
    if (!vault) throw new Error('vault insert failed');
    const headerWriteId = newId();
    const commonWriteId = newId();
    const headerBlob = envelope({
      vaultId: vault.id,
      docId: headerDocId,
      docKind: 'header',
      docVersion: 1,
      writeId: headerWriteId,
    });
    const commonBlob = envelope({
      vaultId: vault.id,
      docId: commonDocId,
      docKind: 'common',
      docVersion: 1,
      writeId: commonWriteId,
    });
    await h.db.insert(vaultBlobs).values([
      {
        vaultId: vault.id,
        docId: headerDocId,
        docKind: 'header',
        portfolioId: null,
        version: 1,
        formatVersion: 2,
        sizeBytes: headerBlob.length,
        blob: headerBlob,
      },
      {
        vaultId: vault.id,
        docId: commonDocId,
        docKind: 'common',
        portfolioId: null,
        version: 1,
        formatVersion: 2,
        sizeBytes: commonBlob.length,
        blob: commonBlob,
      },
    ]);
    const request: PerVaultMediaTransitionRequest = {
      transitionId: newId(),
      expected: { media: ['server'], driveConnectionId: null, mediaAttestedAt: null },
      next: { media: ['server', 'drive'], driveConnectionId: connection.id },
      verification: {
        kind: 'drive',
        driveConnectionId: connection.id,
        docs: [
          { docId: headerDocId, docVersion: 1, writeId: headerWriteId },
          { docId: commonDocId, docVersion: 1, writeId: commonWriteId },
        ],
      },
    };
    // Deterministic TEST VECTOR time: only the rolled-back attestation stamp uses it.
    const transitionResult = await createVaultBlobRepository(
      failAtCommit('vaults_media_attested_drive_connection_fk'),
    ).transitionMedia({
      userId: user.id,
      vaultId: vault.id,
      request,
      verifiedCandidateIds: new Set(),
      now: new Date('2026-08-20T12:00:00.000Z'),
    });
    expect(transitionResult).toMatchObject({
      status: 'drive_not_found',
      current: {
        media: ['server'],
        driveConnectionId: null,
        mediaAttestedAt: null,
      },
    });
    const [storedVault] = await h.db.select().from(vaults).where(eq(vaults.id, vault.id));
    expect(storedVault).toMatchObject({
      media: ['server'],
      driveConnectionId: null,
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
    });
    expect(Number((await h.db.select({ value: count() }).from(vaultBlobs))[0]?.value)).toBe(2);
  });

  it('keeps vault read and write limiter budgets independent', async () => {
    h = await createTestApp({
      env: {
        BT_VAULT_RATE_LIMIT: '1',
        BT_VAULT_READ_RATE_LIMIT: '1',
        BT_VAULT_RATE_WINDOW_SEC: '60',
      },
      rateLimitsEnabled: true,
    });
    const user = await h.seedUser({ email: 'e1-limit@bt.test', username: 'e1_limit' });
    const agent = await login(h.app, user);
    const vault = await createVault({ user, agent });
    // Express serves HEAD through the GET route; it must share the read budget,
    // not consume the mutation allowance.
    const firstRead = await agent.head('/api/v1/vaults');
    expect(firstRead.status).toBe(200);
    const limitedRead = await agent.get('/api/v1/vaults');
    expect(limitedRead.status).toBe(429);
    expect(limitedRead.body.error.code).toBe('RATE_LIMITED');
    const limitedWrite = await agent
      .patch(`/api/v1/vaults/${vault.id}`)
      .set(...XRW)
      .send({ name: 'Write budget already consumed' });
    expect(limitedWrite.status).toBe(429);
    expect(limitedWrite.body.error.code).toBe('RATE_LIMITED');
  });
});
