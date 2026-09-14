import type { Redis } from 'ioredis';

import {
  FEATURE_FLAG_KEYS,
  featureFlagsPublicSchema,
  type AdminFeatureFlag,
  type FeatureFlagKey,
  type FeatureFlagsPublic,
} from '@bettertrack/contracts';

import type { AppSettingsRepository } from '../../data/repositories/appSettingsRepository';
import { ApiError } from '../../errors';
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

/** Redis snapshot of the effective flag map — invalidated on every write. */
export const FEATURE_FLAG_CACHE_KEY = 'feature-flags:effective';

/**
 * Monotonic snapshot generation, bumped by every flip (#1847). It is what makes
 * the kill switch race-free: the cached snapshot carries the generation it was
 * computed under, and a reader serves it ONLY while that generation is still
 * current. A cache-aside read that started before a flip therefore cannot
 * resurrect the killed value — its late write is stamped with the superseded
 * generation and every reader treats it as a miss.
 *
 * Deliberately without a TTL: it must outlive the snapshots that reference it.
 * It is a single small counter, and a lost one degrades to "every snapshot is
 * stale", never to "a stale snapshot is served".
 */
export const FEATURE_FLAG_GENERATION_KEY = 'feature-flags:generation';

/** Generation of a snapshot written before any flip was ever recorded. */
const NO_GENERATION = '0';

/** Snapshot TTL: a backstop so a lost snapshot self-heals; writes invalidate directly. */
export const FEATURE_FLAG_CACHE_TTL_SECONDS = 60;

/**
 * Error code a flip returns when the snapshot could not be dropped OR rewritten
 * (§13.5 V5-P2 arc (c), #1744). The value IS persisted; what is unknown is
 * whether the running instances have picked it up yet.
 */
export const FEATURE_FLAG_PROPAGATION_UNCONFIRMED = 'FEATURE_FLAG_PROPAGATION_UNCONFIRMED';

/** Stable English metadata per flag — API/audit only; the SPA renders i18n. */
export const FEATURE_FLAG_REGISTRY: Record<FeatureFlagKey, { description: string }> = {
  realtime: { description: 'Realtime updates (Socket.IO live push).' },
  liveMode: { description: 'Live Mode intraday asset streaming.' },
  chat: { description: 'Friend chat / direct messages.' },
  alerts: { description: 'Price alerts.' },
  imports: { description: 'Broker CSV imports.' },
  ai: {
    description: 'AI portfolio insights & the natural-language Blueprint builder (local provider).',
  },
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
   * Read a cached snapshot, ACCEPTING it only when it was computed under the
   * generation that is still current. A malformed, legacy (bare-map) or
   * superseded snapshot reads as a miss and is recomputed rather than trusted.
   */
  function readSnapshot(cached: string | null, generation: string): FeatureFlagsPublic | null {
    if (!cached) return null;
    const envelope: unknown = JSON.parse(cached);
    if (typeof envelope !== 'object' || envelope === null) return null;
    const { generation: stamped, flags } = envelope as { generation?: unknown; flags?: unknown };
    if (typeof stamped !== 'string' || stamped !== generation) return null;
    const parsed = featureFlagsPublicSchema.safeParse(flags);
    return parsed.success ? parsed.data : null;
  }

  /**
   * The per-request read (chip-cheap): a single Redis MGET when warm, else one
   * store read cached under {@link FEATURE_FLAG_CACHE_KEY}.
   *
   * The generation is read BEFORE the store, and the snapshot is stamped with
   * that pre-read value (#1847). A flip landing anywhere between the two makes
   * this write self-invalidating, which is the whole point: the alternative —
   * stamping the generation as it is at write time — is exactly how a read that
   * began before the flip could republish the killed value for a full TTL.
   */
  async function getEffectiveFlags(): Promise<FeatureFlagsPublic> {
    let generation = NO_GENERATION;
    let generationKnown = false;
    try {
      const [cached, stored] = await redis.mget(
        FEATURE_FLAG_CACHE_KEY,
        FEATURE_FLAG_GENERATION_KEY,
      );
      generation = stored ?? NO_GENERATION;
      generationKnown = true;
      const snapshot = readSnapshot(cached ?? null, generation);
      if (snapshot) return snapshot;
    } catch (err) {
      // A cache miss must never take the app down — fall through to the store.
      logger.warn({ err }, 'feature-flag cache read failed');
    }

    const flags = await loadFromStore();
    // With no generation in hand there is nothing to stamp, so caching would
    // mean caching unconditionally — the very thing a flip cannot outrun.
    if (!generationKnown) return flags;
    try {
      await redis.set(
        FEATURE_FLAG_CACHE_KEY,
        JSON.stringify({ generation, flags }),
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
   * Invalidate the shared snapshot so the next read recomputes from the store.
   *
   * The BUMP is the invalidation (#1847): once the generation has moved, every
   * snapshot computed under the old one — including one an in-flight read has
   * not written yet — reads as a miss, so no racing reader can put the killed
   * value back. The DEL that follows is housekeeping (it saves the next reader a
   * store round trip); its failure is a warning, not an unpropagated flip.
   *
   * This deliberately replaces the old "DEL, else rewrite the snapshot" pair:
   * BOTH of those could be undone a millisecond later by a read that started
   * before the flip, so reporting either as propagation was a promise the code
   * could not keep. Returns false only when the bump itself fails — the one
   * outcome after which the flip really may not have taken effect.
   */
  async function invalidateSnapshot(): Promise<boolean> {
    try {
      await redis.incr(FEATURE_FLAG_GENERATION_KEY);
    } catch (err) {
      logger.error({ err }, 'feature-flag generation bump failed — flip may not have propagated');
      return false;
    }
    try {
      await redis.del(FEATURE_FLAG_CACHE_KEY);
    } catch (err) {
      logger.warn({ err }, 'feature-flag snapshot delete failed — the bump already invalidated it');
    }
    return true;
  }

  /**
   * Flip one flag (audit-logged) and invalidate the snapshot so the next request
   * — HTTP or socket — reads the new value. Returns the full refreshed registry.
   *
   * Deliberately push-free: work that is ALREADY established when the flip lands
   * (a connected socket, a registered live watch) is shed by the realtime
   * gateway's existing revalidation sweep, which re-reads these flags once per
   * pass. That keeps one flip = one DEL here, with the shed bounded by
   * `REALTIME_FEATURE_SHED_MAX_DELAY_MS` instead of a new eviction fan-out.
   *
   * Propagation is NOT best-effort (#1744). A kill switch exists to stop
   * something already in progress, so "it may or may not have taken effect and
   * we won't say" is the one answer the admin must never get. Order and
   * reasoning:
   *
   *  1. persist first — the durable value is what the TTL backstop and every
   *     cold read converge on, so it must land even when Redis is unusable;
   *  2. audit always, carrying `propagated` — a flip that could not be confirmed
   *     is exactly the one worth finding in the log later;
   *  3. then, and only if the generation bump failed, throw 503. The write is
   *     kept (retrying is idempotent) and the message says so; what the error
   *     reports is the unconfirmed propagation, not a lost write. Swallowing it
   *     into a 200 — or widening the try so the failure disappears into the
   *     returned registry — would report a flip that the serving instances may
   *     keep ignoring for the full {@link FEATURE_FLAG_CACHE_TTL_SECONDS}.
   */
  async function setFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    actor: FeatureFlagActor,
  ): Promise<AdminFeatureFlag[]> {
    await repo.upsert(settingKey(key), enabled, actor.id);
    const propagated = await invalidateSnapshot();
    // `targetId` is a uuid column — the flag key rides in `meta`, not there.
    await audit.record({
      actorId: actor.id,
      action: AuditAction.FeatureFlagChanged,
      targetType: 'feature_flag',
      ip: actor.ip ?? null,
      meta: { key, enabled, propagated },
    });
    if (!propagated) {
      throw new ApiError(
        503,
        FEATURE_FLAG_PROPAGATION_UNCONFIRMED,
        `The '${key}' switch was saved, but the shared cache could not be refreshed: running instances may keep the previous value for up to ${FEATURE_FLAG_CACHE_TTL_SECONDS} seconds. Retry to confirm it has taken effect.`,
      );
    }
    return listForAdmin();
  }

  return { getEffectiveFlags, isEnabled, listForAdmin, setFlag };
}

export type FeatureFlagService = ReturnType<typeof createFeatureFlagService>;
