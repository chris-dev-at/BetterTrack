import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceTokenRepository } from '../../../data/repositories/deviceTokenRepository';
import type { Logger } from '../../../logger';
import { buildServiceAccountJwt, createFcmChannel, type PushMessage } from '../fcm';

const logger = pino({ level: 'silent' }) as unknown as Logger;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

/** Write a service-account JSON to a temp file; returns its path. */
function writeServiceAccount(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bt-fcm-'));
  const file = path.join(dir, 'sa.json');
  writeFileSync(
    file,
    JSON.stringify({
      project_id: 'bettertrackapp-c6996',
      client_email: 'sender@bettertrackapp-c6996.iam.gserviceaccount.com',
      private_key: PRIVATE_PEM,
      ...overrides,
    }),
  );
  return file;
}

function deviceRepo(tokens: string[]): DeviceTokenRepository & { pruned: string[] } {
  const pruned: string[] = [];
  return {
    pruned,
    upsert: async () => undefined,
    deleteForUser: async () => undefined,
    async deleteByToken(token) {
      pruned.push(token);
    },
    async listForUser(userId) {
      return tokens.map((token, i) => ({
        id: `d${i}`,
        userId,
        token,
        platform: 'android' as const,
      }));
    },
  };
}

const MESSAGE: PushMessage = {
  type: 'alert.triggered',
  title: 'Price alert: AAPL',
  body: 'AAPL is above 100.',
  data: { alertId: 'a1', assetId: 'x1' },
};

/** fetch stub: first call answers the token mint, the rest answer sends. */
function fetchStub(sendResponses: Array<{ status: number; body?: string }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let sendIndex = 0;
  const fn = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'test-bearer', expires_in: 3600 }), {
        status: 200,
      });
    }
    const next = sendResponses[Math.min(sendIndex++, sendResponses.length - 1)]!;
    return new Response(next.body ?? '{}', { status: next.status });
  });
  return { fn, calls };
}

describe('FCM channel (#368, HTTP v1)', () => {
  it('is disabled (null) with one warn when the env var is unset', () => {
    const warn = vi.fn();
    const channel = createFcmChannel({
      serviceAccountFile: undefined,
      devices: deviceRepo([]),
      logger: { ...logger, warn } as unknown as Logger,
    });
    expect(channel).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is disabled (null) with one warn when the file is missing or invalid — never throws', () => {
    const warn = vi.fn();
    const missing = createFcmChannel({
      serviceAccountFile: '/nope/does-not-exist.json',
      devices: deviceRepo([]),
      logger: { ...logger, warn } as unknown as Logger,
    });
    expect(missing).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    const badFile = writeServiceAccount({ private_key: undefined });
    const invalid = createFcmChannel({
      serviceAccountFile: badFile,
      devices: deviceRepo([]),
      logger,
    });
    expect(invalid).toBeNull();
  });

  it('signs a verifiable RS256 service-account JWT with the messaging scope', () => {
    const jwt = buildServiceAccountJwt(
      {
        projectId: 'p',
        clientEmail: 'e@x.iam.gserviceaccount.com',
        privateKey: PRIVATE_PEM,
      },
      1_750_000_000,
    );
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.exp - claims.iat).toBe(3600);
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
  });

  it('sends a data message + notification block with android HIGH priority per device', async () => {
    const { fn, calls } = fetchStub([{ status: 200 }]);
    const channel = createFcmChannel({
      serviceAccountFile: writeServiceAccount(),
      devices: deviceRepo(['tok-1', 'tok-2']),
      logger,
      fetchFn: fn as unknown as typeof fetch,
      now: () => 1_750_000_000_000,
    });
    await channel!.deliver('user-1', MESSAGE);

    const sends = calls.filter((c) => c.url.includes('messages:send'));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.url).toBe(
      'https://fcm.googleapis.com/v1/projects/bettertrackapp-c6996/messages:send',
    );
    const body = JSON.parse(String(sends[0]!.init.body));
    expect(body.message.token).toBe('tok-1');
    expect(body.message.notification).toEqual({
      title: 'Price alert: AAPL',
      body: 'AAPL is above 100.',
    });
    // The DATA payload carries the canonical type + deep-link ids (mobile contract).
    expect(body.message.data).toEqual({ alertId: 'a1', assetId: 'x1', type: 'alert.triggered' });
    expect(body.message.android).toEqual({ priority: 'HIGH' });
    expect((sends[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-bearer',
    );
    // One token mint served both sends (cached until expiry).
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
  });

  it('prunes a token FCM reports UNREGISTERED/404 and keeps the healthy ones', async () => {
    const repo = deviceRepo(['dead-token', 'live-token']);
    const { fn } = fetchStub([
      { status: 404, body: '{"error":{"status":"NOT_FOUND"}}' },
      { status: 200 },
    ]);
    const channel = createFcmChannel({
      serviceAccountFile: writeServiceAccount(),
      devices: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
    });
    await channel!.deliver('user-1', MESSAGE);
    expect(repo.pruned).toEqual(['dead-token']);
  });

  it('treats a 400 UNREGISTERED error body as a dead token too', async () => {
    const repo = deviceRepo(['stale']);
    const { fn } = fetchStub([
      { status: 400, body: '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}' },
    ]);
    const channel = createFcmChannel({
      serviceAccountFile: writeServiceAccount(),
      devices: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
    });
    await channel!.deliver('user-1', MESSAGE);
    expect(repo.pruned).toEqual(['stale']);
  });

  it('a transient send failure logs and neither throws nor prunes', async () => {
    const repo = deviceRepo(['tok']);
    const { fn } = fetchStub([{ status: 503 }]);
    const channel = createFcmChannel({
      serviceAccountFile: writeServiceAccount(),
      devices: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
    });
    await expect(channel!.deliver('user-1', MESSAGE)).resolves.toBeUndefined();
    expect(repo.pruned).toEqual([]);
  });
});
