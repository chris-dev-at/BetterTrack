/**
 * E1-specific e2e harness — digest + quiet-hours delivery ([V5-P14][E1], #734).
 *
 * The V5-P3 digest / quiet-hours behaviors have no in-run HTTP seam: the
 * production driver is the worker's cron, delivery deliberately skips the still-
 * open current period, and the running Playwright stack has SMTP unset (so its
 * own EmailService is disabled and captures nothing). Per the owner's COD
 * decision on #734 ("proceed with an e2e-local service harness; do not add a
 * product/admin test endpoint"), this helper is the allowed E1-specific seam:
 * it connects to the SAME Playwright test database and constructs the REAL
 * notification dispatcher + digest/deferred-delivery service from the production
 * repositories, wired to an injected deterministic clock and an in-memory
 * capture transport. The browser flow still creates the user and configures the
 * digest cadence + quiet-hours window through the real Settings UI; this helper
 * reads those exact settings back out of the DB and exercises the real
 * service/repository logic against them — no product-code change, no SMTP, no
 * external service, no wall-clock sleeps.
 *
 * Two design points make the assertions deterministic AND race-free against the
 * live worker that shares this database:
 *
 *  - **Injected clock.** Both the dispatcher's quiet-hours defer decision and the
 *    digest/deferred delivery run off one mutable `clock` this helper controls,
 *    so "inside the window", "period closed" and "window end" are exact — never a
 *    real-wall-clock coin flip.
 *  - **Far-future stamps.** Dispatch happens at a FIXED far-future instant, so
 *    every queued row carries a far-future period / `deliver_after`. The live
 *    worker's cron evaluates against the real clock (2026), for which those rows
 *    are never "closed"/"due", so it never claims them out from under the test;
 *    this helper claims them with an even-later injected clock.
 *
 * The email matrix (which type routes to email) is configured HERE via the
 * production repository rather than through the browser: email is a deployment-
 * gated channel (SMTP), so its column is hidden in the SMTP-less Playwright UI —
 * `upsertChannelConfig` is the production write the UI would otherwise perform.
 */
import { loadConfig } from '../../apps/api/src/config/env';
import { createDatabase, type Database } from '../../apps/api/src/data/db';
import { createAuditRepository } from '../../apps/api/src/data/repositories/auditRepository';
import { createEmailLogRepository } from '../../apps/api/src/data/repositories/emailLogRepository';
import { createNotificationDigestRepository } from '../../apps/api/src/data/repositories/notificationDigestRepository';
import { createNotificationRepository } from '../../apps/api/src/data/repositories/notificationRepository';
import { createUserRepository } from '../../apps/api/src/data/repositories/userRepository';
import { createLogger } from '../../apps/api/src/logger';
import { createAuditService } from '../../apps/api/src/services/audit/auditService';
import { createEmailService } from '../../apps/api/src/services/email/emailService';
import type { MailTransport, OutgoingMail } from '../../apps/api/src/services/email/transport';
import {
  createDigestService,
  type DeferredDeliveryResult,
  type DigestDeliveryResult,
} from '../../apps/api/src/services/notifications/digestService';
import { createNotificationDispatcher } from '../../apps/api/src/services/notifications/notificationDispatcher';

import { DATABASE_URL, REDIS_URL, SESSION_SECRET } from './config';

/** A captured outbound email — the same shape the real SMTP transport receives. */
export type CapturedMail = OutgoingMail;

export interface E1Harness {
  /** Every "sent" email, in send order (the digest summary + released deferrals). */
  readonly captured: CapturedMail[];
  /** Advance the injected clock the dispatcher + delivery run off of. */
  setNow(now: Date): void;
  /** Resolve a browser-provisioned user's id from its email. */
  findUserIdByEmail(email: string): Promise<string>;
  /**
   * Set the user's per-type EMAIL routing (the matrix). Email is SMTP-gated and
   * hidden in the Playwright UI, so this production write stands in for the
   * browser cell the UI would otherwise expose (see file header).
   */
  setEmailMatrix(userId: string, overrides: Record<string, boolean>): Promise<void>;
  /** Dispatch a `friend.request` at the current injected clock. */
  dispatchFriendRequest(input: {
    userId: string;
    actorUsername: string;
    requestId: string;
  }): Promise<void>;
  /** Dispatch a `watchlist.shared` at the current injected clock. */
  dispatchWatchlistShared(input: {
    userId: string;
    actorUsername: string;
    watchlistId: string;
  }): Promise<void>;
  /** Run the daily-digest delivery for the current injected clock. */
  deliverDailyDigest(): Promise<DigestDeliveryResult>;
  /** Run the quiet-hours deferred-delivery pass for the current injected clock. */
  deliverDeferred(): Promise<DeferredDeliveryResult>;
  /** Close the database pool. */
  dispose(): Promise<void>;
}

/**
 * Build the E1 harness against the running Playwright Postgres. The email
 * channel is force-enabled on THIS helper's own config (SMTP host+from) so the
 * real EmailService renders and hands the message to the capture transport — the
 * live API/worker's own EmailService stays disabled and untouched.
 */
export function createE1Harness(): E1Harness {
  const {
    db,
    client,
  }: { db: Database; client: { end: (opts?: { timeout?: number }) => Promise<void> } } =
    createDatabase(DATABASE_URL);

  const config = loadConfig({
    NODE_ENV: 'test', // silences the logger; email.enabled keys off SMTP_* only
    DATABASE_URL,
    REDIS_URL,
    SESSION_SECRET,
    SMTP_HOST: 'smtp.e2e.local',
    SMTP_FROM: 'BetterTrack E2E <no-reply@e2e.local>',
  });
  const logger = createLogger(config);

  const captured: CapturedMail[] = [];
  const transport: MailTransport = {
    async send(mail) {
      captured.push(mail);
    },
  };

  const users = createUserRepository(db);
  const notifications = createNotificationRepository(db);
  const digestRepo = createNotificationDigestRepository(db);
  const email = createEmailService({
    config,
    logger,
    audit: createAuditService(createAuditRepository(db)),
    emailLog: createEmailLogRepository(db),
    transport,
  });

  // One mutable clock drives the defer decision AND the delivery run so every
  // "inside the window / period closed / window end" moment is exact.
  let clock = new Date();

  const dispatcher = createNotificationDispatcher({
    bus: { publish: async () => {} }, // realtime bell push is out of E1 scope
    repo: notifications,
    users,
    email,
    digest: {
      cadenceFor: (userId, type) => digestRepo.cadenceFor(userId, type),
      enqueue: (item) => digestRepo.enqueue(item),
    },
    quietHours: { enqueueDeferred: (item) => digestRepo.enqueueDeferred(item) },
    now: () => clock,
    logger,
  });

  const digestService = createDigestService({
    repo: digestRepo,
    users,
    email,
    quietHours: { enqueueDeferred: (item) => digestRepo.enqueueDeferred(item) },
    now: () => clock,
    logger,
  });

  return {
    captured,
    setNow(now) {
      clock = now;
    },
    async findUserIdByEmail(userEmail) {
      const row = await users.findByEmail(userEmail);
      if (!row) throw new Error(`E1: no user for email ${userEmail}`);
      return row.id;
    },
    async setEmailMatrix(userId, overrides) {
      await notifications.upsertChannelConfig(userId, 'email', overrides);
    },
    async dispatchFriendRequest({ userId, actorUsername, requestId }) {
      await dispatcher.dispatch({
        type: 'friend.request',
        userId,
        actorId: 'e1-actor',
        actorUsername,
        requestId,
        occurredAt: clock.toISOString(),
      });
    },
    async dispatchWatchlistShared({ userId, actorUsername, watchlistId }) {
      await dispatcher.dispatch({
        type: 'watchlist.shared',
        userId,
        actorId: 'e1-actor',
        actorUsername,
        watchlistId,
        occurredAt: clock.toISOString(),
      });
    },
    deliverDailyDigest() {
      return digestService.deliverDue('daily');
    },
    deliverDeferred() {
      return digestService.deliverDeferred();
    },
    async dispose() {
      await client.end({ timeout: 5 });
    },
  };
}
