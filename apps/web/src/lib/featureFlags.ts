import { useQuery } from '@tanstack/react-query';

import {
  DEPLOY_CAPABILITY_KEYS,
  FEATURE_FLAG_KEYS,
  featureFlagsResponseSchema,
  type DeployCapabilities,
  type DeployCapabilityKey,
  type FeatureFlagKey,
  type FeatureFlagsPublic,
  type FeatureFlagsResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Runtime feature kill-switches (PROJECTPLAN.md §13.5 V5-P2 arc (c)) and the
 * deployment's fixed capabilities (§13.5 V5-P5), both read from the one
 * `/feature-flags` bootstrap. The SPA hides any killed or unconfigured surface —
 * the client mirror of the server-side `requireFeature` guard and of the intel
 * reads' `available: false`. The server stays the real boundary.
 */
export const ALL_FEATURES_ON: FeatureFlagsPublic = Object.fromEntries(
  FEATURE_FLAG_KEYS.map((key) => [key, true]),
) as FeatureFlagsPublic;

/**
 * What an *unresolved* capability means: not present. A capability is a
 * statement about what this deployment physically HAS (deploy-time env, never
 * admin-toggled), so "no answer yet" is no evidence of presence — asserting one
 * on no evidence advertises destinations the server will refuse, and once
 * react-query has exhausted its retries that advertisement is permanent, not a
 * blink. Absent-until-known also removes the flash: a gated rail tab, ⌘K entry
 * or catalog widget appears when the bootstrap says so and never before, so a
 * healthy load reveals it once instead of showing then retracting it.
 */
export const NO_CAPABILITIES: DeployCapabilities = Object.fromEntries(
  DEPLOY_CAPABILITY_KEYS.map((key) => [key, false]),
) as DeployCapabilities;

/**
 * The two halves deliberately fall back in opposite directions.
 *
 * `flags` fail OPEN: they are admin-toggled runtime kill-switches over features
 * the deployment does have, defaulting to on server-side, so hiding them during
 * a fetch blip would blank working surfaces for no gain — and the server refuses
 * anything actually killed.
 *
 * `capabilities` fail CLOSED, per `NO_CAPABILITIES` above.
 */
const BOOTSTRAP_FALLBACK: FeatureFlagsResponse = {
  flags: ALL_FEATURES_ON,
  capabilities: NO_CAPABILITIES,
};

/**
 * The bootstrap's cache key, exported so the ONE place that must drop it —
 * `AuthContext.applyUser`, the single door into a session user — cannot drift
 * from the query that reads it.
 */
export const FEATURE_FLAGS_QUERY_KEY = ['feature-flags'] as const;

export async function getFeatureFlags(signal?: AbortSignal): Promise<FeatureFlagsResponse> {
  const data = await apiRequest<unknown>('/feature-flags', { signal });
  return featureFlagsResponseSchema.parse(data);
}

/**
 * The bootstrap envelope, refetched on the standard cadence so a flip lands soon.
 *
 * Since #1910 this answer is PRINCIPAL-DEPENDENT: a flag can be rolled out to a
 * percentage of accounts or to a named list, so the map an anonymous visitor
 * reads before logging in is not the map their account gets. The server marks
 * the response `no-store` so no shared cache can mix two principals' answers;
 * this query is the client half of that, and `applyUser` invalidates it the
 * moment a session user is adopted. Without that, a partially-rolled feature
 * would stay hidden for a whole `staleTime` after login — the SPA would hide a
 * surface the API is perfectly willing to serve.
 */
function useFeatureFlagsBootstrap(): FeatureFlagsResponse {
  const { data } = useQuery({
    queryKey: FEATURE_FLAGS_QUERY_KEY,
    queryFn: ({ signal }) => getFeatureFlags(signal),
    staleTime: 60_000,
  });
  return data ?? BOOTSTRAP_FALLBACK;
}

/** The effective runtime flags (admin-toggled). */
export function useFeatureFlags(): FeatureFlagsPublic {
  return useFeatureFlagsBootstrap().flags;
}

/** True when the given feature is enabled (or its state is not yet known). */
export function useFeatureEnabled(key: FeatureFlagKey): boolean {
  return useFeatureFlags()[key];
}

/**
 * This deployment's fixed capabilities (env-set, never admin-toggled). All
 * false until the bootstrap resolves — see `NO_CAPABILITIES`.
 */
export function useDeployCapabilities(): DeployCapabilities {
  return useFeatureFlagsBootstrap().capabilities;
}

/** True when this deployment is KNOWN to have the given capability. */
export function useDeployCapability(key: DeployCapabilityKey): boolean {
  return useDeployCapabilities()[key];
}
