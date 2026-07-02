import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { AcceptInviteRequest, ChangePasswordRequest } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { UserRow } from '../../data/schema';
import { accountDisabled, badRequest, conflict, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { checkPasswordPolicy } from '../password/passwordPolicy';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import type { SessionService } from '../sessions/sessionService';
import {
  clearLoginThrottle,
  LOGIN_ACCOUNT_NAMESPACE,
  pinFailCountKey,
  PIN_FALLBACK_THRESHOLD,
} from './loginThrottle';

export interface AuthServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
  portfolioRepo: PortfolioRepository;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  email: EmailService;
}

export interface LoginInput {
  identifier: string;
  password: string;
  ip?: string | null;
  currentSessionId?: string;
}

export interface SessionResult {
  user: UserRow;
  sessionId: string;
}

export interface VerifyPinInput {
  userId: string;
  sessionId: string;
  pin: string;
  ip?: string | null;
}

export interface AuthService {
  login(input: LoginInput): Promise<SessionResult>;
  logout(sessionId: string): Promise<void>;
  resolveSession(sessionId: string): Promise<UserRow | null>;
  changePassword(
    userId: string,
    input: ChangePasswordRequest,
    ip?: string | null,
  ): Promise<SessionResult>;
  validateInvite(token: string): Promise<{ valid: boolean; email: string | null }>;
  acceptInvite(input: AcceptInviteRequest, ip?: string | null): Promise<SessionResult>;
  /**
   * Verify the PIN for the current session, renewing its 30-day window on
   * success (§6.1). {@link PIN_FALLBACK_THRESHOLD} wrong PINs in a row destroy
   * the session and throw `PIN_FALLBACK_LOGIN`, forcing a full login.
   */
  verifyPin(input: VerifyPinInput): Promise<UserRow>;
  /** Enable the PIN or change it to a new value (§6.1). */
  setPin(userId: string, pin: string, ip?: string | null): Promise<UserRow>;
  /** Turn the PIN gate off (§6.1). */
  disablePin(userId: string, ip?: string | null): Promise<UserRow>;
}

// Single generic failure for every login rejection — no user enumeration (§6.1).
const invalidCredentials = () =>
  unauthorized('Invalid email/username or password.', 'INVALID_CREDENTIALS');

/**
 * Two-factor authentication hook (PROJECTPLAN.md §6.1, §6.3 — planned, post-v1).
 *
 * ── 2FA INSERTION POINT ──────────────────────────────────────────────────────
 * This is the single place a second verification step will plug into the login
 * flow. It runs after the password (and account-status) checks pass but BEFORE a
 * session is minted, so an unverified second factor can block session creation
 * without ever exposing a usable cookie. Today it is intentionally a no-op: the
 * TOTP/WebAuthn implementation is out of scope for P2 (§14). When 2FA lands, the
 * real check goes here (e.g. throw a `second-factor-required` challenge, or
 * verify a supplied code) — nothing else in `login` needs to move.
 */
async function verifySecondFactor(_user: UserRow): Promise<void> {
  // No-op until 2FA is implemented (§6.1/§6.3, §14).
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const {
    config,
    redis,
    userRepo,
    inviteRepo,
    portfolioRepo,
    sessions,
    audit,
    passwordHasher,
    email,
  } = deps;
  // Per-account failed-login throttle (§6.1, §10): ~10 failures → a short
  // cooldown, escalating on repeat batches and decaying after a quiet period.
  // Tracked independently of the per-IP counter the HTTP middleware keeps.
  const accountThrottle = createProgressiveLimiter(
    redis,
    LOGIN_ACCOUNT_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  // Computed once, lazily — verified against on unknown-user logins so response
  // timing doesn't reveal whether an account exists.
  let dummyHashPromise: Promise<string> | null = null;
  const getDummyHash = () => {
    dummyHashPromise ??= passwordHasher.hash(randomBytes(16).toString('hex'));
    return dummyHashPromise;
  };

  const clearFailures = (userId: string) => clearLoginThrottle(redis, userId);

  return {
    async login({ identifier, password, ip, currentSessionId }) {
      const user = await userRepo.findByIdentifier(identifier);

      if (!user) {
        await passwordHasher.verify(await getDummyHash(), password);
        await audit.record({ action: AuditAction.LoginFail, ip, meta: { reason: 'unknown_user' } });
        throw invalidCredentials();
      }

      // Account already cooling down from prior failures: reject before touching
      // the password hash. Stays a generic INVALID_CREDENTIALS (no retryAfter) so
      // the cooldown never leaks that the account exists (§6.1); the per-IP
      // limiter is what surfaces a retryAfter to the client.
      if ((await accountThrottle.peek(user.id)) > 0) {
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'locked' },
        });
        throw invalidCredentials();
      }

      const passwordOk = await passwordHasher.verify(user.passwordHash, password);
      if (!passwordOk) {
        // Count the failure; the attempt that overflows the allowance arms (or
        // escalates) the cooldown for subsequent attempts.
        const decision = await accountThrottle.consume(user.id);
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: decision.allowed ? 'bad_password' : 'locked' },
        });
        throw invalidCredentials();
      }

      if (user.status !== 'active') {
        // The password is already verified correct at this point, so revealing
        // the suspended status here leaks nothing to an attacker guessing
        // passwords (wrong-password/unknown-user still return the generic
        // INVALID_CREDENTIALS above). Owner-authorized 2026-06-16, §16.
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'disabled' },
        });
        throw accountDisabled();
      }

      // 2FA hook (§6.1/§6.3): the insertion point for a second verification
      // step, gating session creation. No-op until 2FA ships (see above).
      await verifySecondFactor(user);

      await clearFailures(user.id);
      // Session rotation: drop any pre-login session before minting a new id.
      if (currentSessionId) await sessions.destroy(currentSessionId);
      const sessionId = await sessions.create(user.id);

      const now = new Date();
      await userRepo.setLastLogin(user.id, now);
      await audit.record({
        actorId: user.id,
        action: AuditAction.LoginSuccess,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      if (user.role === 'admin') {
        await audit.record({
          actorId: user.id,
          action: AuditAction.AdminLogin,
          targetType: 'user',
          targetId: user.id,
          ip,
        });
      }

      return { user: { ...user, lastLoginAt: now }, sessionId };
    },

    async logout(sessionId) {
      await sessions.destroy(sessionId);
    },

    async resolveSession(sessionId) {
      const data = await sessions.get(sessionId);
      if (!data) return null;
      const user = await userRepo.findById(data.userId);
      if (!user || user.status !== 'active') {
        // Disabled/deleted out from under a live session → terminate it.
        await sessions.destroy(sessionId);
        return null;
      }
      return user;
    },

    async changePassword(userId, input, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();

      const currentOk = await passwordHasher.verify(user.passwordHash, input.currentPassword);
      if (!currentOk) throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');

      const policy = checkPasswordPolicy(input.newPassword);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      const passwordHash = await passwordHasher.hash(input.newPassword);
      await userRepo.updatePassword(user.id, passwordHash, false);

      // Kill every session, then re-establish one for the current device.
      await sessions.destroyAllForUser(user.id);
      const sessionId = await sessions.create(user.id);

      await audit.record({
        actorId: user.id,
        action: AuditAction.PasswordChanged,
        targetType: 'user',
        targetId: user.id,
        ip,
      });

      const updated = await userRepo.findById(user.id);
      return { user: updated ?? { ...user, passwordHash, mustChangePassword: false }, sessionId };
    },

    async validateInvite(token) {
      const invite = await inviteRepo.findByTokenHash(hashToken(token));
      if (!invite) return { valid: false, email: null };
      const valid =
        !invite.usedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
      return { valid, email: valid ? invite.email : null };
    },

    async acceptInvite(input, ip) {
      const invite = await inviteRepo.findByTokenHash(hashToken(input.token));
      if (
        !invite ||
        invite.usedAt ||
        invite.revokedAt ||
        new Date(invite.expiresAt).getTime() <= Date.now()
      ) {
        throw badRequest('This invite link is invalid or has expired.', 'INVALID_INVITE');
      }

      const policy = checkPasswordPolicy(input.password);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      if (await userRepo.findByUsername(input.username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }
      if (await userRepo.findByEmail(invite.email)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }

      const passwordHash = await passwordHasher.hash(input.password);
      const user = await userRepo.create({
        email: invite.email,
        username: input.username,
        passwordHash,
        role: 'user',
        status: 'active',
        mustChangePassword: false,
      });

      // Invited accounts are always the user kind (§5.5): provision their one
      // default portfolio up front so the app opens onto a real workspace.
      await portfolioRepo.createDefault(user.id);

      await inviteRepo.markUsed(invite.id, new Date());
      await audit.record({
        actorId: user.id,
        action: AuditAction.UserCreated,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: { via: 'invite' },
      });
      await audit.record({
        actorId: user.id,
        action: AuditAction.InviteUsed,
        targetType: 'invite',
        targetId: invite.id,
        ip,
      });

      // Best-effort welcome mail, after the account is fully provisioned.
      await email.sendWelcome({
        to: user.email,
        username: user.username,
        audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
      });

      const sessionId = await sessions.create(user.id);
      return { user, sessionId };
    },

    async verifyPin({ userId, sessionId, pin, ip }) {
      const user = await userRepo.findById(userId);
      // The session guard already resolved this user, but re-check the account.
      if (!user || user.status !== 'active') {
        await sessions.destroy(sessionId);
        throw unauthorized();
      }
      if (!user.pinEnabled || !user.pinHash) {
        // No PIN to verify — nothing to gate on; the client shouldn't be here.
        throw badRequest('No PIN is set for this account.', 'PIN_NOT_ENABLED');
      }

      const ok = await passwordHasher.verify(user.pinHash, pin);
      if (!ok) {
        const consecutive = await redis.incr(pinFailCountKey(user.id));
        // Match the session TTL so the tally never outlives the session itself.
        if (consecutive === 1) {
          await redis.expire(pinFailCountKey(user.id), Math.floor(config.cookie.maxAgeMs / 1000));
        }
        await audit.record({
          action: AuditAction.PinVerifyFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { consecutive },
        });
        if (consecutive >= PIN_FALLBACK_THRESHOLD) {
          // Too many wrong PINs: drop the session so the only way back in is a
          // full password login (§6.1). Clear the tally with the session.
          await redis.del(pinFailCountKey(user.id));
          await sessions.destroy(sessionId);
          throw unauthorized(
            'Too many incorrect PIN attempts. Please sign in with your password.',
            'PIN_FALLBACK_LOGIN',
          );
        }
        throw unauthorized('Incorrect PIN.', 'INVALID_PIN');
      }

      // Correct PIN: clear the tally and renew the full 30-day window (§6.1).
      await redis.del(pinFailCountKey(user.id));
      await sessions.renew(sessionId);
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinVerified,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      return user;
    },

    async setPin(userId, pin, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      // PIN is hashed with the same argon2id hasher as passwords (§10), so it
      // is never recoverable and verification is uniform across both secrets.
      const pinHash = await passwordHasher.hash(pin);
      await userRepo.setPin(user.id, pinHash);
      await redis.del(pinFailCountKey(user.id));
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinEnabled,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      const updated = await userRepo.findById(user.id);
      return updated ?? { ...user, pinHash, pinEnabled: true };
    },

    async disablePin(userId, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      await userRepo.clearPin(user.id);
      await redis.del(pinFailCountKey(user.id));
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinDisabled,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      const updated = await userRepo.findById(user.id);
      return updated ?? { ...user, pinHash: null, pinEnabled: false };
    },
  };
}
