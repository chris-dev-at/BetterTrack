import {
  ADMIN_SESSION_LIFETIME_MAX_HOURS,
  ADMIN_SESSION_LIFETIME_MIN_HOURS,
  profileIconIdSchema,
  type AdminInvite,
  type AdminSessionPolicyResponse,
  type AdminUser,
  type AdminUserAccessResponse,
  type AdminUserNote,
  type AdminUserSharingResponse,
  type AdminUserSupportItem,
  type Alert,
  type AppSettingsResponse,
  type AuditLogEntry,
  type EmailLogEntry,
  type MeResponse,
  type Problem,
  type ProfileIconId,
  type RegistrationRequest,
  type RegistrationToken,
  type VaultMediaSet,
  type WorkboardItem,
} from '@bettertrack/contracts';

import type { AlertRecord } from '../data/repositories/alertRepository';
import type {
  AdminUserApiKeyRow,
  AdminUserIdentityRow,
  AdminUserNoteRow,
  AdminUserOAuthGrantRow,
  AdminUserSharingCounts,
  AdminUserSupportRow,
} from '../data/repositories/adminPeopleRepository';
import type { SessionListEntry } from '../services/sessions/sessionService';
import { describeUserAgent } from '../services/sessions/deviceLabel';
import type { WorkboardItemWithAsset } from '../data/repositories/workboardRepository';
import type {
  AuditLogRow,
  EmailLogRow,
  InviteRow,
  ProblemRow,
  RegistrationRequestRow,
  RegistrationTokenRow,
  UserRow,
} from '../data/schema';
import type { AdminSessionPolicy, AppSettings } from '../services/appSettings/appSettingsService';
import type { AuthUser } from './types';

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const toIsoRequired = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Coerce a stored `profile_icon` column value to a curated icon id, or `null`.
 * The write path validates against {@link profileIconIdSchema} before storing,
 * so under normal operation this only ever sees a known id or `null`; any
 * unexpected value (a pre-existing hand-edit, a removed curated id from an
 * older deploy) reads back as `null` and the SPA falls through to the
 * deterministic default, so no surface ever renders broken.
 */
export function coerceProfileIcon(value: string | null | undefined): ProfileIconId | null {
  if (value == null) return null;
  const parsed = profileIconIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    pinEnabled: row.pinEnabled,
    pinLockIdleMinutes: row.pinLockIdleMinutes,
    baseCurrency: row.baseCurrency,
    locale: row.locale,
    profileIcon: coerceProfileIcon(row.profileIcon),
    discreetMode: row.discreetMode,
    privacyMode: row.privacyMode,
    lastLoginAt: row.lastLoginAt,
    firstRunCompletedAt: row.firstRunCompletedAt,
    createdAt: row.createdAt,
  };
}

export function toMeResponse(user: AuthUser): MeResponse {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    pinEnabled: user.pinEnabled,
    pinLockIdleMinutes: user.pinLockIdleMinutes,
    baseCurrency: user.baseCurrency,
    locale: user.locale,
    profileIcon: user.profileIcon,
    discreetMode: user.discreetMode,
    privacyMode: user.privacyMode,
    lastLoginAt: toIso(user.lastLoginAt),
    firstRunCompletedAt: toIso(user.firstRunCompletedAt),
    createdAt: toIsoRequired(user.createdAt),
  };
}

export const toMeResponseFromRow = (row: UserRow): MeResponse => toMeResponse(toAuthUser(row));

export function toAdminUser(
  row: UserRow,
  paranoidMetadata: {
    privacyMode: 'normal' | 'paranoid';
    mediaSet: VaultMediaSet | null;
    vault: { version: number; sizeBytes: number; updatedAt: Date } | null;
    historyCount: number;
  },
): AdminUser {
  if (paranoidMetadata.privacyMode === 'paranoid' && paranoidMetadata.mediaSet === null) {
    throw new Error('Paranoid account is missing its media set.');
  }
  const serialized: AdminUser = {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    chatBanned: row.chatBanned,
    lastLoginAt: toIso(row.lastLoginAt),
    createdAt: toIsoRequired(row.createdAt),
  };
  if (paranoidMetadata.privacyMode === 'normal') return serialized;
  return {
    ...serialized,
    privacyMode: 'paranoid',
    paranoid: {
      mediaSet: paranoidMetadata.mediaSet!,
      vault: paranoidMetadata.vault
        ? {
            ...paranoidMetadata.vault,
            updatedAt: toIsoRequired(paranoidMetadata.vault.updatedAt),
          }
        : null,
      historyCount: paranoidMetadata.historyCount,
    },
  };
}

function inviteStatus(row: InviteRow): AdminInvite['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.usedAt) return 'used';
  if (new Date(row.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

export function toAdminInvite(row: InviteRow): AdminInvite {
  return {
    id: row.id,
    email: row.email,
    status: inviteStatus(row),
    createdAt: toIsoRequired(row.createdAt),
    expiresAt: toIsoRequired(row.expiresAt),
    usedAt: toIso(row.usedAt),
    revokedAt: toIso(row.revokedAt),
  };
}

function registrationTokenStatus(row: RegistrationTokenRow): RegistrationToken['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return 'expired';
  if (row.useCount >= row.maxUses) return 'exhausted';
  return 'active';
}

export function toRegistrationToken(row: RegistrationTokenRow): RegistrationToken {
  return {
    id: row.id,
    label: row.label,
    status: registrationTokenStatus(row),
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: toIso(row.expiresAt),
    revokedAt: toIso(row.revokedAt),
    createdAt: toIsoRequired(row.createdAt),
  };
}

export function toRegistrationRequest(row: RegistrationRequestRow): RegistrationRequest {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    // Already stored and already read at approval time to link the identity —
    // W2 only stops hiding it, so the operator can tell a Google applicant from
    // a password one. The provider SUBJECT stays server-side (#1406 W2).
    provider: row.provider ?? null,
    createdAt: toIsoRequired(row.createdAt),
  };
}

// ── People 360 (#1406 W2) ────────────────────────────────────────────────────

/**
 * One live session, for the Access tab. `entry.id` is already the PUBLIC handle
 * (SHA-256 of the session id) minted by the session service — the raw session
 * token never leaves Redis, so this response cannot be replayed into a session.
 * The stored User-Agent is reduced to a coarse device label here rather than
 * shipped raw: the operator needs "Safari on iPhone", not a fingerprint.
 */
export function toAdminUserSession(entry: SessionListEntry) {
  return {
    id: entry.id,
    device: describeUserAgent(entry.userAgent),
    createdAt: new Date(entry.createdAt).toISOString(),
    lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
    persistent: entry.persistent,
  };
}

export function toAdminUserAccess(input: {
  sessions: SessionListEntry[];
  apiKeys: AdminUserApiKeyRow[];
  oauthGrants: AdminUserOAuthGrantRow[];
  identities: AdminUserIdentityRow[];
}): AdminUserAccessResponse {
  return {
    sessions: input.sessions.map(toAdminUserSession),
    apiKeys: input.apiKeys.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      lastUsedAt: toIso(row.lastUsedAt),
      revokedAt: toIso(row.revokedAt),
      createdAt: toIsoRequired(row.createdAt),
    })),
    oauthGrants: input.oauthGrants.map((row) => ({
      id: row.id,
      clientName: row.clientName,
      firstParty: row.firstParty,
      scopes: row.scopes,
      lastUsedAt: toIso(row.lastUsedAt),
      revokedAt: toIso(row.revokedAt),
      createdAt: toIsoRequired(row.createdAt),
    })),
    identities: input.identities.map((row) => ({
      provider: row.provider,
      emailVerified: row.emailVerified,
      linkedAt: toIsoRequired(row.linkedAt),
    })),
  };
}

export function toAdminUserSharing(counts: AdminUserSharingCounts): AdminUserSharingResponse {
  return { ...counts };
}

export function toAdminUserSupportItem(row: AdminUserSupportRow): AdminUserSupportItem {
  return {
    id: row.id,
    category: row.category,
    subject: row.subject,
    status: row.status,
    deletedByUser: row.deletedByUser,
    archived: row.archived,
    unreadByAdmin: row.unreadByAdmin,
    createdAt: toIsoRequired(row.createdAt),
    updatedAt: toIsoRequired(row.updatedAt),
  };
}

export function toAdminUserNote(row: AdminUserNoteRow): AdminUserNote {
  return {
    id: row.id,
    body: row.body,
    authorId: row.authorId,
    authorUsername: row.authorUsername,
    createdAt: toIsoRequired(row.createdAt),
  };
}

export function toWorkboardItem(item: WorkboardItemWithAsset): WorkboardItem {
  return {
    id: item.id,
    watchlistId: item.watchlistId,
    assetId: item.assetId,
    sortOrder: item.sortOrder,
    note: item.note ?? null,
    asset: {
      symbol: item.asset.symbol,
      name: item.asset.name,
      exchange: item.asset.exchange ?? null,
      currency: item.asset.currency,
      type: item.asset.type,
    },
  };
}

export function toAlert(record: AlertRecord): Alert {
  return {
    id: record.id,
    kind: record.kind,
    threshold: record.threshold,
    refPrice: record.refPrice,
    repeat: record.repeat,
    status: record.status,
    lastTriggeredAt: toIso(record.lastTriggeredAt),
    asset: {
      id: record.asset.id,
      symbol: record.asset.symbol,
      name: record.asset.name,
      currency: record.asset.currency,
      type: record.asset.type,
    },
  };
}

export function toEmailLogEntry(row: EmailLogRow): EmailLogEntry {
  return {
    id: row.id,
    userId: row.userId,
    recipient: row.recipient,
    template: row.template,
    subject: row.subject,
    status: row.status,
    errorCode: row.errorCode,
    createdAt: toIsoRequired(row.createdAt),
  };
}

export function toAppSettings(settings: AppSettings): AppSettingsResponse {
  return {
    registrationMode: settings.registrationMode,
    betaMode: settings.betaMode,
    updatedAt: toIso(settings.updatedAt),
    updatedBy: settings.updatedBy,
  };
}

export function toAdminSessionPolicy(policy: AdminSessionPolicy): AdminSessionPolicyResponse {
  return {
    sessionLifetimeHours: policy.sessionLifetimeHours,
    minHours: ADMIN_SESSION_LIFETIME_MIN_HOURS,
    maxHours: ADMIN_SESSION_LIFETIME_MAX_HOURS,
    updatedAt: toIso(policy.updatedAt),
    updatedBy: policy.updatedBy,
  };
}

export function toAuditEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ip: row.ip,
    meta: row.meta ?? null,
    createdAt: toIsoRequired(row.createdAt),
  };
}

export function toProblem(row: ProblemRow): Problem {
  return {
    id: row.id,
    kind: row.kind,
    fingerprint: row.fingerprint,
    title: row.title,
    message: row.message,
    context: row.context ?? null,
    status: row.status,
    occurrenceCount: row.occurrenceCount,
    firstSeenAt: toIsoRequired(row.firstSeenAt),
    lastSeenAt: toIsoRequired(row.lastSeenAt),
    resolvedAt: toIso(row.resolvedAt),
    resolvedBy: row.resolvedBy,
  };
}
