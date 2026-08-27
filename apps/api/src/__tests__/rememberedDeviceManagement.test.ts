import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPES,
  createApiKeyResponseSchema,
  rememberedDeviceListResponseSchema,
} from '@bettertrack/contracts';

import { auditLog } from '../data/schema';
import { REMEMBERED_DEVICE_COOKIE } from '../http/cookies';
import {
  pinQuickAuthMarkerKey,
  rememberedDeviceKey,
  rememberedDeviceMetadataKey,
  rememberedDevicesForUserKey,
} from '../services/auth/loginThrottle';
import { rememberedDeviceHandle } from '../services/auth/rememberedDeviceStore';
import { FIRST_PARTY_CLIENTS } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const PIN = '4242';

const EXPECTED_SCOPES = [
  'portfolio:read',
  'portfolio:write',
  'workboard:read',
  'workboard:write',
  'market:read',
  'social:read',
  'social:write',
  'notifications:read',
  'notifications:write',
  'chat:read',
  'chat:write',
  'account:security',
  'alerts:read',
  'alerts:write',
  'cash:read',
  'cash:write',
  'mirrorchain:read',
  'mirrorchain:write',
  'vault:sync',
  'feedback:write',
  'feedback:read',
] as const;

describe('remembered-device policy invariants', () => {
  it('does not add a scope or widen the seeded BetterTrackMobile client', () => {
    expect(API_KEY_SCOPES).toEqual(EXPECTED_SCOPES);
    expect(FIRST_PARTY_CLIENTS).toHaveLength(1);
    expect(FIRST_PARTY_CLIENTS[0]?.scopeCeiling).toEqual(EXPECTED_SCOPES);
  });
});

describe('remembered-device management — session + account:security bearer', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  }, 60_000);

  const seedUser = (tag: string) =>
    harness.seedUser({
      email: `remembered-device-${tag}@bettertrack.test`,
      username: `rd${tag.replaceAll('-', '')}`,
    });

  async function loginAgent(user: { email: string; password: string }) {
    const agent = request.agent(harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);
    return agent;
  }

  async function mintKeyFor(
    user: { email: string; password: string },
    scopes: string[],
  ): Promise<string> {
    const agent = await loginAgent(user);
    const response = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'remembered-device-test', scopes });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return createApiKeyResponseSchema.parse(response.body).token;
  }

  const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as const;

  function deviceCookie(response: request.Response): string {
    const values = response.headers['set-cookie'] as unknown as string[] | undefined;
    const header = (values ?? [])
      .filter((value) => value.startsWith(`${REMEMBERED_DEVICE_COOKIE}=`))
      .at(-1);
    if (!header) throw new Error('no remembered-device cookie set');
    return header.split(';')[0] ?? header;
  }

  it.each([
    ['GET list', 'get', '/api/v1/auth/remembered-devices'],
    ['DELETE one', 'delete', '/api/v1/auth/remembered-devices/forged-safe-handle'],
    ['DELETE all', 'delete', '/api/v1/auth/remembered-devices'],
  ] as const)(
    '%s reaches scope evaluation for an under-scoped bearer',
    async (_label, method, path) => {
      const user = await seedUser(`scope-${method}-${path.endsWith('devices') ? 'all' : 'one'}`);
      const token = await mintKeyFor(user, ['market:read']);
      const response =
        method === 'get'
          ? await request(harness.app)
              .get(path)
              .set(...bearer(token))
          : await request(harness.app)
              .delete(path)
              .set(...bearer(token));

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(response.body.error.message).toContain('account:security');
    },
  );

  it('lists and revokes through a cookie session without ever returning the raw id', async () => {
    const user = await seedUser('cookie');
    await harness.ctx.auth.setPin(user.id, PIN);
    const agent = await loginAgent(user);
    const remember = await agent.post('/api/v1/auth/remembered-device').set(...XRW);
    expect(remember.status).toBe(200);
    const cookie = deviceCookie(remember);
    const [rawDeviceId] = await harness.ctx.redis.smembers(rememberedDevicesForUserKey(user.id));
    expect(rawDeviceId).toBeTruthy();

    const initialResponse = await agent.get('/api/v1/auth/remembered-devices');
    const initial = rememberedDeviceListResponseSchema.parse(initialResponse.body);
    expect(initial.devices).toHaveLength(1);
    expect(Object.keys(initial.devices[0]!).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'handle',
      'lastSeenAt',
    ]);
    expect(initial.devices[0]).toMatchObject({
      handle: rememberedDeviceHandle(rawDeviceId!),
      lastSeenAt: null,
    });
    expect(initial.devices[0]!.createdAt).not.toBeNull();
    expect(Date.parse(initial.devices[0]!.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(initialResponse.body)).not.toContain(rawDeviceId!);

    const quickAuth = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });
    expect(quickAuth.status).toBe(200);
    const seen = rememberedDeviceListResponseSchema.parse(
      (await agent.get('/api/v1/auth/remembered-devices')).body,
    );
    expect(seen.devices[0]!.lastSeenAt).not.toBeNull();
    expect(JSON.stringify(seen)).not.toContain(rawDeviceId!);

    const handle = seen.devices[0]!.handle;
    await agent
      .delete(`/api/v1/auth/remembered-devices/${handle}`)
      .set(...XRW)
      .expect(200, { ok: true });
    // Idempotency key: (authenticated user id, stable handle).
    await agent
      .delete(`/api/v1/auth/remembered-devices/${handle}`)
      .set(...XRW)
      .expect(200, { ok: true });

    expect(await harness.ctx.redis.get(rememberedDeviceKey(rawDeviceId!))).toBeNull();
    expect(await harness.ctx.redis.get(rememberedDeviceMetadataKey(rawDeviceId!))).toBeNull();
    expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(rawDeviceId!))).toBeNull();
    expect(await harness.ctx.redis.smembers(rememberedDevicesForUserKey(user.id))).toEqual([]);
    const after = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('REMEMBER_DEVICE_UNKNOWN');
  });

  it('manages only caller-owned live bindings through a bearer', async () => {
    const userA = await seedUser('bearer-a');
    const userB = await seedUser('bearer-b');
    await harness.ctx.auth.setPin(userA.id, PIN);
    await harness.ctx.auth.setPin(userB.id, PIN);
    const revokeOne = await harness.ctx.auth.rememberDevice(userA.id);
    const revokeWithAll = await harness.ctx.auth.rememberDevice(userA.id);
    const secondRevokeWithAll = await harness.ctx.auth.rememberDevice(userA.id);
    const expireBeforeList = await harness.ctx.auth.rememberDevice(userA.id);
    const foreign = await harness.ctx.auth.rememberDevice(userB.id);
    for (const deviceId of [
      revokeOne.deviceId,
      revokeWithAll.deviceId,
      secondRevokeWithAll.deviceId,
      expireBeforeList.deviceId,
      foreign.deviceId,
    ]) {
      await harness.ctx.redis.set(pinQuickAuthMarkerKey(deviceId), '1');
    }
    // Pin the data-layer guard, not just controller behavior: poison A's owner
    // index with B's raw id and require the forward-owner check to reject it.
    await harness.ctx.redis.sadd(rememberedDevicesForUserKey(userA.id), foreign.deviceId);
    const tokenA = await mintKeyFor(userA, ['account:security']);

    const browserOnly = await request(harness.app)
      .post('/api/v1/auth/remembered-device')
      .set(...bearer(tokenA));
    expect(browserOnly.status).toBe(403);
    expect(browserOnly.body.error.code).toBe('API_KEY_FORBIDDEN');
    expect(browserOnly.body.error.message).toContain('browser session');
    expect(browserOnly.body.error.message).toContain('OAuth login');

    const listResponse = await request(harness.app)
      .get('/api/v1/auth/remembered-devices')
      .set(...bearer(tokenA));
    expect(listResponse.status).toBe(200);
    const listed = rememberedDeviceListResponseSchema.parse(listResponse.body);
    const listedHandles = listed.devices.map((row) => row.handle);
    expect(listedHandles).toEqual(
      expect.arrayContaining([
        rememberedDeviceHandle(revokeOne.deviceId),
        rememberedDeviceHandle(revokeWithAll.deviceId),
        rememberedDeviceHandle(secondRevokeWithAll.deviceId),
        rememberedDeviceHandle(expireBeforeList.deviceId),
      ]),
    );
    expect(listedHandles).not.toContain(rememberedDeviceHandle(foreign.deviceId));
    for (const rawId of [
      revokeOne.deviceId,
      revokeWithAll.deviceId,
      secondRevokeWithAll.deviceId,
      expireBeforeList.deviceId,
      foreign.deviceId,
    ]) {
      expect(JSON.stringify(listResponse.body)).not.toContain(rawId);
    }

    // Re-add the poisoned member after list pruning so revoke-one itself must
    // enforce ownership. A valid foreign handle is still an idempotent no-op.
    await harness.ctx.redis.sadd(rememberedDevicesForUserKey(userA.id), foreign.deviceId);
    await request(harness.app)
      .delete(`/api/v1/auth/remembered-devices/${rememberedDeviceHandle(foreign.deviceId)}`)
      .set(...bearer(tokenA))
      .expect(200, { ok: true });
    expect(await harness.ctx.redis.get(rememberedDeviceKey(foreign.deviceId))).toBe(userB.id);
    expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(foreign.deviceId))).toBe('1');

    const oneHandle = rememberedDeviceHandle(revokeOne.deviceId);
    await request(harness.app)
      .delete(`/api/v1/auth/remembered-devices/${oneHandle}`)
      .set(...bearer(tokenA))
      .expect(200, { ok: true });
    await request(harness.app)
      .delete(`/api/v1/auth/remembered-devices/${oneHandle}`)
      .set(...bearer(tokenA))
      .expect(200, { ok: true });
    await expect(
      harness.ctx.auth.quickAuth({ deviceId: revokeOne.deviceId }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'REMEMBER_DEVICE_UNKNOWN' });
    expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(revokeOne.deviceId))).toBeNull();

    // Simulate Redis expiry while its reverse-index member/sidecars linger.
    await harness.ctx.redis.del(rememberedDeviceKey(expireBeforeList.deviceId));
    const afterExpiry = rememberedDeviceListResponseSchema.parse(
      (
        await request(harness.app)
          .get('/api/v1/auth/remembered-devices')
          .set(...bearer(tokenA))
      ).body,
    );
    expect(afterExpiry.devices.map((row) => row.handle)).not.toContain(
      rememberedDeviceHandle(expireBeforeList.deviceId),
    );
    expect(
      await harness.ctx.redis.get(rememberedDeviceMetadataKey(expireBeforeList.deviceId)),
    ).toBeNull();
    expect(
      await harness.ctx.redis.get(pinQuickAuthMarkerKey(expireBeforeList.deviceId)),
    ).toBeNull();
    await request(harness.app)
      .delete(
        `/api/v1/auth/remembered-devices/${rememberedDeviceHandle(expireBeforeList.deviceId)}`,
      )
      .set(...bearer(tokenA))
      .expect(200, { ok: true });
    expect(await harness.ctx.redis.get(rememberedDeviceKey(expireBeforeList.deviceId))).toBeNull();

    await request(harness.app)
      .delete('/api/v1/auth/remembered-devices')
      .set(...bearer(tokenA))
      .expect(200, { ok: true });
    expect(await harness.ctx.auth.listRememberedDevices(userA.id)).toEqual([]);
    expect(await harness.ctx.redis.smembers(rememberedDevicesForUserKey(userA.id))).toEqual([]);
    await expect(
      harness.ctx.auth.quickAuth({ deviceId: revokeWithAll.deviceId }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'REMEMBER_DEVICE_UNKNOWN' });
    expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(revokeWithAll.deviceId))).toBeNull();
    await expect(
      harness.ctx.auth.quickAuth({ deviceId: secondRevokeWithAll.deviceId }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'REMEMBER_DEVICE_UNKNOWN' });
    expect(
      await harness.ctx.redis.get(pinQuickAuthMarkerKey(secondRevokeWithAll.deviceId)),
    ).toBeNull();

    // B's binding and quick-auth marker survive every A operation.
    expect(await harness.ctx.redis.get(rememberedDeviceKey(foreign.deviceId))).toBe(userB.id);
    await expect(harness.ctx.auth.quickAuth({ deviceId: foreign.deviceId })).resolves.toMatchObject(
      {
        status: 'authenticated',
        user: { id: userB.id },
      },
    );

    const revokeAudits = await harness.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorId, userA.id), eq(auditLog.action, 'remembered_device.forgotten')),
      );
    // One row for revoke-one and one per remaining live binding in revoke-all.
    // Foreign/expired/idempotent no-ops are deliberately not audited.
    expect(revokeAudits).toHaveLength(3);
    const managementAudit = revokeAudits.find(
      (row) => (row.meta as { via?: string } | null)?.via === 'management',
    );
    expect(managementAudit?.meta).toMatchObject({ via: 'management', handle: oneHandle });

    const revokeAllHandles = revokeAudits
      .filter((row) => (row.meta as { via?: string } | null)?.via === 'management_all')
      .map((row) => (row.meta as { handle?: string } | null)?.handle)
      .sort();
    expect(revokeAllHandles).toEqual(
      [
        rememberedDeviceHandle(revokeWithAll.deviceId),
        rememberedDeviceHandle(secondRevokeWithAll.deviceId),
      ].sort(),
    );
  });
});
