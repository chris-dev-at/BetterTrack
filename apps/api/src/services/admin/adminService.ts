import type { Redis } from 'ioredis';

import type {
  BulkUserActionRequest,
  BulkUserActionResponse,
  CreateInviteRequest,
  CreateRegistrationTokenRequest,
  CreateUserRequest,
  UpdateAppSettingsRequest,
  UpdateUserRequest,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { EmailLogPage, EmailLogRepository } from '../../data/repositories/emailLogRepository';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { RegistrationRequestRepository } from '../../data/repositories/registrationRequestRepository';
import type { RegistrationTokenRepository } from '../../data/repositories/registrationTokenRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { InviteRow, RegistrationTokenRow, UserRow } from '../../data/schema';
import { badRequest, conflict, notFound } from '../../errors';
import type { AppSettings, AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { clearLoginThrottle } from '../auth/loginThrottle';
import { generateToken } from '../crypto/tokens';
import type { EmailSendResult, EmailService } from '../email/emailService';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { PasswordHasher } from '../password/passwordHasher';
import { generateTempPassword } from '../password/tempPassword';
import type { SessionService } from '../sessions/sessionService';

export interface AdminServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
  /** Registration access tokens for the `invite_token` mode (§13.4 V4-P4a). */
  registrationTokenRepo: RegistrationTokenRepository;
  /** Approval-queue applications for the `approval` mode (§13.4 V4-P4a). */
  registrationRequestRepo: RegistrationRequestRepository;
  portfolioRepo: PortfolioRepository;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  email: EmailService;
  emailLog: EmailLogRepository;
  appSettings: AppSettingsService;
  /** The central notification pipeline (#368) — `account.temp_password` notices. */
  notify: NotificationCenter;
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
    registrationTokenRepo,
    registrationRequestRepo,
    portfolioRepo,
    sessions,
    audit,
    passwordHasher,
    email,
    emailLog,
    appSettings,
    notify,
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

  /**
   * Bulk-disable (§6.12, §13.2): best-effort over a set — an id that can't be
   * disabled (unknown, the actor themselves, already disabled, or the last
   * active admin) is skipped rather than failing the whole batch. Each success
   * kills the user's sessions and is audited exactly like a single disable.
   */
  async function bulkDisableUsers(
    userIds: string[],
    actor: AdminActor,
  ): Promise<{ disabled: number; skipped: number }> {
    const unique = [...new Set(userIds)];
    let activeAdmins = await userRepo.countActiveAdmins();
    const toDisable: string[] = [];
    let skipped = 0;

    for (const id of unique) {
      const target = await userRepo.findById(id);
      if (!target || target.id === actor.id || target.status !== 'active') {
        skipped += 1;
        continue;
      }
      if (target.role === 'admin' && activeAdmins <= 1) {
        skipped += 1;
        continue;
      }
      toDisable.push(target.id);
      if (target.role === 'admin') activeAdmins -= 1;
    }

    if (toDisable.length > 0) {
      await userRepo.setStatusMany(toDisable, 'disabled');
      for (const id of toDisable) {
        await sessions.destroyAllForUser(id);
        await audit.record({
          actorId: actor.id,
          action: AuditAction.UserDisabled,
          targetType: 'user',
          targetId: id,
          ip: actor.ip,
          meta: { via: 'bulk' },
        });
      }
    }

    return { disabled: toDisable.length, skipped };
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

      if (input.email !== undefined) {
        const normalized = input.email.trim().toLowerCase();
        if (normalized !== target.email) {
          const existing = await userRepo.findByEmail(normalized);
          if (existing && existing.id !== target.id) {
            throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
          }
          await userRepo.updateEmail(target.id, normalized);
          await audit.record({
            actorId: actor.id,
            action: AuditAction.UserEmailChanged,
            targetType: 'user',
            targetId: target.id,
            ip: actor.ip,
            meta: { email: normalized },
          });
        }
      }

      if (input.username !== undefined) {
        const trimmed = input.username.trim();
        if (trimmed.toLowerCase() !== target.username.toLowerCase()) {
          const existing = await userRepo.findByUsername(trimmed);
          if (existing && existing.id !== target.id) {
            throw conflict('That username is already taken.', 'USERNAME_TAKEN');
          }
          await userRepo.updateUsername(target.id, trimmed);
          await audit.record({
            actorId: actor.id,
            action: AuditAction.UserUsernameChanged,
            targetType: 'user',
            targetId: target.id,
            ip: actor.ip,
            meta: { username: trimmed },
          });
        }
      }

      return loadUser(id);
    },

    /** Bulk action from the admin user list (§6.12, §13.2). V1: bulk-disable. */
    async bulkUserAction(
      input: BulkUserActionRequest,
      actor: AdminActor,
    ): Promise<BulkUserActionResponse> {
      switch (input.action) {
        case 'disable': {
          const { disabled, skipped } = await bulkDisableUsers(input.userIds, actor);
          return { action: 'disable', disabled, skipped };
        }
      }
    },

    /**
     * Admin password reset (§6.1). Idempotent by design: every call mints a
     * fresh temp password, overwrites the stored hash, and re-arms
     * `must_change_password`, so a re-reset after a lost token issues a new,
     * immediately-usable credential and never bricks the account (#248 item 6).
     * Works for admin-kind targets too — the reset a management account recovers
     * with is completed against its own session on login, not the user app.
     */
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
      // The credential email is TRANSACTIONAL and sent directly — it must never
      // ride the notification queue (#368: no secrets in Redis-persisted jobs).
      await email.sendTempPassword({
        to: user.email,
        username: user.username,
        tempPassword,
        reason: 'reset',
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });
      // The matrix-routed informational notice (inbox/push) carries NO secret.
      await notify.emit({
        type: 'account.temp_password',
        userId: user.id,
        occurredAt: new Date().toISOString(),
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

    // ── Registration access tokens (§6.12, §13.4 V4-P4a) ──────────────────────
    // Admin-issued tokens that gate the `invite_token` registration mode. The raw
    // token is only ever returned here, once, inside the register URL; the store
    // keeps its hash. All actions are audit-logged.
    async createRegistrationToken(
      input: CreateRegistrationTokenRequest,
      actor: AdminActor,
    ): Promise<{ token: RegistrationTokenRow; registerUrl: string }> {
      const { token, tokenHash } = generateToken();
      const expiresAt =
        input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
      const row = await registrationTokenRepo.create({
        tokenHash,
        label: input.label?.trim() ? input.label.trim() : null,
        maxUses: input.maxUses,
        createdBy: actor.id,
        expiresAt,
      });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationTokenCreated,
        targetType: 'registration_token',
        targetId: row.id,
        ip: actor.ip,
        meta: { maxUses: row.maxUses, expiresAt: expiresAt?.toISOString() ?? null },
      });
      const registerUrl = `${config.appOrigin}/register?token=${token}`;
      return { token: row, registerUrl };
    },

    listRegistrationTokens: () => registrationTokenRepo.listAll(),

    async revokeRegistrationToken(id: string, actor: AdminActor): Promise<void> {
      const row = await registrationTokenRepo.findById(id);
      if (!row) throw notFound('Registration token not found.', 'REGISTRATION_TOKEN_NOT_FOUND');
      if (row.revokedAt) return;
      await registrationTokenRepo.revoke(id, new Date());
      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationTokenRevoked,
        targetType: 'registration_token',
        targetId: id,
        ip: actor.ip,
      });
    },

    // ── Approval queue (§6.12, §13.4 V4-P4a) ──────────────────────────────────
    // Pending `approval`-mode applications. Approve creates the real account (with
    // the applicant's chosen password) and sends a localized decision email;
    // reject drops the application and sends its own decision email. Either way the
    // row is removed so it leaves the queue.
    listRegistrationRequests: () => registrationRequestRepo.listAll(),

    async approveRegistrationRequest(id: string, actor: AdminActor): Promise<UserRow> {
      const request = await registrationRequestRepo.findById(id);
      if (!request) {
        throw notFound('Registration request not found.', 'REGISTRATION_REQUEST_NOT_FOUND');
      }
      // Re-check uniqueness at approval time — the email/username may have been
      // claimed by an admin-created account (or another approval) since the
      // application was filed.
      if (await userRepo.findByEmail(request.email)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }
      if (await userRepo.findByUsername(request.username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }

      const user = await userRepo.create({
        email: request.email,
        username: request.username,
        // The applicant already chose (and hashed) their password at request time.
        passwordHash: request.passwordHash,
        role: 'user',
        status: 'active',
        mustChangePassword: false,
        // Carry the language they applied in onto the account (matches the
        // decision-mail locale below).
        locale: request.locale,
      });
      await portfolioRepo.createDefault(user.id);
      await registrationRequestRepo.remove(id);

      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationRequestApproved,
        targetType: 'user',
        targetId: user.id,
        ip: actor.ip,
        meta: { requestId: id },
      });

      // Best-effort, post-commit: the account exists regardless of mail state.
      await email.sendRegistrationApproved({
        to: user.email,
        userId: user.id,
        username: user.username,
        locale: request.locale,
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });
      return user;
    },

    async rejectRegistrationRequest(id: string, actor: AdminActor): Promise<void> {
      const request = await registrationRequestRepo.findById(id);
      if (!request) {
        throw notFound('Registration request not found.', 'REGISTRATION_REQUEST_NOT_FOUND');
      }
      await registrationRequestRepo.remove(id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationRequestRejected,
        targetType: 'registration_request',
        targetId: id,
        ip: actor.ip,
        meta: { email: request.email },
      });
      // No account was ever created — the decision email carries no credential.
      await email.sendRegistrationRejected({
        to: request.email,
        locale: request.locale,
        audit: { actorId: actor.id, targetType: 'user', targetId: id, ip: actor.ip },
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

    /** One user's audit history (§6.12) — entries whose target is this user. */
    async listUserAudit(userId: string, params: { limit: number; cursor?: string }) {
      await loadUser(userId); // 404 for an unknown user, like the other per-user reads.
      return deps.audit.listForTarget({
        targetId: userId,
        limit: params.limit,
        cursor: params.cursor,
      });
    },

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
    async updateSettings(input: UpdateAppSettingsRequest, actor: AdminActor): Promise<AppSettings> {
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
