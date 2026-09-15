import { z } from 'zod';

import type { Database } from '../../data/db';
import {
  createAuditRepository,
  type AuditListFilters,
  type AuditPage,
  type AuditRepository,
  type AuditSignalCounts,
  type RecordAuditInput,
} from '../../data/repositories/auditRepository';
import { redactAuditMeta } from './auditRedaction';

type LockedPrivacyMode = 'normal' | 'paranoid' | null;
type WithAuditPrivacyMode = <T>(
  userId: string,
  run: (privacyMode: LockedPrivacyMode) => Promise<T>,
) => Promise<T>;

const PARANOID_AUDIT_RESOURCE_PATH = '[redacted-resource-path]';

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
  /**
   * Operator notes on an account (#1406 W2). Audited even though a note changes
   * nothing about the account: the note IS operator speech about a real person,
   * so who wrote and who removed one has to be answerable. `meta` carries the
   * note id only — never the body, which would copy the prose into a second,
   * longer-lived store the delete route cannot reach.
   */
  AdminUserNoteAdded: 'user.note_added',
  AdminUserNoteDeleted: 'user.note_deleted',
  /**
   * Review flag (#1907 ADMIN-W5). A flag suspends nothing — it is the
   * non-destructive "look at this again" that stops `disabled` from being the
   * only lever an operator has. `meta` carries the moderation-action id only,
   * never the reason: the reason is a bounded column in
   * `admin_moderation_actions` and belongs in exactly one place.
   */
  AdminUserFlagged: 'user.flagged',
  AdminUserUnflagged: 'user.unflagged',
  /** Admin workspace hygiene for the helpdesk queue; no submitter lifecycle change. */
  FeedbackArchived: 'feedback.archived',
  FeedbackUnarchived: 'feedback.unarchived',
  AccountDeleteFail: 'account.delete_fail',
  // Self-service data export (§13.4 V4-P6a, #494).
  AccountExportRequested: 'account.export_requested',
  AccountExportFail: 'account.export_fail',
  /** Client-encrypted data-home transitions; metadata is media/version only. */
  ParanoidEnabled: 'account.paranoid_enabled',
  ParanoidDisabled: 'account.paranoid_disabled',
  /** A failed re-auth on the irreversible paranoid discard (throttled like deletion). */
  ParanoidDiscardFail: 'account.paranoid_discard_fail',
  /** Per-vault lifecycle metadata only; ciphertext and credentials are never copied. */
  VaultCreated: 'vault.created',
  VaultUpdated: 'vault.updated',
  VaultDeleted: 'vault.deleted',
  VaultMediaChanged: 'vault.media_changed',
  VaultRetiredPurged: 'vault.retired_purged',
  VaultDeleteReauthFail: 'vault.delete_reauth_fail',
  PortfolioVaultMovedIn: 'portfolio.vault_moved_in',
  PortfolioVaultMovedOut: 'portfolio.vault_moved_out',
  PortfolioVaultMoveInReauthFail: 'portfolio.vault_move_in_reauth_fail',
  PortfolioVaultMoveOutReauthFail: 'portfolio.vault_move_out_reauth_fail',
  /**
   * Google Drive identity registry (§13.5 V5-P13 / E5). Identity metadata only —
   * the Google subject id, never a token, a file id or a byte of ciphertext.
   */
  DriveConnectionCreated: 'drive_connection.created',
  /** Re-consent of an already registered Google account — an upsert onto the
   *  same row, never a second registration. */
  DriveConnectionRefreshed: 'drive_connection.refreshed',
  DriveConnectionDeleted: 'drive_connection.deleted',
  /** A failed §15 step-up on the acknowledged disconnect-with-loss (#1632). */
  DriveConnectionDisconnectReauthFail: 'drive_connection.disconnect_reauth_fail',
  /**
   * Generic session step-up (`POST /auth/reauth`). `meta.purpose` is the
   * caller-supplied provenance string; it is never trusted for authorization.
   */
  AuthReauth: 'auth.reauth',
  AuthReauthFail: 'auth.reauth_fail',
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
  /** Bearer/cookie caller minted a native Google LINK ceremony (#1328). */
  ExternalIdentityLinkStarted: 'external_identity.link_started',
  /** Native Google LINK ceremony completed (including an idempotent same-link). */
  ExternalIdentityLinkSucceeded: 'external_identity.link_succeeded',
  /** Native Google LINK ceremony was refused, invalid, expired or rate-limited. */
  ExternalIdentityLinkFailed: 'external_identity.link_failed',
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
  /** Local-AI provider settings (endpoint/model/cap) changed (§13.5 V5-P12). */
  AiSettingsUpdated: 'ai_settings.updated',
  ApiKeyCreated: 'api_key.created',
  ApiKeyRevoked: 'api_key.revoked',
  ApiKeyScopeDenied: 'api_key.scope_denied',
  // `meta.reason` on the row above discriminates WHY the bearer was refused —
  // see BEARER_SCOPE_DENIAL_REASONS below.
  // §13.5 V5-P10 (issue 2/2) key governance: admin rate-tier lifecycle + per-key
  // tier assignment.
  ApiKeyTierCreated: 'api_key_tier.created',
  ApiKeyTierUpdated: 'api_key_tier.updated',
  ApiKeyTierDeleted: 'api_key_tier.deleted',
  ApiKeyTierAssigned: 'api_key.tier_assigned',
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
  // MIRRORCHAIN membership lifecycle (§13.5 V5-P7 M3, design §§4–7): the
  // chain-level actions an admin/owner may need to trace. The oplog is the
  // full chain audit trail; these mirror the security-relevant mutations into
  // the per-account audit_log too.
  MirrorChainCreated: 'mirror.chain_created',
  MirrorMemberInvited: 'mirror.member_invited',
  MirrorMemberJoined: 'mirror.member_joined',
  MirrorMemberRemoved: 'mirror.member_removed',
  MirrorMemberLeft: 'mirror.member_left',
  MirrorRoleChanged: 'mirror.role_changed',
  MirrorOwnershipTransferred: 'mirror.ownership_transferred',
  MirrorChainDissolved: 'mirror.chain_dissolved',
  // Outbound webhooks (§13.5 V5-P10, issue 1/2): subscription lifecycle + the
  // auto-disable that a dead receiver triggers (the disable is audit-visible).
  WebhookCreated: 'webhook.created',
  WebhookUpdated: 'webhook.updated',
  WebhookDeleted: 'webhook.deleted',
  WebhookAutoDisabled: 'webhook.auto_disabled',
} as const;

/**
 * The action vocabularies the `preset` filter expands to (#1908 §3).
 *
 * Derived from {@link AuditAction} rather than hand-written strings, so a
 * preset can never name an action the product does not write — and renaming an
 * action moves its preset with it instead of silently emptying the view.
 */
export const AUDIT_PRESET_ACTIONS = {
  /**
   * The shell break-glass 2FA reset. The action alone is not enough — an admin
   * can also reset 2FA through the console — so the repository narrows it
   * further by `meta.via`, which only the script stamps.
   */
  break_glass: [AuditAction.AdminTwoFactorReset],
  /** Every failed authentication signal, in one view. */
  auth_failures: [
    AuditAction.LoginFail,
    AuditAction.TwoFactorVerifyFail,
    AuditAction.PasskeyLoginFail,
    AuditAction.PasskeyManageReauthFail,
    AuditAction.PinVerifyFail,
    AuditAction.AuthReauthFail,
    AuditAction.ApiKeyScopeDenied,
    AuditAction.AccountDeleteFail,
    AuditAction.ParanoidDiscardFail,
    AuditAction.VaultDeleteReauthFail,
    AuditAction.PortfolioVaultMoveInReauthFail,
    AuditAction.PortfolioVaultMoveOutReauthFail,
    AuditAction.DriveConnectionDisconnectReauthFail,
  ],
  /**
   * What the CONSOLE did, as opposed to what accounts did — the admin-only
   * writes plus the admin sign-in that precedes them.
   */
  admin_actions: [
    AuditAction.AdminLogin,
    AuditAction.AdminTwoFactorReset,
    AuditAction.UserCreated,
    AuditAction.UserDisabled,
    AuditAction.UserEnabled,
    AuditAction.UserDeleted,
    AuditAction.UserRoleChanged,
    AuditAction.UserUsernameChanged,
    AuditAction.UserEmailChanged,
    AuditAction.UserPasswordReset,
    AuditAction.UserChatBanned,
    AuditAction.UserChatUnbanned,
    AuditAction.AdminUserNoteAdded,
    AuditAction.AdminUserNoteDeleted,
    AuditAction.InviteCreated,
    AuditAction.InviteRevoked,
    AuditAction.RegistrationTokenCreated,
    AuditAction.RegistrationTokenRevoked,
    AuditAction.RegistrationRequestApproved,
    AuditAction.RegistrationRequestRejected,
    AuditAction.SettingsUpdated,
    AuditAction.AccountDefaultsUpdated,
    AuditAction.AdminSessionPolicyUpdated,
    AuditAction.AiSettingsUpdated,
    AuditAction.FeatureFlagChanged,
    AuditAction.MonitoringExternalAccessChanged,
    AuditAction.ProblemResolved,
    AuditAction.ProblemReopened,
    AuditAction.FeedbackArchived,
    AuditAction.FeedbackUnarchived,
    AuditAction.EmailTestSent,
    AuditAction.ApiKeyTierCreated,
    AuditAction.ApiKeyTierUpdated,
    AuditAction.ApiKeyTierDeleted,
    AuditAction.ApiKeyTierAssigned,
    AuditAction.OAuthClientRegistered,
    AuditAction.OAuthClientUpdated,
    AuditAction.OAuthClientDeleted,
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * The actions the Signals section counts one by one (#1908 §5). The login
 * failures are counted separately because they are grouped by `meta.reason`.
 */
export const AUDIT_SIGNAL_ACTIONS = [
  AuditAction.TwoFactorVerifyFail,
  AuditAction.PasskeyLoginFail,
  AuditAction.PinVerifyFail,
  AuditAction.AuthReauthFail,
  AuditAction.ApiKeyScopeDenied,
  AuditAction.AdminLogin,
] as const;

/**
 * Why one bearer request was refused, recorded as `meta.reason` on every
 * `api_key.scope_denied` row. Both refusals share the audit action because both
 * are credential-boundary events the account owner must be able to trace, but
 * they are NOT the same event: `insufficient-scope` means the credential simply
 * lacks the scope, while `first-party-only` means it HOLDS the scope and was
 * still refused because the route is reserved for trusted first-party clients —
 * i.e. an app probing another app's grants. Keeping the discriminator in the
 * meta makes that second, interesting event greppable (#1365).
 */
export const BEARER_SCOPE_DENIAL_REASONS = ['insufficient-scope', 'first-party-only'] as const;
export type BearerScopeDenialReason = (typeof BEARER_SCOPE_DENIAL_REASONS)[number];

/**
 * The closed `reason` vocabulary as a runtime check (#1951 §1).
 *
 * {@link BEARER_SCOPE_DENIAL_REASONS} alone is a COMPILE-time fence: a caller
 * reaching the writer through `as never`, an untyped boundary or a future JS
 * consumer could persist `reason: 'totally-made-up'` unchallenged, and the row
 * is durable for the full audit retention. The enum below is the same list,
 * enforced where the row is actually built.
 */
export const bearerScopeDenialReasonSchema = z.enum(BEARER_SCOPE_DENIAL_REASONS);

/**
 * The `meta` contract for an `api_key.scope_denied` row — the personal-key
 * shape and its OAuth twin, which differ only by the `kind` discriminator the
 * OAuth writer stamps.
 *
 * STRICT, with its reach stated precisely. `.strict()` fires on the object
 * handed to `parse`, so it guards the shape a future writer is most likely to
 * reach for — spreading caller input into the meta (`{ ...input, reason }`),
 * which is how a presented credential would end up in a 400-day store. It does
 * NOT fire for the two writers that exist today: both destructure a fixed field
 * list, so an extra property is dropped before the parse ever sees it. The row
 * is clean either way; only one of the two paths is clean *because of* this
 * schema, and `bearerDenialAudit.test.ts` pins both facts rather than letting a
 * reader assume the stronger one.
 *
 * Nor does anything bind `action: ApiKeyScopeDenied` to this schema — an audit
 * row written for that action through `audit.record()` directly bypasses it.
 * The two service writers are the only production path, and the contract lives
 * where they call it.
 *
 * `requiredScope` is a scope NAME, never a secret; the credential itself is
 * identified only by the row's own `targetId` (the key/grant id).
 */
export const bearerScopeDeniedMetaSchema = z
  .object({
    requiredScope: z.string().min(1),
    reason: bearerScopeDenialReasonSchema,
    method: z.string().min(1),
    path: z.string(),
    kind: z.literal('oauth').optional(),
  })
  .strict();

export type BearerScopeDeniedMeta = z.infer<typeof bearerScopeDeniedMetaSchema>;

/**
 * Field paths + issue codes of a schema failure, with NO values.
 *
 * An invalid `api_key.scope_denied` meta is precisely where a mis-wired writer
 * might have put credential material, and this string travels to the log and to
 * the admin Problems page. So the report says WHICH field and WHAT KIND of
 * failure — plus, for an unrecognized key, the offending key NAME, which is the
 * one fact that makes the defect fixable and is never itself a secret.
 */
function describeMetaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.') || '<root>';
      return issue.code === 'unrecognized_keys'
        ? `${path}:unrecognized_keys(${issue.keys.join(',')})`
        : `${path}:${issue.code}`;
    })
    .join('; ');
}

/**
 * Why these throw a PLAIN `Error` rather than the `ZodError` or an `ApiError`
 * (#1951 L1).
 *
 * `createErrorHandler` answers a `ZodError` with `400 VALIDATION_ERROR` and
 * returns BEFORE `reportUnexpected` — and it returns early for `ApiError` too.
 * Either shape would mean that the day this fence finally catches a bad writer,
 * the only symptom is a refusal path quietly answering 400 with no Problems row
 * and no log line: the fence would hide exactly the defect it exists to expose.
 * A plain `Error` is the one shape the handler reports, so it becomes
 * `500 INTERNAL` *and* a captured problem. The refusal still stands either way —
 * the guard never admits the request — but now it is loud.
 */
export function parseBearerScopeDeniedMeta(writer: string, meta: unknown): BearerScopeDeniedMeta {
  const parsed = bearerScopeDeniedMetaSchema.safeParse(meta);
  if (parsed.success) return parsed.data;
  throw new Error(
    `${writer}: refused to write an api_key.scope_denied row — ${describeMetaIssues(parsed.error)}`,
  );
}

/** The reason half of the contract, checked at the shared rail. See above. */
export function parseBearerScopeDenialReason(
  writer: string,
  reason: unknown,
): BearerScopeDenialReason {
  const parsed = bearerScopeDenialReasonSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  throw new Error(
    `${writer}: refused to audit a bearer scope denial — reason:${describeMetaIssues(parsed.error)}`,
  );
}

export interface AuditService {
  record(input: RecordAuditInput): Promise<void>;
  /**
   * Persist an audit row through the caller's transaction executor. This is
   * reserved for security transitions whose state change and success audit
   * must either commit or roll back together.
   */
  recordInTransaction(executor: Database, input: RecordAuditInput): Promise<void>;
  list(params: { limit: number; cursor?: string; filters?: AuditListFilters }): Promise<AuditPage>;
  listForTarget(params: {
    targetId: string;
    limit: number;
    cursor?: string;
    filters?: AuditListFilters;
  }): Promise<AuditPage>;
  signals(params: {
    from: Date;
    to: Date;
    actions?: readonly string[];
    groupLimit?: number;
  }): Promise<AuditSignalCounts>;
  breakGlassTotal(cap: number): Promise<{ count: number; capped: boolean }>;
}

/**
 * Ceiling on the rows one `GROUP BY` in the Signals read may return. The
 * vocabularies above are far smaller; this is what keeps a future one from
 * turning a bounded aggregate into an unbounded read.
 */
const SIGNAL_GROUP_LIMIT = 50;

export function createAuditService(
  auditRepo: AuditRepository,
  withPrivacyMode: WithAuditPrivacyMode = (_userId, run) => run(null),
): AuditService {
  return {
    record: (rawInput) => {
      // Secret redaction runs FIRST and on every action, before any other rule
      // decides anything (#1908 §4). It is a write-path policy: a marker
      // substituted here is durable, while a renderer-side filter would leave
      // the real value in `audit_log` for the full 400-day retention.
      const input = redactInput(rawInput);
      const meta = input.meta;
      if (
        input.action !== AuditAction.ApiKeyScopeDenied ||
        !input.actorId ||
        !meta ||
        typeof meta !== 'object' ||
        Array.isArray(meta) ||
        typeof (meta as Record<string, unknown>).path !== 'string'
      ) {
        return auditRepo.record(input);
      }

      // Both personal-key and OAuth scope denials use this one action. Hold the
      // privacy lock through persistence so a denial racing paranoid enable is
      // either written first and scrubbed by enable, or written redacted after
      // the transition commits. Unknown/deleted actors fail closed as redacted.
      //
      // Untouched by the secret redaction above: `path` is not a secret-shaped
      // key, so the paranoid rule is still the ONLY thing that rewrites it and
      // still rewrites it to its own marker.
      return withPrivacyMode(input.actorId, (privacyMode) =>
        auditRepo.record({
          ...input,
          meta: privacyMode === 'normal' ? meta : { ...meta, path: PARANOID_AUDIT_RESOURCE_PATH },
        }),
      );
    },
    recordInTransaction: (executor, input) =>
      createAuditRepository(executor).record(redactInput(input)),
    list: (params) => auditRepo.list(params),
    listForTarget: (params) => auditRepo.listForTarget(params),
    signals: (params) =>
      auditRepo.signals({
        from: params.from,
        to: params.to,
        actions: params.actions ?? AUDIT_SIGNAL_ACTIONS,
        groupLimit: params.groupLimit ?? SIGNAL_GROUP_LIMIT,
      }),
    breakGlassTotal: (cap) => auditRepo.breakGlassTotal(cap),
  };
}

/** `meta` with every secret-shaped value replaced, leaving the row untouched. */
function redactInput(input: RecordAuditInput): RecordAuditInput {
  if (input.meta === undefined || input.meta === null) return input;
  const meta = redactAuditMeta(input.meta);
  return meta === input.meta ? input : { ...input, meta };
}
