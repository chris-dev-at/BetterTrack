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

import { paranoidVaultServerCandidates, users } from '../data/schema';
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
});

describe('paranoid media endpoint', () => {
  async function prepareMediaProof(
    agent: Agent,
    claim: {
      expected: { mediaSet: ('server' | 'drive')[]; driveAttestedVersion: number | null };
      nextMediaSet: ('server' | 'drive')[];
      verification: {
        medium: 'server' | 'drive';
        version: number;
        serverCandidateId?: string;
      };
    },
  ): Promise<string> {
    const response = await agent
      .post('/api/v1/account/paranoid/media/verification')
      .set(...XRW)
      .send(claim);
    expect(response.status).toBe(200);
    expect(response.body.proof).toEqual(expect.any(String));
    return response.body.proof as string;
  }

  it('returns portfolio-free state and rejects normal-mode or empty-set PATCHes', async () => {
    const normal = await seedAndLogin('normal-media@bt.test', 'normal-media');
    expect((await normal.get('/api/v1/account/paranoid/media')).body).toEqual({
      privacyMode: 'normal',
      mediaState: null,
    });
    const normalPatch = await normal
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { medium: 'drive', version: 1, proof: 'x'.repeat(32) },
      });
    expect(normalPatch.status).toBe(403);
    expect(normalPatch.body.error.code).toBe('VAULT_PARANOID_MODE_REQUIRED');

    const paranoid = await seedAndLogin('empty-media@bt.test', 'empty-media', 'paranoid');
    const empty = await paranoid
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: [],
        verification: { medium: 'server', version: 1, proof: 'x'.repeat(32) },
      });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('atomically reaches Drive-only and leaves zero current/history server bytes', async () => {
    const agent = await seedAndLogin('drive-only@bt.test', 'drive-only', 'paranoid');
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(envelope(2, new Uint8Array([2])));

    const addClaim = {
      expected: { mediaSet: ['server'] as ('server' | 'drive')[], driveAttestedVersion: null },
      nextMediaSet: ['server', 'drive'] as ('server' | 'drive')[],
      verification: { medium: 'drive' as const, version: 2 },
    };
    const addProof = await prepareMediaProof(agent, addClaim);
    const add = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        ...addClaim,
        verification: { ...addClaim.verification, proof: addProof },
      });
    expect(add.status).toBe(200);
    expect(add.body).toEqual({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: null,
    });

    // The first transition proof records Drive as live but cannot authorize the
    // destructive follow-up. Until a distinct post-commit authenticated
    // round-trip attests Drive, even the proof endpoint fails closed and the
    // server ciphertext remains authoritative.
    const unverifiedRemovalClaim = {
      expected: {
        mediaSet: ['server', 'drive'] as ('server' | 'drive')[],
        driveAttestedVersion: null,
      },
      nextMediaSet: ['drive'] as ('server' | 'drive')[],
      verification: { medium: 'drive' as const, version: 2 },
    };
    const unverifiedRemoval = await agent
      .post('/api/v1/account/paranoid/media/verification')
      .set(...XRW)
      .send(unverifiedRemovalClaim);
    expect(unverifiedRemoval.status).toBe(412);
    expect(unverifiedRemoval.body.error.code).toBe('VAULT_MEDIA_VERIFICATION_FAILED');
    expect((await agent.get('/api/v1/vault')).status).toBe(200);

    // Both copies advance in the authenticated client before a medium is
    // removed. The same-set proof refreshes the durable Drive attestation from
    // null to v3 instead of leaving both-media accounts permanently stuck.
    const advanced = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"2"')
      .send(envelope(3, new Uint8Array([3])));
    expect(advanced.status).toBe(204);
    const refreshClaim = {
      expected: {
        mediaSet: ['server', 'drive'] as ('server' | 'drive')[],
        driveAttestedVersion: null,
      },
      nextMediaSet: ['server', 'drive'] as ('server' | 'drive')[],
      verification: { medium: 'drive' as const, version: 3 },
    };
    const refreshProof = await prepareMediaProof(agent, refreshClaim);
    const refreshed = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        ...refreshClaim,
        verification: { ...refreshClaim.verification, proof: refreshProof },
      });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.driveAttestedVersion).toBe(3);

    // A proof is one-transition-only: replaying the add proof cannot authorize
    // the destructive second PATCH.
    const replayed = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expected: { mediaSet: ['server', 'drive'], driveAttestedVersion: 3 },
        nextMediaSet: ['drive'],
        verification: { medium: 'drive', version: 3, proof: addProof },
      });
    expect(replayed.status).toBe(412);
    expect((await agent.get('/api/v1/vault')).status).toBe(200);

    const removeClaim = {
      expected: {
        mediaSet: ['server', 'drive'] as ('server' | 'drive')[],
        driveAttestedVersion: 3,
      },
      nextMediaSet: ['drive'] as ('server' | 'drive')[],
      verification: { medium: 'drive' as const, version: 3 },
    };
    const removeProof = await prepareMediaProof(agent, removeClaim);
    const remove = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        ...removeClaim,
        verification: { ...removeClaim.verification, proof: removeProof },
      });
    expect(remove.status).toBe(200);
    expect(remove.body).toEqual({ mediaSet: ['drive'], driveAttestedVersion: 3 });
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    expect((await agent.get('/api/v1/vault/history')).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await agent.get('/api/v1/account/paranoid/media')).body).toEqual({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['drive'], driveAttestedVersion: 3 },
    });

    // The ordinary blob endpoint cannot pre-write an inactive server medium.
    const forbiddenPrewrite = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(4, new Uint8Array([4])));
    expect(forbiddenPrewrite.status).toBe(409);
    expect(forbiddenPrewrite.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');
    expect((await agent.get('/api/v1/vault')).status).toBe(404);

    // Staging is explicitly NOT activation. A failed operation can discard its
    // inactive bytes without creating a live head or history.
    const driveSource = envelope(4, new Uint8Array([4]));
    const abandoned = await agent
      .put('/api/v1/account/paranoid/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .send(driveSource);
    expect(abandoned.status).toBe(200);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);
    expect((await agent.get('/api/v1/account/paranoid/media')).body.mediaState).toEqual({
      mediaSet: ['drive'],
      driveAttestedVersion: 3,
    });
    expect(
      (
        await agent
          .delete(
            `/api/v1/account/paranoid/media/server-candidate/${abandoned.body.candidateId as string}`,
          )
          .set(...XRW)
      ).status,
    ).toBe(200);
    expect(await harness.db.select().from(paranoidVaultServerCandidates)).toEqual([]);

    // Expired candidates are deleted on bounded read and can never be promoted.
    const expiring = await agent
      .put('/api/v1/account/paranoid/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .send(driveSource);
    await harness.db
      .update(paranoidVaultServerCandidates)
      .set({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(paranoidVaultServerCandidates.id, expiring.body.candidateId as string));
    expect(
      (
        await agent.get(
          `/api/v1/account/paranoid/media/server-candidate/${expiring.body.candidateId as string}`,
        )
      ).status,
    ).toBe(404);
    expect(await harness.db.select().from(paranoidVaultServerCandidates)).toEqual([]);

    // Successful order is literal: write inactive candidate → raw readback →
    // proof-bound PATCH promotion. Only the final step activates server.
    const staged = await agent
      .put('/api/v1/account/paranoid/media/server-candidate')
      .set(...XRW)
      .set(...OCTET)
      .send(driveSource);
    expect(staged.status).toBe(200);
    const stagedRead = await agent
      .get(`/api/v1/account/paranoid/media/server-candidate/${staged.body.candidateId as string}`)
      .responseType('blob');
    expect(stagedRead.status).toBe(200);
    expect((stagedRead.body as Buffer).equals(driveSource)).toBe(true);
    expect((await agent.get('/api/v1/vault')).status).toBe(404);

    const restoreClaim = {
      expected: {
        mediaSet: ['drive'] as ('server' | 'drive')[],
        driveAttestedVersion: 3,
      },
      nextMediaSet: ['server', 'drive'] as ('server' | 'drive')[],
      verification: {
        medium: 'server' as const,
        version: 4,
        serverCandidateId: staged.body.candidateId as string,
      },
    };
    const restoreProof = await prepareMediaProof(agent, restoreClaim);
    const restoredServer = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        ...restoreClaim,
        verification: { ...restoreClaim.verification, proof: restoreProof },
      });
    expect(restoredServer.status).toBe(200);
    expect(restoredServer.body).toEqual({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 4,
    });
    const serverCopy = await agent.get('/api/v1/vault').responseType('blob');
    expect((serverCopy.body as Buffer).equals(driveSource)).toBe(true);
    expect(
      (
        await agent.get(
          `/api/v1/account/paranoid/media/server-candidate/${staged.body.candidateId as string}`,
        )
      ).status,
    ).toBe(404);
  });

  it('rejects stale or fabricated verification without deleting ciphertext', async () => {
    const agent = await seedAndLogin('stale-media@bt.test', 'stale-media', 'paranoid');
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([1])));

    const fabricated = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { medium: 'server', version: 1, proof: 'x'.repeat(32) },
      });
    expect(fabricated.status).toBe(412);
    expect(fabricated.body.error.code).toBe('VAULT_MEDIA_VERIFICATION_FAILED');

    const stale = await agent
      .patch('/api/v1/account/paranoid/media')
      .set(...XRW)
      .send({
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { medium: 'drive', version: 99, proof: 'x'.repeat(32) },
      });
    expect(stale.status).toBe(412);
    expect((await agent.get('/api/v1/vault')).status).toBe(200);
    expect((await agent.get('/api/v1/account/paranoid/media')).body.mediaState).toEqual({
      mediaSet: ['server'],
      driveAttestedVersion: null,
    });
  });
});
