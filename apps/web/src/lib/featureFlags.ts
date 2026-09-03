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
 * reads' `available: false`. Defaults to everything ON (matching the server
 * defaults), so a slow/failed fetch never blanks the app; the server stays the
 * real boundary.
 */
export const ALL_FEATURES_ON: FeatureFlagsPublic = Object.fromEntries(
  FEATURE_FLAG_KEYS.map((key) => [key, true]),
) as FeatureFlagsPublic;

export const ALL_CAPABILITIES_ON: DeployCapabilities = Object.fromEntries(
  DEPLOY_CAPABILITY_KEYS.map((key) => [key, true]),
) as DeployCapabilities;

const BOOTSTRAP_FALLBACK: FeatureFlagsResponse = {
  flags: ALL_FEATURES_ON,
  capabilities: ALL_CAPABILITIES_ON,
};

export async function getFeatureFlags(signal?: AbortSignal): Promise<FeatureFlagsResponse> {
  const data = await apiRequest<unknown>('/feature-flags', { signal });
  return featureFlagsResponseSchema.parse(data);
}

/** The bootstrap envelope, refetched on the standard cadence so a flip lands soon. */
function useFeatureFlagsBootstrap(): FeatureFlagsResponse {
  const { data } = useQuery({
    queryKey: ['feature-flags'],
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

/** This deployment's fixed capabilities (env-set, never admin-toggled). */
export function useDeployCapabilities(): DeployCapabilities {
  return useFeatureFlagsBootstrap().capabilities;
}

/** True when this deployment has the given capability (or it is not yet known). */
export function useDeployCapability(key: DeployCapabilityKey): boolean {
  return useDeployCapabilities()[key];
}
