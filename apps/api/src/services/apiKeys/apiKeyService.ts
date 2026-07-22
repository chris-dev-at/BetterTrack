import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  API_KEY_TOKEN_PREFIX,
  type AdminApiKey,
  type ApiKeyAuditResponse,
  type ApiKeyScope,
  type ApiKeySummary,
  type ApiKeyTier,
  type CreateApiKeyResponse,
  type CreateApiKeyTierRequest,
  type UpdateApiKeyTierRequest,
} from '@bettertrack/contracts';

import type { ApiKeyRepository } from '../../data/repositories/apiKeyRepository';
import type { ApiKeyRequestLogRepository } from '../../data/repositories/apiKeyRequestLogRepository';
import type { ApiKeyTierRepository } from '../../data/repositories/apiKeyTierRepository';
import type { ApiKeyRequestLogRow, ApiKeyRow, ApiKeyTierRow, UserRow } from '../../data/schema';
import { badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import { redactString } from '../observability/scrubber';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken } from '../crypto/tokens';

/** The resolved principal behind a valid bearer token. */
export interface ApiKeyPrincipal {
  user: UserRow;
  keyId: string;
  scopes: ApiKeyScope[];
  /** Per-key rate tier (limit, window) — absent when no tier resolves. */
  rateLimit?: { limit: number; windowSec: number };
}

/** Admin actor for governance-action audit entries. */
export interface ApiKeyAdminActor {
  id: string;
  ip?: string | null;
}

export interface ApiKeyServiceDeps {
  repo: ApiKeyRepository;
  tierRepo: ApiKeyTierRepository;
  requestLogRepo: ApiKeyRequestLogRepository;
  audit: AuditService;
  redis: Redis;
  logger: Logger;
  /**
   * Config fallback allowance (§10 `rateLimits.apiKey`) used when a key has no
   * explicit tier AND no admin-marked default tier row resolves — so a personal
   * key always carries a concrete steady-state limit.
   */
  defaultRateLimit: { limit: number; windowSec: number };
}

export interface ApiKeyService {
  create(input: {
    userId: string;
    name: string;
    scopes: ApiKeyScope[];
    ip?: string | null;
  }): Promise<CreateApiKeyResponse>;
  list(userId: string): Promise<ApiKeySummary[]>;
  revoke(input: { userId: string; id: string; ip?: string | null }): Promise<void>;
  /** Bearer-auth lookup: resolve an active key by its plaintext token, else null. */
  authenticate(token: string): Promise<ApiKeyPrincipal | null>;
  /** Record a scope-denied bearer attempt (called by the enforcement middleware). */
  recordScopeDenied(input: {
    userId: string;
    keyId: string;
    requiredScope: string;
    method: string;
    path: string;
    ip?: string | null;
  }): Promise<void>;
  /**
   * Capture one bearer request into the bounded per-key request log. Best-effort
   * and PII-scrubbed — a write failure is swallowed (never affects the request).
   */
  recordRequest(input: {
    keyId: string;
    userId: string;
    method: string;
    path: string;
    status: number;
  }): Promise<void>;

  // -- Admin governance (§13.5 V5-P10, issue 2/2) --
  listTiers(): Promise<ApiKeyTier[]>;
  createTier(input: CreateApiKeyTierRequest, actor: ApiKeyAdminActor): Promise<ApiKeyTier>;
  updateTier(
    id: string,
    patch: UpdateApiKeyTierRequest,
    actor: ApiKeyAdminActor,
  ): Promise<ApiKeyTier>;
  deleteTier(id: string, actor: ApiKeyAdminActor): Promise<void>;
  listAllKeys(): Promise<AdminApiKey[]>;
  assignTier(id: string, tierId: string | null, actor: ApiKeyAdminActor): Promise<AdminApiKey>;
  keyAudit(id: string): Promise<ApiKeyAuditResponse>;
}

/** Minimum gap between `lastUsedAt` writes for one key — a throttle, not per-request. */
const LAST_USED_THROTTLE_SEC = 60;

/** How long the resolved default tier is cached in-process (admin edits propagate within this). */
const DEFAULT_TIER_CACHE_TTL_MS = 15_000;

/** Bound on the per-key audit view — the most recent lines only. */
export const API_KEY_AUDIT_LIST_LIMIT = 200;

const toSummary = (row: ApiKeyRow): ApiKeySummary => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes as ApiKeyScope[],
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
});

const toTier = (row: ApiKeyTierRow): ApiKeyTier => ({
  id: row.id,
  name: row.name,
  requestLimit: row.requestLimit,
  windowSec: row.windowSec,
  isDefault: row.isDefault,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toAdminKey = (row: ApiKeyRow & { tierName: string | null }): AdminApiKey => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  tierId: row.tierId ?? null,
  tierName: row.tierName,
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
});

const toLogEntry = (row: ApiKeyRequestLogRow): ApiKeyAuditResponse['entries'][number] => ({
  id: row.id,
  method: row.method,
  path: row.path,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

/** Mint an opaque token: recognizable prefix + 256 bits of CSPRNG entropy. */
function mintToken(): { token: string; tokenHash: string } {
  const token = `${API_KEY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashToken(token) };
}

/**
 * Personal API key service (PROJECTPLAN.md §6.13, §14, V2-P12). Issues opaque
 * bearer tokens (shown once, only the hash stored), lists/revokes them, resolves
 * a token to its owning user for the bearer middleware, and audit-logs the
 * lifecycle. Scope *enforcement* lives in the HTTP middleware; this service owns
 * issuance, resolution and the audit trail.
 *
 * §13.5 V5-P10 (issue 2/2) adds key governance: admin-configurable rate tiers
 * (name/limit/window) resolved per-request onto the principal, and a bounded,
 * PII-scrubbed per-key request-log audit trail.
 */
export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const { repo, tierRepo, requestLogRepo, audit, redis, logger, defaultRateLimit } = deps;

  // In-process cache of the admin-marked default tier so a key with no explicit
  // tier resolves its limit without a DB hit on every bearer request. Admin edits
  // invalidate it directly; the TTL is a backstop for multi-process deploys.
  let defaultTierCache: { tier: ApiKeyTierRow | null; at: number } | null = null;

  async function resolveDefaultTier(): Promise<ApiKeyTierRow | null> {
    const now = Date.now();
    if (defaultTierCache && now - defaultTierCache.at < DEFAULT_TIER_CACHE_TTL_MS) {
      return defaultTierCache.tier;
    }
    const tier = (await tierRepo.getDefault()) ?? null;
    defaultTierCache = { tier, at: now };
    return tier;
  }

  const invalidateDefaultTier = (): void => {
    defaultTierCache = null;
  };

  return {
    async create({ userId, name, scopes, ip }) {
      const { token, tokenHash } = mintToken();
      const row = await repo.create({ userId, name, tokenHash, scopes });
      await audit.record({
        actorId: userId,
        action: AuditAction.ApiKeyCreated,
        targetType: 'api_key',
        targetId: row.id,
        ip: ip ?? null,
        meta: { scopes },
      });
      return { key: toSummary(row), token };
    },

    async list(userId) {
      const rows = await repo.listActiveForUser(userId);
      return rows.map(toSummary);
    },

    async revoke({ userId, id, ip }) {
      const row = await repo.revoke(userId, id);
      if (!row) {
        // Unknown id, another user's key, or already revoked — a uniform 404 so
        // key ids can't be probed across accounts.
        throw notFound('API key not found.', 'API_KEY_NOT_FOUND');
      }
      await audit.record({
        actorId: userId,
        action: AuditAction.ApiKeyRevoked,
        targetType: 'api_key',
        targetId: row.id,
        ip: ip ?? null,
      });
    },

    async authenticate(token) {
      if (!token.startsWith(API_KEY_TOKEN_PREFIX)) return null;
      const found = await repo.findActiveByTokenHash(hashToken(token));
      if (!found) return null;

      // Throttle the lastUsedAt write: only the first hit within the window
      // touches the DB, so a busy key doesn't write on every request.
      const throttleKey = `apikey:touched:${found.key.id}`;
      const first = await redis.set(throttleKey, '1', 'EX', LAST_USED_THROTTLE_SEC, 'NX');
      if (first === 'OK') {
        await repo.touchLastUsed(found.key.id, new Date());
      }

      // Resolve the per-key rate tier: the key's explicit tier, else the
      // admin-marked default tier row, else the config fallback — so a personal
      // key always carries a concrete steady-state limit.
      const tier = found.tier ?? (await resolveDefaultTier());
      const rateLimit = tier
        ? { limit: tier.requestLimit, windowSec: tier.windowSec }
        : defaultRateLimit;

      return {
        user: found.user,
        keyId: found.key.id,
        scopes: found.key.scopes as ApiKeyScope[],
        rateLimit,
      };
    },

    async recordScopeDenied({ userId, keyId, requiredScope, method, path, ip }) {
      await audit.record({
        actorId: userId,
        action: AuditAction.ApiKeyScopeDenied,
        targetType: 'api_key',
        targetId: keyId,
        ip: ip ?? null,
        meta: { requiredScope, method, path },
      });
    },

    async recordRequest({ keyId, userId, method, path, status }) {
      // Best-effort: the audit trail must NEVER add a failure mode to request
      // handling, so a write failure is caught and logged, not propagated.
      try {
        await requestLogRepo.record({
          keyId,
          userId,
          method,
          // Scrub any token/email that slipped into the path/query per the
          // observability scrubber conventions before it is persisted.
          path: redactString(path),
          status,
        });
      } catch (err) {
        logger.warn({ err, keyId }, 'api-key request-log capture failed (swallowed)');
      }
    },

    async listTiers() {
      return (await tierRepo.list()).map(toTier);
    },

    async createTier(input, actor) {
      const row = await tierRepo.create({
        name: input.name,
        requestLimit: input.requestLimit,
        windowSec: input.windowSec,
        isDefault: input.isDefault ?? false,
      });
      invalidateDefaultTier();
      await audit.record({
        actorId: actor.id,
        action: AuditAction.ApiKeyTierCreated,
        targetType: 'api_key_tier',
        targetId: row.id,
        ip: actor.ip ?? null,
        meta: { name: row.name, requestLimit: row.requestLimit, windowSec: row.windowSec },
      });
      return toTier(row);
    },

    async updateTier(id, patch, actor) {
      const row = await tierRepo.update(id, patch);
      if (!row) throw notFound('API key tier not found.', 'API_KEY_TIER_NOT_FOUND');
      invalidateDefaultTier();
      await audit.record({
        actorId: actor.id,
        action: AuditAction.ApiKeyTierUpdated,
        targetType: 'api_key_tier',
        targetId: row.id,
        ip: actor.ip ?? null,
        meta: { ...patch },
      });
      return toTier(row);
    },

    async deleteTier(id, actor) {
      const tier = await tierRepo.getById(id);
      if (!tier) throw notFound('API key tier not found.', 'API_KEY_TIER_NOT_FOUND');
      if (tier.isDefault) {
        // Never leave keys homeless: the default must be re-pointed first.
        throw badRequest('Cannot delete the default tier.', 'API_KEY_TIER_DEFAULT');
      }
      await tierRepo.delete(id);
      invalidateDefaultTier();
      await audit.record({
        actorId: actor.id,
        action: AuditAction.ApiKeyTierDeleted,
        targetType: 'api_key_tier',
        targetId: id,
        ip: actor.ip ?? null,
      });
    },

    async listAllKeys() {
      return (await repo.listAllForAdmin()).map(toAdminKey);
    },

    async assignTier(id, tierId, actor) {
      if (tierId !== null) {
        const tier = await tierRepo.getById(tierId);
        if (!tier) throw badRequest('Unknown tier.', 'API_KEY_TIER_NOT_FOUND');
      }
      const row = await repo.setTier(id, tierId);
      if (!row) throw notFound('API key not found.', 'API_KEY_NOT_FOUND');
      const [withTier] = (await repo.listAllForAdmin()).filter((k) => k.id === id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.ApiKeyTierAssigned,
        targetType: 'api_key',
        targetId: id,
        ip: actor.ip ?? null,
        meta: { tierId },
      });
      return toAdminKey(withTier ?? { ...row, tierName: null });
    },

    async keyAudit(id) {
      const key = await repo.getById(id);
      if (!key) throw notFound('API key not found.', 'API_KEY_NOT_FOUND');
      const rows = await requestLogRepo.listForKey(id, API_KEY_AUDIT_LIST_LIMIT);
      return {
        keyId: id,
        lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
        entries: rows.map(toLogEntry),
      };
    },
  };
}
