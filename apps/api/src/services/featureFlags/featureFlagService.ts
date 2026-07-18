import type { Redis } from 'ioredis';

import {
  FEATURE_FLAG_KEYS,
  featureFlagsPublicSchema,
  type AdminFeatureFlag,
  type FeatureFlagKey,
  type FeatureFlagsPublic,
} from '@bettertrack/contracts';

import type { AppSettingsRepository } from '../../data/repositories/appSettingsRepository';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';

/**
 * Runtime feature kill-switches (PROJECTPLAN.md §13.5 V5-P2 arc (c)). The admin
 * flips a switch and the gated surface refuses within one request cycle — no
 * redeploy. Storage rides the existing `app_settings` KV store (one boolean row
 * per flag, key = {@link FEATURE_FLAG_PREFIX}`<key>`), so no new table/migration
 * is needed; a cheap Redis snapshot makes the per-request read a single cache
 * hit, invalidated the instant an admin writes.
 *
 * Default state is every feature ON: with no stored rows the app is byte-
 * identical to a pre-flag build.
 */

/** `app_settings` key prefix for a flag row (e.g. `feature_flag_chat`). */
export const FEATURE_FLAG_PREFIX = 'feature_flag_';

/** Redis snapshot of the effective flag map — invalidated (DEL) on every write. */
export const FEATURE_FLAG_CACHE_KEY = 'feature-flags:effective';

/** Snapshot TTL: a backstop so a lost DEL self-heals; writes invalidate directly. */
export const FEATURE_FLAG_CACHE_TTL_SECONDS = 60;

/** Stable English metadata per flag — API/audit only; the SPA renders i18n. */
export const FEATURE_FLAG_REGISTRY: Record<FeatureFlagKey, { description: string }> = {
  realtime: { description: 'Realtime updates (Socket.IO live push).' },
  liveMode: { description: 'Live Mode intraday asset streaming.' },
  chat: { description: 'Friend chat / direct messages.' },
  alerts: { description: 'Price alerts.' },
  imports: { description: 'Broker CSV imports.' },
  ai: { description: 'AI insights & assistant (reserved).' },
};

const settingKey = (key: FeatureFlagKey): string => `${FEATURE_FLAG_PREFIX}${key}`;

/** Fill every key with its default (ON) so the map is always total. */
function allEnabled(): FeatureFlagsPublic {
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, true])) as FeatureFlagsPublic;
}

export interface FeatureFlagServiceDeps {
  repo: AppSettingsRepository;
  redis: Redis;
  audit: AuditService;
  logger: Logger;
}

export interface FeatureFlagActor {
  id: string;
  ip?: string | null;
}

export function createFeatureFlagService(deps: FeatureFlagServiceDeps) {
  const { repo, redis, audit, logger } = deps;

  /** Read the persisted rows and resolve to a total map (unset ⇒ ON). */
  async function loadFromStore(): Promise<FeatureFlagsPublic> {
    const rows = await repo.getAll();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const flags = allEnabled();
    for (const key of FEATURE_FLAG_KEYS) {
      const row = byKey.get(settingKey(key));
      if (typeof row?.value === 'boolean') flags[key] = row.value;
    }
    return flags;
  }

  /**
   * The per-request read (chip-cheap): a single Redis GET when warm, else one
   * store read cached under {@link FEATURE_FLAG_CACHE_KEY}. A malformed/legacy
   * snapshot is ignored and recomputed rather than trusted.
   */
  async function getEffectiveFlags(): Promise<FeatureFlagsPublic> {
    try {
      const cached = await redis.get(FEATURE_FLAG_CACHE_KEY);
      if (cached) {
        const parsed = featureFlagsPublicSchema.safeParse(JSON.parse(cached));
        if (parsed.success) return parsed.data;
      }
    } catch (err) {
      // A cache miss must never take the app down — fall through to the store.
      logger.warn({ err }, 'feature-flag cache read failed');
    }

    const flags = await loadFromStore();
    try {
      await redis.set(
        FEATURE_FLAG_CACHE_KEY,
        JSON.stringify(flags),
        'EX',
        FEATURE_FLAG_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      logger.warn({ err }, 'feature-flag cache write failed');
    }
    return flags;
  }

  async function isEnabled(key: FeatureFlagKey): Promise<boolean> {
    const flags = await getEffectiveFlags();
    return flags[key];
  }

  /** The admin registry view: every flag, in canonical order, with metadata. */
  async function listForAdmin(): Promise<AdminFeatureFlag[]> {
    const rows = await repo.getAll();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return FEATURE_FLAG_KEYS.map((key) => {
      const row = byKey.get(settingKey(key));
      return {
        key,
        enabled: typeof row?.value === 'boolean' ? row.value : true,
        description: FEATURE_FLAG_REGISTRY[key].description,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  }

  /**
   * Flip one flag (audit-logged) and invalidate the snapshot so the next request
   * — HTTP or socket — reads the new value. Returns the full refreshed registry.
   */
  async function setFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    actor: FeatureFlagActor,
  ): Promise<AdminFeatureFlag[]> {
    await repo.upsert(settingKey(key), enabled, actor.id);
    try {
      await redis.del(FEATURE_FLAG_CACHE_KEY);
    } catch (err) {
      logger.warn({ err }, 'feature-flag cache invalidation failed');
    }
    // `targetId` is a uuid column — the flag key rides in `meta`, not there.
    await audit.record({
      actorId: actor.id,
      action: AuditAction.FeatureFlagChanged,
      targetType: 'feature_flag',
      ip: actor.ip ?? null,
      meta: { key, enabled },
    });
    return listForAdmin();
  }

  return { getEffectiveFlags, isEnabled, listForAdmin, setFlag };
}

export type FeatureFlagService = ReturnType<typeof createFeatureFlagService>;
