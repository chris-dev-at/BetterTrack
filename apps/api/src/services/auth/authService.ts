import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { AcceptInviteRequest, ChangePasswordRequest } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { UserRow } from '../../data/schema';
import { accountDisabled, badRequest, conflict, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { checkPasswordPolicy } from '../password/passwordPolicy';
import type { SessionService } from '../sessions/sessionService';
import { clearLoginThrottle, failCountKey, failHourKey, lockKey } from './loginThrottle';

export interface AuthServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
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
}

// Single generic failure for every login rejection — no user enumeration (§6.1).
const invalidCredentials = () =>
  unauthorized('Invalid email/username or password.', 'INVALID_CREDENTIALS');

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { config, redis, userRepo, inviteRepo, sessions, audit, passwordHasher, email } = deps;
  const limits = config.rateLimits;

  // Computed once, lazily — verified against on unknown-user logins so response
  // timing doesn't reveal whether an account exists.
  let dummyHashPromise: Promise<string> | null = null;
  const getDummyHash = () => {
    dummyHashPromise ??= passwordHasher.hash(randomBytes(16).toString('hex'));
    return dummyHashPromise;
  };

  async function registerFailure(userId: string): Promise<void> {
    const consecutive = await redis.incr(failCountKey(userId));
    if (consecutive === 1) await redis.expire(failCountKey(userId), limits.lockoutSeconds);

    const hourly = await redis.incr(failHourKey(userId));
    if (hourly === 1) await redis.expire(failHourKey(userId), 3600);

    if (consecutive >= limits.lockoutThreshold) {
      await redis.set(lockKey(userId), '1', 'EX', limits.lockoutSeconds);
      await redis.del(failCountKey(userId));
    }
  }

  const clearFailures = (userId: string) => clearLoginThrottle(redis, userId);

  return {
    async login({ identifier, password, ip, currentSessionId }) {
      const user = await userRepo.findByIdentifier(identifier);

      if (!user) {
        await passwordHasher.verify(await getDummyHash(), password);
        await audit.record({ action: AuditAction.LoginFail, ip, meta: { reason: 'unknown_user' } });
        throw invalidCredentials();
      }

      if (await redis.get(lockKey(user.id))) {
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'locked' },
        });
        throw invalidCredentials();
      }

      const hourlyFailures = Number(await redis.get(failHourKey(user.id))) || 0;
      if (hourlyFailures >= limits.accountFailuresPerHour) {
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'throttled' },
        });
        throw invalidCredentials();
      }

      const passwordOk = await passwordHasher.verify(user.passwordHash, password);
      if (!passwordOk) {
        await registerFailure(user.id);
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'bad_password' },
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
  };
}
