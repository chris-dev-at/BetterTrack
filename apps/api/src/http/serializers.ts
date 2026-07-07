import type {
  AdminInvite,
  AdminUser,
  Alert,
  AppSettingsResponse,
  AuditLogEntry,
  EmailLogEntry,
  MeResponse,
  WorkboardItem,
} from '@bettertrack/contracts';

import type { AlertRecord } from '../data/repositories/alertRepository';
import type { WorkboardItemWithAsset } from '../data/repositories/workboardRepository';
import type { AuditLogRow, EmailLogRow, InviteRow, UserRow } from '../data/schema';
import type { AppSettings } from '../services/appSettings/appSettingsService';
import type { AuthUser } from './types';

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const toIsoRequired = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

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

export function toWorkboardItem(item: WorkboardItemWithAsset): WorkboardItem {
  return {
    id: item.id,
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
