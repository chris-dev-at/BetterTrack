import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  API_KEY_TOKEN_PREFIX,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreateApiKeyResponse,
} from '@bettertrack/contracts';

import type { ApiKeyRepository } from '../../data/repositories/apiKeyRepository';
import type { ApiKeyRow, UserRow } from '../../data/schema';
import { notFound } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken } from '../crypto/tokens';

/** The resolved principal behind a valid bearer token. */
export interface ApiKeyPrincipal {
  user: UserRow;
  keyId: string;
  scopes: ApiKeyScope[];
}

export interface ApiKeyServiceDeps {
  repo: ApiKeyRepository;
  audit: AuditService;
  redis: Redis;
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
}

/** Minimum gap between `lastUsedAt` writes for one key — a throttle, not per-request. */
const LAST_USED_THROTTLE_SEC = 60;

const toSummary = (row: ApiKeyRow): ApiKeySummary => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes as ApiKeyScope[],
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
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
 */
export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const { repo, audit, redis } = deps;

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

      return {
        user: found.user,
        keyId: found.key.id,
        scopes: found.key.scopes as ApiKeyScope[],
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
  };
}
