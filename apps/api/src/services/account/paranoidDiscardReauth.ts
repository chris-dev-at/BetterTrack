import type { Redis } from 'ioredis';

import type { ParanoidDisableRequest } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { Database } from '../../data/db';
import { createTwoFactorRepository } from '../../data/repositories/twoFactorRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { ApiError, badRequest, tooManyRequests, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  ACCOUNT_PARANOID_DISCARD_NAMESPACE,
  ACCOUNT_VAULT_DELETE_NAMESPACE,
  PORTFOLIO_VAULT_MOVE_IN_NAMESPACE,
  PORTFOLIO_VAULT_MOVE_OUT_NAMESPACE,
} from '../auth/loginThrottle';
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

/** The additional same-lock verifier used by R5's per-vault delete. */
export interface VaultDeleteReauth {
  /**
   * §15 step-up while the caller owns the users-row lock. Keeping the
   * credential read and the destructive delete in one transaction closes the
   * password/factor-change race that a preliminary re-auth request would leave.
   */
  verifyVaultDelete(input: {
    userId: string;
    vaultId: string;
    body: VaultDeleteCredential;
    ip?: string | null;
    auth: LockedVaultDeleteAuth;
    db: Database;
  }): Promise<void>;
  /** Persist a wrong-credential audit only after the caller's transaction rolls back. */
  recordVaultDeleteFailure(error: unknown): Promise<boolean>;
  verifyPortfolioVaultTransition(input: {
    userId: string;
    portfolioId: string;
    vaultId: string;
    kind: 'move-in' | 'move-out';
    body: VaultDeleteCredential;
    ip?: string | null;
    auth: LockedVaultDeleteAuth;
    db: Database;
  }): Promise<void>;
  /** Persist a wrong transition credential only after its transaction rolls back. */
  recordPortfolioVaultTransitionFailure(error: unknown): Promise<boolean>;
}

export interface VaultDeleteCredential {
  password?: string;
  code?: string;
  recoveryCode?: string;
}

export interface LockedVaultDeleteAuth {
  passwordHash: string;
  twoFactorSecret: string | null;
  twoFactorEnabled: boolean;
  twoFactorEmailEnabled: boolean;
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
): ParanoidDiscardReauth & VaultDeleteReauth {
  const { config, redis, userRepo, passwordHasher, twoFactor, audit } = deps;

  // Its own namespace on the shared login schedule: wrong attempts here must not
  // be a cheaper oracle than login, and must not be charged to the deletion or
  // export counters either.
  const throttle = createProgressiveLimiter(
    redis,
    ACCOUNT_PARANOID_DISCARD_NAMESPACE,
    config.rateLimits.loginAccount,
  );
  const vaultDeleteThrottle = createProgressiveLimiter(
    redis,
    ACCOUNT_VAULT_DELETE_NAMESPACE,
    config.rateLimits.loginAccount,
  );
  const portfolioMoveInThrottle = createProgressiveLimiter(
    redis,
    PORTFOLIO_VAULT_MOVE_IN_NAMESPACE,
    config.rateLimits.loginAccount,
  );
  const portfolioMoveOutThrottle = createProgressiveLimiter(
    redis,
    PORTFOLIO_VAULT_MOVE_OUT_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  class VaultDeleteReauthFailure extends ApiError {
    constructor(
      response: ApiError,
      readonly auditMeta: {
        userId: string;
        vaultId: string;
        ip?: string | null;
        kind: string;
        locked: boolean;
      },
    ) {
      super(response.statusCode, response.code, response.message, response.details);
      this.name = 'VaultDeleteReauthFailure';
    }
  }

  class PortfolioVaultTransitionReauthFailure extends ApiError {
    constructor(
      response: ApiError,
      readonly auditMeta: {
        userId: string;
        portfolioId: string;
        vaultId: string;
        kind: 'move-in' | 'move-out';
        factor: string;
        ip?: string | null;
        locked: boolean;
      },
    ) {
      super(response.statusCode, response.code, response.message, response.details);
      this.name = 'PortfolioVaultTransitionReauthFailure';
    }
  }

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
    async verifyVaultDelete({ userId, vaultId, body, ip, auth, db }) {
      const cooling = await vaultDeleteThrottle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }

      const fail = async (kind: string): Promise<never> => {
        const decision = await vaultDeleteThrottle.consume(userId);
        const response = !decision.allowed
          ? tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.')
          : kind === 'password'
            ? unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS')
            : unauthorized('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
        throw new VaultDeleteReauthFailure(response, {
          userId,
          vaultId,
          ip,
          kind,
          locked: !decision.allowed,
        });
      };

      const factorState = {
        secret: auth.twoFactorSecret,
        enabled: auth.twoFactorEnabled,
        emailEnabled: auth.twoFactorEmailEnabled,
      };
      if (body.password !== undefined) {
        if (!(await passwordHasher.verify(auth.passwordHash, body.password))) {
          await fail('password');
        }
      } else if (body.recoveryCode !== undefined) {
        const ok = await twoFactor.consumeRecoveryCode(
          userId,
          body.recoveryCode,
          factorState,
          createTwoFactorRepository(db),
        );
        if (!ok) await fail('recovery_code');
      } else if (body.code !== undefined) {
        const ok = await twoFactor.verifyTotpCode(userId, body.code, factorState);
        if (!ok) await fail('totp');
      } else {
        // Direct service calls stay fail-closed if contract validation is bypassed.
        throw unauthorized('Re-authentication is required.', 'INVALID_CREDENTIALS');
      }
      await vaultDeleteThrottle.reset(userId);
    },
    async recordVaultDeleteFailure(error) {
      if (!(error instanceof VaultDeleteReauthFailure)) return false;
      await audit.record({
        actorId: error.auditMeta.userId,
        action: AuditAction.VaultDeleteReauthFail,
        targetType: 'vault',
        targetId: error.auditMeta.vaultId,
        ip: error.auditMeta.ip,
        meta: { kind: error.auditMeta.kind, locked: error.auditMeta.locked },
      });
      return true;
    },
    async verifyPortfolioVaultTransition({
      userId,
      portfolioId,
      vaultId,
      kind,
      body,
      ip,
      auth,
      db,
    }) {
      const transitionThrottle =
        kind === 'move-in' ? portfolioMoveInThrottle : portfolioMoveOutThrottle;
      const cooling = await transitionThrottle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }

      const fail = async (factor: string): Promise<never> => {
        const decision = await transitionThrottle.consume(userId);
        const response = !decision.allowed
          ? tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.')
          : unauthorized('Re-authentication failed.', 'INVALID_CREDENTIALS');
        throw new PortfolioVaultTransitionReauthFailure(response, {
          userId,
          portfolioId,
          vaultId,
          kind,
          factor,
          ip,
          locked: !decision.allowed,
        });
      };

      const factorState = {
        secret: auth.twoFactorSecret,
        enabled: auth.twoFactorEnabled,
        emailEnabled: auth.twoFactorEmailEnabled,
      };
      if (body.password !== undefined) {
        if (!(await passwordHasher.verify(auth.passwordHash, body.password)))
          await fail('password');
      } else if (body.recoveryCode !== undefined) {
        const ok = await twoFactor.consumeRecoveryCode(
          userId,
          body.recoveryCode,
          factorState,
          createTwoFactorRepository(db),
        );
        if (!ok) await fail('recovery_code');
      } else if (body.code !== undefined) {
        if (!(await twoFactor.verifyTotpCode(userId, body.code, factorState))) await fail('totp');
      } else {
        throw unauthorized('Re-authentication is required.', 'INVALID_CREDENTIALS');
      }
      await transitionThrottle.reset(userId);
    },
    async recordPortfolioVaultTransitionFailure(error) {
      if (!(error instanceof PortfolioVaultTransitionReauthFailure)) return false;
      await audit.record({
        actorId: error.auditMeta.userId,
        action:
          error.auditMeta.kind === 'move-in'
            ? AuditAction.PortfolioVaultMoveInReauthFail
            : AuditAction.PortfolioVaultMoveOutReauthFail,
        targetType: 'portfolio',
        targetId: error.auditMeta.portfolioId,
        ip: error.auditMeta.ip,
        meta: {
          kind: error.auditMeta.kind,
          factor: error.auditMeta.factor,
          locked: error.auditMeta.locked,
          vaultId: error.auditMeta.vaultId,
        },
      });
      return true;
    },
  };
}
