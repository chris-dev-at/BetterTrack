import type { Redis } from 'ioredis';

import type {
  CreateInviteRequest,
  CreateUserRequest,
  UpdateAppSettingsRequest,
  UpdateUserRequest,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { EmailLogPage, EmailLogRepository } from '../../data/repositories/emailLogRepository';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { InviteRow, UserRow } from '../../data/schema';
import { badRequest, conflict, notFound } from '../../errors';
import type { AppSettings, AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { clearLoginThrottle } from '../auth/loginThrottle';
import { generateToken } from '../crypto/tokens';
import type { EmailSendResult, EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { generateTempPassword } from '../password/tempPassword';
import type { SessionService } from '../sessions/sessionService';

export interface AdminServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
  portfolioRepo: PortfolioRepository;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  email: EmailService;
  emailLog: EmailLogRepository;
  appSettings: AppSettingsService;
}

export interface AdminActor {
  id: string;
  ip?: string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createAdminService(deps: AdminServiceDeps) {
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
    emailLog,
    appSettings,
  } = deps;

  async function loadUser(id: string): Promise<UserRow> {
    const user = await userRepo.findById(id);
    if (!user) throw notFound('User not found.', 'USER_NOT_FOUND');
    return user;
  }

  async function ensureNotLastActiveAdmin(target: UserRow): Promise<void> {
    if (target.role === 'admin' && target.status === 'active') {
      const activeAdmins = await userRepo.countActiveAdmins();
      if (activeAdmins <= 1) {
        throw badRequest('Cannot remove the last active administrator.', 'LAST_ADMIN');
      }
    }
  }

  return {
    listUsers: (search?: string) => userRepo.list(search),

    async createUser(
      input: CreateUserRequest,
      actor: AdminActor,
    ): Promise<{ user: UserRow; tempPassword: string }> {
      if (await userRepo.findByEmail(input.email)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }
      if (await userRepo.findByUsername(input.username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await passwordHasher.hash(tempPassword);
      const user = await userRepo.create({
        email: input.email,
        username: input.username,
        passwordHash,
        role: input.role,
        status: 'active',
        mustChangePassword: true,
      });

      // Account kinds are disjoint (§5.5): a new *user* opens onto a default
      // portfolio; a management-only *admin* never gets one.
      if (user.role === 'user') {
        await portfolioRepo.createDefault(user.id);
      }

      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserCreated,
        targetType: 'user',
        targetId: user.id,
        ip: actor.ip,
        meta: { via: 'admin', role: input.role },
      });

      // Best-effort, post-commit: a mail failure must not undo the new account.
      await email.sendTempPassword({
        to: user.email,
        username: user.username,
        tempPassword,
        reason: 'created',
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });

      return { user, tempPassword };
    },

    async updateUser(id: string, input: UpdateUserRequest, actor: AdminActor): Promise<UserRow> {
      const target = await loadUser(id);

      if (input.status && input.status !== target.status) {
        if (input.status === 'disabled') {
          if (target.id === actor.id) {
            throw badRequest('You cannot disable your own account.', 'SELF_ACTION');
          }
          await ensureNotLastActiveAdmin(target);
          await userRepo.setStatus(target.id, 'disabled');
          await sessions.destroyAllForUser(target.id);
          await audit.record({
            actorId: actor.id,
            action: AuditAction.UserDisabled,
            targetType: 'user',
            targetId: target.id,
            ip: actor.ip,
          });
        } else {
          await userRepo.setStatus(target.id, 'active');
          // Re-enabling must let the user back in immediately — drop any
          // failed-login / lockout state accrued before they were disabled.
          await clearLoginThrottle(redis, target.id);
          await audit.record({
            actorId: actor.id,
            action: AuditAction.UserEnabled,
            targetType: 'user',
            targetId: target.id,
            ip: actor.ip,
          });
        }
      }

      if (input.role && input.role !== target.role) {
        if (input.role === 'user') {
          if (target.id === actor.id) {
            throw badRequest('You cannot remove your own administrator role.', 'SELF_ACTION');
          }
          await ensureNotLastActiveAdmin(target);
        }
        await userRepo.setRole(target.id, input.role);
        await audit.record({
          actorId: actor.id,
          action: AuditAction.UserRoleChanged,
          targetType: 'user',
          targetId: target.id,
          ip: actor.ip,
          meta: { role: input.role },
        });
      }

      return loadUser(id);
    },

    async resetPassword(
      id: string,
      actor: AdminActor,
    ): Promise<{ user: UserRow; tempPassword: string }> {
      const target = await loadUser(id);
      const tempPassword = generateTempPassword();
      const passwordHash = await passwordHasher.hash(tempPassword);
      await userRepo.updatePassword(target.id, passwordHash, true);
      await sessions.destroyAllForUser(target.id);
      // Clear lockout so the user can sign in with the new temp password now.
      await clearLoginThrottle(redis, target.id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserPasswordReset,
        targetType: 'user',
        targetId: target.id,
        ip: actor.ip,
      });
      const user = await loadUser(id);

      // Best-effort, post-commit: the admin already holds the temp password.
      await email.sendTempPassword({
        to: user.email,
        username: user.username,
        tempPassword,
        reason: 'reset',
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });

      return { user, tempPassword };
    },

    async deleteUser(id: string, confirmUsername: string, actor: AdminActor): Promise<void> {
      const target = await loadUser(id);
      if (target.username.toLowerCase() !== confirmUsername.trim().toLowerCase()) {
        throw badRequest('Username confirmation does not match.', 'CONFIRMATION_MISMATCH');
      }
      if (target.id === actor.id) {
        throw badRequest('You cannot delete your own account.', 'SELF_ACTION');
      }
      await ensureNotLastActiveAdmin(target);
      await sessions.destroyAllForUser(target.id);
      await userRepo.remove(target.id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserDeleted,
        targetType: 'user',
        targetId: target.id,
        ip: actor.ip,
        meta: { username: target.username },
      });
    },

    async createInvite(
      input: CreateInviteRequest,
      actor: AdminActor,
    ): Promise<{ invite: InviteRow; inviteUrl: string }> {
      const { token, tokenHash } = generateToken();
      const invite = await inviteRepo.create({
        email: input.email,
        tokenHash,
        createdBy: actor.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.InviteCreated,
        targetType: 'invite',
        targetId: invite.id,
        ip: actor.ip,
      });

      const inviteUrl = `${config.appOrigin}/invite/${token}`;
      // Best-effort, post-commit: the admin can still copy the URL on failure.
      await email.sendInvite({
        to: invite.email,
        inviteUrl,
        audit: { actorId: actor.id, targetType: 'invite', targetId: invite.id, ip: actor.ip },
      });

      return { invite, inviteUrl };
    },

    listInvites: () => inviteRepo.listAll(),

    async revokeInvite(id: string, actor: AdminActor): Promise<void> {
      const invite = await inviteRepo.findById(id);
      if (!invite) throw notFound('Invite not found.', 'INVITE_NOT_FOUND');
      if (invite.usedAt) throw badRequest('This invite has already been used.', 'INVITE_USED');
      if (invite.revokedAt) return;
      await inviteRepo.revoke(id, new Date());
      await audit.record({
        actorId: actor.id,
        action: AuditAction.InviteRevoked,
        targetType: 'invite',
        targetId: id,
        ip: actor.ip,
      });
    },

    async stats(): Promise<{
      userCount: number;
      activeUserCount: number;
      disabledUserCount: number;
      pendingInviteCount: number;
    }> {
      const counts = await userRepo.counts();
      const pendingInviteCount = await inviteRepo.pendingCount();
      return {
        userCount: counts.total,
        activeUserCount: counts.activeRecentLogin,
        disabledUserCount: counts.disabled,
        pendingInviteCount,
      };
    },

    listAudit: (params: { limit: number; cursor?: string }) => deps.audit.list(params),

    /** Global email send log, newest first (PROJECTPLAN.md §6.10, §6.12). */
    listEmails: (params: { limit: number; cursor?: string }): Promise<EmailLogPage> =>
      emailLog.listGlobal(params.limit, params.cursor),

    /** One user's email send log (PROJECTPLAN.md §6.10, §6.12). */
    async listUserEmails(
      userId: string,
      params: { limit: number; cursor?: string },
    ): Promise<EmailLogPage> {
      await loadUser(userId); // 404 for an unknown user, like the other per-user reads.
      return emailLog.listForUser(userId, params.limit, params.cursor);
    },

    /** Whether the email channel is configured + wired (PROJECTPLAN.md §6.11). */
    emailStatus(): { enabled: boolean } {
      return { enabled: email.enabled };
    },

    /** Current global app settings, defaults filled in (PROJECTPLAN.md §6.12). */
    getSettings: (): Promise<AppSettings> => appSettings.get(),

    /**
     * Persist a global-settings change and audit it (PROJECTPLAN.md §6.12, §8).
     * The settings service rejects any non-`closed` registration mode in V1;
     * every accepted change is recorded with the actor and what changed.
     */
    async updateSettings(
      input: UpdateAppSettingsRequest,
      actor: AdminActor,
    ): Promise<AppSettings> {
      const settings = await appSettings.update(input, actor.id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.SettingsUpdated,
        targetType: 'app_settings',
        targetId: null,
        ip: actor.ip,
        meta: { changed: input },
      });
      return settings;
    },

    /**
     * Admin diagnostic (PROJECTPLAN.md §6.12): send a test email to confirm SMTP
     * works. Defaults to the admin's own address. The attempt is audited (status
     * only — never credentials); a disabled channel returns `skipped`.
     */
    async sendTestEmail(
      to: string | undefined,
      actor: AdminActor,
    ): Promise<EmailSendResult & { to: string }> {
      const adminUser = await loadUser(actor.id);
      const recipient = (to ?? adminUser.email).trim();
      const result = await email.sendTest({
        to: recipient,
        audit: { actorId: actor.id, targetType: 'user', targetId: actor.id, ip: actor.ip },
      });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.EmailTestSent,
        targetType: 'user',
        targetId: actor.id,
        ip: actor.ip,
        meta:
          result.status === 'failed'
            ? { status: result.status, code: result.code }
            : { status: result.status },
      });
      return { ...result, to: recipient };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
