import { eq } from 'drizzle-orm';

import {
  encodeVaultEnvelope,
  VAULT_CONTENT_CIPHER,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
} from '@bettertrack/contracts';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { users } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * CORS + cookie behaviour end-to-end (PROJECTPLAN.md §10). The harness derives
 * web/admin/api origins from BT_*_ORIGIN, so these assertions exercise the same
 * derivation the app runs in production. Covers both a ports-style layout (the
 * harness default) and a subdomains-style layout.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;
const WEB = 'http://localhost:5173';
const ADMIN = 'http://localhost:5174';
const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

function vaultEnvelope(version: number, ciphertext: Uint8Array): Buffer {
  return Buffer.from(
    encodeVaultEnvelope(
      {
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
        vaultVersion: version,
        schemaVersion: 1,
        deviceId: UUID_B,
        writeId: UUID_C,
        writtenAt: '2026-07-25T10:00:00.000Z',
      },
      ciphertext,
    ),
  );
}

describe('CORS allowlist', () => {
  it('reflects an allowed web origin with credentials on a simple request', async () => {
    const res = await request(harness.app).get('/api/v1/health').set('Origin', WEB);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('reflects the admin origin too', async () => {
    const res = await request(harness.app).get('/api/v1/health').set('Origin', ADMIN);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN);
  });

  it('sends no ACAO header for a disallowed origin', async () => {
    const res = await request(harness.app)
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Still varies on Origin so caches never leak another origin's header.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers a preflight from an allowed origin with 204 + allow-* headers', async () => {
    const res = await request(harness.app)
      .options('/api/v1/auth/login')
      .set('Origin', WEB)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toContain('X-Requested-With');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('permits conditional vault writes and exposes historical response metadata', async () => {
    const user = await harness.seedUser({
      email: 'vault-cors@bt.test',
      username: 'vault-cors',
    });
    await harness.db.update(users).set({ privacyMode: 'paranoid' }).where(eq(users.id, user.id));

    const agent = request.agent(harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', WEB)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);

    for (const conditionalHeader of ['If-None-Match', 'If-Match']) {
      const preflight = await request(harness.app)
        .options('/api/v1/vault')
        .set('Origin', WEB)
        .set('Access-Control-Request-Method', 'PUT')
        .set(
          'Access-Control-Request-Headers',
          `Content-Type, X-Requested-With, ${conditionalHeader}`,
        );
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-headers']).toContain(conditionalHeader);
    }

    const created = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('Origin', WEB)
      .set('If-None-Match', '*')
      .send(vaultEnvelope(1, new Uint8Array([1])));
    expect(created.status).toBe(204);
    expect(created.headers['access-control-expose-headers']).toContain('ETag');

    const replaced = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('Origin', WEB)
      .set('If-Match', '"1"')
      .send(vaultEnvelope(2, new Uint8Array([2])));
    expect(replaced.status).toBe(204);

    const historyRead = await agent
      .get('/api/v1/vault/history/1')
      .set('Origin', WEB)
      .responseType('blob');
    expect(historyRead.status).toBe(200);
    const exposedHeaders = historyRead.headers['access-control-expose-headers'] ?? '';
    for (const header of [
      'ETag',
      VAULT_HISTORY_CREATED_AT_HEADER,
      VAULT_HISTORY_MEDIUM_HEADER,
      VAULT_HISTORY_SIZE_BYTES_HEADER,
    ]) {
      expect(exposedHeaders).toContain(header);
    }
    expect(historyRead.headers.etag).toBe('"1"');
    expect(historyRead.headers[VAULT_HISTORY_MEDIUM_HEADER.toLowerCase()]).toBe('server');
  });
});

describe('strict Origin check on state-changing requests', () => {
  it('rejects a mutation carrying a disallowed Origin even with the CSRF header', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', 'https://evil.example')
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('allows a mutation from an allowed origin', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', WEB)
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);
  });
});

describe('credentialed login sets a Lax session cookie', () => {
  it('flows cross-origin in ports mode', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', WEB)
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/bt_sid=/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Plain-http ports layout → not Secure, so the browser accepts the cookie.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('marks the cookie Secure in an https subdomains layout', async () => {
    const httpsHarness = await createTestApp({
      env: {
        BT_API_ORIGIN: 'https://api.example.at',
        BT_WEB_ORIGIN: 'https://web.example.at',
        BT_ADMIN_ORIGIN: 'https://admin.example.at',
      },
    });
    const admin = await httpsHarness.seedAdmin();
    const res = await request(httpsHarness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', 'https://web.example.at')
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(res.headers['access-control-allow-origin']).toBe('https://web.example.at');
  });
});
