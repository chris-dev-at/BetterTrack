import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { featureFlagConfigSchema, type FeatureFlagConfig } from '@bettertrack/contracts';

import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  featureFlagBucket,
  principalFromUserId,
  resolveFeatureFlag,
  userPrincipal,
} from '../featureFlagResolution';

/**
 * The targeting core of the runtime kill switches (#1910, §6.12, §13.5 V5-P2
 * arc (c)). Pure, so it is tested here without a store, a cache or a request;
 * the seam tests in `apps/api/src/__tests__/featureFlags.test.ts` then prove the
 * same rules hold end to end through HTTP.
 */

const config = (patch: Partial<FeatureFlagConfig> = {}): FeatureFlagConfig =>
  featureFlagConfigSchema.parse({ enabled: true, ...patch });

/** A stable synthetic population — ids are uuids, exactly like real user ids. */
function population(count: number, seed = 'pop'): string[] {
  return Array.from({ length: count }, (_, index) => {
    // Deterministic uuid-shaped ids so a failure is reproducible, not a lottery.
    const hex = Buffer.from(`${seed}:${index}`).toString('hex').padEnd(32, '0').slice(0, 32);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  });
}

describe('the rollout bucket is stable, well-spread and flag-scoped', () => {
  it('is a pure function of (flag, user): the same pair resolves identically, always', () => {
    const userId = randomUUID();
    const first = featureFlagBucket('chat', userId);
    for (let i = 0; i < 100; i += 1) {
      expect(featureFlagBucket('chat', userId)).toBe(first);
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it('is reproducible in a SEPARATE PROCESS from the documented recipe alone', () => {
    // The property production needs is CROSS-PROCESS stability: the API, the
    // worker and every replica must bucket a user identically, or a user's HTTP
    // answer disagrees with their socket answer inside one session. Asserting
    // the value repeats in THIS process would only prove it is not random — it
    // would still pass for a per-process seed or for V8's implementation-defined
    // string hashing.
    //
    // So this recomputes the bucket in a fresh `node -e`, from the documented
    // recipe and nothing else (no import of the module under test): SHA-256 over
    // `<keyLength>:<key>:<userId>`, first four bytes big-endian, mod 100. If the
    // implementation ever drifts to something process-local, the two disagree.
    const ids = population(8, 'cross-process');
    const local = ids.map((id) => featureFlagBucket('liveMode', id));
    const script = [
      "const { createHash } = require('node:crypto');",
      `const ids = ${JSON.stringify(ids)};`,
      "const key = 'liveMode';",
      'const out = ids.map((id) =>',
      "  createHash('sha256').update(`${key.length}:${key}:${id}`, 'utf8').digest().readUInt32BE(0) % 100);",
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(local);
    // …and the bucket genuinely varies across the population, so the comparison
    // above is not two constant arrays agreeing.
    expect(new Set(local).size).toBeGreaterThan(1);
  });

  it('spreads 10 000 ids over the 100 buckets without a hot decile (chi-square)', () => {
    const ids = population(10_000, 'spread');
    const counts = new Array<number>(100).fill(0);
    for (const id of ids) counts[featureFlagBucket('imports', id)]! += 1;

    // Every bucket is actually used — a hash that collapsed onto a few buckets
    // would make `rolloutPercent` a lie even if the total were right.
    expect(counts.filter((count) => count === 0)).toHaveLength(0);

    // Pearson's chi-square against the uniform expectation. With 99 degrees of
    // freedom the 99.9th percentile is ~148.2; a sound hash lands near 99. The
    // bound is generous on purpose: this guards against a BROKEN hash (a
    // truncated digest, a forgotten key, a modulo over 8 bits), not against
    // ordinary sampling noise, and the population is fixed so the value is
    // deterministic rather than flaky.
    const expected = ids.length / 100;
    const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(chiSquare).toBeLessThan(148.2);
  });

  it('gives two flags at the same percentage DIFFERENT user sets', () => {
    // Without the flag key in the digest, every 10 % rollout would select the
    // identical decile of accounts — the same unlucky users would be the guinea
    // pigs for every feature the product ever ships.
    const ids = population(2_000, 'independence');
    const inChat = new Set(ids.filter((id) => featureFlagBucket('chat', id) < 10));
    const inAlerts = new Set(ids.filter((id) => featureFlagBucket('alerts', id) < 10));
    expect(inChat.size).toBeGreaterThan(100);
    expect(inAlerts.size).toBeGreaterThan(100);

    const overlap = [...inChat].filter((id) => inAlerts.has(id)).length;
    // Independent 10 % selections overlap on ~1 % of the population (~20 ids).
    // Identical selections would overlap on 100 % of the smaller set.
    expect(overlap).toBeLessThan(inChat.size / 2);
  });
});

describe('precedence: kill switch → deny → allow → percentage', () => {
  const alice = randomUUID();
  const bob = randomUUID();

  it('`enabled: false` refuses even an ALLOWLISTED user — the kill switch is absolute', () => {
    // §6.12: these six flags are the product's kill switches. A kill switch a
    // list can override is not a kill switch, so this is the one precedence rule
    // that is a safety property rather than a convenience.
    const off = config({ enabled: false, allowUserIds: [alice], rolloutPercent: 100 });
    expect(resolveFeatureFlag(off, 'chat', userPrincipal(alice))).toBe(false);
    expect(resolveFeatureFlag(off, 'chat', ANONYMOUS_PRINCIPAL)).toBe(false);
    expect(resolveFeatureFlag(off, 'chat', SYSTEM_PRINCIPAL)).toBe(false);
  });

  it('deny beats allow, and deny beats a 100 % rollout', () => {
    const both = config({ allowUserIds: [alice], denyUserIds: [alice], rolloutPercent: 100 });
    expect(resolveFeatureFlag(both, 'alerts', userPrincipal(alice))).toBe(false);
    expect(resolveFeatureFlag(both, 'alerts', userPrincipal(bob))).toBe(true);

    const fullyRolled = config({ denyUserIds: [alice], rolloutPercent: 100 });
    expect(resolveFeatureFlag(fullyRolled, 'alerts', userPrincipal(alice))).toBe(false);
  });

  it('allow beats the percentage — including a 0 % rollout', () => {
    const dark = config({ rolloutPercent: 0, allowUserIds: [alice] });
    expect(resolveFeatureFlag(dark, 'ai', userPrincipal(alice))).toBe(true);
    expect(resolveFeatureFlag(dark, 'ai', userPrincipal(bob))).toBe(false);
  });

  it('0 % is OFF for every principal and 100 % is ON for every principal', () => {
    const ids = population(500, 'ends');
    const zero = config({ rolloutPercent: 0 });
    const full = config({ rolloutPercent: 100 });
    for (const id of ids) {
      expect(resolveFeatureFlag(zero, 'imports', userPrincipal(id))).toBe(false);
      expect(resolveFeatureFlag(full, 'imports', userPrincipal(id))).toBe(true);
    }
  });

  it('a mid rollout partitions a population approximately as configured', () => {
    const ids = population(2_000, 'partition');
    const quarter = config({ rolloutPercent: 25 });
    const on = ids.filter((id) => resolveFeatureFlag(quarter, 'liveMode', userPrincipal(id)));
    // A tolerance band, not an exact count: the point is that 25 means roughly a
    // quarter, not that this fixed population lands on exactly 500.
    expect(on.length).toBeGreaterThan(ids.length * 0.2);
    expect(on.length).toBeLessThan(ids.length * 0.3);

    // …and it is a SUBSET relationship as the percentage widens: nobody who was
    // already in at 25 % falls out at 50 %, so widening a rollout never takes the
    // feature away from someone who had it.
    const half = config({ rolloutPercent: 50 });
    for (const id of on) {
      expect(resolveFeatureFlag(half, 'liveMode', userPrincipal(id))).toBe(true);
    }
  });
});

describe('the three principal kinds answer differently, on purpose', () => {
  it('anonymous sees a partially-rolled flag as OFF and a fully-rolled one as ON', () => {
    expect(resolveFeatureFlag(config({ rolloutPercent: 99 }), 'chat', ANONYMOUS_PRINCIPAL)).toBe(
      false,
    );
    expect(resolveFeatureFlag(config({ rolloutPercent: 100 }), 'chat', ANONYMOUS_PRINCIPAL)).toBe(
      true,
    );
  });

  it('anonymous sees a flag with a non-empty ALLOWLIST as OFF', () => {
    // A targeted feature is aimed at named accounts, and an anonymous caller is
    // not one of them — advertising it pre-login would promise a surface the
    // server then 404s.
    const targeted = config({ rolloutPercent: 100, allowUserIds: [randomUUID()] });
    expect(resolveFeatureFlag(targeted, 'ai', ANONYMOUS_PRINCIPAL)).toBe(false);
  });

  it('system reads the BASE switch only — a percentage never halves a background sweep', () => {
    expect(resolveFeatureFlag(config({ rolloutPercent: 0 }), 'alerts', SYSTEM_PRINCIPAL)).toBe(
      true,
    );
    expect(
      resolveFeatureFlag(
        config({ rolloutPercent: 0, denyUserIds: [randomUUID()] }),
        'alerts',
        SYSTEM_PRINCIPAL,
      ),
    ).toBe(true);
    expect(resolveFeatureFlag(config({ enabled: false }), 'alerts', SYSTEM_PRINCIPAL)).toBe(false);
  });

  it('an absent user id becomes ANONYMOUS, never system', () => {
    // The dangerous default would be `system`: it bypasses the rollout, so an
    // unidentified caller would be handed the fully-rolled answer.
    expect(principalFromUserId(undefined)).toEqual(ANONYMOUS_PRINCIPAL);
    expect(principalFromUserId(null)).toEqual(ANONYMOUS_PRINCIPAL);
    expect(principalFromUserId('')).toEqual(ANONYMOUS_PRINCIPAL);
    expect(principalFromUserId('a-user')).toEqual({ kind: 'user', userId: 'a-user' });
  });
});

describe('forbidden targeting axes (§13.5)', () => {
  it('resolves from (config, key, principal) alone — no privacy-mode input exists', () => {
    // Structural, not aspirational: the principal type is the ONLY channel a
    // user attribute could arrive on, and it carries an id and nothing else.
    // Targeting on privacy mode / paranoid status would make a user's mode
    // observable through feature behaviour, which §13.5 forbids.
    expect(Object.keys(userPrincipal(randomUUID())).sort()).toEqual(['kind', 'userId']);
    expect(resolveFeatureFlag.length).toBe(3);
    expect(Object.keys(featureFlagConfigSchema.shape).sort()).toEqual([
      'allowUserIds',
      'denyUserIds',
      'enabled',
      'rolloutPercent',
    ]);
  });
});
