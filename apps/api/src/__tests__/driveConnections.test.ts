import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../data/ids';
import { driveConnections, vaults } from '../data/schema';
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

  it('refuses a bound disconnect, detaches replicated vaults only after acknowledgement, and leaves Drive-only protected', async () => {
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
    expect(detached).toMatchObject({ media: ['server'], driveConnectionId: null });
    expect(
      await h.db
        .select()
        .from(driveConnections)
        .where(eq(driveConnections.id, replicatedConnection.id)),
    ).toHaveLength(0);

    const driveOnlyConnection = await connect(agent, {
      googleSub: 'drive-only',
      email: 'drive-only@example.test',
    });
    await createVault(agent, driveOnlyConnection.id, ['drive'], 'Drive-only vault');
    const lastMedium = await agent
      .delete(`/api/v1/drive-connections/${driveOnlyConnection.id}?acknowledgeBound=true`)
      .set(...XRW)
      .expect(409);
    expect(lastMedium.body.error.code).toBe('DRIVE_CONNECTION_LAST_MEDIUM');
  });
});
