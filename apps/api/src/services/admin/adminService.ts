import type {
  CreateInviteRequest,
  CreateUserRequest,
  UpdateUserRequest,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { InviteRow, UserRow } from '../../data/schema';
import { badRequest, conflict, notFound } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { generateToken } from '../crypto/tokens';
import type { PasswordHasher } from '../password/passwordHasher';
import { generateTempPassword } from '../password/tempPassword';
import type { SessionService } from '../sessions/sessionService';

export interface AdminServiceDeps {
  config: AppConfig;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
}

export interface AdminActor {
  id: string;
  ip?: string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createAdminService(deps: AdminServiceDeps) {
  const { config, userRepo, inviteRepo, sessions, audit, passwordHasher } = deps;

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

      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserCreated,
        targetType: 'user',
        targetId: user.id,
        ip: actor.ip,
        meta: { via: 'admin', role: input.role },
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
      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserPasswordReset,
        targetType: 'user',
        targetId: target.id,
        ip: actor.ip,
      });
      const user = await loadUser(id);
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
      return { invite, inviteUrl: `${config.appOrigin}/invite/${token}` };
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
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
