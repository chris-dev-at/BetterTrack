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
  /** OAuth device remembered for PIN quick re-auth (#399 §B, V4-P2b). */
  RememberedDeviceCreated: 'remembered_device.created',
  /** Remembered device forgotten ("Another account" / explicit forget). */
  RememberedDeviceForgotten: 'remembered_device.forgotten',
  TwoFactorEnrolled: 'two_factor.enrolled',
  TwoFactorEnrollCanceled: 'two_factor.enroll_canceled',
  TwoFactorConfirmed: 'two_factor.confirmed',
  TwoFactorDisabled: 'two_factor.disabled',
  TwoFactorRecoveryRegenerated: 'two_factor.recovery_regenerated',
  TwoFactorChallengeIssued: 'two_factor.challenge_issued',
  TwoFactorEmailCodeSent: 'two_factor.email_code_sent',
  TwoFactorEmailEnabled: 'two_factor.email_enabled',
  TwoFactorEmailDisabled: 'two_factor.email_disabled',
  TwoFactorVerifyFail: 'two_factor.verify_fail',
  /** Break-glass reset of an admin's 2FA enrollment via the shell-only script (#400). */
  AdminTwoFactorReset: 'admin.two_factor_reset',
  UserCreated: 'user.created',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  UserRoleChanged: 'user.role_changed',
  UserUsernameChanged: 'user.username_changed',
  UserEmailChanged: 'user.email_changed',
  UserDeleted: 'user.deleted',
  AccountDeleteFail: 'account.delete_fail',
  UserPasswordReset: 'user.pw_reset',
  InviteCreated: 'invite.created',
  InviteUsed: 'invite.used',
  InviteRevoked: 'invite.revoked',
  EmailSendFailed: 'email.send_failed',
  EmailTestSent: 'email.test_sent',
  SettingsUpdated: 'settings.updated',
  ApiKeyCreated: 'api_key.created',
  ApiKeyRevoked: 'api_key.revoked',
  ApiKeyScopeDenied: 'api_key.scope_denied',
  OAuthClientRegistered: 'oauth.client_registered',
  OAuthClientUpdated: 'oauth.client_updated',
  OAuthClientDeleted: 'oauth.client_deleted',
  OAuthGrantAuthorized: 'oauth.grant_authorized',
  OAuthGrantRevoked: 'oauth.grant_revoked',
  OAuthTokenIssued: 'oauth.token_issued',
  OAuthTokenRefreshed: 'oauth.token_refreshed',
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
