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
  // Passkeys / WebAuthn (§13.4 V4-P4). Registration + management on the account;
  // a passkey login records the shared LoginSuccess with `meta.via = 'passkey'`.
  PasskeyRegistered: 'passkey.registered',
  PasskeyRenamed: 'passkey.renamed',
  PasskeyDeleted: 'passkey.deleted',
  /** A passkey login rejected (assertion failed or a cloned-authenticator counter regression). */
  PasskeyLoginFail: 'passkey.login_fail',
  /** A failed re-auth on passkey add/delete (per-account throttled like export/deletion). */
  PasskeyManageReauthFail: 'passkey.manage_reauth_fail',
  UserCreated: 'user.created',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  // Per-user chat moderation (§13.4 V4-P0d).
  UserChatBanned: 'user.chat_banned',
  UserChatUnbanned: 'user.chat_unbanned',
  UserRoleChanged: 'user.role_changed',
  UserUsernameChanged: 'user.username_changed',
  UserEmailChanged: 'user.email_changed',
  UserDeleted: 'user.deleted',
  AccountDeleteFail: 'account.delete_fail',
  // Self-service data export (§13.4 V4-P6a, #494).
  AccountExportRequested: 'account.export_requested',
  AccountExportFail: 'account.export_fail',
  UserPasswordReset: 'user.pw_reset',
  InviteCreated: 'invite.created',
  InviteUsed: 'invite.used',
  InviteRevoked: 'invite.revoked',
  // Registration modes (§6.12, §13.4 V4-P4a).
  RegistrationTokenCreated: 'registration_token.created',
  RegistrationTokenRevoked: 'registration_token.revoked',
  RegistrationRequested: 'registration.requested',
  RegistrationRequestApproved: 'registration.approved',
  RegistrationRequestRejected: 'registration.rejected',
  // Federated (Google) sign-in identity link/unlink (§13.4 V4-P4b).
  ExternalIdentityLinked: 'external_identity.linked',
  ExternalIdentityUnlinked: 'external_identity.unlinked',
  EmailSendFailed: 'email.send_failed',
  EmailTestSent: 'email.test_sent',
  SettingsUpdated: 'settings.updated',
  /** New-account defaults panel changed (§13.4 V4-P0d). */
  AccountDefaultsUpdated: 'account_defaults.updated',
  /** Admin session lifetime changed (§13.5 V5-P13c). */
  AdminSessionPolicyUpdated: 'admin_session_policy.updated',
  /** Monitoring external-access runtime kill-switch flipped (§13.5 V5-P2 arc (a)). */
  MonitoringExternalAccessChanged: 'monitoring.external_access_changed',
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
  // Admin Problems page (§13.5 V5-P2, the Sentry replacement).
  ProblemResolved: 'problem.resolved',
  ProblemReopened: 'problem.reopened',
  // Runtime feature kill-switches (§13.5 V5-P2 arc (c)).
  FeatureFlagChanged: 'feature_flag.changed',
  /**
   * MIRRORCHAIN (§13.5 V5-P7, design §2/§10): one row per applied op per copy —
   * actor = the acting member, target = the copy-local row — so each copy's
   * audit trail is complete and survives forks and actor deletion.
   */
  MirrorOpApplied: 'mirror.op_applied',
  // Outbound webhooks (§13.5 V5-P10, issue 1/2): subscription lifecycle + the
  // auto-disable that a dead receiver triggers (the disable is audit-visible).
  WebhookCreated: 'webhook.created',
  WebhookUpdated: 'webhook.updated',
  WebhookDeleted: 'webhook.deleted',
  WebhookAutoDisabled: 'webhook.auto_disabled',
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
