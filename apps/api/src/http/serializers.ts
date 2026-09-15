import {
  ADMIN_SESSION_LIFETIME_MAX_HOURS,
  ADMIN_SESSION_LIFETIME_MIN_HOURS,
  adminModerationActionSchema,
  profileIconIdSchema,
  type AdminInvite,
  type AdminModerationEntry,
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
import type { AdminModerationActionRow } from '../data/repositories/adminModerationRepository';
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
import { BREAK_GLASS_VIA, type AuditEntryRow } from '../data/repositories/auditRepository';
import type {
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
  /**
   * Review flag (#1907 ADMIN-W5). Additive exactly as the paranoid metadata is:
   * an unflagged account's payload is byte-for-byte what it was before this
   * wave, so every existing consumer stays valid.
   */
  flagged = false,
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
    ...(flagged ? { flagged: true as const } : {}),
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

/**
 * One moderation row (#1907 ADMIN-W5). The actor is a USERNAME or a tombstone —
 * never an e-mail, a session id or any other handle — and `action` is narrowed
 * back to the contract's enum here rather than trusted from the column: the
 * table's CHECK holds the same vocabulary, so a row that cannot be classified
 * is a corrupted row and must not be rendered as one of the known actions.
 */
export function toAdminModerationEntry(row: AdminModerationActionRow): AdminModerationEntry {
  const action = adminModerationActionSchema.parse(row.action);
  return {
    id: row.id,
    action,
    reason: row.reason,
    previousValue: row.previousValue,
    nextValue: row.nextValue,
    actorId: row.actorId,
    actorUsername: row.actorUsername,
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

/**
 * One audit row, with its actor resolved (#1908 §3).
 *
 * The three `actorKind` values answer a question the console could not answer
 * before: a NULL `actor_id` used to render as the single word "system" whether
 * it was an anonymous failed login, a server-initiated write, or the SHELL
 * break-glass 2FA reset — the highest-privilege event the product has.
 *
 *  - `account` is the resolved join, and it OUTRANKS the marker. `actor_id` is
 *    a foreign key the server set; `meta.via` is a string inside a free-form
 *    payload. A row carrying both did not come from the shell script (which has
 *    no session and always writes a null actor), so labelling it `shell` would
 *    have named the wrong provenance for an action a real operator took. The
 *    break-glass PRESET and the banner count are unaffected either way: both
 *    filter on `action` + `meta.via` in the repository and never on this field,
 *    so nothing can be hidden from them by an actor id.
 *  - `shell` is a FACT about an UNATTRIBUTED row: `actor_id` is null and the
 *    break-glass script stamped `meta.via`. Nothing else writes that marker.
 *  - `unattributed` is the honest remainder. `ON DELETE SET NULL` destroys the
 *    evidence that would separate "no human actor" from "the account that acted
 *    has since been deleted", so this projection does NOT guess between them —
 *    the copy says the row is no longer resolvable instead of asserting a
 *    deletion that nothing in the row records.
 *
 * The e-mail is not in the row shape at all, so no caller can ship it by
 * accident: the repository never selects it (§6.12).
 */
export function toAuditEntry(row: AuditEntryRow): AuditLogEntry {
  const meta = row.meta ?? null;
  const viaBreakGlass =
    meta !== null &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).via === BREAK_GLASS_VIA;
  const actor =
    row.actorId !== null && row.actorUsername !== null && row.actorRole !== null
      ? { id: row.actorId, username: row.actorUsername, kind: row.actorRole }
      : null;
  // The column first, the payload second.
  const shell = row.actorId === null && viaBreakGlass;

  return {
    id: row.id,
    actorId: row.actorId,
    actor,
    actorKind: actor ? 'account' : shell ? 'shell' : 'unattributed',
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ip: row.ip,
    meta,
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
    // A regression, derived rather than stored (§13.5 V5-P2 is migration-free):
    // the capture reopens a resolved row on recurrence and leaves `resolved_at`
    // standing, so an open row that still carries an EARLIER resolution is one
    // an admin cleared and that came back. A manual reopen nulls it.
    regressed:
      row.status === 'open' &&
      row.resolvedAt !== null &&
      row.lastSeenAt.getTime() > row.resolvedAt.getTime(),
  };
}
