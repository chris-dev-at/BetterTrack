import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type {
  Passkey,
  PasskeyDeleteRequest,
  PasskeyListResponse,
  PasskeyLoginVerifyRequest,
  PasskeyRegisterVerifyRequest,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { PasskeyRepository, PasskeyRow } from '../../data/repositories/passkeyRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { UserRow } from '../../data/schema';
import { badRequest, conflict, notFound, tooManyRequests, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import type { SessionService } from '../sessions/sessionService';
import { ACCOUNT_PASSKEY_NAMESPACE } from './loginThrottle';
import type { TwoFactorService } from './twoFactorService';

/**
 * The `@simplewebauthn/server` primitives the service leans on, behind an
 * injectable seam. Production wires the real functions ({@link defaultPasskeyWebAuthnEngine});
 * tests pass a fixture engine so registration/login can be exercised with no real
 * authenticator, browser, or network — the ceremony crypto is the library's own
 * concern and is not what we are verifying.
 */
export interface PasskeyWebAuthnEngine {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export const defaultPasskeyWebAuthnEngine: PasskeyWebAuthnEngine = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export interface PasskeyServiceDeps {
  config: AppConfig;
  redis: Redis;
  passkeyRepo: PasskeyRepository;
  userRepo: UserRepository;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  twoFactor: TwoFactorService;
  /** WebAuthn primitives; defaults to the real library, overridden in tests. */
  engine?: PasskeyWebAuthnEngine;
  /** Clock seam for deterministic last-used stamps in tests. */
  now?: () => Date;
}

/** The outcome of a verified passkey login — the caller sets the session cookie. */
export interface PasskeyLoginResult {
  user: UserRow;
  sessionId: string;
  persistent: boolean;
}

/** The re-auth credential shared by add + delete (a subset of their request bodies). */
type ReauthCredential = Pick<PasskeyRegisterVerifyRequest, 'password' | 'code' | 'recoveryCode'>;

export interface PasskeyService {
  /** The caller's registered passkeys for the Settings manager. */
  list(userId: string): Promise<PasskeyListResponse>;
  /**
   * Begin registration: mint creation options + a single-use server-held challenge.
   * Returns the library's `PublicKeyCredentialCreationOptionsJSON` wrapper — an opaque
   * blob the browser feeds straight to `startRegistration({ optionsJSON })`; the wire
   * contract ({@link PasskeyRegisterOptionsResponse}) validates it on the client.
   */
  startRegistration(userId: string): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }>;
  /**
   * Finish registration: re-authenticate, verify the authenticator's response against
   * the single-use challenge, and persist the credential. Returns the stored view.
   */
  finishRegistration(
    userId: string,
    body: PasskeyRegisterVerifyRequest,
    ip?: string | null,
  ): Promise<Passkey>;
  /** Rename one of the caller's passkeys (session alone — no re-auth). */
  rename(userId: string, id: string, name: string, ip?: string | null): Promise<Passkey>;
  /** Delete one of the caller's passkeys after a re-auth; deleting the last is allowed. */
  delete(userId: string, id: string, body: PasskeyDeleteRequest, ip?: string | null): Promise<void>;
  /**
   * Begin a usernameless login: mint request options + a single-use challenge handle.
   * `options` is the library's `PublicKeyCredentialRequestOptionsJSON`; the wire
   * contract ({@link PasskeyLoginOptionsResponse}) validates it on the client.
   */
  startLogin(): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>;
  /**
   * Finish a passkey login: verify the assertion against the single-use challenge,
   * reject a cloned-authenticator counter regression, and — treating a
   * user-verified assertion as strong auth — issue a session with no 2FA step (§16).
   * User-kind only: a non-`user` role is refused like an unavailable account, so
   * this path never mints an admin session outside the mandatory admin-2FA gate.
   */
  finishLogin(body: PasskeyLoginVerifyRequest, ip?: string | null): Promise<PasskeyLoginResult>;
}

// Challenges are short-lived and single-use (§13.4 V4-P4 acceptance): tight enough
// to bound a stolen challenge, long enough to complete the authenticator prompt.
const CHALLENGE_TTL_SECONDS = 5 * 60;
// The pending registration challenge is per-user (the ceremony is session-authed).
const regChallengeKey = (userId: string) => `passkey_reg_chal:${userId}`;
// The login challenge is keyed by an opaque handle — a public login has no session.
const loginChallengeKey = (challengeId: string) => `passkey_login_chal:${challengeId}`;

/** Store the COSE public-key bytes as base64url text (and back). */
const encodePublicKey = (key: Uint8Array): string => Buffer.from(key).toString('base64url');
const decodePublicKey = (key: string): Uint8Array => new Uint8Array(Buffer.from(key, 'base64url'));

/** Narrow the stored transport hints to the library's transport union. */
const asTransports = (transports: string[] | null): AuthenticatorTransportFuture[] | undefined =>
  transports && transports.length > 0 ? (transports as AuthenticatorTransportFuture[]) : undefined;

function toView(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** One generic failure for every passkey-login rejection — no account enumeration. */
const invalidPasskey = () =>
  unauthorized(
    'That passkey could not be used. Please try another sign-in method.',
    'PASSKEY_VERIFICATION_FAILED',
  );

export function createPasskeyService(deps: PasskeyServiceDeps): PasskeyService {
  const { config, redis, passkeyRepo, userRepo, sessions, audit, passwordHasher, twoFactor } = deps;
  const engine = deps.engine ?? defaultPasskeyWebAuthnEngine;
  const clock = deps.now ?? (() => new Date());
  const rp = config.webauthn;

  // Per-account brute-force throttle for the add/delete re-auth, so these
  // endpoints are never a lighter password/2FA oracle than login (mirrors the
  // account-export / deletion re-auth).
  const reauthThrottle = createProgressiveLimiter(
    redis,
    ACCOUNT_PASSKEY_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  /** Count one failed re-auth, audit it, and raise the right error. */
  async function failReauth(
    userId: string,
    ip: string | null | undefined,
    kind: string,
  ): Promise<never> {
    const decision = await reauthThrottle.consume(userId);
    await audit.record({
      actorId: userId,
      action: AuditAction.PasskeyManageReauthFail,
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

  /**
   * Re-verify a credential before a sensitive passkey mutation (add / delete). A
   * fresh password, or — for a 2FA-enrolled account — a TOTP code or an unused
   * recovery code. Throws on failure; mirrors the account-deletion / export gate.
   */
  async function verifyReauth(
    userId: string,
    body: ReauthCredential,
    ip: string | null | undefined,
  ): Promise<void> {
    const user = await userRepo.findById(userId);
    if (!user) throw unauthorized();

    // Reject an already-cooling account before any credential verify, so a blocked
    // retry — even with a correct credential — cannot ride through the cooldown.
    const cooling = await reauthThrottle.peek(userId);
    if (cooling > 0) {
      throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
    }

    if (body.password !== undefined) {
      const ok = await passwordHasher.verify(user.passwordHash, body.password);
      if (!ok) await failReauth(userId, ip, 'password');
    } else if (!(await twoFactor.isEnabled(userId))) {
      throw unauthorized('Re-authenticate with your password.', 'TWO_FACTOR_NOT_ENABLED');
    } else if (body.recoveryCode !== undefined) {
      const ok = await twoFactor.consumeRecoveryCode(userId, body.recoveryCode);
      if (!ok) await failReauth(userId, ip, 'recovery_code');
    } else {
      const ok = await twoFactor.verifyTotpCode(userId, body.code!);
      if (!ok) await failReauth(userId, ip, 'totp');
    }
    await reauthThrottle.reset(userId);
  }

  return {
    async list(userId) {
      const rows = await passkeyRepo.listForUser(userId);
      return { passkeys: rows.map(toView) };
    },

    async startRegistration(userId) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      const existing = await passkeyRepo.listForUser(userId);
      const options = await engine.generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpId,
        userName: user.username,
        // The user handle ties the discoverable credential to this account.
        userID: new TextEncoder().encode(user.id),
        userDisplayName: user.username,
        attestationType: 'none',
        // Block re-registering an authenticator this account already holds.
        excludeCredentials: existing.map((p) => ({
          id: p.credentialId,
          transports: asTransports(p.transports),
        })),
        // A passkey login skips 2FA, so every passkey must carry user verification.
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      // Single-use challenge: held server-side, consumed on the matching verify.
      await redis.set(regChallengeKey(userId), options.challenge, 'EX', CHALLENGE_TTL_SECONDS);
      return { options };
    },

    async finishRegistration(userId, body, ip) {
      // Adding a passkey is re-auth-gated, like disabling 2FA.
      await verifyReauth(userId, body, ip);

      const expectedChallenge = await redis.get(regChallengeKey(userId));
      if (!expectedChallenge) {
        throw badRequest(
          'Your passkey registration expired. Please start again.',
          'PASSKEY_CHALLENGE_INVALID',
        );
      }
      // Consume on presentation: a replayed/expired challenge can never verify.
      await redis.del(regChallengeKey(userId));

      let verification;
      try {
        verification = await engine.verifyRegistrationResponse({
          response: body.response as unknown as RegistrationResponseJSON,
          expectedChallenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          requireUserVerification: true,
        });
      } catch {
        throw badRequest(
          'That passkey could not be verified. Please try again.',
          'PASSKEY_VERIFICATION_FAILED',
        );
      }
      if (!verification.verified || !verification.registrationInfo) {
        throw badRequest(
          'That passkey could not be verified. Please try again.',
          'PASSKEY_VERIFICATION_FAILED',
        );
      }

      const { credential } = verification.registrationInfo;
      // A credential id is globally unique; reject one already registered anywhere.
      const clash = await passkeyRepo.findByCredentialId(credential.id);
      if (clash) {
        throw conflict('That passkey is already registered.', 'PASSKEY_ALREADY_REGISTERED');
      }

      const row = await passkeyRepo.create({
        userId,
        name: body.name,
        credentialId: credential.id,
        publicKey: encodePublicKey(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
      });
      await audit.record({
        actorId: userId,
        action: AuditAction.PasskeyRegistered,
        targetType: 'passkey',
        targetId: row.id,
        ip,
      });
      return toView(row);
    },

    async rename(userId, id, name, ip) {
      const ok = await passkeyRepo.rename(userId, id, name);
      if (!ok) throw notFound('Passkey not found.', 'PASSKEY_NOT_FOUND');
      const row = await passkeyRepo.findByIdForUser(userId, id);
      await audit.record({
        actorId: userId,
        action: AuditAction.PasskeyRenamed,
        targetType: 'passkey',
        targetId: id,
        ip,
      });
      return toView(row!);
    },

    async delete(userId, id, body, ip) {
      // Deleting a passkey is re-auth-gated, like adding one.
      await verifyReauth(userId, body, ip);
      const ok = await passkeyRepo.deleteForUser(userId, id);
      if (!ok) throw notFound('Passkey not found.', 'PASSKEY_NOT_FOUND');
      await audit.record({
        actorId: userId,
        action: AuditAction.PasskeyDeleted,
        targetType: 'passkey',
        targetId: id,
        ip,
      });
    },

    async startLogin() {
      // Usernameless / discoverable-credential flow: no allowCredentials — the
      // authenticator offers its resident keys and the account is resolved from
      // the returned credential id at verify.
      const options = await engine.generateAuthenticationOptions({
        rpID: rp.rpId,
        userVerification: 'required',
      });
      const challengeId = randomBytes(32).toString('base64url');
      await redis.set(
        loginChallengeKey(challengeId),
        options.challenge,
        'EX',
        CHALLENGE_TTL_SECONDS,
      );
      return { challengeId, options };
    },

    async finishLogin(body, ip) {
      const expectedChallenge = await redis.get(loginChallengeKey(body.challengeId));
      if (!expectedChallenge) {
        throw unauthorized(
          'Your sign-in request expired. Please try again.',
          'PASSKEY_CHALLENGE_INVALID',
        );
      }
      // Consume on presentation: a replayed/expired challenge can never verify.
      await redis.del(loginChallengeKey(body.challengeId));

      const response = body.response as unknown as AuthenticationResponseJSON;
      const credentialId = typeof response.id === 'string' ? response.id : '';
      const passkey = credentialId ? await passkeyRepo.findByCredentialId(credentialId) : undefined;
      if (!passkey) {
        await audit.record({
          action: AuditAction.PasskeyLoginFail,
          ip,
          meta: { reason: 'unknown_credential' },
        });
        throw invalidPasskey();
      }

      const user = await userRepo.findById(passkey.userId);
      if (!user || user.status !== 'active') {
        await audit.record({
          action: AuditAction.PasskeyLoginFail,
          targetType: 'user',
          targetId: passkey.userId,
          ip,
          meta: { reason: 'account_unavailable' },
        });
        throw invalidPasskey();
      }

      // Passkeys are user-kind end to end (§16): management is requireUser-gated
      // and admin-app passkeys are out of scope. If an account was promoted to
      // admin after enrolling a passkey, its surviving credential must NOT mint a
      // session here — a passkey login raises no 2FA challenge, so that would hand
      // out an admin session with no factor presented and defeat the mandatory
      // admin-2FA-at-login gate (#400). Refuse it like an unavailable account.
      if (user.role !== 'user') {
        await audit.record({
          action: AuditAction.PasskeyLoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'role_not_user' },
        });
        throw invalidPasskey();
      }

      let verification;
      try {
        verification = await engine.verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          credential: {
            id: passkey.credentialId,
            publicKey: decodePublicKey(passkey.publicKey),
            counter: passkey.counter,
            transports: asTransports(passkey.transports),
          },
          requireUserVerification: true,
        });
      } catch {
        // The library throws on a bad signature OR a non-increasing counter; both
        // are a hard failure recorded for the security trail.
        await audit.record({
          action: AuditAction.PasskeyLoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'verification_error' },
        });
        throw invalidPasskey();
      }
      if (!verification.verified) {
        await audit.record({
          action: AuditAction.PasskeyLoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'not_verified' },
        });
        throw invalidPasskey();
      }

      const { newCounter } = verification.authenticationInfo;
      // Clone detection: a counter that fails to advance signals a duplicated
      // authenticator. The library guards this too; this is the authoritative,
      // audited check (and covers a stub engine that returns `verified`).
      if ((newCounter > 0 || passkey.counter > 0) && newCounter <= passkey.counter) {
        await audit.record({
          action: AuditAction.PasskeyLoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'counter_regression', stored: passkey.counter, presented: newCounter },
        });
        throw unauthorized(
          'This passkey could not be used. Please try another sign-in method.',
          'PASSKEY_COUNTER_REGRESSION',
        );
      }

      const now = clock();
      await passkeyRepo.markUsed(passkey.id, newCounter, now);

      // Session issuance — the SAME path as password login. A user-verified passkey
      // is strong auth on its own, so no 2FA challenge is raised (§16). Mints the
      // session, stamps last-login, and audits LoginSuccess with `meta.via`.
      const persistent = body.staySignedIn ?? true;
      const sessionId = await sessions.create(user.id, persistent);
      await userRepo.setLastLogin(user.id, now);
      await audit.record({
        actorId: user.id,
        action: AuditAction.LoginSuccess,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: { via: 'passkey' },
      });
      return { user: { ...user, lastLoginAt: now }, sessionId, persistent };
    },
  };
}
