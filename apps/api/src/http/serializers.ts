import {
  profileIconIdSchema,
  type AdminInvite,
  type AdminUser,
  type Alert,
  type AppSettingsResponse,
  type AuditLogEntry,
  type EmailLogEntry,
  type MeResponse,
  type ProfileIconId,
  type RegistrationRequest,
  type RegistrationToken,
  type WorkboardItem,
} from '@bettertrack/contracts';

import type { AlertRecord } from '../data/repositories/alertRepository';
import type { WorkboardItemWithAsset } from '../data/repositories/workboardRepository';
import type {
  AuditLogRow,
  EmailLogRow,
  InviteRow,
  RegistrationRequestRow,
  RegistrationTokenRow,
  UserRow,
} from '../data/schema';
import type { AppSettings } from '../services/appSettings/appSettingsService';
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
    lastLoginAt: row.lastLoginAt,
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
    lastLoginAt: toIso(user.lastLoginAt),
    createdAt: toIsoRequired(user.createdAt),
  };
}

export const toMeResponseFromRow = (row: UserRow): MeResponse => toMeResponse(toAuthUser(row));

export function toAdminUser(row: UserRow): AdminUser {
  return {
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
