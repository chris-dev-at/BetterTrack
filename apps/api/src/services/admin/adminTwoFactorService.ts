import { randomInt } from 'node:crypto';

import type { Redis } from 'ioredis';

import type {
  AdminTwoFactorStatusResponse,
  TwoFactorEnrollResponse,
  TwoFactorMethodEnabledResponse,
  TwoFactorRecoveryCodesResponse,
} from '@bettertrack/contracts';

import type { TwoFactorRepository } from '../../data/repositories/twoFactorRepository';
import { badRequest, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import { generateRecoveryCodes, normalizeRecoveryCode } from '../auth/totp';
import type { TwoFactorMutationResult, TwoFactorService } from '../auth/twoFactorService';
import {
  authenticationMethodOf,
  isPersistent,
  type SessionData,
  type SessionMfaMethod,
  type SessionSecurityContext,
  type SessionService,
} from '../sessions/sessionService';

export interface AdminMfaCompletionResult<T> extends TwoFactorMutationResult<T> {
  /** Fresh assured session replacing the first-factor/bootstrap session. */
  sessionId: string;
  persistent: boolean;
}

/**
 * Mandatory admin-login two-factor authentication (PROJECTPLAN.md §6.12, #400).
 *
 * The design reuses the user 2FA machinery rather than forking a parallel admin
 * protocol (owner COD): admin accounts are `users` rows, so their 2FA state lives
 * in the SAME `users` columns + `two_factor_recovery_codes` table, and the login
 * challenge runs through the SAME `/auth/login` → `/auth/2fa/verify` flow (the
 * auth service simply sends an admin's email code to `twoFactorEmail`). This
 * service is only the ADMIN-SIDE MANAGEMENT surface — the enrollment wizard + the
 * admin Security settings — so it:
 *   - delegates the TOTP + recovery-code lifecycle to {@link TwoFactorService}
 *     (identical crypto, one implementation), and
 *   - owns the email method to the SEPARATE 2FA email (set/confirm/change/disable),
 *     which the user surface has no concept of, plus the status shape carrying the
 *     setup-gate flag.
 *
 * Every method here is reachable only behind `requireAdmin` (404 to everyone
 * else), so non-admins can never touch admin 2FA state.
 */
export interface AdminTwoFactorService {
  /** The admin's own 2FA methods + the mandatory-setup gate state. */
  status(adminId: string, session: SessionSecurityContext): Promise<AdminTwoFactorStatusResponse>;
  /** Begin TOTP enrollment — provisional encrypted secret + provisioning URI. */
  enrollTotp(
    adminId: string,
    ip: string | null | undefined,
    session: SessionSecurityContext,
  ): Promise<TwoFactorEnrollResponse>;
  /** Confirm TOTP with a current code; recovery codes returned iff first method. */
  confirmTotp(
    adminId: string,
    code: string,
    ip: string | null | undefined,
    session: SessionSecurityContext,
  ): Promise<AdminMfaCompletionResult<TwoFactorMethodEnabledResponse>>;
  /** Turn TOTP off with a valid factor (re-enroll = disable then enroll). */
  disableTotp(
    adminId: string,
    code: string,
    ip: string | null | undefined,
    session: SessionSecurityContext,
  ): Promise<TwoFactorMutationResult<void>>;
  /**
   * Set (first time) or change the 2FA email and send a confirmation code to it.
   * A fresh 2FA `proof` (current TOTP code or unused recovery code) is REQUIRED
   * once the admin is already enrolled; the first-time set during forced
   * enrollment needs none (decision 3, #400).
   */
  startEmailEnrollment(
    adminId: string,
    email: string,
    proof: string | undefined,
    session: SessionSecurityContext,
    ip?: string | null,
  ): Promise<void>;
  /** Confirm the emailed code — activates the email method on the new address. */
  confirmEmail(
    adminId: string,
    code: string,
    ip: string | null | undefined,
    session: SessionSecurityContext,
  ): Promise<AdminMfaCompletionResult<TwoFactorMethodEnabledResponse>>;
  /** Turn the email method off (session-authorized); clears the 2FA email. */
  disableEmail(
    adminId: string,
    ip: string | null | undefined,
    session: SessionSecurityContext,
  ): Promise<TwoFactorMutationResult<void>>;
  /** Regenerate the recovery codes (only while some method is on; old set voided). */
  regenerateRecoveryCodes(
    adminId: string,
    ip: string | null | undefined,
    session: SessionSecurityContext,
  ): Promise<TwoFactorMutationResult<TwoFactorRecoveryCodesResponse>>;
}

export interface AdminTwoFactorServiceDeps {
  twoFactorRepo: TwoFactorRepository;
  /** The shared user 2FA core — TOTP + recovery lifecycle + factor checks. */
  twoFactor: TwoFactorService;
  audit: AuditService;
  redis: Redis;
  email: EmailService;
  sessions: Pick<SessionService, 'create' | 'destroyAllForUser' | 'get'>;
}

// The admin email-method setup code (#400): a short-lived numeric code proving the
// admin controls the chosen 2FA email before the method activates. Stored with the
// pending address so confirm writes the exact email that was proven. Distinct from
// the login-time email code (auth service, scoped to a pending challenge) and from
// the user email-setup code (twoFactorService, keyed to the account email).
const EMAIL_SETUP_CODE_TTL_MINUTES = 10;
const emailSetupKey = (adminId: string) => `admin_2fa_email_setup:${adminId}`;

interface EmailSetupState {
  email: string;
  codeHash: string;
  securityGeneration: number;
}

export function createAdminTwoFactorService(
  deps: AdminTwoFactorServiceDeps,
): AdminTwoFactorService {
  const { twoFactorRepo, twoFactor, audit, redis, email, sessions } = deps;

  /** Generate a fresh recovery-code batch; the repository persists it atomically. */
  function recoveryCodeBatch(): { codes: string[]; hashes: string[] } {
    const codes = generateRecoveryCodes();
    return {
      codes,
      hashes: codes.map((code) => hashToken(normalizeRecoveryCode(code))),
    };
  }

  async function invalidateSessions(adminId: string): Promise<void> {
    try {
      await sessions.destroyAllForUser(adminId);
    } catch {
      // The committed generation rejects every old cookie even when eager
      // Redis cleanup is unavailable.
    }
  }

  async function sessionForMfaCompletion(
    adminId: string,
    session: SessionSecurityContext,
  ): Promise<SessionData> {
    const current = await sessions.get(session.sessionId);
    if (
      !current ||
      current.userId !== adminId ||
      current.securityGeneration !== session.securityGeneration ||
      authenticationMethodOf(current) !== 'password'
    ) {
      throw unauthorized();
    }
    return current;
  }

  async function rotateAssuredSession<T>(
    adminId: string,
    prior: SessionData,
    method: SessionMfaMethod,
    result: TwoFactorMutationResult<T>,
  ): Promise<AdminMfaCompletionResult<T>> {
    const persistent = isPersistent(prior);
    const sessionId = await sessions.create(adminId, result.securityGeneration, persistent, {
      method: 'password',
      mfaAssurance: { method, verifiedAt: Date.now() },
    });
    return { ...result, sessionId, persistent };
  }

  async function invalidEmailSetup(adminId: string): Promise<never> {
    await redis.del(emailSetupKey(adminId));
    throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
  }

  async function parseEmailSetup(adminId: string, raw: string): Promise<EmailSetupState> {
    try {
      const parsed = JSON.parse(raw) as Partial<EmailSetupState>;
      if (
        typeof parsed.email !== 'string' ||
        typeof parsed.codeHash !== 'string' ||
        !Number.isSafeInteger(parsed.securityGeneration) ||
        parsed.securityGeneration! < 0
      ) {
        return invalidEmailSetup(adminId);
      }
      return parsed as EmailSetupState;
    } catch {
      return invalidEmailSetup(adminId);
    }
  }

  /**
   * A fresh 2FA proof for the email-change gate (decision 3): a current TOTP code
   * (when that method is on; non-consuming) or an unused recovery code (consumed
   * single-use on match). Reuses the shared core's factor checks so there is one
   * implementation of both.
   */
  async function proofOk(adminId: string, proof: string | undefined): Promise<boolean> {
    if (!proof) return false;
    const trimmed = proof.trim();
    if (/^\d{6}$/.test(trimmed)) return twoFactor.verifyTotpCode(adminId, trimmed);
    return twoFactor.consumeRecoveryCode(adminId, trimmed);
  }

  return {
    async status(adminId, session) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state || state.securityGeneration !== session.securityGeneration) {
        throw unauthorized();
      }
      const anyOn = state.enabled || state.emailEnabled;
      const recoveryCodesRemaining = anyOn
        ? await twoFactorRepo.countUnusedRecoveryCodes(adminId)
        : 0;
      const current = await twoFactorRepo.getState(adminId);
      if (!current || current.securityGeneration !== session.securityGeneration) {
        throw unauthorized();
      }
      const currentAnyOn = current.enabled || current.emailEnabled;
      return {
        setupRequired: !currentAnyOn,
        totpEnabled: current.enabled,
        totpPending: !current.enabled && current.secret !== null,
        emailEnabled: current.emailEnabled,
        twoFactorEmail: current.twoFactorEmail,
        recoveryCodesRemaining: currentAnyOn ? recoveryCodesRemaining : 0,
      };
    },

    enrollTotp(adminId, ip, session) {
      return twoFactor.enrollTotp(adminId, ip, session);
    },

    async confirmTotp(adminId, code, ip, session) {
      const prior = await sessionForMfaCompletion(adminId, session);
      const result = await twoFactor.confirmTotp(adminId, code, ip, session);
      return rotateAssuredSession(adminId, prior, 'totp', result);
    },

    disableTotp(adminId, code, ip, session) {
      return twoFactor.disableTotp(adminId, code, ip, session);
    },

    regenerateRecoveryCodes(adminId, ip, session) {
      return twoFactor.regenerateRecoveryCodes(adminId, ip, session);
    },

    async startEmailEnrollment(adminId, address, proof, session, ip) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state || state.securityGeneration !== session.securityGeneration) {
        throw unauthorized();
      }

      // Changing/setting the 2FA email once enrolled clears a fresh 2FA proof
      // (decision 3); the first-time set during forced enrollment does not.
      if (state.enabled || state.emailEnabled) {
        const ok = await proofOk(adminId, proof);
        if (!ok) {
          throw unauthorized(
            'A current two-factor code is required to change the 2FA email.',
            'TWO_FACTOR_INVALID_CODE',
          );
        }
      }

      // Lockout guard (mirrors #298): with no SMTP the confirmation code can't be
      // sent. An admin always has the TOTP method as an alternative, so this only
      // blocks the email method — never all of 2FA.
      if (!email.enabled) {
        throw badRequest(
          'Email delivery is not configured, so email codes can’t be sent. ' +
            'Set up SMTP, or use an authenticator app instead.',
          'TWO_FACTOR_EMAIL_UNAVAILABLE',
        );
      }

      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      // Factor proof may have taken time. Re-read immediately before persisting
      // or sending so a request admitted at G cannot create setup authority
      // after a transition committed G+1.
      const current = await twoFactorRepo.getState(adminId);
      if (!current || current.securityGeneration !== session.securityGeneration) {
        throw unauthorized();
      }
      const setup: EmailSetupState = {
        email: address,
        codeHash: hashToken(code),
        securityGeneration: session.securityGeneration,
      };
      await redis.set(
        emailSetupKey(adminId),
        JSON.stringify(setup),
        'EX',
        EMAIL_SETUP_CODE_TTL_MINUTES * 60,
      );
      await audit.record({
        actorId: adminId,
        action: AuditAction.TwoFactorEmailCodeSent,
        targetType: 'user',
        targetId: adminId,
        ip,
        meta: { purpose: 'admin_setup' },
      });
      // Best-effort send to the CHOSEN 2FA email — never the account email.
      await email.sendTwoFactorCode({
        to: address,
        userId: adminId,
        code,
        expiresInMinutes: EMAIL_SETUP_CODE_TTL_MINUTES,
        audit: { actorId: adminId, targetType: 'user', targetId: adminId, ip },
      });
    },

    async confirmEmail(adminId, code, ip, session) {
      const prior = await sessionForMfaCompletion(adminId, session);
      const state = await twoFactorRepo.getState(adminId);
      if (!state) throw unauthorized();

      const raw = await redis.get(emailSetupKey(adminId));
      if (!raw) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      const setup = await parseEmailSetup(adminId, raw);
      const securityGeneration = session?.securityGeneration ?? state.securityGeneration;
      if (state.securityGeneration !== securityGeneration) {
        // Preserve a newer setup if this is an older in-flight request.
        if (setup.securityGeneration !== state.securityGeneration) {
          await redis.del(emailSetupKey(adminId));
        }
        throw unauthorized();
      }
      if (setup.securityGeneration !== securityGeneration) {
        return invalidEmailSetup(adminId);
      }
      if (hashToken(code.trim()) !== setup.codeHash) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      await redis.del(emailSetupKey(adminId));

      // First method on ⇒ issue the shared recovery codes; a change/second method
      // leaves the existing set intact.
      const isFirstMethod = !state.enabled && !state.emailEnabled;
      const recovery = isFirstMethod ? recoveryCodeBatch() : null;
      const committedGeneration = await twoFactorRepo.confirmEmail(
        adminId,
        setup.email,
        recovery?.hashes ?? null,
        setup.securityGeneration,
      );
      if (committedGeneration === null) throw unauthorized();
      const recoveryCodes = recovery?.codes ?? null;
      await audit.record({
        actorId: adminId,
        action: AuditAction.TwoFactorEmailEnabled,
        targetType: 'user',
        targetId: adminId,
        ip,
      });
      await invalidateSessions(adminId);
      return rotateAssuredSession(adminId, prior, 'email', {
        response: { recoveryCodes },
        securityGeneration: committedGeneration,
      });
    },

    async disableEmail(adminId, ip, session) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state?.emailEnabled) {
        throw badRequest(
          'Email two-factor authentication is not enabled.',
          'TWO_FACTOR_NOT_ENABLED',
        );
      }
      const securityGeneration = await twoFactorRepo.disableEmail(
        adminId,
        true,
        !state.enabled,
        session?.securityGeneration ?? state.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();
      await redis.del(emailSetupKey(adminId));
      await audit.record({
        actorId: adminId,
        action: AuditAction.TwoFactorEmailDisabled,
        targetType: 'user',
        targetId: adminId,
        ip,
      });
      await invalidateSessions(adminId);
      return { response: undefined, securityGeneration };
    },
  };
}
