import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../data/ids';
import { auditLog, driveConnections, vaults } from '../data/schema';
import {
  DRIVE_CONNECTIONS_SESSION_ONLY_ROUTES,
  openApiPathTemplateAcceptsBearer,
  pathAcceptsBearer,
} from '../http/middleware/bearerAuth';
import { buildRouteTable } from '../scripts/checkOpenapiCoverage';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

import { BEARER_OPAQUE_MOUNT_METHOD, mountedBearerRouteInventory } from './bearerRouteInventory';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let h: TestHarness;

beforeEach(async () => {
  h = await createTestApp();
});

async function login(user: SeededUser) {
  const agent = request.agent(h.app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password })
    .expect(200);
  return agent;
}

async function connect(
  agent: ReturnType<typeof request.agent>,
  identity: { googleSub: string; email: string; displayName?: string | null },
) {
  const response = await agent
    .post('/api/v1/drive-connections')
    .set(...XRW)
    .send({ displayName: null, ...identity })
    .expect(201);
  return response.body.connection as { id: string; googleSub: string; email: string };
}

function retirementPublicKey(): string {
  return generateKeyPairSync('ed25519')
    .publicKey.export({
      type: 'spki',
      format: 'der',
    })
    .toString('base64url');
}

async function createVault(
  agent: ReturnType<typeof request.agent>,
  connectionId: string,
  media: ('server' | 'drive')[],
  name: string,
) {
  return agent
    .post('/api/v1/vaults')
    .set(...XRW)
    .send({
      name,
      headerDocId: newId(),
      commonDocId: newId(),
      media,
      driveConnectionId: connectionId,
      keyFingerprint: 'Abcdef0123456789',
      retirementProofPublicKey: retirementPublicKey(),
    })
    .expect(201);
}

/**
 * Stamp the R3 full-doc-set attestation a freshly created vault does NOT have:
 * `media` is the owner's declared selection, `media_attested_at` is the server's
 * record that the doc set was actually verified across it. Production writes
 * this pair through `PATCH /vaults/:id/media` (covered end to end in
 * `vaultsE1.test.ts`); stamping it directly keeps this suite on its own subject,
 * and `vaults_media_attestation_state` still rejects an incoherent fixture.
 */
async function attestFullDocSet(vaultId: string, connectionId: string) {
  await h.db
    .update(vaults)
    .set({
      mediaAttestedAt: new Date('2026-08-22T09:00:00.000Z'),
      mediaAttestedDriveConnectionId: connectionId,
    })
    .where(eq(vaults.id, vaultId));
}

describe('Drive connection registry', () => {
  it('pins every mounted route as cookie-session-only in the bearer census', () => {
    const expected = [
      { method: 'GET', path: '/drive-connections' },
      { method: 'POST', path: '/drive-connections' },
      { method: 'PATCH', path: '/drive-connections/{connectionId}/verified' },
      { method: 'DELETE', path: '/drive-connections/{connectionId}' },
    ] as const;
    expect(DRIVE_CONNECTIONS_SESSION_ONLY_ROUTES).toEqual(expected);
    for (const route of expected) {
      const livePath = route.path.replace('{connectionId}', newId());
      expect(pathAcceptsBearer(livePath, route.method)).toBe(false);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(false);
    }

    const guards = [
      {
        method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireUser[1]`,
        path: '/drive-connections',
      },
      {
        method: `${BEARER_OPAQUE_MOUNT_METHOD}:<anonymous>[1]`,
        path: '/drive-connections',
      },
      {
        method: `${BEARER_OPAQUE_MOUNT_METHOD}:<anonymous>[2]`,
        path: '/drive-connections',
      },
    ];
    const sortRoutes = (routes: Array<{ method: string; path: string }>) =>
      routes.sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
      );
    expect(
      sortRoutes(mountedBearerRouteInventory(buildRouteTable(), '/drive-connections')),
    ).toEqual(sortRoutes([...expected, ...guards]));
  });

  it('has no server-side Google Drive fetch capability', () => {
    const root = resolve(process.cwd(), 'src');
    const source: string[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = resolve(directory, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (!/\.(test|spec)\.[cm]?[jt]sx?$/u.test(name))
          source.push(readFileSync(path, 'utf8'));
      }
    };
    visit(root);
    expect(source.join('\n')).not.toMatch(/googleapis\.com\/drive|upload\/drive\/v3/iu);
  });

  it('stores identity only, upserts one Google subject per user, and rejects token-shaped bodies', async () => {
    const user = await h.seedUser({ email: 'drive-owner@bt.test', username: 'drive_owner' });
    const agent = await login(user);

    const first = await connect(agent, {
      googleSub: 'google-stable-subject-y',
      email: 'drive-y@example.test',
      displayName: 'Drive Y',
    });
    const updated = await connect(agent, {
      googleSub: 'google-stable-subject-y',
      email: 'renamed-y@example.test',
      displayName: 'Drive Y renamed',
    });
    expect(updated.id).toBe(first.id);

    const list = await agent.get('/api/v1/drive-connections').expect(200);
    expect(list.body.connections).toEqual([
      expect.objectContaining({
        id: first.id,
        googleSub: 'google-stable-subject-y',
        email: 'renamed-y@example.test',
        displayName: 'Drive Y renamed',
      }),
    ]);

    const [row] = await h.db
      .select()
      .from(driveConnections)
      .where(eq(driveConnections.id, first.id));
    expect(Object.keys(row!).sort()).toEqual(
      ['createdAt', 'displayName', 'email', 'googleSub', 'id', 'lastVerifiedAt', 'userId'].sort(),
    );
    expect(JSON.stringify(row)).not.toMatch(/access.?token|refresh.?token|file.?id/i);

    await agent
      .post('/api/v1/drive-connections')
      .set(...XRW)
      .send({
        googleSub: 'another-subject',
        email: 'another@example.test',
        displayName: null,
        accessToken: 'must-never-cross-the-api',
      })
      .expect(400);
    expect(await h.db.select().from(driveConnections)).toHaveLength(1);

    // The upsert landed on the same row, so the trail must not claim a second
    // registration: re-consent is `refreshed`, not `created`.
    const trail = await h.db.select().from(auditLog).where(eq(auditLog.targetId, first.id));
    expect(trail.map(({ action }) => action).sort()).toEqual([
      'drive_connection.created',
      'drive_connection.refreshed',
    ]);
  });

  it('refuses a token-shaped body on every method and an unknown disconnect query parameter', async () => {
    const user = await h.seedUser({ email: 'drive-strict@bt.test', username: 'drive_strict' });
    const agent = await login(user);
    const connection = await connect(agent, {
      googleSub: 'strict-subject',
      email: 'strict@example.test',
    });

    // The "no Drive route accepts a Google token" guarantee has to hold on the
    // methods that document no body too — otherwise it is pinned only where a
    // strict schema happened to be needed anyway.
    for (const send of [
      () =>
        agent
          .patch(`/api/v1/drive-connections/${connection.id}/verified`)
          .set(...XRW)
          .send({ accessToken: 'must-never-cross-the-api' }),
      () =>
        agent
          .delete(`/api/v1/drive-connections/${connection.id}`)
          .set(...XRW)
          .send({ accessToken: 'must-never-cross-the-api' }),
    ]) {
      await send().expect(400);
    }

    // The published query schema is `.strict()`; the route must refuse what the
    // contract refuses instead of quietly ignoring it.
    await agent
      .delete(`/api/v1/drive-connections/${connection.id}?acknowledgeBound=true&prompt=consent`)
      .set(...XRW)
      .expect(400);
    await agent
      .delete(`/api/v1/drive-connections/${connection.id}?acknowledgeBound=yes`)
      .set(...XRW)
      .expect(400);

    // Nothing above was acted on; the bodyless forms still work.
    expect(await h.db.select().from(driveConnections)).toHaveLength(1);
    await agent
      .patch(`/api/v1/drive-connections/${connection.id}/verified`)
      .set(...XRW)
      .expect(200);
    await agent
      .delete(`/api/v1/drive-connections/${connection.id}`)
      .set(...XRW)
      .expect(204);
    expect(await h.db.select().from(driveConnections)).toHaveLength(0);
  });

  it('scopes every id-addressed operation in the repository and allows two users on one Drive', async () => {
    const ownerA = await h.seedUser({ email: 'drive-a@bt.test', username: 'drive_a' });
    const agentA = await login(ownerA);
    const connectionA = await connect(agentA, {
      googleSub: 'shared-physical-drive',
      email: 'shared@example.test',
    });

    const ownerB = await h.seedUser({ email: 'drive-b@bt.test', username: 'drive_b' });
    const agentB = await login(ownerB);
    const connectionB = await connect(agentB, {
      googleSub: 'shared-physical-drive',
      email: 'shared@example.test',
    });

    expect(connectionB.id).not.toBe(connectionA.id);
    expect((await agentB.get('/api/v1/drive-connections')).body.connections).toHaveLength(1);
    await agentB
      .patch(`/api/v1/drive-connections/${connectionA.id}/verified`)
      .set(...XRW)
      .expect(404);
    await agentB
      .delete(`/api/v1/drive-connections/${connectionA.id}`)
      .set(...XRW)
      .expect(404);
    await agentA
      .patch(`/api/v1/drive-connections/${connectionA.id}/verified`)
      .set(...XRW)
      .expect(200);
  });

  it("binds one owner's vault A to Drive Y and vault B to separately consented Drive Z", async () => {
    const owner = await h.seedUser({ email: 'gmail-x@bt.test', username: 'gmail_x' });
    const agent = await login(owner);
    const driveY = await connect(agent, {
      googleSub: 'drive-y-subject',
      email: 'drive-y@example.test',
    });
    const driveZ = await connect(agent, {
      googleSub: 'drive-z-subject',
      email: 'drive-z@example.test',
    });
    const vaultA = await createVault(agent, driveY.id, ['drive'], 'Vault A');
    const vaultB = await createVault(agent, driveZ.id, ['drive'], 'Vault B');

    const listed = await agent.get('/api/v1/vaults').expect(200);
    expect(listed.body.vaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: vaultA.body.vault.id,
          name: 'Vault A',
          driveConnectionId: driveY.id,
        }),
        expect.objectContaining({
          id: vaultB.body.vault.id,
          name: 'Vault B',
          driveConnectionId: driveZ.id,
        }),
      ]),
    );
  });

  it('refuses a bound disconnect, detaches a VERIFIED replicated vault only after acknowledgement, audits both, and leaves Drive-only protected', async () => {
    const user = await h.seedUser({ email: 'drive-bound@bt.test', username: 'drive_bound' });
    const agent = await login(user);
    const replicatedConnection = await connect(agent, {
      googleSub: 'replicated-drive',
      email: 'replicated@example.test',
    });
    const replicatedVault = await createVault(
      agent,
      replicatedConnection.id,
      ['server', 'drive'],
      'Replicated vault',
    );
    await attestFullDocSet(replicatedVault.body.vault.id, replicatedConnection.id);

    const refused = await agent
      .delete(`/api/v1/drive-connections/${replicatedConnection.id}`)
      .set(...XRW)
      .expect(409);
    expect(refused.body.error.code).toBe('DRIVE_CONNECTION_BOUND');

    await agent
      .delete(`/api/v1/drive-connections/${replicatedConnection.id}?acknowledgeBound=true`)
      .set(...XRW)
      .expect(204);
    const [detached] = await h.db
      .select()
      .from(vaults)
      .where(eq(vaults.id, replicatedVault.body.vault.id));
    expect(detached).toMatchObject({
      media: ['server'],
      driveConnectionId: null,
      // The attestation covered a media set including the Drive copy this row no
      // longer reaches, so it is void with it (§16, 2026-08-21).
      mediaAttestedAt: null,
      mediaAttestedDriveConnectionId: null,
    });
    expect(
      await h.db
        .select()
        .from(driveConnections)
        .where(eq(driveConnections.id, replicatedConnection.id)),
    ).toHaveLength(0);

    const detachAudit = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, replicatedVault.body.vault.id));
    expect(detachAudit.filter(({ action }) => action === 'vault.media_changed')).toEqual([
      expect.objectContaining({
        action: 'vault.media_changed',
        meta: { media: ['server'], via: 'drive_connection_disconnect' },
      }),
    ]);
    const connectionAudit = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, replicatedConnection.id));
    expect(connectionAudit.map(({ action }) => action).sort()).toEqual([
      'drive_connection.created',
      'drive_connection.deleted',
    ]);
    expect(JSON.stringify(connectionAudit)).not.toMatch(/token|file.?id/i);

    // A Drive-only vault owner meets the accurate refusal on the FIRST attempt:
    // the loss-of-reach acknowledgement was never on offer for it.
    const driveOnlyConnection = await connect(agent, {
      googleSub: 'drive-only',
      email: 'drive-only@example.test',
    });
    await createVault(agent, driveOnlyConnection.id, ['drive'], 'Drive-only vault');
    const lastMedium = await agent
      .delete(`/api/v1/drive-connections/${driveOnlyConnection.id}`)
      .set(...XRW)
      .expect(409);
    expect(lastMedium.body.error.code).toBe('DRIVE_CONNECTION_LAST_MEDIUM');
    const acknowledged = await agent
      .delete(`/api/v1/drive-connections/${driveOnlyConnection.id}?acknowledgeBound=true`)
      .set(...XRW)
      .expect(409);
    expect(acknowledged.body.error.code).toBe('DRIVE_CONNECTION_LAST_MEDIUM');
  });

  it('refuses to detach a server+drive vault whose server copy was never verified, acknowledged or not', async () => {
    // The data-loss shape the media LABEL hides: a vault created
    // `['server','drive']` carries no attestation and zero blobs until the first
    // full-doc-set verification, so detaching it here would strand every doc in
    // a Drive we just unbound — while the acknowledgement copy promises "keeps
    // each verified server copy exactly as it is".
    const user = await h.seedUser({
      email: 'drive-unverified@bt.test',
      username: 'drive_unverified',
    });
    const agent = await login(user);
    const connection = await connect(agent, {
      googleSub: 'unverified-server-copy',
      email: 'unverified@example.test',
    });
    const vault = await createVault(
      agent,
      connection.id,
      ['server', 'drive'],
      'Declared-but-unverified vault',
    );
    const [created] = await h.db.select().from(vaults).where(eq(vaults.id, vault.body.vault.id));
    expect(created?.mediaAttestedAt).toBeNull();

    // Both attempts meet the same refusal, and `last_medium` is decided before
    // the acknowledgement: the owner is never invited to accept a loss of reach
    // that would in fact be a loss of data.
    const refused = await agent
      .delete(`/api/v1/drive-connections/${connection.id}`)
      .set(...XRW)
      .expect(409);
    expect(refused.body.error.code).toBe('DRIVE_CONNECTION_LAST_MEDIUM');
    expect(refused.body.error.message).toMatch(/verified server copy/i);
    const acknowledged = await agent
      .delete(`/api/v1/drive-connections/${connection.id}?acknowledgeBound=true`)
      .set(...XRW)
      .expect(409);
    expect(acknowledged.body.error.code).toBe('DRIVE_CONNECTION_LAST_MEDIUM');

    // Nothing moved: binding, media and the registry row are exactly as created.
    const [untouched] = await h.db.select().from(vaults).where(eq(vaults.id, vault.body.vault.id));
    expect(untouched).toMatchObject({
      media: ['server', 'drive'],
      driveConnectionId: connection.id,
    });
    expect(
      await h.db.select().from(driveConnections).where(eq(driveConnections.id, connection.id)),
    ).toHaveLength(1);

    // The same vault detaches cleanly once the server copy is actually verified.
    await attestFullDocSet(vault.body.vault.id, connection.id);
    const bound = await agent
      .delete(`/api/v1/drive-connections/${connection.id}`)
      .set(...XRW)
      .expect(409);
    expect(bound.body.error.code).toBe('DRIVE_CONNECTION_BOUND');
    await agent
      .delete(`/api/v1/drive-connections/${connection.id}?acknowledgeBound=true`)
      .set(...XRW)
      .expect(204);
    const [detached] = await h.db.select().from(vaults).where(eq(vaults.id, vault.body.vault.id));
    expect(detached).toMatchObject({
      media: ['server'],
      driveConnectionId: null,
      mediaAttestedAt: null,
    });
  });
});
