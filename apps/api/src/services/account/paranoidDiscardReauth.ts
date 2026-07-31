import type { Redis } from 'ioredis';

import type { ParanoidDisableRequest } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { UserRepository } from '../../data/repositories/userRepository';
import { badRequest, tooManyRequests, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { ACCOUNT_PARANOID_DISCARD_NAMESPACE } from '../auth/loginThrottle';
import type { TwoFactorService } from '../auth/twoFactorService';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';

/**
 * Re-auth gate for the ONE irreversible paranoid transition: `disable` with
 * `discard: true`, the §3 destruction exit for a vault whose key is lost. The
 * ordinary disable hands the decrypted rows back and is therefore not
 * destructive; discarding throws them away for good, so it carries exactly the
 * gates `accountDeletionService.deleteAccount` carries, in the same order:
 *
 *  1. **Typed confirmation** — `confirmUsername` must match the account's
 *     username case-insensitively. Not a secret, so a mismatch neither consumes
 *     the throttle nor discloses anything.
 *  2. **Re-auth** — the current password, or (for a 2FA-enrolled account) a
 *     fresh TOTP `code` or an unused `recoveryCode`, on a per-account
 *     progressive throttle that is checked BEFORE any credential verify so a
 *     cooling account cannot ride through with a correct credential.
 *
 * It is a required dependency of the transition service rather than an optional
 * one: a composition that forgets it must not typecheck, because the failure
 * mode is a live hijacked session destroying a vault with one POST.
 */
export interface ParanoidDiscardReauth {
  /** Throws 400/401/429 exactly like the deletion gate; returns on success. */
  verify(input: {
    userId: string;
    body: ParanoidDisableRequest;
    ip?: string | null;
  }): Promise<void>;
}

export interface ParanoidDiscardReauthDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  passwordHasher: PasswordHasher;
  twoFactor: TwoFactorService;
  audit: AuditService;
}

export function createParanoidDiscardReauth(
  deps: ParanoidDiscardReauthDeps,
): ParanoidDiscardReauth {
  const { config, redis, userRepo, passwordHasher, twoFactor, audit } = deps;

  // Its own namespace on the shared login schedule: wrong attempts here must not
  // be a cheaper oracle than login, and must not be charged to the deletion or
  // export counters either.
  const throttle = createProgressiveLimiter(
    redis,
    ACCOUNT_PARANOID_DISCARD_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  async function failReauth(userId: string, ip: string | null | undefined, kind: string) {
    const decision = await throttle.consume(userId);
    await audit.record({
      action: AuditAction.ParanoidDiscardFail,
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

  return {
    async verify({ userId, body, ip }) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();

      // The contract already rejects a `discard` without these, so a missing
      // field here means the schema and this gate drifted apart — fail closed.
      if (
        body.confirmUsername === undefined ||
        user.username.toLowerCase() !== body.confirmUsername.trim().toLowerCase()
      ) {
        throw badRequest('Username confirmation does not match.', 'CONFIRMATION_MISMATCH');
      }

      const cooling = await throttle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }

      // Password wins when several credentials are sent; the 2FA factors are
      // only meaningful for an enrolled account.
      if (body.password !== undefined) {
        const ok = await passwordHasher.verify(user.passwordHash, body.password);
        if (!ok) await failReauth(userId, ip, 'password');
      } else if (!(await twoFactor.isEnabled(userId))) {
        throw unauthorized('Re-authenticate with your password.', 'TWO_FACTOR_NOT_ENABLED');
      } else if (body.recoveryCode !== undefined) {
        const ok = await twoFactor.consumeRecoveryCode(userId, body.recoveryCode);
        if (!ok) await failReauth(userId, ip, 'recovery_code');
      } else if (body.code !== undefined) {
        const ok = await twoFactor.verifyTotpCode(userId, body.code);
        if (!ok) await failReauth(userId, ip, 'totp');
      } else {
        throw unauthorized('Re-authenticate with your password.', 'INVALID_CREDENTIALS');
      }
      await throttle.reset(userId);
    },
  };
}
