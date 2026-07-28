import { randomInt } from 'node:crypto';

import type { Redis } from 'ioredis';

import type {
  TwoFactorEnrollResponse,
  TwoFactorMethodEnabledResponse,
  TwoFactorRecoveryCodesResponse,
  TwoFactorStatusResponse,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type {
  TwoFactorRepository,
  TwoFactorState,
} from '../../data/repositories/twoFactorRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { badRequest, conflict, notFound, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { decryptSecret, encryptSecret } from '../crypto/secretBox';
import { hashToken } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { SecurityMutationContext, SessionService } from '../sessions/sessionService';
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from './totp';

export interface TwoFactorServiceDeps {
  config: AppConfig;
  userRepo: UserRepository;
  twoFactorRepo: TwoFactorRepository;
  audit: AuditService;
  /** Backs the email-method setup code (proving mailbox access on enable, #298). */
  redis: Redis;
  /** Sends the email-method setup code; also the SMTP-configured signal for the guard. */
  email: EmailService;
  /** Omitted in the worker, whose export-only instance never mutates factors. */
  sessions?: Pick<SessionService, 'destroyAllForUser'>;
}

/** Which second-factor methods an account has switched on (#298). */
export interface TwoFactorMethods {
  /** Authenticator app (TOTP). */
  totp: boolean;
  /** Email codes. */
  email: boolean;
}

/** Factor state read atomically with the durable request/session generation. */
export interface TwoFactorAuthorizationState {
  enabled: boolean;
  securityGeneration: number;
}

/** Internal result wrapper; the HTTP layer emits only `response`. */
export interface TwoFactorMutationResult<T> {
  response: T;
}

export interface TwoFactorService {
  /** The caller's current per-method 2FA state (§6.1). */
  status(userId: string): Promise<TwoFactorStatusResponse>;
  /**
   * Begin TOTP enrollment (§6.1): mint a fresh secret, store it ENCRYPTED in a
   * provisional (not-yet-enabled) state, and return the `otpauth://` URI + secret
   * for the authenticator QR. Re-enrolling while TOTP is already on is rejected.
   */
  enrollTotp(
    userId: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorEnrollResponse>;
  /**
   * Cancel a pending (unconfirmed) TOTP enrollment (#401): wipe the provisional
   * secret so a client's "cancel" on the enroll screen cleans up server-side.
   * Armed TOTP is untouchable here — a 409 `TWO_FACTOR_ALREADY_ENABLED` protects
   * it (disabling needs a valid factor via {@link disableTotp}); a 404
   * `TWO_FACTOR_NOT_PENDING` when there is nothing pending to cancel.
   */
  cancelTotpEnrollment(
    userId: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<void>;
  /**
   * Confirm TOTP enrollment (§6.1): a valid current code flips the TOTP method on.
   * Recovery codes are issued only when this is the FIRST method enabled (returned
   * once, in plaintext); otherwise `recoveryCodes` is `null` and the existing set
   * stays valid.
   */
  confirmTotp(
    userId: string,
    code: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<TwoFactorMethodEnabledResponse>>;
  /**
   * Turn the TOTP method off (§6.1): a valid factor (TOTP code or an unused
   * recovery code) authorizes it. The secret is wiped; recovery codes are dropped
   * only if no method remains.
   */
  disableTotp(
    userId: string,
    code: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<void>>;
  /**
   * Begin email-method enrollment (#298): send a one-time code to the account
   * email to prove mailbox access. Rejected with `TWO_FACTOR_EMAIL_UNAVAILABLE`
   * when SMTP is unconfigured and email would be the *only* method — a user must
   * never lock themselves out behind mail that can't be sent.
   */
  startEmailEnrollment(
    userId: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<void>;
  /**
   * Confirm email-method enrollment (#298): a valid setup code turns the email
   * method on. Recovery codes are issued only when this is the FIRST method
   * enabled (returned once); otherwise `recoveryCodes` is `null`.
   */
  confirmEmail(
    userId: string,
    code: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<TwoFactorMethodEnabledResponse>>;
  /**
   * Turn the email method off (#298). Authorized by the authenticated session
   * alone — the mailbox was already proven at enable time and there is no offline
   * factor to re-enter. Recovery codes are dropped only if no method remains.
   */
  disableEmail(
    userId: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<void>>;
  /** Regenerate the recovery codes (§6.1): only while some method is on; old set voided. */
  regenerateRecoveryCodes(
    userId: string,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<TwoFactorRecoveryCodesResponse>>;
  /** Whether the account has ANY 2FA method on — the login challenge gate (§6.1). */
  isEnabled(userId: string): Promise<boolean>;
  /**
   * Final request-bootstrap authorization read. Factor state and generation come
   * from one repository read so an in-flight request cannot inherit a later
   * generation's newly enabled administrator assurance.
   */
  getAuthorizationState(userId: string): Promise<TwoFactorAuthorizationState | null>;
  /** Which methods are on, so the login flow can offer the right challenge channels. */
  getMethods(userId: string): Promise<TwoFactorMethods>;
  /**
   * Login-challenge factor check (§6.1): true when `code` is the account's current
   * TOTP code. Requires the TOTP method on; a malformed/undecryptable secret
   * verifies as false. Does not touch recovery codes.
   */
  verifyTotpCode(userId: string, code: string): Promise<boolean>;
  /**
   * Login-challenge factor check (§6.1): consume one unused recovery code
   * single-use, returning whether a match was found. Works whenever any method is
   * on, so recovery codes stay usable across the method mix.
   */
  consumeRecoveryCode(userId: string, code: string): Promise<boolean>;
}

// The email-method setup code (#298): a short-lived numeric code proving the user
// controls the account mailbox before the method activates. Distinct from the
// login-time email code, which the auth service scopes to a pending challenge.
const EMAIL_SETUP_CODE_TTL_MINUTES = 10;
const emailSetupKey = (userId: string) => `2fa_email_setup:${userId}`;

interface EmailSetupState {
  codeHash: string;
  securityGeneration: number;
}

export function createTwoFactorService(deps: TwoFactorServiceDeps): TwoFactorService {
  const { config, userRepo, twoFactorRepo, audit, redis, email, sessions } = deps;

  const alreadyEnabled = () =>
    badRequest(
      'Authenticator-app two-factor authentication is already enabled.',
      'TWO_FACTOR_ALREADY_ENABLED',
    );
  const notEnabled = () =>
    badRequest('Two-factor authentication is not enabled.', 'TWO_FACTOR_NOT_ENABLED');

  /** True when at least one 2FA method is currently on. */
  const anyMethodOn = (state: TwoFactorState) => state.enabled || state.emailEnabled;

  /** Generate a fresh recovery-code batch; repository composites persist hashes. */
  function recoveryCodeBatch(): { codes: string[]; hashes: string[] } {
    const codes = generateRecoveryCodes();
    const hashes = codes.map((code) => hashToken(normalizeRecoveryCode(code)));
    return { codes, hashes };
  }

  async function invalidateSessions(userId: string): Promise<void> {
    if (!sessions) return;
    try {
      await sessions.destroyAllForUser(userId);
    } catch {
      // The committed generation rejects every old cookie even when eager
      // Redis cleanup is unavailable.
    }
  }

  async function invalidEmailSetup(userId: string): Promise<never> {
    await redis.del(emailSetupKey(userId));
    throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
  }

  async function parseEmailSetup(userId: string, raw: string): Promise<EmailSetupState> {
    try {
      const parsed = JSON.parse(raw) as Partial<EmailSetupState>;
      if (
        typeof parsed.codeHash !== 'string' ||
        !Number.isSafeInteger(parsed.securityGeneration) ||
        parsed.securityGeneration! < 0
      ) {
        return invalidEmailSetup(userId);
      }
      return parsed as EmailSetupState;
    } catch {
      return invalidEmailSetup(userId);
    }
  }

  async function authorizationState(userId: string): Promise<TwoFactorAuthorizationState | null> {
    const state = await twoFactorRepo.getState(userId);
    return state
      ? {
          enabled: anyMethodOn(state),
          securityGeneration: state.securityGeneration,
        }
      : null;
  }

  /**
   * True when `code` is a valid second factor for the account: a TOTP code
   * verified against the decrypted secret (TOTP method on), or an unused recovery
   * code (consumed on match). A malformed/undecryptable secret verifies as false.
   */
  async function verifyFactor(
    userId: string,
    state: TwoFactorState,
    code: string,
  ): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed) && state.enabled && state.secret) {
      let secret: string;
      try {
        secret = decryptSecret(state.secret, config.recordEncryption);
      } catch {
        return false;
      }
      return verifyTotp(secret, trimmed);
    }
    const hash = hashToken(normalizeRecoveryCode(trimmed));
    return twoFactorRepo.consumeRecoveryCode(userId, hash, new Date());
  }

  return {
    async status(userId) {
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      return {
        totpEnabled: state.enabled,
        totpPending: !state.enabled && state.secret !== null,
        emailEnabled: state.emailEnabled,
        recoveryCodesRemaining: anyMethodOn(state)
          ? await twoFactorRepo.countUnusedRecoveryCodes(userId)
          : 0,
      };
    },

    async enrollTotp(userId, ip, security) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      const state = await twoFactorRepo.getState(userId);
      if (state?.enabled) throw alreadyEnabled();

      const secret = generateTotpSecret();
      const stored = await twoFactorRepo.setProvisionalSecret(
        userId,
        encryptSecret(secret, config.recordEncryption),
        security?.securityGeneration ?? user.securityGeneration,
      );
      if (!stored) throw unauthorized();
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorEnrolled,
        targetType: 'user',
        targetId: userId,
        ip,
      });

      return {
        otpauthUri: buildOtpauthUri({
          secret,
          accountName: user.email,
          issuer: config.twoFactor.issuer,
        }),
        secret,
      };
    },

    async cancelTotpEnrollment(userId, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      // Armed TOTP is never cleared by this route — that path needs a valid
      // factor (disableTotp). A pending secret exists only while not enabled.
      if (state.enabled) throw conflict(alreadyEnabled().message, 'TWO_FACTOR_ALREADY_ENABLED');
      if (!state.secret) {
        throw notFound(
          'There is no pending two-factor enrollment to cancel.',
          'TWO_FACTOR_NOT_PENDING',
        );
      }

      const cleared = await twoFactorRepo.clearProvisionalSecret(
        userId,
        security?.securityGeneration ?? state.securityGeneration,
      );
      if (!cleared) throw unauthorized();
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorEnrollCanceled,
        targetType: 'user',
        targetId: userId,
        ip,
      });
    },

    async confirmTotp(userId, code, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      if (state.enabled) throw alreadyEnabled();
      if (!state.secret) {
        throw badRequest(
          'Start two-factor enrollment before confirming.',
          'TWO_FACTOR_NOT_PENDING',
        );
      }

      const encryptedSecret = state.secret;
      let secret: string;
      try {
        secret = decryptSecret(encryptedSecret, config.recordEncryption);
      } catch {
        throw badRequest(
          'Two-factor enrollment is invalid; start again.',
          'TWO_FACTOR_NOT_PENDING',
        );
      }
      if (!verifyTotp(secret, code)) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }

      // First method on ⇒ issue the shared recovery codes; otherwise the email
      // method already provided them and they stay valid.
      const isFirstMethod = !state.emailEnabled;
      const recovery = isFirstMethod ? recoveryCodeBatch() : null;
      const securityGeneration = await twoFactorRepo.confirmTotp(
        userId,
        encryptedSecret,
        new Date(),
        recovery?.hashes ?? null,
        security?.securityGeneration ?? state.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();
      const recoveryCodes = recovery?.codes ?? null;
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorConfirmed,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      await invalidateSessions(userId);
      return { response: { recoveryCodes } };
    },

    async disableTotp(userId, code, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.enabled || !state.secret) throw notEnabled();

      const ok = await verifyFactor(userId, state, code);
      if (!ok) {
        throw unauthorized('That two-factor code is incorrect.', 'TWO_FACTOR_INVALID_CODE');
      }

      const securityGeneration = await twoFactorRepo.disableTotp(
        userId,
        !state.emailEnabled,
        security?.securityGeneration ?? state.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorDisabled,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      await invalidateSessions(userId);
      return { response: undefined };
    },

    async startEmailEnrollment(userId, ip, security) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      const securityGeneration = security?.securityGeneration ?? state.securityGeneration;
      if (state.securityGeneration !== securityGeneration) throw unauthorized();
      if (state.emailEnabled) {
        throw badRequest(
          'Email two-factor authentication is already enabled.',
          'TWO_FACTOR_ALREADY_ENABLED',
        );
      }

      // Lockout guard (#298): with no SMTP the confirmation code can't be sent, so
      // enabling email as the ONLY method would strand the user behind mail that
      // never arrives. Block it clearly. (With TOTP already on there's no lockout,
      // but the code still can't be received — so the guard applies uniformly.)
      if (!email.enabled) {
        throw badRequest(
          'Email delivery is not configured, so email codes can’t be sent. ' +
            'Ask your administrator to set up SMTP, or use an authenticator app instead.',
          'TWO_FACTOR_EMAIL_UNAVAILABLE',
        );
      }

      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const current = await twoFactorRepo.getState(userId);
      if (!current || current.securityGeneration !== securityGeneration) throw unauthorized();
      const setup: EmailSetupState = {
        codeHash: hashToken(code),
        securityGeneration,
      };
      await redis.set(
        emailSetupKey(userId),
        JSON.stringify(setup),
        'EX',
        EMAIL_SETUP_CODE_TTL_MINUTES * 60,
      );
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorEmailCodeSent,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { purpose: 'setup' },
      });
      // Best-effort send (§6.11) — logged to email_log. The guard above already
      // ensured the channel is configured, so this is expected to deliver.
      await email.sendTwoFactorCode({
        to: user.email,
        userId: user.id,
        code,
        expiresInMinutes: EMAIL_SETUP_CODE_TTL_MINUTES,
        audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
      });
    },

    async confirmEmail(userId, code, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      if (state.emailEnabled) {
        throw badRequest(
          'Email two-factor authentication is already enabled.',
          'TWO_FACTOR_ALREADY_ENABLED',
        );
      }

      const raw = await redis.get(emailSetupKey(userId));
      if (!raw) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      const setup = await parseEmailSetup(userId, raw);
      const securityGeneration = security?.securityGeneration ?? state.securityGeneration;
      if (state.securityGeneration !== securityGeneration) {
        // Do not let an older in-flight request erase a newer setup record.
        if (setup.securityGeneration !== state.securityGeneration) {
          await redis.del(emailSetupKey(userId));
        }
        throw unauthorized();
      }
      if (setup.securityGeneration !== securityGeneration) {
        return invalidEmailSetup(userId);
      }
      if (hashToken(code.trim()) !== setup.codeHash) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      await redis.del(emailSetupKey(userId));

      // First method on ⇒ issue the shared recovery codes; otherwise TOTP already
      // provided them.
      const isFirstMethod = !state.enabled;
      const recovery = isFirstMethod ? recoveryCodeBatch() : null;
      const committedGeneration = await twoFactorRepo.confirmEmail(
        userId,
        undefined,
        recovery?.hashes ?? null,
        setup.securityGeneration,
      );
      if (committedGeneration === null) throw unauthorized();
      const recoveryCodes = recovery?.codes ?? null;
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorEmailEnabled,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      await invalidateSessions(userId);
      return { response: { recoveryCodes } };
    },

    async disableEmail(userId, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.emailEnabled) {
        throw badRequest(
          'Email two-factor authentication is not enabled.',
          'TWO_FACTOR_NOT_ENABLED',
        );
      }

      const securityGeneration = await twoFactorRepo.disableEmail(
        userId,
        false,
        !state.enabled,
        security?.securityGeneration ?? state.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();
      await redis.del(emailSetupKey(userId));
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorEmailDisabled,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      await invalidateSessions(userId);
      return { response: undefined };
    },

    async regenerateRecoveryCodes(userId, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state || !anyMethodOn(state)) throw notEnabled();

      const recovery = recoveryCodeBatch();
      const securityGeneration = await twoFactorRepo.regenerateRecoveryCodes(
        userId,
        recovery.hashes,
        security?.securityGeneration ?? state.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorRecoveryRegenerated,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      await invalidateSessions(userId);
      return {
        response: { recoveryCodes: recovery.codes },
      };
    },

    async isEnabled(userId) {
      return Boolean((await authorizationState(userId))?.enabled);
    },

    getAuthorizationState(userId) {
      return authorizationState(userId);
    },

    async getMethods(userId) {
      const state = await twoFactorRepo.getState(userId);
      return { totp: Boolean(state?.enabled), email: Boolean(state?.emailEnabled) };
    },

    async verifyTotpCode(userId, code) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.enabled || !state.secret) return false;
      let secret: string;
      try {
        secret = decryptSecret(state.secret, config.recordEncryption);
      } catch {
        return false;
      }
      return verifyTotp(secret, code);
    },

    async consumeRecoveryCode(userId, code) {
      const state = await twoFactorRepo.getState(userId);
      if (!state || !anyMethodOn(state)) return false;
      const hash = hashToken(normalizeRecoveryCode(code));
      return twoFactorRepo.consumeRecoveryCode(userId, hash, new Date());
    },
  };
}
