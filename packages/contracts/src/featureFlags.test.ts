import { describe, expect, it } from 'vitest';

import {
  DEPLOY_CAPABILITY_KEYS,
  FEATURE_FLAG_KEYS,
  deployCapabilitiesSchema,
  featureFlagsResponseSchema,
} from './featureFlags';

const FLAGS = Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, true]));

describe('feature flags vs deploy capabilities (§13.5 V5-P2 / V5-P5)', () => {
  it('keeps the admin runtime kill-switch registry exactly as it was', () => {
    // Market intelligence is a per-deploy env gate, NOT an admin toggle: adding
    // it here would be the wrong mechanism (and would put it in the admin
    // console's registry). Asserting the contents makes that drift loud.
    expect([...FEATURE_FLAG_KEYS]).toEqual([
      'realtime',
      'liveMode',
      'chat',
      'alerts',
      'imports',
      'ai',
    ]);
    expect(FEATURE_FLAG_KEYS).not.toContain('marketIntel');
  });

  it('carries market intelligence as a deploy-time capability instead', () => {
    expect([...DEPLOY_CAPABILITY_KEYS]).toEqual(['marketIntel']);
    expect(deployCapabilitiesSchema.safeParse({ marketIntel: false }).success).toBe(true);
    // Strict: an unknown capability is a contract error, never silently ignored.
    expect(deployCapabilitiesSchema.safeParse({ marketIntel: true, other: true }).success).toBe(
      false,
    );
  });

  it('requires both halves on the SPA bootstrap response', () => {
    const parsed = featureFlagsResponseSchema.safeParse({
      flags: FLAGS,
      capabilities: { marketIntel: false },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.capabilities.marketIntel).toBe(false);
    // The flags map alone no longer satisfies the envelope.
    expect(featureFlagsResponseSchema.safeParse({ flags: FLAGS }).success).toBe(false);
  });
});
