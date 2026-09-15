import { describe, expect, it } from 'vitest';

import {
  DEPLOY_CAPABILITY_KEYS,
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_TARGET_LIST_MAX,
  adminFeatureFlagSchema,
  deployCapabilitiesSchema,
  featureFlagConfigSchema,
  featureFlagStoredConfigSchema,
  featureFlagsPublicSchema,
  featureFlagsResponseSchema,
  updateFeatureFlagRequestSchema,
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

/**
 * Rollout targeting bounds (#1910). The contract is the first of the two locks
 * on a security-relevant gate — everything it refuses is a 400 before it can
 * reach the resolver, the store or the audit log.
 */
describe('feature-flag rollout configuration', () => {
  const uuid = (n: number): string =>
    `0000${n}`.slice(-4).padStart(8, '0').concat('-0000-4000-8000-000000000000');

  it('defaults an unconfigured flag to fully rolled with no lists', () => {
    const parsed = featureFlagConfigSchema.parse({ enabled: true });
    expect(parsed).toEqual({
      enabled: true,
      rolloutPercent: 100,
      allowUserIds: [],
      denyUserIds: [],
    });
  });

  it('bounds the percentage to an integer 0..100', () => {
    for (const value of [0, 1, 50, 100]) {
      expect(
        featureFlagConfigSchema.safeParse({ enabled: true, rolloutPercent: value }).success,
      ).toBe(true);
    }
    for (const value of [-1, 101, 12.5, Number.NaN, '50']) {
      expect(
        featureFlagConfigSchema.safeParse({ enabled: true, rolloutPercent: value }).success,
        String(value),
      ).toBe(false);
    }
  });

  it('requires uuids in both id lists and caps each at 200', () => {
    const at = Array.from({ length: FEATURE_FLAG_TARGET_LIST_MAX }, (_, i) => uuid(i));
    expect(featureFlagConfigSchema.safeParse({ enabled: true, allowUserIds: at }).success).toBe(
      true,
    );
    expect(featureFlagConfigSchema.safeParse({ enabled: true, denyUserIds: at }).success).toBe(
      true,
    );
    // 201 is refused — an unbounded list is an unbounded jsonb row, an unbounded
    // response and an unbounded `includes` on every resolution.
    expect(
      featureFlagConfigSchema.safeParse({ enabled: true, allowUserIds: [...at, uuid(999)] })
        .success,
    ).toBe(false);
    expect(
      featureFlagConfigSchema.safeParse({ enabled: true, denyUserIds: ['not-a-uuid'] }).success,
    ).toBe(false);
  });

  it('is strict: an unknown key is a contract error, never a silent no-op', () => {
    expect(featureFlagConfigSchema.safeParse({ enabled: true, cohort: 'beta' }).success).toBe(
      false,
    );
    // The forbidden targeting axis, spelled out (§13.5): privacy mode must never
    // become an input, and the strict schema is what makes adding it a change
    // someone has to make deliberately rather than by passing an extra field.
    expect(
      featureFlagConfigSchema.safeParse({ enabled: true, privacyMode: 'paranoid' }).success,
    ).toBe(false);
  });

  it('accepts a PATCH with any subset of the fields — and refuses a misspelt one', () => {
    for (const body of [
      {},
      { enabled: false },
      { rolloutPercent: 10 },
      { allowUserIds: [uuid(1)] },
      { denyUserIds: [uuid(2)], enabled: true },
    ]) {
      expect(updateFeatureFlagRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        true,
      );
    }
    // A misspelt list name must not silently write nothing on a kill switch.
    expect(updateFeatureFlagRequestSchema.safeParse({ allowUserIDs: [] }).success).toBe(false);
    expect(updateFeatureFlagRequestSchema.safeParse({ rolloutPercent: 101 }).success).toBe(false);
  });

  it('separates the STRICT request shape from the forward-compatible storage shape', () => {
    // The request boundary must refuse an unknown key: there it is an operator's
    // typo on a security-relevant gate, and a silent no-op would be worse than a
    // 400. Storage is the opposite case — the row was written by some version of
    // this code, and strictness there means the first field a later wave adds
    // makes every row the previous version wrote unreadable. For a registry of
    // kill switches that reads as "every killed feature turns on during the
    // deploy" (#1910 review B1), so the stored shape strips instead.
    const withFutureField = {
      enabled: false,
      rolloutPercent: 100,
      allowUserIds: [],
      denyUserIds: [],
      futureField: 'written by a later version',
    };
    expect(featureFlagConfigSchema.safeParse(withFutureField).success).toBe(false);

    const stored = featureFlagStoredConfigSchema.safeParse(withFutureField);
    expect(stored.success).toBe(true);
    // The kill survives, and the unknown key is dropped rather than carried.
    if (stored.success) {
      expect(stored.data).toEqual({
        enabled: false,
        rolloutPercent: 100,
        allowUserIds: [],
        denyUserIds: [],
      });
    }
  });

  it('still refuses a stored row whose KNOWN fields are invalid', () => {
    // Stripping unknown keys is forward compatibility, not a free pass: a
    // `rolloutPercent` that is not a percentage is still a parse failure, which
    // is what lets the service tell "row from the future" apart from "row that
    // is genuinely broken" and salvage only `enabled` in the second case.
    expect(
      featureFlagStoredConfigSchema.safeParse({ enabled: true, rolloutPercent: 'fifty' }).success,
    ).toBe(false);
    expect(
      featureFlagStoredConfigSchema.safeParse({ enabled: true, allowUserIds: 'nope' }).success,
    ).toBe(false);
    expect(featureFlagStoredConfigSchema.safeParse({ rolloutPercent: 50 }).success).toBe(false);
  });

  it('keeps the rollout OUT of the public bootstrap schema', () => {
    // The anonymous endpoint carries resolved booleans and nothing else; a
    // config field riding along would publish which accounts are allowlisted.
    const withRollout = { ...FLAGS, rolloutPercent: 50 };
    expect(featureFlagsPublicSchema.safeParse(withRollout).success).toBe(false);
    expect(featureFlagsPublicSchema.safeParse(FLAGS).success).toBe(true);
  });

  it('serves the rollout on the ADMIN schema, where the guard already fences it', () => {
    const flag = {
      key: 'chat' as const,
      enabled: true,
      rolloutPercent: 25,
      allowUserIds: [uuid(1)],
      denyUserIds: [],
      description: 'Friend chat.',
      updatedAt: null,
      updatedBy: null,
    };
    expect(adminFeatureFlagSchema.safeParse(flag).success).toBe(true);
    // Total, not optional: the console renders one shape for every flag.
    const { rolloutPercent, ...missing } = flag;
    expect(rolloutPercent).toBe(25);
    expect(adminFeatureFlagSchema.safeParse(missing).success).toBe(false);
  });
});
