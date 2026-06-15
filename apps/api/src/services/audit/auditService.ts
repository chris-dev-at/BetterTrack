import type { AuditRepository, RecordAuditInput } from '../../data/repositories/auditRepository';

/** Audit actions written across auth/admin flows (PROJECTPLAN.md §5.5, §10). */
export const AuditAction = {
  LoginSuccess: 'login.success',
  LoginFail: 'login.fail',
  AdminLogin: 'admin.login',
  PasswordChanged: 'password.changed',
  UserCreated: 'user.created',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  UserRoleChanged: 'user.role_changed',
  UserDeleted: 'user.deleted',
  UserPasswordReset: 'user.pw_reset',
  InviteCreated: 'invite.created',
  InviteUsed: 'invite.used',
  InviteRevoked: 'invite.revoked',
  EmailSendFailed: 'email.send_failed',
} as const;

export interface AuditService {
  record(input: RecordAuditInput): Promise<void>;
  list(params: { limit: number; cursor?: string }): ReturnType<AuditRepository['list']>;
}

export function createAuditService(auditRepo: AuditRepository): AuditService {
  return {
    record: (input) => auditRepo.record(input),
    list: (params) => auditRepo.list(params),
  };
}
