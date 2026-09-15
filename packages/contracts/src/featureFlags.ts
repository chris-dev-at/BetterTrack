import { z } from 'zod';

/**
 * Runtime feature kill-switches (PROJECTPLAN.md §13.5 V5-P2 arc (c)). The admin
 * flips these at runtime — read per request, no redeploy — to disable a whole
 * surface. This is the single source of truth for WHICH features are switchable;
 * the API's typed registry and the SPA's client gating both derive from it, so
 * the two can never drift.
 *
 * Distinct from the per-deploy env kill-switch for Telegram/Discord (V5-P0):
 * that is set once at deploy time; these are admin-toggled while the app runs.
 */
export const FEATURE_FLAG_KEYS = [
  'realtime',
  'liveMode',
  'chat',
  'alerts',
  'imports',
  'ai',
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export const featureFlagKeySchema = z.enum(FEATURE_FLAG_KEYS);

/**
 * The effective on/off map advertised to the SPA bootstrap so killed features
 * disappear client-side (like the deploy-level capability flags). Every key is
 * always present; default state is every feature ON.
 *
 * RESOLVED BOOLEANS ONLY (#1910). `GET /feature-flags` is served to anonymous
 * callers, so the rollout configuration — `rolloutPercent` and above all the two
 * user-id lists — must never ride along: an anonymous endpoint that publishes
 * which accounts are in an allowlist is a user-identifier leak. `.strict()` is
 * the schema half of that guarantee; `featureFlags.test.ts` asserts the other
 * half over the serialized body.
 */
export const featureFlagsPublicSchema = z
  .object(
    Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, z.boolean()])) as Record<
      FeatureFlagKey,
      z.ZodBoolean
    >,
  )
  .strict();

export type FeatureFlagsPublic = z.infer<typeof featureFlagsPublicSchema>;

/**
 * Deploy-time capabilities the SPA has to know about (§13.5 V5-P5). These are
 * NOT admin-toggled kill-switches — they are set once per deployment by env and
 * cannot change while the app runs, exactly like the per-deploy Telegram/Discord
 * switch reported by `channelsConfigurable` on the notification settings
 * response. They ride the same bootstrap read as {@link FEATURE_FLAG_KEYS} only
 * so the SPA needs one fetch, and they are deliberately kept OUT of that array:
 * adding one there would put it in the admin runtime registry, which is the
 * wrong mechanism for a deploy-level gate.
 *
 * `marketIntel` is the `MARKET_INTEL_ENABLED` gate (§13.5 V5-P5). False ⇒ every
 * intel read already reports `available: false`; advertising it here is what
 * lets the *destinations* (the Assets → News tab, its ⌘K entry) disappear too,
 * instead of leading to a page that misreports a kill-switch as "no headlines
 * yet" — "invisible when unconfigured".
 */
export const DEPLOY_CAPABILITY_KEYS = ['marketIntel'] as const;

export type DeployCapabilityKey = (typeof DEPLOY_CAPABILITY_KEYS)[number];

export const deployCapabilityKeySchema = z.enum(DEPLOY_CAPABILITY_KEYS);

export const deployCapabilitiesSchema = z
  .object(
    Object.fromEntries(DEPLOY_CAPABILITY_KEYS.map((key) => [key, z.boolean()])) as Record<
      DeployCapabilityKey,
      z.ZodBoolean
    >,
  )
  .strict();

export type DeployCapabilities = z.infer<typeof deployCapabilitiesSchema>;

/**
 * `GET /feature-flags` — the SPA-facing bootstrap envelope: the admin-toggled
 * effective flags plus this deployment's fixed capabilities.
 */
export const featureFlagsResponseSchema = z
  .object({ flags: featureFlagsPublicSchema, capabilities: deployCapabilitiesSchema })
  .strict();

export type FeatureFlagsResponse = z.infer<typeof featureFlagsResponseSchema>;

/**
 * Targeting configuration for one flag (#1910). The stored `app_settings` value
 * used to be a bare `boolean`; it is this object now, and the service still
 * accepts the bare form on READ because every row written before this change is
 * one (`{ enabled: <bool> }`).
 *
 * Precedence, in exactly this order — encoded once in the API's resolver and
 * asserted there:
 *
 *  1. `enabled === false` ⇒ OFF for everyone, **allowUserIds included**. These
 *     six flags are the product's kill switches (§6.12); a kill switch a list
 *     can override is not a kill switch.
 *  2. the principal is in `denyUserIds` ⇒ OFF (beats the allowlist and a 100 %
 *     rollout).
 *  3. the principal is in `allowUserIds` ⇒ ON regardless of `rolloutPercent`.
 *  4. otherwise the stable per-user bucket is compared against `rolloutPercent`.
 *
 * FORBIDDEN targeting axes: privacy mode, paranoid status, or any vault
 * attribute. Targeting on them would make a user's mode observable through
 * feature behaviour, against §13.5 — the id lists and the percentage are the
 * only axes, deliberately.
 */
export const FEATURE_FLAG_TARGET_LIST_MAX = 200;

const featureFlagConfigShape = {
  enabled: z.boolean(),
  /** Integer 0..100. 0 = nobody outside the allowlist, 100 = everybody. */
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  /** Always ON regardless of the percentage — unless `enabled` is false. */
  allowUserIds: z.array(z.string().uuid()).max(FEATURE_FLAG_TARGET_LIST_MAX).default([]),
  /** Always OFF; wins over everything below the kill switch. */
  denyUserIds: z.array(z.string().uuid()).max(FEATURE_FLAG_TARGET_LIST_MAX).default([]),
} as const;

/**
 * The API-boundary shape: `.strict()`, so a misspelt key is a 400 rather than a
 * silent no-op on a security-relevant gate.
 */
export const featureFlagConfigSchema = z.object(featureFlagConfigShape).strict();

/**
 * The STORAGE shape — the same four fields, deliberately **not** `.strict()`.
 *
 * Strictness belongs on the request boundary, where an unknown key is an
 * operator's typo. On the read-back path it is the opposite of safe: the stored
 * row was written by some version of this code, and the first field a later wave
 * adds would make every row the previous version wrote unparseable. For a
 * registry of KILL SWITCHES that failure mode is "every killed feature in the
 * estate turns on during a deploy" (#1910 review B1), so an unknown key is
 * stripped and the four fields we do understand are honoured.
 */
export const featureFlagStoredConfigSchema = z.object(featureFlagConfigShape);

/** Input shape (every targeting field optional) vs the normalised output shape. */
export type FeatureFlagConfigInput = z.input<typeof featureFlagConfigSchema>;
export type FeatureFlagConfig = z.output<typeof featureFlagConfigSchema>;

/**
 * Error code a PATCH is refused with when the stored row cannot be read and the
 * patch would have to INVENT the fields it omits (#1910 review B1).
 *
 * It lives in the contract rather than in the API service because BOTH sides
 * need it: the API throws it, and the console matches on it to swap the generic
 * "could not update" banner for copy that names the repair (#1950). Server error
 * envelopes are authored in English and are not locale-aware, so the CODE is the
 * only part of the refusal the SPA may render off.
 */
export const FEATURE_FLAG_CONFIG_UNREADABLE = 'FEATURE_FLAG_CONFIG_UNREADABLE';

/**
 * How well one flag's stored row could be read, as reported to the admin console
 * (#1950).
 *
 * The API already computes this to decide what it may honour; serving it is what
 * lets the console tell a healthy row from one whose displayed rollout is a
 * FALLBACK rather than what is on disk. Without it the two look identical and
 * the only way to discover the damage is to attempt a write and collect a 409.
 *
 *  - `parsed` — every field understood. An unconfigured row reports this too:
 *    "never configured" and "configured and fully understood" are the same thing
 *    to an operator, namely nothing to repair.
 *  - `salvaged` — `enabled` was readable and is honoured; the targeting fields
 *    were not, so the rollout shown is the default.
 *  - `unreadable` — nothing usable in the row, so everything shown is the
 *    default.
 *
 * Both degraded values mean the same thing operationally: only a COMPLETE
 * replacement (all four fields) can be written to that row.
 */
export const FEATURE_FLAG_STORED_READS = ['parsed', 'salvaged', 'unreadable'] as const;

export const featureFlagStoredReadSchema = z.enum(FEATURE_FLAG_STORED_READS);

export type FeatureFlagStoredRead = z.infer<typeof featureFlagStoredReadSchema>;

/** One flag as the admin console lists it: state + targeting + change metadata. */
export const adminFeatureFlagSchema = z
  .object({
    key: featureFlagKeySchema,
    enabled: z.boolean(),
    /**
     * The rollout, served TOTAL (never optional) so the console renders one
     * shape. Admin-only: the anonymous bootstrap must never carry these — see
     * {@link featureFlagsPublicSchema}, which is `.strict()` over booleans alone.
     */
    rolloutPercent: z.number().int().min(0).max(100),
    allowUserIds: z.array(z.string().uuid()),
    denyUserIds: z.array(z.string().uuid()),
    /**
     * Whether the four fields above are what is STORED or what is being fallen
     * back to. Required, not optional: an optional field would let a serving
     * instance that has not been updated read as "healthy" on a console that
     * has, which is precisely the false reassurance this reports away.
     */
    stored: featureFlagStoredReadSchema,
    /** Stable English metadata for API/audit consumers; the SPA renders i18n. */
    description: z.string(),
    updatedAt: z.string().datetime().nullable(),
    updatedBy: z.string().uuid().nullable(),
  })
  .strict();

export type AdminFeatureFlag = z.infer<typeof adminFeatureFlagSchema>;

/** `GET /admin/feature-flags` — the whole registry, in canonical key order. */
export const adminFeatureFlagsResponseSchema = z
  .object({ flags: z.array(adminFeatureFlagSchema) })
  .strict();

export type AdminFeatureFlagsResponse = z.infer<typeof adminFeatureFlagsResponseSchema>;

/** `PATCH /admin/feature-flags/:key` — path param. */
export const featureFlagKeyParamSchema = z.object({ key: featureFlagKeySchema }).strict();

export type FeatureFlagKeyParam = z.infer<typeof featureFlagKeyParamSchema>;

/**
 * `PATCH /admin/feature-flags/:key` — body. Every field is optional: the patch
 * merges onto the stored config, so flipping the kill switch does not reset a
 * rollout and editing a rollout does not touch the switch. `.strict()`, so an
 * unknown key (or a misspelt `allowUserIDs`) is a 400 rather than a silent no-op
 * on a security-relevant gate.
 */
export const updateFeatureFlagRequestSchema = z
  .object({
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    allowUserIds: z.array(z.string().uuid()).max(FEATURE_FLAG_TARGET_LIST_MAX),
    denyUserIds: z.array(z.string().uuid()).max(FEATURE_FLAG_TARGET_LIST_MAX),
  })
  .partial()
  .strict();

export type UpdateFeatureFlagRequest = z.infer<typeof updateFeatureFlagRequestSchema>;
