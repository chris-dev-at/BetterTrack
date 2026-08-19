import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  encodeVaultEnvelope,
  createOAuthClientResponseSchema,
  oauthTokenResponseSchema,
  serializeRetiredServerPurgeTranscript,
  VAULT_CONTENT_CIPHER,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER,
  VAULT_SERVER_CANDIDATE_READBACK_HEADER,
  VAULT_VERSION_MAX,
} from '@bettertrack/contracts';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
  paranoidVaultServerCandidates,
  paranoidVaults,
  users,
} from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Build a valid opaque vault envelope carrying the given version + ciphertext. */
function envelope(vaultVersion: number, ciphertext: Uint8Array): Buffer {
  const header = {
    formatVersion: 1,
    cipher: VAULT_CONTENT_CIPHER,
    iv: 'aXYtOTZiaXQ=',
    keyId: UUID_A,
    wrappedKeys: [
      {
        keyId: UUID_A,
        kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
        wrappedVk: 'd3JhcHBlZA==',
      },
    ],
    vaultVersion,
    schemaVersion: 1,
    deviceId: UUID_B,
    writeId: UUID_C,
    writtenAt: '2026-07-24T10:00:00.000Z',
  };
  return Buffer.from(encodeVaultEnvelope(header, ciphertext));
}

async function seedAndLogin(
  email: string,
  username: string,
  privacyMode: 'normal' | 'paranoid' = 'normal',
): Promise<Agent> {
  const user = await harness.seedUser({ email, username, password: 'user-strong-password-1' });
  if (privacyMode === 'paranoid') {
    await harness.db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(users.id, user.id));
  }
  const agent = await loginAgent(harness.app, user.email, 'user-strong-password-1');
  if (privacyMode === 'normal') {
    // The real enable wizard opens this owner-only staging window with its
    // capture revision before probing/writing the selected server medium.
    await agent.get('/api/v1/account/paranoid/normal-revision').expect(200);
  }
  return agent;
}

async function seedParanoidAgent(email: string, username: string) {
  const user = await harness.seedUser({ email, username, password: 'user-strong-password-1' });
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
      paranoidDriveAttestedVersion: null,
    })
    .where(eq(users.id, user.id));
  return { user, agent: await loginAgent(harness.app, user.email, 'user-strong-password-1') };
}

function retirementProofKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

function purgeSignature(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  retiredVersion: number,
  observedVersion: number,
  challenge: string,
): string {
  return sign(
    null,
    Buffer.from(
      serializeRetiredServerPurgeTranscript({ retiredVersion, observedVersion, challenge }),
    ),
    privateKey,
  ).toString('base64url');
}

async function mintDelegatedSecurityToken(): Promise<string> {
  const tag = randomBytes(5).toString('hex');
  const user = await harness.seedUser({
    email: `oauth-vault-${tag}@bt.test`,
    username: `oauthvault${tag}`,
    password: 'user-strong-password-1',
  });
  const agent = await loginAgent(harness.app, user.email, 'user-strong-password-1');
  const registered = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Vault bearer test',
      redirectUris: ['https://app.example/vault-callback'],
      scopes: ['account:security'],
      public: true,
    });
  expect(registered.status).toBe(201);
  const client = createOAuthClientResponseSchema.parse(registered.body).client;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorized = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: client.clientId,
      redirect_uri: 'https://app.example/vault-callback',
      scope: 'account:security',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(authorized.status).toBe(200);
  const code = new URL(authorized.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();
  const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://app.example/vault-callback',
    client_id: client.clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  return oauthTokenResponseSchema.parse(exchanged.body).access_token;
}

describe('vault blob store', () => {
  it('requires an authenticated owner', async () => {
    const res = await request(harness.app).get('/api/v1/vault');
    expect(res.status).toBe(401);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('404s before any blob exists', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice');
    const res = await agent.get('/api/v1/vault');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('VAULT_NOT_FOUND');
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('creates, reads back byte-identical, and conditionally 304s', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice');
    const ciphertext = new Uint8Array([0, 255, 16, 42, 200, 7]);
    const blob = envelope(1, ciphertext);

    const created = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(blob);
    expect(created.status).toBe(204);
    expect(created.headers.etag).toBe('"1"');

    const read = await agent.get('/api/v1/vault').responseType('blob');
    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toContain('application/octet-stream');
    expect(read.headers.etag).toBe('"1"');
    // The server stored and returned the exact opaque bytes — never parsed the
    // ciphertext.
    expect((read.body as Buffer).equals(blob)).toBe(true);

    const notModified = await agent.get('/api/v1/vault').set('If-None-Match', '"1"');
    expect(notModified.status).toBe(304);
  });

  it('replaces on a matching If-Match and rejects a stale one without overwriting', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice');
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));

    const v2 = envelope(2, new Uint8Array([2, 2]));
    const replaced = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v2);
    expect(replaced.status).toBe(204);
    expect(replaced.headers.etag).toBe('"2"');

    // A writer still on version 1 tries to overwrite — 412, and the current
    // ciphertext is untouched.
    const stale = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(envelope(2, new Uint8Array([9, 9, 9])));
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('VAULT_PRECONDITION_FAILED');
    // #1161 keeps validators off error responses; the winner's version rides
    // the BODY instead (r3 regression guard — the loser must not need a second
    // GET /vault just to learn the current version).
    expect(stale.headers.etag).toBeUndefined();
    expect(stale.headers['last-modified']).toBeUndefined();
    expect(stale.body.currentVersion).toBe(2);

    const read = await agent.get('/api/v1/vault').responseType('blob');
    expect(read.headers.etag).toBe('"2"');
    expect((read.body as Buffer).equals(v2)).toBe(true);
  });

  it('rejects a write with no precondition', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice');
    const res = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .send(envelope(1, new Uint8Array([1])));
    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('VAULT_PRECONDITION_REQUIRED');
  });

  it('rejects a malformed envelope', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice');
    const res = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(Buffer.from('not-an-envelope'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VAULT_MALFORMED');
  });

  it('scopes the vault strictly to its owner', async () => {
    const alice = await seedAndLogin('alice@bt.test', 'alice');
    await alice
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));

    const bob = await seedAndLogin('bob@bt.test', 'bob');
    const res = await bob.get('/api/v1/vault');
    expect(res.status).toBe(404);
  });

  it('lists safe metadata and reads one historical blob byte-identically', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice', 'paranoid');
    const v1 = envelope(1, new Uint8Array([7, 8, 9]));
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v1);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(envelope(2, new Uint8Array([10])));

    const list = await agent.get('/api/v1/vault/history');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      items: [
        {
          version: 1,
          createdAt: expect.any(String),
          sizeBytes: v1.length,
          medium: 'server',
        },
      ],
      nextCursor: null,
    });
    expect(Object.keys(list.body.items[0]).sort()).toEqual([
      'createdAt',
      'medium',
      'sizeBytes',
      'version',
    ]);
    const serialized = JSON.stringify(list.body);
    for (const forbiddenField of [
      'blob',
      'ciphertext',
      'documentHash',
      'entityNames',
      'decryptedRowCount',
      'formatVersion',
    ]) {
      expect(serialized).not.toContain(forbiddenField);
    }

    const read = await agent.get('/api/v1/vault/history/1').responseType('blob');
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    expect(read.headers['content-type']).toContain('application/octet-stream');
    expect(read.headers[VAULT_HISTORY_CREATED_AT_HEADER.toLowerCase()]).toBe(
      list.body.items[0].createdAt,
    );
    expect(read.headers[VAULT_HISTORY_SIZE_BYTES_HEADER.toLowerCase()]).toBe(String(v1.length));
    expect(read.headers[VAULT_HISTORY_MEDIUM_HEADER.toLowerCase()]).toBe('server');
    expect((read.body as Buffer).equals(v1)).toBe(true);
  });

  it('enforces authentication, paranoid account mode and owner scope on history', async () => {
    expect((await request(harness.app).get('/api/v1/vault/history')).status).toBe(401);

    const normal = await seedAndLogin('normal@bt.test', 'normal');
    const normalResult = await normal.get('/api/v1/vault/history');
    expect(normalResult.status).toBe(403);
    expect(normalResult.body.error.code).toBe('VAULT_PARANOID_MODE_REQUIRED');
    expect(normalResult.headers.etag).toBeUndefined();
    expect(normalResult.headers['last-modified']).toBeUndefined();

    const alice = await seedAndLogin('alice@bt.test', 'alice', 'paranoid');
    await alice
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));
    await alice
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(envelope(2, new Uint8Array([2])));

    const bob = await seedAndLogin('bob@bt.test', 'bob', 'paranoid');
    const bobList = await bob.get('/api/v1/vault/history');
    expect(bobList.status).toBe(200);
    expect(bobList.body).toEqual({ items: [], nextCursor: null });
    expect((await bob.get('/api/v1/vault/history/1')).status).toBe(404);
    expect((await alice.get('/api/v1/vault/history')).body.items).toHaveLength(1);
  });

  it('caps oversized history pages server-side and keyset-paginates the remainder', async () => {
    harness = await createTestApp({ env: { BT_VAULT_HISTORY_MAX_VERSIONS: '20' } });
    const agent = await seedAndLogin('pages@bt.test', 'pages', 'paranoid');
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));
    for (let version = 2; version <= 14; version += 1) {
      const response = await agent
        .put('/api/v1/vault')
        .set(...XRW)
        .set(...OCTET)
        .set('If-Match', `"${version - 1}"`)
        .send(envelope(version, new Uint8Array([version])));
      expect(response.status).toBe(204);
    }

    const first = await agent.get('/api/v1/vault/history?limit=1000');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(VAULT_HISTORY_PAGE_MAX);
    expect(first.body.items.map((item: { version: number }) => item.version)).toEqual([
      13, 12, 11, 10, 9, 8, 7, 6, 5, 4,
    ]);
    expect(first.body.nextCursor).toBe(4);

    const second = await agent.get(
      `/api/v1/vault/history?limit=1000&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items.map((item: { version: number }) => item.version)).toEqual([3, 2, 1]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('rejects history cursor and version overflow before querying PostgreSQL', async () => {
    const agent = await seedAndLogin('bounds@bt.test', 'bounds', 'paranoid');
    const overflow = VAULT_VERSION_MAX + 1;

    const list = await agent.get(`/api/v1/vault/history?cursor=${overflow}`);
    expect(list.status).toBe(400);
    expect(list.body.error.code).toBe('VALIDATION_ERROR');

    const read = await agent.get(`/api/v1/vault/history/${overflow}`);
    expect(read.status).toBe(400);
    expect(read.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an oversized payload before persistence', async () => {
    const smallHarness = await createTestApp({ env: { BT_VAULT_MAX_BYTES: '2048' } });
    const user = await smallHarness.seedUser({ email: 'big@bt.test', username: 'big' });
    const agent = await loginAgent(smallHarness.app, user.email, 'user-strong-password-1');
    await agent.get('/api/v1/account/paranoid/normal-revision').expect(200);
    const res = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(Buffer.alloc(4096, 7));
    expect(res.status).toBe(413);
    // Nothing was persisted.
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
  });

  it('applies the dedicated vault write rate limit', async () => {
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { BT_VAULT_RATE_LIMIT: '2' },
    });
    const user = await limited.seedUser({ email: 'rl@bt.test', username: 'rl' });
    const agent = await loginAgent(limited.app, user.email, 'user-strong-password-1');
    const hit = () =>
      agent
        .put('/api/v1/vault')
        .set(...XRW)
        .set(...OCTET)
        .set('If-None-Match', '*')
        .send(envelope(1, new Uint8Array([1])));
    // The first two requests fit the allowance; the third trips the vault limiter.
    await hit();
    await hit();
    const over = await hit();
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });
});

describe('durable paranoid server-media lifecycle', () => {
  it('requires vault:sync, not account:security, for widened media transitions', async () => {
    const user = await harness.seedUser({ email: 'key-vault@bt.test', username: 'keyvault' });
    const personal = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'vault test key',
      scopes: ['account:security'],
    });
    const personalResult = await request(harness.app)
      .patch('/api/v1/vault/media')
      .set('Authorization', `Bearer ${personal.token}`)
      .send({ mediaSet: ['server'], expectedVaultVersion: 1 });
    expect(personalResult.status).toBe(403);
    expect(personalResult.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const delegated = await mintDelegatedSecurityToken();
    const delegatedResult = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set('Authorization', `Bearer ${delegated}`)
      .send({ retiredVersion: 1 });
    expect(delegatedResult.status).toBe(403);
    expect(delegatedResult.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('enrols a legacy active vault into the immutable retirement verifier on its first CAS update', async () => {
    const { agent } = await seedParanoidAgent('legacy-proof@bt.test', 'legacyproof');
    const { publicKey } = retirementProofKey();
    const { publicKey: replacementKey } = retirementProofKey();
    const v1 = envelope(1, new Uint8Array([1]));
    const v2 = envelope(2, new Uint8Array([2]));
    const v3 = envelope(3, new Uint8Array([3]));

    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v1)
      .expect(204);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v2)
      .expect(204);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"2"')
      .send(v3)
      .expect(204);
    await agent
      .patch('/api/v1/vault/media')
      .set(...XRW)
      .send({
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { kind: 'drive', version: 3 },
      })
      .expect(200);
    const replacement = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"3"')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, replacementKey)
      .send(envelope(4, new Uint8Array([4])));
    expect(replacement.status).toBe(409);
  });

  it('rejects a non-Ed25519 verifier before active or candidate server media is enrolled', async () => {
    const { user, agent } = await seedParanoidAgent('invalid-proof@bt.test', 'invalidproof');
    const x25519ProofKey = generateKeyPairSync('x25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url');
    const v1 = envelope(1, new Uint8Array([1]));

    const active = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, x25519ProofKey)
      .send(v1);
    expect(active.status).toBe(400);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);

    await harness.db
      .update(users)
      .set({ paranoidMediaSet: ['drive'], paranoidDriveAttestedVersion: 1 })
      .where(eq(users.id, user.id));
    const candidate = await agent
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, x25519ProofKey)
      .send(v1);
    expect(candidate.status).toBe(400);
    const rows = await harness.db
      .select()
      .from(paranoidVaultServerCandidates)
      .where(eq(paranoidVaultServerCandidates.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it('does not promote a Drive-only candidate without a retirement verifier', async () => {
    const { user, agent } = await seedParanoidAgent('missing-proof@bt.test', 'missingproof');
    const v1 = envelope(1, new Uint8Array([1, 2, 3]));
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 1 };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 1 };

    await harness.db
      .update(users)
      .set({ paranoidMediaSet: driveOnly.mediaSet, paranoidDriveAttestedVersion: 1 })
      .where(eq(users.id, user.id));

    // Staging can remain resumable without the header, but those bytes must
    // never become active because they would be impossible to retire safely.
    const staged = await agent
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .send(v1);
    expect(staged.status).toBe(200);
    const candidateId = staged.body.candidateId as string;
    const readback = await agent
      .get(`/api/v1/vault/media/server-candidate/${candidateId}`)
      .responseType('blob');
    expect(readback.status).toBe(200);

    const promotion = await agent
      .patch('/api/v1/vault/media')
      .set(...XRW)
      .send({
        expected: driveOnly,
        nextMediaSet: both.mediaSet,
        verification: {
          kind: 'server-candidate',
          candidateId,
          readback: readback.headers[
            VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
          ] as string,
        },
      });
    expect(promotion.status).toBe(409);
    expect(promotion.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_REQUIRED');
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    const media = await agent.get('/api/v1/vault/media');
    expect(media.body.mediaState.server.disposition).toBe('inactive-candidate');
    expect(media.body.mediaState.server.candidate.candidateId).toBe(candidateId);
  });

  it('moves bytes through candidate and retirement states before a retained, advanced-version purge', async () => {
    const { user, agent } = await seedParanoidAgent('lifecycle@bt.test', 'lifecycle');
    const { privateKey, publicKey } = retirementProofKey();
    const { privateKey: invalidPrivateKey } = retirementProofKey();
    const v1 = envelope(1, new Uint8Array([1, 2, 3]));
    const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 1 };
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 1 };
    const patchMedia = (body: Record<string, unknown>) =>
      agent
        .patch('/api/v1/vault/media')
        .set(...XRW)
        .send(body);

    expect(
      (
        await agent
          .put('/api/v1/vault')
          .set(...XRW)
          .set(...OCTET)
          .set('If-None-Match', '*')
          .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
          .send(v1)
      ).status,
    ).toBe(204);
    expect(
      (
        await patchMedia({
          expected: serverOnly,
          nextMediaSet: both.mediaSet,
          verification: { kind: 'drive', version: 1 },
        })
      ).status,
    ).toBe(200);
    const retired = await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    });
    expect(retired.status).toBe(200);
    expect(retired.body.server.disposition).toBe('retired');
    expect(JSON.stringify(retired.body)).not.toContain('ciphertext');
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    expect((await agent.get('/api/v1/vault/history/1').responseType('blob')).body.equals(v1)).toBe(
      true,
    );

    const staged = await agent
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1);
    expect(staged.status).toBe(200);
    const candidateId = staged.body.candidateId as string;

    // A candidate is still server-held ciphertext. Even a valid proof after
    // the recovery window must not report a completed purge while that blob is
    // present; otherwise a successful response would leave server bytes behind.
    await harness.db
      .update(paranoidVaultRetirements)
      .set({ retiredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(paranoidVaultRetirements.userId, user.id));
    const candidatePurgeChallenge = await agent
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(...XRW)
      .send({ retiredVersion: 1 });
    expect(candidatePurgeChallenge.status).toBe(200);
    const candidatePurge = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({
        retiredVersion: 1,
        observedVersion: 2,
        challenge: candidatePurgeChallenge.body.challenge as string,
        signature: purgeSignature(
          privateKey,
          1,
          2,
          candidatePurgeChallenge.body.challenge as string,
        ),
      });
    expect(candidatePurge.status).toBe(409);
    expect(candidatePurge.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');
    expect((await agent.get('/api/v1/vault/history/1')).status).toBe(200);
    const candidate = await agent
      .get(`/api/v1/vault/media/server-candidate/${candidateId}`)
      .responseType('blob');
    expect(candidate.status).toBe(200);
    expect((candidate.body as Buffer).equals(v1)).toBe(true);
    const readback = candidate.headers[
      VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
    ] as string;

    // A fabricated verification cannot activate staged bytes; the durable
    // selection remains Drive-only and there is still no active server blob.
    const failedPromotion = await patchMedia({
      expected: driveOnly,
      nextMediaSet: both.mediaSet,
      verification: {
        kind: 'server-candidate',
        candidateId,
        readback: 'fabricated-candidate-readback-token'.repeat(2),
      },
    });
    expect(failedPromotion.status).toBe(412);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);

    // Restore the ordinary retention clock so the later assertion covers the
    // pending-to-successful purge transition independently of the candidate
    // conflict above.
    await harness.db
      .update(paranoidVaultRetirements)
      .set({ retiredAt: new Date() })
      .where(eq(paranoidVaultRetirements.userId, user.id));
    const promoted = await patchMedia({
      expected: driveOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'server-candidate', candidateId, readback },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.server.disposition).toBe('active');
    expect((await agent.get('/api/v1/vault').responseType('blob')).body.equals(v1)).toBe(true);

    const serverOnlyAgain = await patchMedia({
      expected: both,
      nextMediaSet: serverOnly.mediaSet,
      verification: { kind: 'server', version: 1 },
    });
    expect(serverOnlyAgain.status).toBe(200);
    expect(serverOnlyAgain.body.mediaSet).toEqual(['server']);
    const staleTransition = await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    });
    expect(staleTransition.status).toBe(409);
    expect(
      (
        await patchMedia({
          expected: serverOnly,
          nextMediaSet: both.mediaSet,
          verification: { kind: 'drive', version: 1 },
        })
      ).status,
    ).toBe(200);
    // Same-version re-retirement reuses the byte-identical retirement row
    // deterministically instead of raising a uniqueness error.
    expect(
      (
        await patchMedia({
          expected: both,
          nextMediaSet: driveOnly.mediaSet,
          verification: { kind: 'drive', version: 1 },
        })
      ).status,
    ).toBe(200);
    // A lost response retries idempotently once the target is already durable.
    expect(
      (
        await patchMedia({
          expected: both,
          nextMediaSet: driveOnly.mediaSet,
          verification: { kind: 'drive', version: 1 },
        })
      ).status,
    ).toBe(200);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);

    const prepared = await agent
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(...XRW)
      .send({ retiredVersion: 1 });
    expect(prepared.status).toBe(200);
    const challenge = prepared.body.challenge as string;
    const advancedProof = {
      retiredVersion: 1,
      observedVersion: 2,
      challenge,
      signature: purgeSignature(privateKey, 1, 2, challenge),
    };
    const invalidProof = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({
        ...advancedProof,
        signature: purgeSignature(invalidPrivateKey, 1, 2, challenge),
      });
    expect(invalidProof.status).toBe(412);
    expect(invalidProof.body).toEqual({
      error: {
        code: 'VAULT_RETIRED_SERVER_PROOF_INVALID',
        message: 'The retired-server purge proof is malformed, stale, or does not verify.',
      },
    });
    const beforeRetention = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send(advancedProof);
    expect(beforeRetention.status).toBe(409);
    expect(beforeRetention.body).toEqual({
      error: {
        code: 'VAULT_RETIRED_SERVER_RETENTION',
        message: 'The retired server recovery window has not elapsed.',
      },
    });
    expect((await agent.get('/api/v1/vault/history/1')).status).toBe(200);

    await harness.db
      .update(paranoidVaultRetirements)
      .set({ retiredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(paranoidVaultRetirements.userId, user.id));
    const purged = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send(advancedProof);
    expect(purged.status).toBe(200);
    expect(purged.body).toEqual({ purged: true });
    expect((await agent.get('/api/v1/vault/history')).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await agent.get('/api/v1/vault/history/1')).status).toBe(404);
  });

  it('purges a retired current vault and its bounded history after a signed retention proof', async () => {
    const { user, agent } = await seedParanoidAgent('purge-history@bt.test', 'purgehistory');
    const { privateKey, publicKey } = retirementProofKey();
    const v1 = envelope(1, new Uint8Array([1, 2, 3]));
    const v2 = envelope(2, new Uint8Array([4, 5, 6]));
    const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 2 };
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 2 };

    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1)
      .expect(204);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v2)
      .expect(204);

    await agent
      .patch('/api/v1/vault/media')
      .set(...XRW)
      .send({
        expected: serverOnly,
        nextMediaSet: both.mediaSet,
        verification: { kind: 'drive', version: 2 },
      })
      .expect(200);
    await agent
      .patch('/api/v1/vault/media')
      .set(...XRW)
      .send({
        expected: both,
        nextMediaSet: driveOnly.mediaSet,
        verification: { kind: 'drive', version: 2 },
      })
      .expect(200);

    // Retiring v2 moves both it and the bounded v1 history into the protected
    // retired set, so a successful purge must dispose of every server copy.
    const retiredHistory = await agent.get('/api/v1/vault/history');
    expect(retiredHistory.body.items.map((item: { version: number }) => item.version)).toEqual([
      2, 1,
    ]);
    expect((await agent.get('/api/v1/vault/history/1').responseType('blob')).status).toBe(200);
    expect((await agent.get('/api/v1/vault/history/2').responseType('blob')).status).toBe(200);

    await harness.db
      .update(paranoidVaultRetirements)
      .set({ retiredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(paranoidVaultRetirements.userId, user.id));
    const prepared = await agent
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(...XRW)
      .send({ retiredVersion: 2 });
    expect(prepared.status).toBe(200);
    const challenge = prepared.body.challenge as string;
    const purged = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({
        retiredVersion: 2,
        observedVersion: 3,
        challenge,
        signature: purgeSignature(privateKey, 2, 3, challenge),
      });
    expect(purged.status).toBe(200);
    expect(purged.body).toEqual({ purged: true });

    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    expect((await agent.get('/api/v1/vault/history/1')).status).toBe(404);
    expect((await agent.get('/api/v1/vault/history/2')).status).toBe(404);
    const media = await agent.get('/api/v1/vault/media');
    expect(media.body.mediaState.server.disposition).toBe('empty');
    expect(media.body.mediaState.server.candidate).toBeNull();
    expect(media.body.mediaState.server.retired).toBeNull();

    const serverCiphertextRows = await Promise.all([
      harness.db
        .select({ blob: paranoidVaults.blob })
        .from(paranoidVaults)
        .where(eq(paranoidVaults.userId, user.id)),
      harness.db
        .select({ blob: paranoidVaultHistory.blob })
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, user.id)),
      harness.db
        .select({ blob: paranoidVaultRetired.blob })
        .from(paranoidVaultRetired)
        .where(eq(paranoidVaultRetired.userId, user.id)),
      harness.db
        .select({ blob: paranoidVaultServerCandidates.blob })
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, user.id)),
    ]);
    expect(serverCiphertextRows).toEqual([[], [], [], []]);
  });

  it('removes an abandoned expired candidate while reporting media state', async () => {
    const { user, agent } = await seedParanoidAgent(
      'expired-candidate@bt.test',
      'expiredcandidate',
    );
    const { privateKey, publicKey } = retirementProofKey();
    const v1 = envelope(1, new Uint8Array([1, 2, 3]));
    const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 1 };
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 1 };
    const patchMedia = (body: Record<string, unknown>) =>
      agent
        .patch('/api/v1/vault/media')
        .set(...XRW)
        .send(body);

    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1)
      .expect(204);
    await patchMedia({
      expected: serverOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'drive', version: 1 },
    }).expect(200);
    await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    }).expect(200);

    const staged = await agent
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1);
    expect(staged.status).toBe(200);
    await harness.db
      .update(paranoidVaultServerCandidates)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(paranoidVaultServerCandidates.userId, user.id));
    await harness.db
      .update(paranoidVaultRetirements)
      .set({ retiredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(paranoidVaultRetirements.userId, user.id));

    // A reload cannot use the now-expired candidate ID. The state endpoint must
    // dispose of its ciphertext in the same transaction instead of only hiding
    // its metadata from the response.
    const media = await agent.get('/api/v1/vault/media');
    expect(media.status).toBe(200);
    expect(media.body.mediaState.server.disposition).toBe('retired');
    expect(media.body.mediaState.server.candidate).toBeNull();
    expect(
      await harness.db
        .select({ id: paranoidVaultServerCandidates.id })
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, user.id)),
    ).toEqual([]);

    const prepared = await agent
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(...XRW)
      .send({ retiredVersion: 1 });
    expect(prepared.status).toBe(200);
    const challenge = prepared.body.challenge as string;
    const purged = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({
        retiredVersion: 1,
        observedVersion: 2,
        challenge,
        signature: purgeSignature(privateKey, 1, 2, challenge),
      });
    expect(purged.status).toBe(200);
    expect((await agent.get('/api/v1/vault/history/1')).status).toBe(404);
    const afterPurge = await agent.get('/api/v1/vault/media');
    expect(afterPurge.body.mediaState.server.disposition).toBe('empty');
  });

  it('rejects a stale candidate promotion after another browser promotes a different candidate', async () => {
    const { user, agent: firstBrowser } = await seedParanoidAgent(
      'concurrent-candidate@bt.test',
      'concurrentcandidate',
    );
    const secondBrowser = await loginAgent(harness.app, user.email, 'user-strong-password-1');
    const { publicKey } = retirementProofKey();
    const firstBytes = envelope(1, new Uint8Array([1, 2, 3]));
    const secondBytes = envelope(1, new Uint8Array([4, 5, 6]));
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 1 };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 1 };

    await harness.db
      .update(users)
      .set({ paranoidMediaSet: driveOnly.mediaSet, paranoidDriveAttestedVersion: 1 })
      .where(eq(users.id, user.id));

    const firstCandidate = await firstBrowser
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(firstBytes);
    expect(firstCandidate.status).toBe(200);
    const firstCandidateId = firstCandidate.body.candidateId as string;
    const firstReadback = await firstBrowser
      .get(`/api/v1/vault/media/server-candidate/${firstCandidateId}`)
      .responseType('blob');
    expect(firstReadback.status).toBe(200);
    const firstReceipt = firstReadback.headers[
      VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
    ] as string;

    const secondCandidate = await secondBrowser
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(secondBytes);
    expect(secondCandidate.status).toBe(200);
    const secondCandidateId = secondCandidate.body.candidateId as string;
    expect(secondCandidateId).not.toBe(firstCandidateId);
    const secondReadback = await secondBrowser
      .get(`/api/v1/vault/media/server-candidate/${secondCandidateId}`)
      .responseType('blob');
    expect(secondReadback.status).toBe(200);
    const secondReceipt = secondReadback.headers[
      VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
    ] as string;

    await secondBrowser
      .patch('/api/v1/vault/media')
      .set(...XRW)
      .send({
        expected: driveOnly,
        nextMediaSet: both.mediaSet,
        verification: {
          kind: 'server-candidate',
          candidateId: secondCandidateId,
          readback: secondReceipt,
        },
      })
      .expect(200);

    // The first browser still has a valid receipt for its own candidate, but
    // that candidate lost the race. A target-only retry must not claim that it
    // promoted bytes belonging to the other browser.
    const stalePromotion = await firstBrowser
      .patch('/api/v1/vault/media')
      .set(...XRW)
      .send({
        expected: driveOnly,
        nextMediaSet: both.mediaSet,
        verification: {
          kind: 'server-candidate',
          candidateId: firstCandidateId,
          readback: firstReceipt,
        },
      });
    expect(stalePromotion.status).toBe(409);
    expect(stalePromotion.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');
    const active = await secondBrowser.get('/api/v1/vault').responseType('blob');
    expect(active.status).toBe(200);
    expect((active.body as Buffer).equals(secondBytes)).toBe(true);
  });

  it('fails closed for a conflicting same-version candidate and proofs derived without the vault key', async () => {
    const { agent } = await seedParanoidAgent('proofs@bt.test', 'proofs');
    const { privateKey, publicKey } = retirementProofKey();
    const { privateKey: fabricatedPrivateKey } = retirementProofKey();
    const v1 = envelope(1, new Uint8Array([1]));
    const v2 = envelope(2, new Uint8Array([2]));
    const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 2 };
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 2 };
    const patchMedia = (body: Record<string, unknown>) =>
      agent
        .patch('/api/v1/vault/media')
        .set(...XRW)
        .send(body);

    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1)
      .expect(204);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v2)
      .expect(204);
    await patchMedia({
      expected: serverOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'drive', version: 2 },
    }).expect(200);
    await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 2 },
    }).expect(200);

    // Downloading the raw retired envelope gives only opaque bytes. A different
    // signing key cannot turn that history response into a destructive proof.
    const retiredRead = await agent.get('/api/v1/vault/history/2').responseType('blob');
    expect(retiredRead.status).toBe(200);
    expect((retiredRead.body as Buffer).equals(v2)).toBe(true);
    const staleCandidate = await agent
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1);
    expect(staleCandidate.status).toBe(412);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    const staged = await agent
      .put('/api/v1/vault/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(envelope(2, new Uint8Array([9, 9, 9])));
    expect(staged.status).toBe(200);
    const candidateId = staged.body.candidateId as string;
    const candidate = await agent
      .get(`/api/v1/vault/media/server-candidate/${candidateId}`)
      .responseType('blob');
    const conflict = await patchMedia({
      expected: driveOnly,
      nextMediaSet: both.mediaSet,
      verification: {
        kind: 'server-candidate',
        candidateId,
        readback: candidate.headers[VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()] as string,
      },
    });
    expect(conflict.status).toBe(409);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    expect((await agent.get('/api/v1/vault/history/2').responseType('blob')).body.equals(v2)).toBe(
      true,
    );

    const prepared = await agent
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(...XRW)
      .send({ retiredVersion: 2 });
    const challenge = prepared.body.challenge as string;
    const fabricated = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({
        retiredVersion: 2,
        observedVersion: 2,
        challenge,
        signature: purgeSignature(fabricatedPrivateKey, 2, 2, challenge),
      });
    expect(fabricated.status).toBe(412);
    const lower = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({
        retiredVersion: 2,
        observedVersion: 1,
        challenge,
        signature: purgeSignature(privateKey, 2, 1, challenge),
      });
    expect(lower.status).toBe(412);
    const malformed = await agent
      .post('/api/v1/vault/media/retired/purge')
      .set(...XRW)
      .send({ retiredVersion: 2, observedVersion: 2, challenge, signature: 'bad' });
    expect(malformed.status).toBe(400);
    expect((await agent.get('/api/v1/vault/history/2')).status).toBe(200);
  });
});
