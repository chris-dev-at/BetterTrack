import { createHash, randomInt } from 'node:crypto';

import type { Redis } from 'ioredis';

import type {
  TwoFactorEnrollResponse,
  TwoFactorMethodEnabledResponse,
  TwoFactorRecoveryCodesResponse,
  TwoFactorStatusResponse,
  TwoFactorStepUpCredential,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type {
  TwoFactorRepository,
  TwoFactorState,
} from '../../data/repositories/twoFactorRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { badRequest, conflict, notFound, tooManyRequests, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { decryptSecret, encryptSecret } from '../crypto/secretBox';
import { hashToken } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import type { SecurityMutationContext, SessionService } from '../sessions/sessionService';
import { recordFactorIssuance } from './factorProvenance';
import { TWO_FACTOR_DISABLE_ACCOUNT_NAMESPACE } from './loginThrottle';
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  TOTP_SKEW_STEPS,
  TOTP_STEP_SECONDS,
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
  /** Verifies the password member of a factor-management step-up (R-05). */
  passwordHasher: PasswordHasher;
}

/**
 * How a USER-side factor mutation is authorized (R-05). Minting or removing a
 * second factor needs a credential the caller held BEFORE the request — the
 * password, or an existing TOTP / recovery code — verified here on the
 * per-account 2FA-management throttle. `credentialKey` (see
 * `factorProvenance.ts`) names the presenting credential, so a mint is recorded
 * against it before it commits.
 */
export interface FactorStepUpAuthorization {
  kind: 'step-up';
  stepUp: TwoFactorStepUpCredential;
  credentialKey: string;
}

/**
 * The admin console's own 2FA surface (§6.12): the admin session is 2FA-checked
 * on every request and the owner ruled out step-up prompts there. Only
 * `adminTwoFactorService` passes this; no user route may.
 */
export interface AdminSessionAuthorization {
  kind: 'admin-session';
}

export type FactorMutationAuthorization = FactorStepUpAuthorization | AdminSessionAuthorization;

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

/** Factor columns already read under a caller-owned users-row lock. */
export type LockedTwoFactorState = Pick<TwoFactorState, 'secret' | 'enabled' | 'emailEnabled'>;

/** Internal result wrapper; the HTTP layer emits only `response`. */
export interface TwoFactorMutationResult<T> {
  response: T;
  /** Durable generation committed by the factor transition. */
  securityGeneration: number;
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
    authorization: FactorMutationAuthorization,
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
    authorization: FactorMutationAuthorization,
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
    authorization: FactorStepUpAuthorization,
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
    authorization: FactorStepUpAuthorization,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<TwoFactorMethodEnabledResponse>>;
  /**
   * Turn the email method off (#298). Authorized by the step-up (R-05): the
   * password or an existing TOTP / recovery code — a bare session or bearer can
   * no longer strip it. Recovery codes are dropped only if no method remains.
   */
  disableEmail(
    userId: string,
    authorization: FactorStepUpAuthorization,
    ip?: string | null,
    security?: SecurityMutationContext,
  ): Promise<TwoFactorMutationResult<void>>;
  /** Regenerate the recovery codes (§6.1): only while some method is on; old set voided. */
  regenerateRecoveryCodes(
    userId: string,
    authorization: FactorMutationAuthorization,
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
  verifyTotpCode(
    userId: string,
    code: string,
    lockedState?: LockedTwoFactorState,
  ): Promise<boolean>;
  /**
   * Login-challenge factor check (§6.1): consume one unused recovery code
   * single-use, returning whether a match was found. Works whenever any method is
   * on, so recovery codes stay usable across the method mix.
   */
  consumeRecoveryCode(
    userId: string,
    code: string,
    lockedState?: LockedTwoFactorState,
    lockedRepository?: Pick<TwoFactorRepository, 'consumeRecoveryCode'>,
  ): Promise<boolean>;
}

// The email-method setup code (#298): a short-lived numeric code proving the user
// controls the account mailbox before the method activates. Distinct from the
// login-time email code, which the auth service scopes to a pending challenge.
const EMAIL_SETUP_CODE_TTL_MINUTES = 10;
const emailSetupKey = (userId: string) => `2fa_email_setup:${userId}`;

// Keep an accepted step for longer than the complete ±1 acceptance window. The
// secret fingerprint makes a re-enrollment start clean without storing secret
// material in a Redis key or needing a best-effort cleanup during rotation.
const TOTP_REPLAY_TTL_SECONDS = TOTP_STEP_SECONDS * (TOTP_SKEW_STEPS * 2 + 2);
const totpReplayKey = (userId: string, secret: string) =>
  `2fa_totp_step:${userId}:${createHash('sha256').update(secret).digest('base64url')}`;

// Compare-and-set the verifier counter atomically across API replicas. A plain
// GET followed by SET would let two independent challenges accept the same step.
const CLAIM_TOTP_STEP_SCRIPT = `
local candidate = tonumber(ARGV[1])
local last = tonumber(redis.call('GET', KEYS[1]) or '')
if last and candidate <= last then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

interface EmailSetupState {
  codeHash: string;
  securityGeneration: number;
}

export function createTwoFactorService(deps: TwoFactorServiceDeps): TwoFactorService {
  const { config, userRepo, twoFactorRepo, audit, redis, email, sessions, passwordHasher } = deps;
  // One per-account budget for every authenticated factor-management proof:
  // the TOTP-disable code and the R-05 step-up share it, so splitting the 2FA
  // surface across routes buys an attacker no extra guesses.
  const disableTotpThrottle = createProgressiveLimiter(
    redis,
    TWO_FACTOR_DISABLE_ACCOUNT_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  const alreadyEnabled = () =>
    badRequest(
      'Authenticator-app two-factor authentication is already enabled.',
      'TWO_FACTOR_ALREADY_ENABLED',
    );
  const notEnabled = () =>
    badRequest('Two-factor authentication is not enabled.', 'TWO_FACTOR_NOT_ENABLED');

  /** True when at least one 2FA method is currently on. */
  const anyMethodOn = (state: Pick<TwoFactorState, 'enabled' | 'emailEnabled'>) =>
    state.enabled || state.emailEnabled;

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

  /** Verify and atomically consume one TOTP step for a real authentication challenge. */
  async function consumeTotpStep(userId: string, secret: string, code: string): Promise<boolean> {
    const key = totpReplayKey(userId, secret);
    const storedStep = await redis.get(key);
    const parsedStep = storedStep === null ? Number.NaN : Number(storedStep);
    const lastAcceptedStep = Number.isSafeInteger(parsedStep) ? parsedStep : null;
    const verification = verifyTotp(secret, code, Date.now(), lastAcceptedStep);
    if (!verification) return false;

    const claimed = await redis.eval(
      CLAIM_TOTP_STEP_SCRIPT,
      1,
      key,
      verification.step,
      TOTP_REPLAY_TTL_SECONDS,
    );
    return Number(claimed) === 1;
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
      return consumeTotpStep(userId, secret, trimmed);
    }
    const hash = hashToken(normalizeRecoveryCode(trimmed));
    return twoFactorRepo.consumeRecoveryCode(userId, hash, new Date());
  }

  /**
   * R-05 step-up for a factor mutation, run AFTER the mutation's own cheap
   * preconditions (so a request that was always going to fail never spends a
   * recovery code) and BEFORE anything is written. Peek-before-verify on the
   * shared 2FA-management throttle: a cooling account is refused even with a
   * correct credential. The password wins when several members are sent; an
   * existing factor counts only while a method is on.
   */
  async function verifyStepUp(
    userId: string,
    state: TwoFactorState,
    authorization: FactorMutationAuthorization,
    ip: string | null | undefined,
    purpose: string,
  ): Promise<void> {
    // §6.12: the admin console's 2FA surface carries no step-up by owner ruling.
    if (authorization.kind === 'admin-session') return;
    const { stepUp } = authorization;

    const cooling = await disableTotpThrottle.peek(userId);
    if (cooling > 0) {
      throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
    }

    let kind: 'password' | 'recovery_code' | 'totp';
    let ok: boolean;
    if (stepUp.password !== undefined) {
      kind = 'password';
      const user = await userRepo.findById(userId);
      if (!user || user.status !== 'active') throw unauthorized();
      ok = await passwordHasher.verify(user.passwordHash, stepUp.password);
    } else if (!anyMethodOn(state)) {
      // A code for an account with no factor: never treat it as a match.
      throw unauthorized('Re-authenticate with your password.', 'TWO_FACTOR_NOT_ENABLED');
    } else if (stepUp.recoveryCode !== undefined) {
      kind = 'recovery_code';
      ok = await twoFactorRepo.consumeRecoveryCode(
        userId,
        hashToken(normalizeRecoveryCode(stepUp.recoveryCode)),
        new Date(),
      );
    } else if (stepUp.code !== undefined) {
      kind = 'totp';
      ok = false;
      const trimmed = stepUp.code.trim();
      if (state.enabled && state.secret && /^\d{6}$/.test(trimmed)) {
        try {
          ok = await consumeTotpStep(
            userId,
            decryptSecret(state.secret, config.recordEncryption),
            trimmed,
          );
        } catch {
          ok = false;
        }
      }
    } else {
      // The contract requires one member; a direct call without one fails closed.
      throw unauthorized('Re-authentication is required.', 'INVALID_CREDENTIALS');
    }

    if (!ok) {
      const decision = await disableTotpThrottle.consume(userId);
      await audit.record({
        actorId: userId,
        action: AuditAction.AuthReauthFail,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { purpose, kind, locked: !decision.allowed },
      });
      if (!decision.allowed) {
        throw tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.');
      }
      if (kind === 'password') {
        throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
      }
      throw unauthorized('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
    }
    await disableTotpThrottle.reset(userId);
  }

  /**
   * Record the presenting credential as the issuer of new factor material
   * BEFORE the commit (see `factorProvenance.ts`): if Redis refuses, the mint
   * fails closed instead of producing a factor its issuer could replay.
   */
  async function recordIssuance(
    userId: string,
    authorization: FactorMutationAuthorization,
  ): Promise<void> {
    if (authorization.kind !== 'step-up') return;
    await recordFactorIssuance(redis, userId, authorization.credentialKey);
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

    async enrollTotp(userId, authorization, ip, security) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      const state = await twoFactorRepo.getState(userId);
      if (!state) throw unauthorized();
      if (state.enabled) throw alreadyEnabled();
      await verifyStepUp(userId, state, authorization, ip, '2fa.totp.enroll');

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

    async confirmTotp(userId, code, authorization, ip, security) {
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
      // Knowing the new secret proves only that the caller saw the enroll
      // response; the confirm is the mint and needs the prior credential too.
      await verifyStepUp(userId, state, authorization, ip, '2fa.totp.confirm');

      // First method on ⇒ issue the shared recovery codes; otherwise the email
      // method already provided them and they stay valid.
      const isFirstMethod = !state.emailEnabled;
      const recovery = isFirstMethod ? recoveryCodeBatch() : null;
      await recordIssuance(userId, authorization);
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
      return { response: { recoveryCodes }, securityGeneration };
    },

    async disableTotp(userId, code, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.enabled || !state.secret) throw notEnabled();

      const cooling = await disableTotpThrottle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many incorrect codes. Please wait and try again.');
      }

      const ok = await verifyFactor(userId, state, code);
      if (!ok) {
        const decision = await disableTotpThrottle.consume(userId);
        if (!decision.allowed) {
          throw tooManyRequests(
            decision.retryAfterSec,
            'Too many incorrect codes. Please wait and try again.',
          );
        }
        throw unauthorized('That two-factor code is incorrect.', 'TWO_FACTOR_INVALID_CODE');
      }

      const securityGeneration = await twoFactorRepo.disableTotp(
        userId,
        !state.emailEnabled,
        security?.securityGeneration ?? state.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();
      await disableTotpThrottle.reset(userId);
      await audit.record({
        actorId: userId,
        action: AuditAction.TwoFactorDisabled,
        targetType: 'user',
        targetId: userId,
        ip,
      });
      await invalidateSessions(userId);
      return { response: undefined, securityGeneration };
    },

    async startEmailEnrollment(userId, authorization, ip, security) {
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
      await verifyStepUp(userId, state, authorization, ip, '2fa.email.enroll');

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

    async confirmEmail(userId, code, authorization, ip, security) {
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
      // The mailbox proof stands; a failed step-up keeps the setup code so the
      // owner can retry the credential without a new mail.
      await verifyStepUp(userId, state, authorization, ip, '2fa.email.confirm');
      await redis.del(emailSetupKey(userId));

      // First method on ⇒ issue the shared recovery codes; otherwise TOTP already
      // provided them.
      const isFirstMethod = !state.enabled;
      const recovery = isFirstMethod ? recoveryCodeBatch() : null;
      // An e-mail code is no step-up factor, but first-method recovery codes are.
      if (recovery) await recordIssuance(userId, authorization);
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
      return { response: { recoveryCodes }, securityGeneration: committedGeneration };
    },

    async disableEmail(userId, authorization, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state?.emailEnabled) {
        throw badRequest(
          'Email two-factor authentication is not enabled.',
          'TWO_FACTOR_NOT_ENABLED',
        );
      }
      await verifyStepUp(userId, state, authorization, ip, '2fa.email.disable');

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
      return { response: undefined, securityGeneration };
    },

    async regenerateRecoveryCodes(userId, authorization, ip, security) {
      const state = await twoFactorRepo.getState(userId);
      if (!state || !anyMethodOn(state)) throw notEnabled();
      await verifyStepUp(userId, state, authorization, ip, '2fa.recovery_codes');

      const recovery = recoveryCodeBatch();
      await recordIssuance(userId, authorization);
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
        securityGeneration,
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

    async verifyTotpCode(userId, code, lockedState) {
      const state = lockedState ?? (await twoFactorRepo.getState(userId));
      if (!state?.enabled || !state.secret) return false;
      let secret: string;
      try {
        secret = decryptSecret(state.secret, config.recordEncryption);
      } catch {
        return false;
      }
      return consumeTotpStep(userId, secret, code);
    },

    async consumeRecoveryCode(userId, code, lockedState, lockedRepository) {
      const state = lockedState ?? (await twoFactorRepo.getState(userId));
      if (!state || !anyMethodOn(state)) return false;
      const hash = hashToken(normalizeRecoveryCode(code));
      return (lockedRepository ?? twoFactorRepo).consumeRecoveryCode(userId, hash, new Date());
    },
  };
}
