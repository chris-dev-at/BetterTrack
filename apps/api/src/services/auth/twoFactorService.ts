import type {
  TwoFactorEnrollResponse,
  TwoFactorRecoveryCodesResponse,
  TwoFactorStatusResponse,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { TwoFactorRepository } from '../../data/repositories/twoFactorRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { badRequest, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { decryptSecret, encryptSecret } from '../crypto/secretBox';
import { hashToken } from '../crypto/tokens';
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
}

export interface TwoFactorService {
  /** The caller's current 2FA state (§6.1). */
  status(userId: string): Promise<TwoFactorStatusResponse>;
  /**
   * Begin enrollment (§6.1): mint a fresh secret, store it ENCRYPTED in a
   * provisional (not-yet-enabled) state, and return the `otpauth://` URI + secret
   * for the authenticator QR. Re-enrolling while already enabled is rejected.
   */
  enroll(userId: string, ip?: string | null): Promise<TwoFactorEnrollResponse>;
  /**
   * Confirm enrollment (§6.1): a valid current TOTP code flips 2FA on and issues
   * the one-time recovery codes (returned in plaintext once; only hashes stored).
   */
  confirm(
    userId: string,
    code: string,
    ip?: string | null,
  ): Promise<TwoFactorRecoveryCodesResponse>;
  /**
   * Turn 2FA off (§6.1): a valid factor (TOTP code or an unused recovery code)
   * authorizes it, then the secret and every recovery code are wiped together.
   */
  disable(userId: string, code: string, ip?: string | null): Promise<void>;
  /** Regenerate the recovery codes (§6.1): only when 2FA is enabled; old set is voided. */
  regenerateRecoveryCodes(
    userId: string,
    ip?: string | null,
  ): Promise<TwoFactorRecoveryCodesResponse>;
}

export function createTwoFactorService(deps: TwoFactorServiceDeps): TwoFactorService {
  const { config, userRepo, twoFactorRepo, audit } = deps;
  const encryptionKey = config.twoFactor.encryptionKey;

  const alreadyEnabled = () =>
    badRequest('Two-factor authentication is already enabled.', 'TWO_FACTOR_ALREADY_ENABLED');
  const notEnabled = () =>
    badRequest('Two-factor authentication is not enabled.', 'TWO_FACTOR_NOT_ENABLED');

  /** Issue a fresh recovery-code batch, persisting only the hashes. */
  async function issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const hashes = codes.map((code) => hashToken(normalizeRecoveryCode(code)));
    await twoFactorRepo.replaceRecoveryCodes(userId, hashes);
    return codes;
  }

  /**
   * True when `code` is a valid second factor for an enabled account: a TOTP
   * code verified against the decrypted secret, or an unused recovery code
   * (consumed on match). A malformed/undecryptable secret verifies as false.
   */
  async function verifyFactor(
    userId: string,
    encryptedSecret: string,
    code: string,
  ): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      let secret: string;
      try {
        secret = decryptSecret(encryptedSecret, encryptionKey);
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
        enabled: state.enabled,
        pending: !state.enabled && state.secret !== null,
        recoveryCodesRemaining: state.enabled
          ? await twoFactorRepo.countUnusedRecoveryCodes(userId)
          : 0,
      };
    },

    async enroll(userId, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      const state = await twoFactorRepo.getState(userId);
      if (state?.enabled) throw alreadyEnabled();

      const secret = generateTotpSecret();
      await twoFactorRepo.setProvisionalSecret(userId, encryptSecret(secret, encryptionKey));
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

    async confirm(userId, code, ip) {
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      if (state.enabled) throw alreadyEnabled();
      if (!state.secret) {
        throw badRequest(
          'Start two-factor enrollment before confirming.',
          'TWO_FACTOR_NOT_PENDING',
        );
      }

      let secret: string;
      try {
        secret = decryptSecret(state.secret, encryptionKey);
      } catch {
        throw badRequest(
          'Two-factor enrollment is invalid; start again.',
          'TWO_FACTOR_NOT_PENDING',
        );
      }
      if (!verifyTotp(secret, code)) {
        throw badRequest('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }

      await twoFactorRepo.enable(userId, new Date());
      const recoveryCodes = await issueRecoveryCodes(userId);
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorConfirmed,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      return { recoveryCodes };
    },

    async disable(userId, code, ip) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.enabled || !state.secret) throw notEnabled();

      const ok = await verifyFactor(userId, state.secret, code);
      if (!ok) {
        throw unauthorized('That two-factor code is incorrect.', 'TWO_FACTOR_INVALID_CODE');
      }

      await twoFactorRepo.disable(userId);
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorDisabled,
        targetType: 'user',
        targetId: userId,
        ip,
      });
    },

    async regenerateRecoveryCodes(userId, ip) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.enabled) throw notEnabled();

      const recoveryCodes = await issueRecoveryCodes(userId);
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorRecoveryRegenerated,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      return { recoveryCodes };
    },
  };
}
