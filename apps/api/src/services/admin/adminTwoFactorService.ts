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
import type { TwoFactorService } from '../auth/twoFactorService';

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
  status(adminId: string): Promise<AdminTwoFactorStatusResponse>;
  /** Begin TOTP enrollment — provisional encrypted secret + provisioning URI. */
  enrollTotp(adminId: string, ip?: string | null): Promise<TwoFactorEnrollResponse>;
  /** Confirm TOTP with a current code; recovery codes returned iff first method. */
  confirmTotp(
    adminId: string,
    code: string,
    ip?: string | null,
  ): Promise<TwoFactorMethodEnabledResponse>;
  /** Turn TOTP off with a valid factor (re-enroll = disable then enroll). */
  disableTotp(adminId: string, code: string, ip?: string | null): Promise<void>;
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
    ip?: string | null,
  ): Promise<void>;
  /** Confirm the emailed code — activates the email method on the new address. */
  confirmEmail(
    adminId: string,
    code: string,
    ip?: string | null,
  ): Promise<TwoFactorMethodEnabledResponse>;
  /** Turn the email method off (session-authorized); clears the 2FA email. */
  disableEmail(adminId: string, ip?: string | null): Promise<void>;
  /** Regenerate the recovery codes (only while some method is on; old set voided). */
  regenerateRecoveryCodes(
    adminId: string,
    ip?: string | null,
  ): Promise<TwoFactorRecoveryCodesResponse>;
}

export interface AdminTwoFactorServiceDeps {
  twoFactorRepo: TwoFactorRepository;
  /** The shared user 2FA core — TOTP + recovery lifecycle + factor checks. */
  twoFactor: TwoFactorService;
  audit: AuditService;
  redis: Redis;
  email: EmailService;
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
}

export function createAdminTwoFactorService(
  deps: AdminTwoFactorServiceDeps,
): AdminTwoFactorService {
  const { twoFactorRepo, twoFactor, audit, redis, email } = deps;

  /** Issue a fresh recovery-code batch, persisting only the hashes (§6.1). */
  async function issueRecoveryCodes(adminId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await twoFactorRepo.replaceRecoveryCodes(
      adminId,
      codes.map((code) => hashToken(normalizeRecoveryCode(code))),
    );
    return codes;
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
    async status(adminId) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state) throw unauthorized();
      const anyOn = state.enabled || state.emailEnabled;
      return {
        setupRequired: !anyOn,
        totpEnabled: state.enabled,
        totpPending: !state.enabled && state.secret !== null,
        emailEnabled: state.emailEnabled,
        twoFactorEmail: state.twoFactorEmail,
        recoveryCodesRemaining: anyOn ? await twoFactorRepo.countUnusedRecoveryCodes(adminId) : 0,
      };
    },

    enrollTotp(adminId, ip) {
      return twoFactor.enrollTotp(adminId, ip);
    },

    confirmTotp(adminId, code, ip) {
      return twoFactor.confirmTotp(adminId, code, ip);
    },

    disableTotp(adminId, code, ip) {
      return twoFactor.disableTotp(adminId, code, ip);
    },

    regenerateRecoveryCodes(adminId, ip) {
      return twoFactor.regenerateRecoveryCodes(adminId, ip);
    },

    async startEmailEnrollment(adminId, address, proof, ip) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state) throw unauthorized();

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
      const setup: EmailSetupState = { email: address, codeHash: hashToken(code) };
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

    async confirmEmail(adminId, code, ip) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state) throw unauthorized();

      const raw = await redis.get(emailSetupKey(adminId));
      if (!raw) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      let setup: EmailSetupState;
      try {
        setup = JSON.parse(raw) as EmailSetupState;
      } catch {
        await redis.del(emailSetupKey(adminId));
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      if (hashToken(code.trim()) !== setup.codeHash) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }
      await redis.del(emailSetupKey(adminId));

      // First method on ⇒ issue the shared recovery codes; a change/second method
      // leaves the existing set intact.
      const isFirstMethod = !state.enabled && !state.emailEnabled;
      await twoFactorRepo.setTwoFactorEmail(adminId, setup.email);
      await twoFactorRepo.setEmailEnabled(adminId, true);
      const recoveryCodes = isFirstMethod ? await issueRecoveryCodes(adminId) : null;
      await audit.record({
        actorId: adminId,
        action: AuditAction.TwoFactorEmailEnabled,
        targetType: 'user',
        targetId: adminId,
        ip,
      });
      return { recoveryCodes };
    },

    async disableEmail(adminId, ip) {
      const state = await twoFactorRepo.getState(adminId);
      if (!state?.emailEnabled) {
        throw badRequest(
          'Email two-factor authentication is not enabled.',
          'TWO_FACTOR_NOT_ENABLED',
        );
      }
      await twoFactorRepo.setEmailEnabled(adminId, false);
      await twoFactorRepo.setTwoFactorEmail(adminId, null);
      await redis.del(emailSetupKey(adminId));
      // Recovery codes are shared: drop them only if the TOTP method is also off.
      if (!state.enabled) await twoFactorRepo.clearRecoveryCodes(adminId);
      await audit.record({
        actorId: adminId,
        action: AuditAction.TwoFactorEmailDisabled,
        targetType: 'user',
        targetId: adminId,
        ip,
      });
    },
  };
}
