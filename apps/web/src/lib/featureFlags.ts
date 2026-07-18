import { useQuery } from '@tanstack/react-query';

import {
  FEATURE_FLAG_KEYS,
  featureFlagsResponseSchema,
  type FeatureFlagKey,
  type FeatureFlagsPublic,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Runtime feature kill-switches (PROJECTPLAN.md §13.5 V5-P2 arc (c)). The SPA
 * reads the effective flags the API advertises and hides any killed surface —
 * the client mirror of the server-side `requireFeature` guard. Defaults to
 * every feature ON (matching the server default), so a slow/failed fetch never
 * blanks the app; the server guard is the real boundary.
 */
export const ALL_FEATURES_ON: FeatureFlagsPublic = Object.fromEntries(
  FEATURE_FLAG_KEYS.map((key) => [key, true]),
) as FeatureFlagsPublic;

export async function getFeatureFlags(signal?: AbortSignal): Promise<FeatureFlagsPublic> {
  const data = await apiRequest<unknown>('/feature-flags', { signal });
  return featureFlagsResponseSchema.parse(data).flags;
}

/** The effective flags, refetched on the standard cadence so a flip lands soon. */
export function useFeatureFlags(): FeatureFlagsPublic {
  const { data } = useQuery({
    queryKey: ['feature-flags'],
    queryFn: ({ signal }) => getFeatureFlags(signal),
    staleTime: 60_000,
  });
  return data ?? ALL_FEATURES_ON;
}

/** True when the given feature is enabled (or its state is not yet known). */
export function useFeatureEnabled(key: FeatureFlagKey): boolean {
  return useFeatureFlags()[key];
}
