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

/** `GET /feature-flags` — the SPA-facing effective flags envelope. */
export const featureFlagsResponseSchema = z.object({ flags: featureFlagsPublicSchema }).strict();

export type FeatureFlagsResponse = z.infer<typeof featureFlagsResponseSchema>;

/** One flag as the admin console lists it: state + change metadata. */
export const adminFeatureFlagSchema = z
  .object({
    key: featureFlagKeySchema,
    enabled: z.boolean(),
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

/** `PATCH /admin/feature-flags/:key` — body. */
export const updateFeatureFlagRequestSchema = z.object({ enabled: z.boolean() }).strict();

export type UpdateFeatureFlagRequest = z.infer<typeof updateFeatureFlagRequestSchema>;
