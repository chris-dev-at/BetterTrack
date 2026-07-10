import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DeviceTokenRepository } from '../../data/repositories/deviceTokenRepository';
import type { Logger } from '../../logger';

/**
 * Phone-push channel over FCM HTTP v1 (#368). Sends `messages:send` on the
 * Firebase project from the mounted service-account key — no firebase-admin
 * SDK: the OAuth2 token mint (RS256 service-account JWT → token endpoint) and
 * the send call are two small HTTP requests, kept behind an injectable `fetch`
 * so tests never touch the network.
 *
 * Channel gating (#421 env contract): `BT_FCM_SERVICE_ACCOUNT_FILE` unset, or
 * the file missing/unparseable ⇒ {@link createFcmChannel} returns null after
 * ONE warn log — api/worker boot on unchanged. The key may land on the host
 * before or after this code deploys, in any order.
 *
 * Each message is a **data message + notification block** with
 * `android.priority: HIGH` (the mobile client's contract): `data` carries the
 * canonical `type` + deep-link ids so the app routes taps, `notification`
 * renders when the app is backgrounded.
 */

/** The FCM OAuth2 scope for messages:send. */
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Access tokens live 3600s; re-mint this many seconds before expiry. */
const TOKEN_SLACK_SECONDS = 60;

/** The service-account fields the sender needs. */
interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** One rendered push for a recipient — shared by the FCM + webpush channels. */
export interface PushMessage {
  /** Canonical notification type (`alert.triggered`, `chat.message`, …). */
  type: string;
  title: string;
  body: string;
  /** Deep-link ids for the client router. Values must be strings (FCM data). */
  data: Record<string, string>;
}

/** Outcome of one token send: delivered, token dead (prune), or transient error. */
export type PushSendOutcome = 'ok' | 'gone' | 'error';

export interface FcmChannel {
  /** Send to every registered device of the user; prunes tokens FCM reports dead. */
  deliver(userId: string, message: PushMessage): Promise<void>;
}

export interface CreateFcmChannelDeps {
  /** Path from `BT_FCM_SERVICE_ACCOUNT_FILE`; undefined ⇒ channel off. */
  serviceAccountFile: string | undefined;
  devices: DeviceTokenRepository;
  logger: Logger;
  /** Injectable transport + clock (tests). */
  fetchFn?: typeof fetch;
  now?: () => number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Mint the RS256 service-account JWT the token endpoint exchanges. */
export function buildServiceAccountJwt(account: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(account.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Load + validate the mounted service-account JSON, or null (with the reason). */
function loadServiceAccount(file: string): ServiceAccount | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { error: 'file missing or unreadable' };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projectId = parsed.project_id;
    const clientEmail = parsed.client_email;
    const privateKey = parsed.private_key;
    if (
      typeof projectId !== 'string' ||
      typeof clientEmail !== 'string' ||
      typeof privateKey !== 'string'
    ) {
      return { error: 'not a service-account key (missing project_id/client_email/private_key)' };
    }
    return { projectId, clientEmail, privateKey };
  } catch {
    return { error: 'invalid JSON' };
  }
}

/**
 * Build the FCM channel, or **null** when unconfigured/unloadable — the
 * dispatcher treats null as "channel absent" and the settings surface reports
 * `push: false`. Exactly one warn log explains a disabled channel (#368).
 */
export function createFcmChannel(deps: CreateFcmChannelDeps): FcmChannel | null {
  const { serviceAccountFile, devices, logger } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;

  if (!serviceAccountFile) {
    logger.warn('push channel disabled: BT_FCM_SERVICE_ACCOUNT_FILE is not set');
    return null;
  }
  const account = loadServiceAccount(serviceAccountFile);
  if ('error' in account) {
    logger.warn(
      { file: serviceAccountFile, reason: account.error },
      'push channel disabled: FCM service-account key could not be loaded',
    );
    return null;
  }
  logger.info({ projectId: account.projectId }, 'push channel enabled (FCM HTTP v1)');

  const sendUrl = `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`;
  let cached: { token: string; expiresAtMs: number } | null = null;

  /** Cached OAuth2 access token; re-minted shortly before expiry. */
  async function accessToken(): Promise<string> {
    const nowMs = now();
    if (cached && nowMs < cached.expiresAtMs) return cached.token;
    const assertion = buildServiceAccountJwt(account as ServiceAccount, Math.floor(nowMs / 1000));
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) throw new Error(`FCM token endpoint responded ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM token endpoint returned no access_token');
    cached = {
      token: body.access_token,
      expiresAtMs: nowMs + ((body.expires_in ?? 3600) - TOKEN_SLACK_SECONDS) * 1000,
    };
    return cached.token;
  }

  /** Whether an FCM error response means the token is permanently dead. */
  function isGone(status: number, bodyText: string): boolean {
    if (status === 404) return true;
    // v1 surfaces dead registrations as 400/404 with errorCode UNREGISTERED
    // (and INVALID_ARGUMENT for garbage tokens — those are dead too).
    return status === 400 && /UNREGISTERED|INVALID_ARGUMENT/.test(bodyText);
  }

  /** One token send. Never throws — outcomes drive pruning + logging only. */
  async function sendToToken(token: string, message: PushMessage): Promise<PushSendOutcome> {
    try {
      const bearer = await accessToken();
      const res = await fetchFn(sendUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            // Data message + notification block (#368): `data` routes the tap
            // in-app (canonical type + ids), `notification` renders backgrounded.
            data: { ...message.data, type: message.type },
            notification: { title: message.title, body: message.body },
            android: { priority: 'HIGH' },
          },
        }),
      });
      if (res.ok) return 'ok';
      const bodyText = await res.text().catch(() => '');
      if (isGone(res.status, bodyText)) return 'gone';
      logger.warn({ status: res.status }, 'FCM send failed');
      return 'error';
    } catch (err) {
      logger.warn({ err }, 'FCM send failed');
      return 'error';
    }
  }

  return {
    async deliver(userId, message): Promise<void> {
      const tokens = await devices.listForUser(userId);
      for (const device of tokens) {
        const outcome = await sendToToken(device.token, message);
        if (outcome === 'gone') {
          // FCM says this registration no longer exists — prune it (#368).
          await devices.deleteByToken(device.token);
          logger.info({ platform: device.platform }, 'pruned dead FCM device token');
        }
      }
    },
  };
}
