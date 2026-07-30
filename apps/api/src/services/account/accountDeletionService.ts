import type { Redis } from 'ioredis';

import type { DeleteAccountRequest } from '@bettertrack/contracts';

import type { ChatRepository } from '../../data/repositories/chatRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { AppConfig } from '../../config/env';
import { badRequest, tooManyRequests, unauthorized } from '../../errors';
import type { EventBus, RealtimePrincipalInvalidatedEvent } from '../../events';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  ACCOUNT_DELETE_NAMESPACE,
  pinQuickAuthMarkerKey,
  rememberedDeviceKey,
  rememberedDevicesForUserKey,
} from '../auth/loginThrottle';
import type { TwoFactorService } from '../auth/twoFactorService';
import type { MirrorService } from '../mirror/mirrorService';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import type { SessionService } from '../sessions/sessionService';

/**
 * Self-service account deletion (PROJECTPLAN.md §13.4 V4-P2c, #362) — the ONE
 * platform capability behind both the web deletion page and the mobile in-app
 * flow (Google Play requires both an in-app path and a public web URL).
 *
 * Gates, in order:
 *  1. **Typed confirmation** — `confirmUsername` must match the account's
 *     username case-insensitively (same guard as the admin delete).
 *  2. **Re-auth** — the current password, or (for a 2FA-enrolled account) a
 *     fresh TOTP `code` or an unused `recoveryCode`. Failures accrue on a
 *     per-account progressive throttle so this endpoint is never a cheaper
 *     brute-force oracle than login itself.
 *
 * Deletion is **hard**: every session is revoked, then the `users` row is
 * deleted and the schema's FKs do the rest in one statement — portfolios,
 * holdings/transactions, cash sources + movements, tax rows, social edges,
 * tokens/grants (bearer lookups join the deleted rows, so API keys and OAuth
 * tokens die instantly), notifications, watchlists, alerts, 2FA state. Chat is
 * the deliberate exception (§16 2026-07-09): participant/sender FKs are
 * SET NULL, so the partner keeps the thread anonymized ("Deleted user"), closed
 * to new messages; conversations with both sides gone are purged. Rows that
 * merely *mention* the user (audit log, email log metadata) SET NULL their
 * actor column — after deletion no row keys to the user.
 */
export interface AccountDeletionServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  chatRepo: ChatRepository;
  sessions: SessionService;
  /** Lifecycle fan-out terminates existing cookie and bearer sockets after deletion. */
  events: Pick<EventBus, 'publish'>;
  logger?: Pick<Logger, 'warn'>;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  twoFactor: TwoFactorService;
  /**
   * MIRRORCHAIN §7 pre-delete succession hook (V5-P7 M4): for every group
   * portfolio the account owns, ownership transfers to the oldest manager (or
   * the chain dissolves) BEFORE the user row is removed, so the chain and the
   * other members' copies survive the deletion.
   */
  mirror: Pick<MirrorService, 'handleAccountDeletion'>;
}

export interface AccountDeletionService {
  /**
   * Verify the confirmation + credential and hard-delete the account. Throws
   * 400 CONFIRMATION_MISMATCH, 401 INVALID_CREDENTIALS / TWO_FACTOR_INVALID_CODE,
   * or 429 on a tripped throttle. On success every credential the caller holds
   * (cookie session, API key, OAuth token) is already dead.
   */
  deleteAccount(input: {
    userId: string;
    body: DeleteAccountRequest;
    ip?: string | null;
  }): Promise<void>;
}

export function createAccountDeletionService(
  deps: AccountDeletionServiceDeps,
): AccountDeletionService {
  const {
    config,
    redis,
    userRepo,
    chatRepo,
    sessions,
    events,
    logger,
    audit,
    passwordHasher,
    twoFactor,
    mirror,
  } = deps;

  // Per-account wrong-credential throttle (§10) on the same escalation ladder
  // as failed logins, independent of the per-IP limiter the route carries.
  const throttle = createProgressiveLimiter(
    redis,
    ACCOUNT_DELETE_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  async function removeRememberedDeviceBindings(userId: string): Promise<void> {
    const indexKey = rememberedDevicesForUserKey(userId);
    const deviceIds = new Set(await redis.smembers(indexKey));

    // Compatibility for bindings written before the reverse index existed.
    // SCAN stays bounded/non-blocking and can be removed after the 400-day
    // legacy horizon; new and lazily-used bindings come from the O(1) index.
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'remember_dev:*', 'COUNT', 100);
      if (keys.length > 0) {
        const userIds = await redis.mget(...keys);
        for (const [index, rememberedUserId] of userIds.entries()) {
          if (rememberedUserId === userId) {
            deviceIds.add(keys[index]!.slice('remember_dev:'.length));
          }
        }
      }
      cursor = nextCursor;
    } while (cursor !== '0');

    const transaction = redis.multi();
    for (const deviceId of deviceIds) {
      transaction.del(rememberedDeviceKey(deviceId), pinQuickAuthMarkerKey(deviceId));
    }
    transaction.del(indexKey);
    await transaction.exec();
  }

  /** Count one failed re-auth, audit it, and raise the right error. */
  async function failReauth(userId: string, ip: string | null | undefined, kind: string) {
    const decision = await throttle.consume(userId);
    await audit.record({
      action: AuditAction.AccountDeleteFail,
      targetType: 'user',
      targetId: userId,
      ip,
      meta: { kind, locked: !decision.allowed },
    });
    if (!decision.allowed) {
      throw tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.');
    }
    if (kind === 'password') {
      throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
    }
    throw unauthorized('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
  }

  async function invalidateAllRealtimePrincipals(userId: string): Promise<void> {
    try {
      await events.publish({
        type: 'realtime.principal.invalidated',
        userId,
        kind: 'all',
        credentialId: null,
        exceptCredentialId: null,
        occurredAt: new Date().toISOString(),
      } satisfies RealtimePrincipalInvalidatedEvent);
    } catch (err) {
      // The durable cascade has already made every credential unusable. Gateway
      // revalidation remains the fail-closed fallback for a missed fan-out.
      logger?.warn({ err, userId }, 'account deletion realtime invalidation publish failed');
    }
  }

  return {
    async deleteAccount({ userId, body, ip }) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();

      // Typed confirmation first — it is not a secret, so a mismatch neither
      // consumes the throttle nor discloses anything (the caller already knows
      // their own username from /auth/me).
      if (user.username.toLowerCase() !== body.confirmUsername.trim().toLowerCase()) {
        throw badRequest('Username confirmation does not match.', 'CONFIRMATION_MISMATCH');
      }

      // Reject an already-cooling account before any credential verify, so
      // blocked retries — even with a correct credential — cannot ride through
      // the cooldown (§10, mirrors the login/PIN limiters).
      const cooling = await throttle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }

      // Re-auth: password wins when several credentials are sent; the 2FA
      // factors are only meaningful for an enrolled account.
      if (body.password !== undefined) {
        const ok = await passwordHasher.verify(user.passwordHash, body.password);
        if (!ok) await failReauth(userId, ip, 'password');
      } else if (!(await twoFactor.isEnabled(userId))) {
        // A code was sent for an account with no 2FA: never treat it as a match.
        throw unauthorized('Re-authenticate with your password.', 'TWO_FACTOR_NOT_ENABLED');
      } else if (body.recoveryCode !== undefined) {
        const ok = await twoFactor.consumeRecoveryCode(userId, body.recoveryCode);
        if (!ok) await failReauth(userId, ip, 'recovery_code');
      } else {
        const ok = await twoFactor.verifyTotpCode(userId, body.code!);
        if (!ok) await failReauth(userId, ip, 'totp');
      }
      await throttle.reset(userId);

      // Revoke every session first, then drop the row — the FK graph deletes
      // (or anonymizes, for chat) everything else atomically with it. Bearer
      // credentials need no separate revocation: their rows cascade, and the
      // bearer lookup resolves from the DB per request.
      await sessions.destroyAllForUser(userId);
      await removeRememberedDeviceBindings(userId);
      // MIRRORCHAIN §7: hand off owned group portfolios (transfer-on-delete to
      // the oldest manager, or dissolve) in the SAME pre-delete slot, so the
      // subsequent row delete only cascades this member's own copy away and
      // every other member's copy + the chain stay intact (V5-P7 M4).
      await mirror.handleAccountDeletion(userId);
      await userRepo.remove(userId);
      // The row cascade has now revoked every credential family. Disconnect any
      // socket that authenticated before deletion rather than waiting for its
      // bounded revalidation sweep.
      await invalidateAllRealtimePrincipals(userId);
      await chatRepo.purgeOrphanedConversations();

      // The account is gone, so the trail carries no actor FK or copied direct
      // identifier. The opaque target UUID is enough to correlate this event
      // until the audit-retention sweep removes it.
      await audit.record({
        action: AuditAction.UserDeleted,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { via: 'self' },
      });
    },
  };
}
