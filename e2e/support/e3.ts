/**
 * E3-specific e2e harness — webhook delivery + NL-conglomerate-builder gates
 * ([V5-P14][E3], #737).
 *
 * Two V5 behaviors these specs drive have no in-run HTTP seam that a browser can
 * reach on its own, so — exactly like the E1/E2 harnesses — this module stands up
 * the REAL production services against the SAME Playwright stack (its Postgres and
 * its running API) and pins each to a deterministic, network-free local endpoint.
 * No product-code change, no external service, no wall-clock sleeps.
 *
 *  - **Webhook delivery.** The production driver is the BullMQ `webhooks.deliver`
 *    job: the bridge enqueues one delivery per (event, subscription), the worker
 *    runs it with exponential backoff, and the dispatcher owns the terminal
 *    outcome (log row + the consecutive-failure streak that auto-disables a dead
 *    receiver). Waiting on that cron/backoff loop would mean arbitrary sleeps.
 *    Instead {@link createWebhookHarness} builds the REAL {@link
 *    createWebhookDispatcher} from the production repositories + the production
 *    address-pinned transport, and drives `deliver()` with explicit attempt contexts —
 *    so the retry boundary (`attempt < max ⇒ retry`, terminal ⇒ log + streak) and
 *    the auto-disable threshold are exercised deterministically, in-process,
 *    against a {@link createCaptureReceiver} listening on an ephemeral port of
 *    this host's own private LAN address — NOT loopback, which the API's egress
 *    guard refuses outright (see that function). The subscription itself is
 *    created through the real Settings UI; the
 *    signing secret is read back by DECRYPTING the stored envelope with the same
 *    key the API derives ({@link harnessConfig}) — the modal's one-time plaintext
 *    is never scraped — so the receiver can independently verify the HMAC.
 *
 *  - **NL conglomerate builder.** The user-facing panel is hidden unless a
 *    provider is configured, and a draft POSTs `/api/chat` to that provider. The
 *    Playwright stack has no Ollama, so {@link createFakeOllama} answers the two
 *    Ollama endpoints (`/api/tags`, `/api/chat`) from an in-process server with a
 *    DETERMINISTIC completion, and {@link setAiProvider} points the API's
 *    admin-configured endpoint at it AT RUNTIME (the registry resolves the
 *    provider per request, so no redeploy). The mock is the only provider ever
 *    configured — Ollama/cloud are never reached — and {@link clearAiProvider}
 *    restores the unconfigured default so the rest of the suite sees AI disabled.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

import type { APIRequestContext } from '@playwright/test';

// The root e2e context has no `@bettertrack/contracts` symlink (existing specs
// only reach it transitively through `apps/api`), so the wire constants are
// imported from the package source by path — the same cross-package relative
// style this harness already uses for `apps/api`. Re-exported below so the specs
// stay on `./support/e3` and never hand-copy a contract value that could drift.
import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_SCHEME,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../../packages/contracts/src/index';
import { loadConfig } from '../../apps/api/src/config/env';
import { createDatabase, type Database } from '../../apps/api/src/data/db';
import { createAuditRepository } from '../../apps/api/src/data/repositories/auditRepository';
import { createUserRepository } from '../../apps/api/src/data/repositories/userRepository';
import {
  createWebhookDeliveryRepository,
  createWebhookSubscriptionRepository,
  type WebhookSubscriptionRepository,
} from '../../apps/api/src/data/repositories/webhookRepository';
import type { DomainEvent } from '../../apps/api/src/events';
import { createLogger } from '../../apps/api/src/logger';
import { createAuditService } from '../../apps/api/src/services/audit/auditService';
import { decryptSecret } from '../../apps/api/src/services/crypto/secretBox';
import {
  createPinnedWebhookTransport,
  createWebhookDispatcher,
  type WebhookDeliveryResult,
} from '../../apps/api/src/services/webhooks';

import { API_BASE_URL, DATABASE_URL, REDIS_URL, SESSION_SECRET } from './config';

/**
 * Re-exported wire constants so the specs import them from `./support/e3` (the
 * root e2e context can't resolve the bare `@bettertrack/contracts` specifier).
 */
export {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
};

/** Mutating API calls need this header or the CSRF guard 403s them (see `alerts.spec.ts`). */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' } as const;

/**
 * Load a config off the same inputs the API boots from, so `twoFactor.
 * encryptionKey` matches the key the API encrypted every webhook secret with.
 * The Playwright stack sets no `TOTP_ENCRYPTION_KEY`, so both sides derive the
 * key from `SESSION_SECRET`; passing through any host-exported value (the API
 * process inherits the same `process.env` this harness runs in) keeps the two in
 * lock-step even on a host that does set one.
 */
function harnessConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    REDIS_URL,
    SESSION_SECRET,
    TOTP_ENCRYPTION_KEY: process.env.TOTP_ENCRYPTION_KEY,
  });
}

/**
 * Recompute the delivery signature the way a RECEIVER would — HMAC-SHA256 of
 * `` `${timestamp}.${body}` `` under the secret, prefixed with the documented
 * scheme. Deliberately independent of the API's own `signWebhookPayload`, so a
 * spec comparing this to the captured header genuinely verifies the signature
 * rather than re-running the signer.
 */
export function independentSignature(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `${WEBHOOK_SIGNATURE_SCHEME}=${mac}`;
}

// ── Webhook receiver ─────────────────────────────────────────────────────────

/** One captured delivery POST — everything the receiver saw, verbatim. */
export interface CapturedDelivery {
  headers: Record<string, string>;
  body: string;
}

export interface CaptureReceiver {
  /** `http://<private-lan-address>:<port>` — the Payload URL the webhook is created with. */
  readonly url: string;
  /** Every delivery POST this receiver has answered, in arrival order. */
  readonly requests: CapturedDelivery[];
  /** Flip the HTTP status the receiver replies with (200 = accept, 5xx = fail). */
  setStatus(status: number): void;
  close(): Promise<void>;
}

// RFC1918 + unique-local, spelled exactly as the API's egress guard spells the
// ranges its webhook policy un-blocks (`LAN_ALLOWED_*` in
// `apps/api/src/services/security/outboundUrlGuard.ts`). Two lists, one per
// family, for the reason the guard keeps two: Node's `BlockList` treats IPv4
// input as IPv4-mapped IPv6 as soon as a list carries a mapped-v6 rule.
const PRIVATE_LAN_IPV4 = new BlockList();
PRIVATE_LAN_IPV4.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_LAN_IPV4.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_LAN_IPV4.addSubnet('192.168.0.0', 16, 'ipv4');
const PRIVATE_LAN_IPV6 = new BlockList();
PRIVATE_LAN_IPV6.addSubnet('fc00::', 7, 'ipv6');

function isPrivateLanAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_LAN_IPV4.check(address, 'ipv4');
  if (family === 6) return PRIVATE_LAN_IPV6.check(address, 'ipv6');
  return false;
}

/**
 * This host's first non-loopback private (RFC1918 / `fc00::/7`) interface
 * address — the only kind of address the API will accept as a webhook receiver
 * on a single box. IPv4 wins when both families are present: it is what every
 * runner and developer box has, and it keeps the advertised URL free of the
 * bracket spelling.
 *
 * Throws when the box has none rather than falling back to loopback. The
 * fallback is what would re-hide #1991: a loopback receiver is refused at CREATE
 * by the egress guard, the signing-secret dialog never appears, and the failure
 * surfaces three layers away from its cause.
 */
function privateLanInterfaceAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const candidates: NetworkInterfaceInfo[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !isPrivateLanAddress(entry.address)) continue;
      candidates.push(entry);
    }
  }
  const chosen = candidates.find((entry) => isIP(entry.address) === 4) ?? candidates[0];
  if (!chosen) {
    throw new Error(
      'E3: this host has no non-loopback private network interface, so the webhook ' +
        'capture receiver has no address the API would accept. The receiver must sit on ' +
        'an RFC1918 (10/8, 172.16/12, 192.168/16) or unique-local (fc00::/7) address: the ' +
        'egress guard on user-supplied webhook URLs refuses loopback under every policy ' +
        '(apps/api/src/services/security/outboundUrlGuard.ts, #1556), so a loopback ' +
        'receiver fails the create with WEBHOOK_URL_BLOCKED. Attach this box to a private ' +
        'network — a Docker bridge is enough — and re-run.',
    );
  }
  return chosen.address;
}

/** `10.0.0.5` → `10.0.0.5`; `fd00::5` → `[fd00::5]` (RFC 3986 host spelling). */
function urlHost(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

/**
 * A local HTTP receiver on an ephemeral port of this host's own private LAN
 * address that records each delivery and replies with the current `status`. The
 * handler captures BEFORE it responds, so once a `deliver()` call resolves its
 * request is already in `requests` (no poll, no sleep).
 *
 * WHY NOT LOOPBACK (#1991). The subscription is created through the real product
 * API, which runs the SSRF guard on the user-supplied URL (#1556) and refuses
 * 127.0.0.0/8 under every policy — so a loopback receiver never gets a webhook
 * at all. The webhook policy DOES allow a private LAN receiver over plain http
 * (`WEBHOOK_RECEIVER_URL_POLICY`, the owner-recorded self-hosted-receiver
 * contract), which is exactly what this is, and the same address then passes the
 * dispatcher's per-attempt guard and its address pin (#1702) at delivery time.
 * The remaining obstacle — #1864 refusing the deployment's OWN interface network
 * — is opted out of for this throwaway stack in `playwright.config.ts`; the
 * guard itself is not weakened anywhere.
 *
 * TRADE-OFF, stated plainly: for the seconds a webhook spec runs, this listener
 * is reachable from the host's LAN rather than from the host alone. It holds no
 * secret (the signing secret is read by decrypting the stored envelope, never
 * from the wire) and it only appends to `requests` and echoes a status, so the
 * worst a LAN peer could do is add a junk entry and fail the spec. Loopback is
 * not available here for the reason above, and silently falling back to it would
 * put the suite back to being green-by-never-running.
 */
export async function createCaptureReceiver(): Promise<CaptureReceiver> {
  const requests: CapturedDelivery[] = [];
  let status = 200;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      requests.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(status).end(status >= 200 && status < 300 ? 'ok' : 'nope');
    });
  });

  const address = privateLanInterfaceAddress();
  await new Promise<void>((resolve, reject) => {
    // The bind can fail now that the address is variable (interface gone between
    // enumeration and bind, a host firewall refusing non-loopback binds); without
    // this handler the promise never settles and the spec dies at its timeout.
    server.once('error', (err: Error) =>
      reject(new Error(`E3: the capture receiver could not bind ${address}: ${err.message}`)),
    );
    server.listen(0, address, resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${urlHost(address)}:${port}`,
    requests,
    setStatus(next) {
      status = next;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── Webhook dispatcher harness ───────────────────────────────────────────────

/** The subset of the stored subscription row the specs assert on. */
export interface HarnessSubscription {
  id: string;
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  secretEncrypted: string;
}

/** A minimal signable event; the dispatcher serializes the whole thing into `data`. */
export type WebhookTestEvent = { type: string; occurredAt: string } & Record<string, unknown>;

export interface WebhookHarness {
  /** Resolve the newest subscription of the browser-provisioned user (one per user here). */
  subscriptionForEmail(email: string): Promise<HarnessSubscription>;
  /** Re-read the current row so a spec can assert enabled/reason/streak after an action. */
  reload(id: string): Promise<HarnessSubscription>;
  /** Decrypt the stored signing secret (same key the API used) — never logged. */
  secretFor(sub: HarnessSubscription): string;
  /** Run ONE delivery attempt through the real dispatcher against the receiver. */
  deliver(
    subscriptionId: string,
    ctx: { deliveryId: string; attempt: number; maxAttempts: number; event?: WebhookTestEvent },
  ): Promise<WebhookDeliveryResult>;
  dispose(): Promise<void>;
}

/**
 * Build the webhook harness against the running Playwright Postgres. It wires the
 * production dispatcher to the production {@link createPinnedWebhookTransport},
 * so a `deliver()` call signs with the subscription's real secret and POSTs to
 * whatever URL the subscription carries — over a socket pinned to the address the
 * dispatcher's own per-attempt guard vetted, exactly as production does (the
 * {@link CaptureReceiver}). Every side-effect — the
 * delivery-log row, the consecutive-failure streak, the audit row on auto-disable
 * — lands in the real tables exactly as production writes them.
 */
export function createWebhookHarness(): WebhookHarness {
  const {
    db,
    client,
  }: { db: Database; client: { end: (o?: { timeout?: number }) => Promise<void> } } =
    createDatabase(DATABASE_URL);
  const config = harnessConfig();
  const logger = createLogger(config);
  const encryptionKey = config.twoFactor.encryptionKey;

  const users = createUserRepository(db);
  const subscriptions: WebhookSubscriptionRepository = createWebhookSubscriptionRepository(db);
  const deliveries = createWebhookDeliveryRepository(db);

  const dispatcher = createWebhookDispatcher({
    subscriptions,
    deliveries,
    transport: createPinnedWebhookTransport(),
    encryptionKey,
    audit: createAuditService(createAuditRepository(db)),
    logger,
  });

  function toHarness(row: {
    id: string;
    enabled: boolean;
    disabledReason: string | null;
    consecutiveFailures: number;
    secretEncrypted: string;
  }): HarnessSubscription {
    return {
      id: row.id,
      enabled: row.enabled,
      disabledReason: row.disabledReason,
      consecutiveFailures: row.consecutiveFailures,
      secretEncrypted: row.secretEncrypted,
    };
  }

  return {
    async subscriptionForEmail(email) {
      const user = await users.findByEmail(email);
      if (!user) throw new Error(`E3: no user for email ${email}`);
      const rows = await subscriptions.listForUser(user.id);
      const row = rows[0];
      if (!row) throw new Error(`E3: no webhook subscription for ${email}`);
      return toHarness(row);
    },
    async reload(id) {
      const row = await subscriptions.findById(id);
      if (!row) throw new Error(`E3: subscription ${id} vanished`);
      return toHarness(row);
    },
    secretFor(sub) {
      return decryptSecret(sub.secretEncrypted, encryptionKey);
    },
    deliver(subscriptionId, ctx) {
      const event: WebhookTestEvent = ctx.event ?? {
        type: 'alert.triggered',
        occurredAt: new Date().toISOString(),
      };
      return dispatcher.deliver(
        { subscriptionId, deliveryId: ctx.deliveryId, event: event as unknown as DomainEvent },
        { attempt: ctx.attempt, maxAttempts: ctx.maxAttempts },
      );
    },
    async dispose() {
      await client.end({ timeout: 5 });
    },
  };
}

// ── NL builder: fake local Ollama + admin provider config ────────────────────

export interface FakeOllama {
  /** `http://127.0.0.1:<port>` — the endpoint the admin config points the API at. */
  readonly endpoint: string;
  /** The model name the fake serves (and the admin config selects). */
  readonly model: string;
  /** How many `/api/chat` completions the API has asked this fake to generate. */
  chatCalls(): number;
  close(): Promise<void>;
}

/**
 * A loopback stand-in for the owner's LAN Ollama. It answers the only two
 * endpoints the {@link createOllamaProvider} adapter calls — `GET /api/tags`
 * (health / model list) and `POST /api/chat` — the latter with a fixed
 * `content` string, so the NL-builder draft is byte-for-byte deterministic and
 * never leaves the host. `chatCalls()` proves the draft was generated HERE, not
 * against a real provider.
 */
export async function createFakeOllama(
  content: string,
  model = 'e2e-mock:latest',
): Promise<FakeOllama> {
  let chatCalls = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const json = (payload: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));

    if (req.method === 'GET' && req.url === '/api/tags') {
      json({ models: [{ name: model }] });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      // Drain and discard the request body, then reply with the canned completion.
      req.on('data', () => {});
      req.on('end', () => {
        chatCalls += 1;
        json({ message: { role: 'assistant', content } });
      });
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    model,
    chatCalls: () => chatCalls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Point the admin-configured AI provider at `endpoint`/`model` via the real
 * `PATCH /admin/ai/settings`. The registry resolves the provider per request, so
 * this takes effect on the very next `/ai/*` call with no redeploy — the switch-
 * without-redeploy contract. `request` must already be an admin session.
 */
export async function setAiProvider(
  request: APIRequestContext,
  endpoint: string,
  model: string,
): Promise<void> {
  const res = await request.patch(`${API_BASE_URL}/api/v1/admin/ai/settings`, {
    headers: CSRF_HEADERS,
    data: { endpoint, model },
  });
  if (!res.ok()) throw new Error(`E3: set AI provider ${res.status()}: ${await res.text()}`);
}

/** Clear the AI provider override so the suite's default (AI disabled) is restored. */
export async function clearAiProvider(request: APIRequestContext): Promise<void> {
  const res = await request.patch(`${API_BASE_URL}/api/v1/admin/ai/settings`, {
    headers: CSRF_HEADERS,
    data: { endpoint: null, model: null },
  });
  if (!res.ok()) throw new Error(`E3: clear AI provider ${res.status()}: ${await res.text()}`);
}
