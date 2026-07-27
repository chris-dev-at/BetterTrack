import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  encodeVaultEnvelope,
  VAULT_CONTENT_CIPHER,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_VERSION_MAX,
} from '@bettertrack/contracts';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { paranoidVaultHistory, paranoidVaults, users } from '../data/schema';
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

function mediaProof(medium: 'server' | 'drive', vaultVersion: number, blob: Buffer) {
  return {
    medium,
    vaultVersion,
    envelopeSha256: createHash('sha256').update(blob).digest('hex'),
    verifiedAt: new Date().toISOString(),
  };
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
  return loginAgent(harness.app, user.email, 'user-strong-password-1');
}

describe('vault blob store', () => {
  it('requires an authenticated session', async () => {
    const res = await request(harness.app).get('/api/v1/vault');
    expect(res.status).toBe(401);
  });

  it('404s before any blob exists', async () => {
    const agent = await seedAndLogin('alice@bt.test', 'alice');
    const res = await agent.get('/api/v1/vault');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('VAULT_NOT_FOUND');
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
    expect(stale.headers.etag).toBe('"2"');

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

  it('retires a fabricated Drive assertion non-destructively, gates purge, then removes all bytes', async () => {
    const agent = await seedAndLogin('media@bt.test', 'media', 'paranoid');
    const v1 = envelope(1, new Uint8Array([1]));
    const v2 = envelope(2, new Uint8Array([2, 2]));
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
      .send(v2);

    const added = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expectedMediaSet: ['server'],
        mediaSet: ['server', 'drive'],
        verification: mediaProof('drive', 2, v2),
      });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 2,
    });

    // This is intentionally only a client assertion (there is no Drive
    // capability server-side). Even if fabricated from the known server bytes,
    // the PATCH can only retire: every byte remains owner-restorable.
    const removed = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expectedMediaSet: ['server', 'drive'],
        mediaSet: ['drive'],
        verification: mediaProof('drive', 2, v2),
      });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      mediaSet: ['drive'],
      driveAttestedVersion: 2,
      retiredServer: { latestVersion: 2 },
    });
    expect((await agent.get('/api/v1/vault')).status).toBe(404);

    const retained = await agent.get('/api/v1/vault/history');
    expect(retained.body.items.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    const restored = await agent.get('/api/v1/vault/history/2').responseType('blob');
    expect((restored.body as Buffer).equals(v2)).toBe(true);
    const [mediaUser] = await harness.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'media@bt.test'));
    expect(
      await harness.db
        .select()
        .from(paranoidVaults)
        .where(eq(paranoidVaults.userId, mediaUser!.id)),
    ).toHaveLength(0);

    const tooEarly = await agent
      .post('/api/v1/account/paranoid/media/server/purge')
      .set(...XRW)
      .send({ proof: mediaProof('drive', 2, v2) });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('VAULT_RETIRED_RETENTION_REQUIRED');

    const oldEnough = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await harness.db.update(paranoidVaultHistory).set({ retiredAt: oldEnough });

    const badProof = await agent
      .post('/api/v1/account/paranoid/media/server/purge')
      .set(...XRW)
      .send({
        proof: mediaProof('drive', 2, envelope(2, new Uint8Array([9]))),
      });
    expect(badProof.status).toBe(422);
    expect(badProof.body.error.code).toBe('VAULT_RETIRED_PURGE_PROOF_INVALID');
    expect((await agent.get('/api/v1/vault/history/2')).status).toBe(200);

    const purged = await agent
      .post('/api/v1/account/paranoid/media/server/purge')
      .set(...XRW)
      .send({ proof: mediaProof('drive', 2, v2) });
    expect(purged.status).toBe(200);
    expect(purged.body).toMatchObject({ purgedVersions: 2 });
    expect((await agent.get('/api/v1/vault/history')).body.items).toEqual([]);
  });

  it('rejects an empty or two-medium jump without changing the active server vault', async () => {
    const agent = await seedAndLogin('closed@bt.test', 'closed', 'paranoid');
    const v1 = envelope(1, new Uint8Array([1]));
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v1);

    const empty = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({ expectedMediaSet: ['server'], mediaSet: [] });
    expect(empty.status).toBe(400);

    const direct = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expectedMediaSet: ['server'],
        mediaSet: ['drive'],
        verification: mediaProof('drive', 1, v1),
      });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('VAULT_MEDIA_TRANSITION_INVALID');
    expect((await agent.get('/api/v1/vault')).status).toBe(200);
  });

  it('rejects a stale server staging copy after a newer version was retired to Drive-only', async () => {
    const agent = await seedAndLogin('staging@bt.test', 'staging', 'paranoid');
    const v2 = envelope(2, new Uint8Array([2]));
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v2);
    await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expectedMediaSet: ['server'],
        mediaSet: ['server', 'drive'],
        verification: mediaProof('drive', 2, v2),
      });
    await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expectedMediaSet: ['server', 'drive'],
        mediaSet: ['drive'],
        verification: mediaProof('drive', 2, v2),
      });

    const stale = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('VAULT_MALFORMED');
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    expect((await agent.get('/api/v1/vault/history/2')).status).toBe(200);
  });
});
