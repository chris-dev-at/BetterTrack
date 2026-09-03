import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { DeployCapabilities, FeatureFlagsPublic } from '@bettertrack/contracts';

vi.mock('../../lib/featureFlags', () => ({
  useFeatureFlags: vi.fn(),
  useDeployCapabilities: vi.fn(),
}));

vi.mock('../vault/usePrivacyMode', () => ({
  useResolvedPrivacyMode: vi.fn(() => 'normal'),
}));

import { useDeployCapabilities, useFeatureFlags } from '../../lib/featureFlags';
import { useRailNavChildren, useSectionNavChildren } from './sectionNav';

const ALL_FLAGS_ON: FeatureFlagsPublic = {
  realtime: true,
  liveMode: true,
  chat: true,
  alerts: true,
  imports: true,
  ai: true,
};

function setCapabilities(capabilities: DeployCapabilities) {
  vi.mocked(useFeatureFlags).mockReturnValue(ALL_FLAGS_ON);
  vi.mocked(useDeployCapabilities).mockReturnValue(capabilities);
}

const assetRoutes = () =>
  renderHook(() => useSectionNavChildren('assets')).result.current.map((c) => c.to);
const assetRailRoutes = () =>
  renderHook(() => useRailNavChildren('assets')).result.current.map((c) => c.to);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('section nav — deploy-time capability gating (§13.5 V5-P5)', () => {
  test('offers the News tab when market intelligence is configured', () => {
    setCapabilities({ marketIntel: true });
    expect(assetRoutes()).toContain('/assets/news');
    expect(assetRailRoutes()).toContain('/assets/news');
  });

  test('drops the News tab entirely when market intelligence is unconfigured', () => {
    setCapabilities({ marketIntel: false });
    // Absent from the strip AND from the rail tree — not present-but-empty.
    expect(assetRoutes()).not.toContain('/assets/news');
    expect(assetRailRoutes()).not.toContain('/assets/news');
  });

  test('gates nothing else in the section', () => {
    setCapabilities({ marketIntel: true });
    const configured = assetRoutes();
    setCapabilities({ marketIntel: false });
    const unconfigured = assetRoutes();
    expect(configured.filter((to) => !unconfigured.includes(to))).toEqual(['/assets/news']);
  });
});
