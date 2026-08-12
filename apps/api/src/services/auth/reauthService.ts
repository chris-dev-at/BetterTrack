import type { Redis } from 'ioredis';

import { tooManyRequests, unauthorized } from '../../errors';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import { AuditAction, type AuditService } from '../audit/auditService';
import { REAUTH_ACCOUNT_NAMESPACE } from './loginThrottle';

import type { AppConfig } from '../../config/env';
import type { PasswordHasher } from '../password/passwordHasher';
import type { UserRepository } from '../../data/repositories/userRepository';

/**
 * Generic session step-up verification (`POST /auth/reauth`).
 *
 * Every re-auth in the codebase so far rides its own destructive endpoint —
 * deletion, export, passkey management, the paranoid discard — each with its own
 * per-account throttle namespace. That works when the sensitive act IS an API
 * call, and stops working when the sensitive act happens entirely client-side:
 * the Vaults v2 QR handoff reveals a passphrase-bearing payload in the browser
 * and has nothing to POST. This endpoint is the missing primitive, and the
 * client is expected to FAIL CLOSED when it is absent.
 *
 * Security properties, all deliberate:
 *  - It proves possession of the password for the CURRENT session's user only.
 *    There is no user selector in the request; the session is the subject.
 *  - It is not a token mint. A 204 is an assertion about this instant, nothing
 *    the caller can store, replay or present elsewhere. Callers gate their own
 *    surface on the response; nothing here becomes an authorization artifact.
 *  - It carries its OWN per-account throttle namespace, so it can never become a
 *    cheaper brute-force oracle than login — the exact reasoning that already
 *    gives deletion, export and passkey management theirs.
 *  - `purpose` is caller-supplied provenance for the audit trail. It is never
 *    trusted for authorization and never changes what is verified.
 */
export interface ReauthServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  passwordHasher: PasswordHasher;
  audit: AuditService;
}

export interface ReauthInput {
  userId: string;
  password: string;
  purpose?: string;
  ip?: string | null;
}

export interface ReauthService {
  verify(input: ReauthInput): Promise<void>;
}

export function createReauthService(deps: ReauthServiceDeps): ReauthService {
  const throttle = createProgressiveLimiter(
    deps.redis,
    REAUTH_ACCOUNT_NAMESPACE,
    deps.config.rateLimits.loginAccount,
  );

  return {
    async verify({ userId, password, purpose, ip }) {
      // Refuse an already-cooling account BEFORE verifying, so a blocked retry
      // cannot ride through on a correct password — the same ordering the export
      // and deletion re-auths use.
      const cooling = await throttle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }

      const user = await deps.userRepo.findById(userId);
      // A session whose user vanished, or a non-active account, is a generic 401
      // — never a distinct signal about which of the two happened.
      if (!user || user.status !== 'active') throw unauthorized();

      const ok = await deps.passwordHasher.verify(user.passwordHash, password);
      if (!ok) {
        const decision = await throttle.consume(userId);
        await deps.audit.record({
          actorId: userId,
          action: AuditAction.AuthReauthFail,
          targetType: 'user',
          targetId: userId,
          ip: ip ?? null,
          meta: { purpose: purpose ?? null, locked: !decision.allowed },
        });
        if (!decision.allowed) {
          throw tooManyRequests(
            decision.retryAfterSec,
            'Too many attempts. Please wait and retry.',
          );
        }
        // The same generic credential error login uses: this endpoint must not
        // become a more talkative password oracle than the front door.
        throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
      }

      await throttle.reset(userId);
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.AuthReauth,
        targetType: 'user',
        targetId: userId,
        ip: ip ?? null,
        meta: { purpose: purpose ?? null },
      });
    },
  };
}
