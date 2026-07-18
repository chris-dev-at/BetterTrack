import { z } from 'zod';

/**
 * Admin **Usage Analytics** surface (PROJECTPLAN.md §13.5 V5-P2, arc (b)).
 * First-party only — DAU/WAU/MAU, feature-usage counters, top viewed assets and
 * a registration funnel, computed entirely from our own request/auth stream. No
 * third-party trackers or scripts feed this; nothing leaves the server.
 *
 * This is DISTINCT from the user-facing portfolio analytics (`analytics.ts`):
 * that surface reports one user's money; this one reports operator-facing usage
 * across the whole install.
 *
 * Shapes are defined once here so the API validates against them and the admin
 * SPA derives its types from the same source (§4.2).
 */

/**
 * The low-cardinality feature buckets a request maps to (roughly the product
 * tabs plus a few key surfaces). The capture middleware collapses every route
 * onto one of these; anything unmapped (admin, auth, health…) is not counted.
 */
export const USAGE_FEATURES = [
  'portfolio',
  'workboard',
  'assets',
  'social',
  'alerts',
  'analytics',
  'imports',
  'settings',
] as const;
export const usageFeatureSchema = z.enum(USAGE_FEATURES);
export type UsageFeature = z.infer<typeof usageFeatureSchema>;

/** Distinct active users over the trailing 1 / 7 / 30-day windows. */
export const usageActiveUsersSchema = z.object({
  daily: z.number().int().nonnegative(),
  weekly: z.number().int().nonnegative(),
  monthly: z.number().int().nonnegative(),
});
export type UsageActiveUsers = z.infer<typeof usageActiveUsersSchema>;

/** Event count for one feature over the reporting window (from the rollup). */
export const usageFeatureCounterSchema = z.object({
  feature: z.string(),
  events: z.number().int().nonnegative(),
});
export type UsageFeatureCounter = z.infer<typeof usageFeatureCounterSchema>;

/** A viewed asset and how many times it was opened over the window. */
export const usageTopAssetSchema = z.object({
  assetId: z.string(),
  views: z.number().int().nonnegative(),
});
export type UsageTopAsset = z.infer<typeof usageTopAssetSchema>;

/**
 * A registration-funnel stage. Stages are nested subsets — every later stage is
 * a subset of the earlier one — so the counts read as a real funnel:
 *  - `registered`    — all accounts
 *  - `activated`     — used the app at least once (any captured signal)
 *  - `weeklyActive`  — active in the trailing 7 days
 *  - `dailyActive`   — active in the trailing 1 day
 */
export const USAGE_FUNNEL_STAGES = [
  'registered',
  'activated',
  'weeklyActive',
  'dailyActive',
] as const;
export const usageFunnelStageSchema = z.enum(USAGE_FUNNEL_STAGES);
export type UsageFunnelStage = z.infer<typeof usageFunnelStageSchema>;

export const usageFunnelPointSchema = z.object({
  stage: usageFunnelStageSchema,
  count: z.number().int().nonnegative(),
});
export type UsageFunnelPoint = z.infer<typeof usageFunnelPointSchema>;

/** One day of the materialized activity series (from the rollup). */
export const usageDailyPointSchema = z.object({
  day: z.string(),
  events: z.number().int().nonnegative(),
  activeUsers: z.number().int().nonnegative(),
});
export type UsageDailyPoint = z.infer<typeof usageDailyPointSchema>;

/** The whole admin usage-analytics payload. */
export const usageAnalyticsResponseSchema = z.object({
  activeUsers: usageActiveUsersSchema,
  features: z.array(usageFeatureCounterSchema),
  topAssets: z.array(usageTopAssetSchema),
  funnel: z.array(usageFunnelPointSchema),
  series: z.array(usageDailyPointSchema),
  /** Window size (days) the feature counters / top assets / series cover. */
  windowDays: z.number().int().positive(),
  generatedAt: z.string().datetime(),
});
export type UsageAnalyticsResponse = z.infer<typeof usageAnalyticsResponseSchema>;
