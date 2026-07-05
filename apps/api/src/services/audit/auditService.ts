import type { AuditRepository, RecordAuditInput } from '../../data/repositories/auditRepository';

/** Audit actions written across auth/admin flows (PROJECTPLAN.md §5.5, §10). */
export const AuditAction = {
  LoginSuccess: 'login.success',
  LoginFail: 'login.fail',
  AdminLogin: 'admin.login',
  PasswordChanged: 'password.changed',
  PasswordResetRequested: 'password.reset_requested',
  PasswordResetCompleted: 'password.reset_completed',
  PinEnabled: 'pin.enabled',
  PinDisabled: 'pin.disabled',
  PinVerified: 'pin.verified',
  PinVerifyFail: 'pin.verify_fail',
  PinLockIdleChanged: 'pin.lock_idle_changed',
  TwoFactorEnrolled: 'two_factor.enrolled',
  TwoFactorConfirmed: 'two_factor.confirmed',
  TwoFactorDisabled: 'two_factor.disabled',
  TwoFactorRecoveryRegenerated: 'two_factor.recovery_regenerated',
  TwoFactorChallengeIssued: 'two_factor.challenge_issued',
  TwoFactorEmailCodeSent: 'two_factor.email_code_sent',
  TwoFactorVerifyFail: 'two_factor.verify_fail',
  UserCreated: 'user.created',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  UserRoleChanged: 'user.role_changed',
  UserUsernameChanged: 'user.username_changed',
  UserEmailChanged: 'user.email_changed',
  UserDeleted: 'user.deleted',
  UserPasswordReset: 'user.pw_reset',
  InviteCreated: 'invite.created',
  InviteUsed: 'invite.used',
  InviteRevoked: 'invite.revoked',
  EmailSendFailed: 'email.send_failed',
  EmailTestSent: 'email.test_sent',
  SettingsUpdated: 'settings.updated',
} as const;

export interface AuditService {
  record(input: RecordAuditInput): Promise<void>;
  list(params: { limit: number; cursor?: string }): ReturnType<AuditRepository['list']>;
  listForTarget(params: {
    targetId: string;
    limit: number;
    cursor?: string;
  }): ReturnType<AuditRepository['listForTarget']>;
}

export function createAuditService(auditRepo: AuditRepository): AuditService {
  return {
    record: (input) => auditRepo.record(input),
    list: (params) => auditRepo.list(params),
    listForTarget: (params) => auditRepo.listForTarget(params),
  };
}
