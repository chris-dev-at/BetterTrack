import type { Redis } from 'ioredis';

import type { ParanoidDisableRequest, ParanoidEnableRequest } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { Database } from '../../data/db';
import { createTwoFactorRepository } from '../../data/repositories/twoFactorRepository';
import { ApiError, badRequest, tooManyRequests, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { ACCOUNT_PARANOID_TRANSITION_NAMESPACE } from '../auth/loginThrottle';
import type { TwoFactorService } from '../auth/twoFactorService';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';

type ParanoidTransitionRequest = ParanoidEnableRequest | ParanoidDisableRequest;

/**
 * In-request step-up for BOTH privacy-mode transition directions. The caller
 * invokes this only after taking the transition's exclusive account lock and
 * before its first destructive write, so a concurrent password/factor change
 * cannot race a credential check away from the state change it authorizes.
 *
 * Password, TOTP and recovery-code behavior deliberately matches
 * `accountDeletionService`: password wins if several fields are supplied, wrong
 * attempts use a dedicated per-account progressive throttle, and failures are
 * audited without copying the credential.
 */
export interface ParanoidTransitionReauth {
  /** Throws 400/401/429 like the deletion gate; returns only on success. */
  verify(input: {
    userId: string;
    body: ParanoidTransitionRequest;
    ip?: string | null;
    /** Credential columns read by the transition's users-row FOR UPDATE. */
    auth: {
      username: string;
      passwordHash: string;
      twoFactorSecret: string | null;
      twoFactorEnabled: boolean;
      twoFactorEmailEnabled: boolean;
    };
    /** The same transaction that owns the users-row lock. */
    db: Database;
    /** The lost-key discard additionally requires the typed username. */
    requireUsernameConfirmation?: boolean;
  }): Promise<void>;
  /** Persist a verifier failure only after the enclosing transaction releases its lock. */
  recordFailure(error: unknown): Promise<boolean>;
}

export interface ParanoidTransitionReauthDeps {
  config: AppConfig;
  redis: Redis;
  passwordHasher: PasswordHasher;
  twoFactor: TwoFactorService;
  audit: AuditService;
}

class ParanoidTransitionReauthFailure extends ApiError {
  constructor(
    response: ApiError,
    readonly audit: {
      userId: string;
      ip?: string | null;
      kind: string;
      locked: boolean;
    },
  ) {
    super(response.statusCode, response.code, response.message, response.details);
    this.name = 'ParanoidTransitionReauthFailure';
  }
}

export function createParanoidTransitionReauth(
  deps: ParanoidTransitionReauthDeps,
): ParanoidTransitionReauth {
  const { config, redis, passwordHasher, twoFactor, audit } = deps;

  const throttle = createProgressiveLimiter(
    redis,
    ACCOUNT_PARANOID_TRANSITION_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  async function failReauth(userId: string, ip: string | null | undefined, kind: string) {
    const decision = await throttle.consume(userId);
    const response = !decision.allowed
      ? tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.')
      : kind === 'password'
        ? unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS')
        : unauthorized('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
    throw new ParanoidTransitionReauthFailure(response, {
      userId,
      ip,
      kind,
      locked: !decision.allowed,
    });
  }

  return {
    async verify({ userId, body, ip, auth, db, requireUsernameConfirmation = false }) {
      if (requireUsernameConfirmation) {
        const confirmUsername = 'confirmUsername' in body ? body.confirmUsername : undefined;
        if (
          confirmUsername === undefined ||
          auth.username.toLowerCase() !== confirmUsername.trim().toLowerCase()
        ) {
          throw badRequest('Username confirmation does not match.', 'CONFIRMATION_MISMATCH');
        }
      }

      // Refuse an already-cooling account before a credential verify, including
      // a correct retry, exactly like the deletion flow.
      const cooling = await throttle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }

      if (body.password !== undefined) {
        const ok = await passwordHasher.verify(auth.passwordHash, body.password);
        if (!ok) await failReauth(userId, ip, 'password');
      } else if (!auth.twoFactorEnabled && !auth.twoFactorEmailEnabled) {
        throw unauthorized('Re-authenticate with your password.', 'TWO_FACTOR_NOT_ENABLED');
      } else if (body.recoveryCode !== undefined) {
        const ok = await twoFactor.consumeRecoveryCode(
          userId,
          body.recoveryCode,
          {
            secret: auth.twoFactorSecret,
            enabled: auth.twoFactorEnabled,
            emailEnabled: auth.twoFactorEmailEnabled,
          },
          createTwoFactorRepository(db),
        );
        if (!ok) await failReauth(userId, ip, 'recovery_code');
      } else if (body.code !== undefined) {
        const ok = await twoFactor.verifyTotpCode(userId, body.code, {
          secret: auth.twoFactorSecret,
          enabled: auth.twoFactorEnabled,
          emailEnabled: auth.twoFactorEmailEnabled,
        });
        if (!ok) await failReauth(userId, ip, 'totp');
      } else {
        // Contract drift must remain fail-closed even for direct service callers.
        throw unauthorized('Re-authentication is required.', 'INVALID_CREDENTIALS');
      }
      await throttle.reset(userId);
    },
    async recordFailure(error) {
      if (!(error instanceof ParanoidTransitionReauthFailure)) return false;
      await audit.record({
        action: AuditAction.ParanoidTransitionReauthFail,
        targetType: 'user',
        targetId: error.audit.userId,
        ip: error.audit.ip,
        meta: { kind: error.audit.kind, locked: error.audit.locked },
      });
      return true;
    },
  };
}
