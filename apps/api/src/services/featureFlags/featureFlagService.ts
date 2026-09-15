import type { Redis } from 'ioredis';

import { z } from 'zod';

import {
  FEATURE_FLAG_CONFIG_CHANGED,
  FEATURE_FLAG_CONFIG_UNREADABLE,
  FEATURE_FLAG_KEYS,
  featureFlagConfigSchema,
  featureFlagStoredConfigSchema,
  type AdminFeatureFlag,
  type FeatureFlagConfig,
  type FeatureFlagKey,
  type FeatureFlagsPublic,
  type FeatureFlagStoredRead,
  type UpdateFeatureFlagRequest,
} from '@bettertrack/contracts';

import type { AppSettingsRepository } from '../../data/repositories/appSettingsRepository';
import { ApiError } from '../../errors';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  resolveFeatureFlag,
  SYSTEM_PRINCIPAL,
  type FeatureFlagPrincipal,
} from './featureFlagResolution';

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
 *
 * Since #1910 the stored value is a CONFIG object (`enabled` + rollout
 * targeting), not a bare boolean, and resolution takes a principal. Two rules
 * hold the seam together:
 *
 *  - **Read stays backward compatible.** Every row written before #1910 is a
 *    bare `boolean`; {@link createFeatureFlagService} keeps accepting one as
 *    `{ enabled: <bool> }`. `jsonb` widens with no migration, so there is none.
 *  - **The cache holds CONFIGURATION, never a resolved answer.** Caching the
 *    resolved map would serve one user's rollout decision to another — the same
 *    class of bug as a shared HTTP cache on the principal-dependent bootstrap.
 *    Resolution happens per request, in memory, off the snapshot.
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

/**
 * Error code a PATCH returns when the stored row cannot be read and the patch
 * would have to INVENT the fields it omits (#1910 review B1). See `setFlag`.
 *
 * Defined in the contract package since #1950 — the console matches on it to
 * render the repair instruction — and re-exported here so this service stays the
 * obvious place to find it.
 */
export { FEATURE_FLAG_CONFIG_UNREADABLE };

/**
 * Error code a PATCH returns when the `repair` precondition it asserted no
 * longer describes the row (#1950 M1). Also defined in the contract package,
 * for the same reason: the console has to match on it.
 */
export { FEATURE_FLAG_CONFIG_CHANGED };

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

/** The stored configuration of every flag, always total. */
export type FeatureFlagConfigMap = Record<FeatureFlagKey, FeatureFlagConfig>;

/** A flag nobody has ever configured: on, fully rolled, no lists. */
const defaultConfig = (): FeatureFlagConfig => ({
  enabled: true,
  rolloutPercent: 100,
  allowUserIds: [],
  denyUserIds: [],
});

/** Fill every key with its default so the map is always total. */
function allDefaults(): FeatureFlagConfigMap {
  return Object.fromEntries(
    FEATURE_FLAG_KEYS.map((key) => [key, defaultConfig()]),
  ) as FeatureFlagConfigMap;
}

/**
 * How well one persisted `app_settings` value could be read.
 *
 * Four outcomes, not two, because the difference between them decides whether a
 * kill switch survives (#1910 review B1). The old code collapsed everything that
 * was not a clean parse into `null`, and every caller turned `null` into the
 * default — which is `enabled: true`. A row that plainly said `enabled: false`
 * therefore served the feature, showed the operator a healthy row, and let the
 * next patch write that invention back as fact.
 */
type StoredConfigRead =
  | { status: 'unset' }
  /** Every field understood — the legacy boolean, or the object form. */
  | { status: 'parsed'; config: FeatureFlagConfig }
  /** `enabled` was readable and honoured; the targeting fields were not. */
  | { status: 'salvaged'; config: FeatureFlagConfig }
  /** Nothing usable in the row at all. */
  | { status: 'unreadable' };

/**
 * Collapse the read outcome to what the admin console is told (#1950).
 *
 * `unset` folds into `parsed` on purpose: the console's use for this value is
 * "does this row need repairing", and a row nobody has ever written does not —
 * the defaults it shows are the defaults that are being served, with nothing on
 * disk contradicting them. The two degraded outcomes stay distinct because they
 * are differently bad: a salvaged row still has a kill switch that was actually
 * read, an unreadable one has nothing.
 */
function reportedRead(read: StoredConfigRead): FeatureFlagStoredRead {
  return read.status === 'unset' ? 'parsed' : read.status;
}

/**
 * Read one persisted `app_settings` value, honouring as much of it as can be
 * understood and never more.
 *
 * The layers, in order:
 *
 *  1. **A bare `boolean`** — the pre-#1910 shape, legal forever. Every row
 *     written before that change is one, and there is no migration to rewrite
 *     them (nor should there be: a jsonb column needs none, and a data migration
 *     over kill switches is risk with no payoff).
 *  2. **The stored object shape**, which is deliberately not `.strict()` — an
 *     unknown key is stripped, so a row written by a LATER version still yields
 *     all four fields truthfully instead of reading as garbage.
 *  3. **Salvage `enabled`** when only the targeting fields are unreadable. The
 *     kill switch is the field whose loss is dangerous; a garbled
 *     `rolloutPercent` is not a kill, and failing it closed would take a working
 *     feature down over a cosmetic field. So the switch is honoured and the
 *     rollout falls back to "fully rolled".
 *  4. **Unreadable.** There is no `enabled` to honour, so there is no kill to
 *     preserve — the caller uses the default, exactly as for a missing row, and
 *     says so in the log rather than leaving it to be inferred.
 */
function readStoredConfig(value: unknown): StoredConfigRead {
  if (value === undefined || value === null) return { status: 'unset' };
  if (typeof value === 'boolean') {
    return { status: 'parsed', config: { ...defaultConfig(), enabled: value } };
  }
  const parsed = featureFlagStoredConfigSchema.safeParse(value);
  if (parsed.success) return { status: 'parsed', config: parsed.data };
  const enabled = (value as { enabled?: unknown }).enabled;
  if (typeof enabled === 'boolean') {
    return { status: 'salvaged', config: { ...defaultConfig(), enabled } };
  }
  return { status: 'unreadable' };
}

/** The snapshot envelope: the generation it was computed under + the configs. */
const snapshotSchema = z
  .object({
    generation: z.string(),
    config: z.object(
      Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, featureFlagConfigSchema])) as Record<
        FeatureFlagKey,
        typeof featureFlagConfigSchema
      >,
    ),
  })
  .strict();

/** What the audit row records about a config — counts, never the ids (#1910 §4). */
function auditableConfig(config: FeatureFlagConfig): {
  enabled: boolean;
  rolloutPercent: number;
  allowCount: number;
  denyCount: number;
} {
  return {
    enabled: config.enabled,
    rolloutPercent: config.rolloutPercent,
    // LENGTHS, never contents. An audit row is retained for `BT_AUDIT_RETENTION_DAYS`
    // (400 by default); durably copying a list of account ids into it every time an
    // operator nudges a rollout would turn the security log into a second, unmanaged
    // store of exactly the identifiers the public bootstrap is forbidden to leak.
    allowCount: config.allowUserIds.length,
    denyCount: config.denyUserIds.length,
  };
}

export interface FeatureFlagServiceDeps {
  repo: AppSettingsRepository;
  redis: Redis;
  audit: AuditService;
  logger: Logger;
}

/**
 * A resolution function bound to ONE configuration read. Pure and synchronous,
 * so a caller holding many principals (the socket sweep) resolves them all
 * without further I/O.
 */
export type FeatureFlagResolver = (key: FeatureFlagKey, principal: FeatureFlagPrincipal) => boolean;

export interface FeatureFlagActor {
  id: string;
  ip?: string | null;
}

export function createFeatureFlagService(deps: FeatureFlagServiceDeps) {
  const { repo, redis, audit, logger } = deps;

  /**
   * Complain about a row that could not be fully read — once per read, at the
   * site that read it. A degraded kill switch has to be VISIBLE rather than
   * inferred from a feature quietly behaving oddly.
   *
   * This log is the signal for every read path that has no operator in front of
   * it (the bootstrap, the route guards, the realtime sweep). The ADMIN list
   * additionally reports the outcome in its response (#1950): the log alone left
   * the one surface that can actually repair the row drawing it as healthy, so
   * the operator met the damage as a 409 on a write instead of as a state they
   * could see. The marker is scoped to the admin console — it is an operational
   * fact for the person holding the switch, and it still does not leak into the
   * SPA bootstrap, which stays booleans only.
   */
  function reportDegraded(key: FeatureFlagKey, read: StoredConfigRead, where: string): void {
    if (read.status === 'salvaged') {
      logger.error(
        { key, where },
        'feature-flag row: targeting unreadable — honouring `enabled`, defaulting the rollout',
      );
      return;
    }
    if (read.status === 'unreadable') {
      logger.error(
        { key, where },
        'feature-flag row: unreadable — falling back to the default (feature ON)',
      );
    }
  }

  /** Read the persisted rows and resolve to a total config map (unset ⇒ default). */
  async function loadFromStore(): Promise<FeatureFlagConfigMap> {
    const rows = await repo.getAll();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const config = allDefaults();
    for (const key of FEATURE_FLAG_KEYS) {
      const read = readStoredConfig(byKey.get(settingKey(key))?.value);
      reportDegraded(key, read, 'loadFromStore');
      if (read.status === 'parsed' || read.status === 'salvaged') config[key] = read.config;
    }
    return config;
  }

  /**
   * Read a cached snapshot, ACCEPTING it only when it was computed under the
   * generation that is still current. A malformed, legacy (pre-#1910 resolved-
   * boolean) or superseded snapshot reads as a miss and is recomputed rather
   * than trusted — which is also how a rolling deploy past #1910 is safe: the
   * old shape simply never parses, so no instance can resolve a principal
   * against an answer some other instance already resolved.
   */
  function readSnapshot(cached: string | null, generation: string): FeatureFlagConfigMap | null {
    if (!cached) return null;
    const parsed = snapshotSchema.safeParse(JSON.parse(cached));
    if (!parsed.success || parsed.data.generation !== generation) return null;
    return parsed.data.config as FeatureFlagConfigMap;
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
  async function getEffectiveConfig(): Promise<FeatureFlagConfigMap> {
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

    const config = await loadFromStore();
    // With no generation in hand there is nothing to stamp, so caching would
    // mean caching unconditionally — the very thing a flip cannot outrun.
    if (!generationKnown) return config;
    try {
      await redis.set(
        FEATURE_FLAG_CACHE_KEY,
        JSON.stringify({ generation, config }),
        'EX',
        FEATURE_FLAG_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      logger.warn({ err }, 'feature-flag cache write failed');
    }
    return config;
  }

  /**
   * One configuration read, then as many principals as the caller likes —
   * resolved in memory, with no further I/O.
   *
   * This is what keeps the realtime sweep honest. The sweep visits every
   * connected socket and each socket has its own principal now; calling
   * {@link isEnabled} per socket would turn "one flag read per sweep" into one
   * Redis round trip per socket per sweep, which is a real regression on the
   * exact path an incident makes hot. The handshake takes a resolver too, so its
   * pre-auth kill-switch check and its post-auth rollout check share one read.
   */
  async function resolver(): Promise<FeatureFlagResolver> {
    const config = await getEffectiveConfig();
    return (key, principal) => resolveFeatureFlag(config[key], key, principal);
  }

  /**
   * Resolve one flag for one principal. The principal is REQUIRED: an optional
   * one would let a call site keep the pre-#1910 signature and silently pick a
   * semantic, and the four call sites this replaced each need a different one.
   * Pass `ANONYMOUS_PRINCIPAL` for an unidentified caller and use
   * {@link isEnabledGlobally} for a server-side gate that has no principal.
   */
  async function isEnabled(key: FeatureFlagKey, principal: FeatureFlagPrincipal): Promise<boolean> {
    const config = await getEffectiveConfig();
    return resolveFeatureFlag(config[key], key, principal);
  }

  /**
   * The BASE kill switch, ignoring every rollout axis — for the gates that have
   * no principal to resolve against and must not invent one: a scheduled job's
   * producer shed, and the pre-authentication socket handshake.
   *
   * Named rather than an omitted argument on purpose (#1910 §2). A job that read
   * `isEnabled(key)` with a defaulted principal would silently shed at whatever
   * the default resolved to — a 10 % rollout would quietly run the nightly sweep
   * for a tenth of the accounts, or none, with nothing at the call site saying so.
   */
  function isEnabledGlobally(key: FeatureFlagKey): Promise<boolean> {
    return isEnabled(key, SYSTEM_PRINCIPAL);
  }

  /** The whole advertised map for one principal — the SPA bootstrap's read. */
  async function resolveAll(principal: FeatureFlagPrincipal): Promise<FeatureFlagsPublic> {
    const config = await getEffectiveConfig();
    return Object.fromEntries(
      FEATURE_FLAG_KEYS.map((key) => [key, resolveFeatureFlag(config[key], key, principal)]),
    ) as FeatureFlagsPublic;
  }

  /**
   * The admin registry view: every flag, in canonical order, with its full
   * configuration and metadata. Read from the STORE, not the snapshot: the
   * console is the surface an operator checks after a flip, so it answers from
   * the durable row rather than from a cache that a failed propagation may have
   * left behind.
   *
   * The two id lists ride this response — the console has to render them to be
   * editable — and it is fenced by `requireAdmin` + admin 2FA. That is exactly
   * the line the public bootstrap must not cross.
   *
   * Each row also carries HOW WELL it could be read (#1950). A row the reader had
   * to fall back on reports the same defaults as a healthy one, so without this
   * the console cannot tell "fully rolled" from "we could not read this and are
   * showing you fully rolled" — and the operator discovers the difference only by
   * attempting a write and collecting {@link FEATURE_FLAG_CONFIG_UNREADABLE}.
   */
  async function listForAdmin(): Promise<AdminFeatureFlag[]> {
    const rows = await repo.getAll();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return FEATURE_FLAG_KEYS.map((key) => {
      const row = byKey.get(settingKey(key));
      const read = readStoredConfig(row?.value);
      reportDegraded(key, read, 'listForAdmin');
      const config =
        read.status === 'parsed' || read.status === 'salvaged' ? read.config : defaultConfig();
      return {
        key,
        enabled: config.enabled,
        rolloutPercent: config.rolloutPercent,
        allowUserIds: config.allowUserIds,
        denyUserIds: config.denyUserIds,
        // Whether the four fields above are the stored row or a fallback for it.
        // Serving this is what lets the console mark the row and route the
        // operator to the one write it will accept — a COMPLETE replacement.
        stored: reportedRead(read),
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
    patch: UpdateFeatureFlagRequest,
    actor: FeatureFlagActor,
  ): Promise<AdminFeatureFlag[]> {
    // Read-modify-write against the STORE, so a patch merges onto the durable
    // row rather than onto whatever a snapshot happened to hold. Two things ride
    // on reading `before` here:
    //
    //  - The PATCH semantics (#1910): every field is optional, so flipping the
    //    kill switch must not silently reset a rollout an operator spent the
    //    afternoon widening, and widening a rollout must not resurrect a killed
    //    feature.
    //  - The audit's before/after (#1908 §4): a kill switch's history is the
    //    whole point of auditing it — "alerts was already off" and "alerts was
    //    just turned off" are different incidents and used to record
    //    identically.
    const row = await repo.get(settingKey(key));
    const read = readStoredConfig(row?.value);
    reportDegraded(key, read, 'setFlag');

    // PRECONDITION FIRST (#1950 M1). `repair` asserts the degraded state the
    // caller was looking at when it built this body. A complete replacement is
    // the one write that inherits nothing — which is what repairs an unreadable
    // row, and equally what makes it a blind overwrite if the row is no longer
    // the one that was seen. A console fetches its list on mount, so the stale
    // tab is not hypothetical: it offers a repair for a row a colleague has
    // since fixed and killed, and applying it would revert that kill with a 200.
    //
    // Checked before completeness so the caller hears the true reason: "the row
    // moved" is a different instruction from "send more fields", and telling an
    // operator to resend a body that will be refused again is worse than useless.
    if (patch.repair !== undefined && patch.repair !== read.status) {
      throw new ApiError(
        409,
        FEATURE_FLAG_CONFIG_CHANGED,
        `The stored configuration for '${key}' is no longer '${patch.repair}', so the replacement was written against a view of the row that is out of date. Reload the flag list and repeat the change against what it says now.`,
        { stored: reportedRead(read) },
      );
    }

    // A PATCH inherits every field it omits, so merging onto a row we could not
    // fully read means INVENTING those fields and then writing the invention
    // back as durable fact — with `enabled` that invention is the kill switch
    // itself (#1910 review B1). A write is never guessed: the patch is refused
    // unless it supplies the complete configuration, which inherits nothing.
    // That refusal is also the operator's repair path, and the message says so.
    //
    // Completeness alone is not consent (#1950 M1): a body that states all four
    // fields but asserts nothing about what it is replacing cannot be told apart
    // from a client that never looked at the row, so the degraded path demands
    // `repair` as well. `details.stored` carries which half is unreadable, so the
    // console can name it instead of guessing.
    const degraded = read.status === 'salvaged' || read.status === 'unreadable';
    const complete =
      patch.enabled !== undefined &&
      patch.rolloutPercent !== undefined &&
      patch.allowUserIds !== undefined &&
      patch.denyUserIds !== undefined;
    if (degraded && (!complete || patch.repair === undefined)) {
      throw new ApiError(
        409,
        FEATURE_FLAG_CONFIG_UNREADABLE,
        `The stored configuration for '${key}' cannot be read, so a partial change would have to invent the fields it does not set. Send the complete configuration (enabled, rolloutPercent, allowUserIds, denyUserIds) together with repair: '${read.status}' to replace it.`,
        { stored: read.status },
      );
    }

    // An UNSET row (no write has ever happened) and an unreadable one both fall
    // back to the default, which is what a fresh install serves.
    const before =
      read.status === 'parsed' || read.status === 'salvaged' ? read.config : defaultConfig();
    const after: FeatureFlagConfig = {
      enabled: patch.enabled ?? before.enabled,
      rolloutPercent: patch.rolloutPercent ?? before.rolloutPercent,
      allowUserIds: patch.allowUserIds ?? before.allowUserIds,
      denyUserIds: patch.denyUserIds ?? before.denyUserIds,
    };
    // ROLLBACK SAFETY (#1910 review H1). Code from before this wave reads a row
    // with `typeof value === 'boolean'` and falls back to "every flag ON" for
    // anything else, so a deploy rolled BACK past #1910 would read every object
    // row as unset and resurrect every killed feature. An untargeted flag has
    // nothing the boolean cannot express, so it keeps the legacy SHAPE: only a
    // genuinely targeted flag costs the object form, and only that one is at
    // risk — a much smaller blast radius than "every switch in the estate".
    const targeted =
      after.rolloutPercent !== 100 || after.allowUserIds.length > 0 || after.denyUserIds.length > 0;
    await repo.upsert(settingKey(key), targeted ? after : after.enabled, actor.id);
    const propagated = await invalidateSnapshot();
    // `targetId` is a uuid column — the flag key rides in `meta`, not there.
    await audit.record({
      actorId: actor.id,
      action: AuditAction.FeatureFlagChanged,
      targetType: 'feature_flag',
      ip: actor.ip ?? null,
      meta: {
        key,
        // Kept at the top level: the pre-#1910 readers of this row (and the
        // console's own history view) look for `enabled` here.
        enabled: after.enabled,
        propagated,
        // How much of `before` was actually READ, rather than fallen back to
        // (#1950 M2). On an unreadable row `before` is unavoidably the default,
        // and a log that stops there claims the feature was ON beforehand —
        // a statement about the estate nobody verified. This is the field that
        // separates "it was on" from "we could not tell, and showed on".
        //
        // The RAW outcome, including `unset`, not the value the console is
        // served: the list collapses `unset` into `parsed` because neither needs
        // repairing, but "nobody had ever configured this" and "it was
        // configured and readable" are different histories, and the audit is
        // where that difference gets asked for. An enum, no ids — the rule
        // `auditableConfig` follows.
        storedBefore: read.status,
        // #1908's before/after, widened to the whole config by #1910 — with the
        // two id lists reduced to LENGTHS. See `auditableConfig`.
        before: auditableConfig(before),
        after: auditableConfig(after),
      },
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

  return {
    getEffectiveConfig,
    resolver,
    isEnabled,
    isEnabledGlobally,
    resolveAll,
    listForAdmin,
    setFlag,
  };
}

export type FeatureFlagService = ReturnType<typeof createFeatureFlagService>;
