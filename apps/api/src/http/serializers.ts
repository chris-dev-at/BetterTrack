import type {
  AdminInvite,
  AdminUser,
  AuditLogEntry,
  ConglomerateDetail,
  MeResponse,
  WorkboardItem,
} from '@bettertrack/contracts';

import type { ConglomerateDetailRow } from '../data/repositories/conglomerateRepository';
import type { WorkboardItemWithAsset } from '../data/repositories/workboardRepository';
import type { AuditLogRow, InviteRow, UserRow } from '../data/schema';
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

export function toConglomerateDetail(row: ConglomerateDetailRow): ConglomerateDetail {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    updatedAt: toIsoRequired(row.updatedAt),
    positions: row.positions.map((position) => ({
      id: position.id,
      assetId: position.assetId,
      weightPct: Number(position.weightPct),
      sortOrder: position.sortOrder,
      asset: {
        id: position.asset.id,
        providerId: position.asset.providerId,
        providerRef: position.asset.providerRef,
        symbol: position.asset.symbol,
        name: position.asset.name,
        exchange: position.asset.exchange ?? null,
        currency: position.asset.currency,
        type: position.asset.type,
        isCustom: position.asset.ownerId !== null,
      },
    })),
  };
}
