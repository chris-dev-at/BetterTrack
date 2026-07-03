import { describe, expect, test } from 'vitest';

import {
  autoBalance,
  canActivate,
  canAddPosition,
  clampWeight,
  isSumValid,
  normalize,
  positionFromSearchResult,
  roundWeight,
  sumWeights,
  type BuilderPosition,
} from './conglomerateBuilder';

function pos(assetId: string, weightPct: number, locked = false): BuilderPosition {
  return {
    assetId,
    symbol: assetId.toUpperCase(),
    name: `${assetId} name`,
    currency: 'USD',
    type: 'stock',
    weightPct,
    locked,
  };
}

describe('conglomerateBuilder helpers', () => {
  test('roundWeight / clampWeight hold 3-decimal precision and the 0–100 range', () => {
    expect(roundWeight(33.3336)).toBe(33.334);
    expect(clampWeight(-5)).toBe(0);
    expect(clampWeight(120)).toBe(100);
    expect(clampWeight(Number.NaN)).toBe(0);
    expect(clampWeight(12.3456)).toBe(12.346);
  });

  test('sumWeights + isSumValid track the 100 ± 0.01 window', () => {
    expect(sumWeights([pos('a', 60), pos('b', 40)])).toBe(100);
    expect(isSumValid([pos('a', 60), pos('b', 40)])).toBe(true);
    expect(isSumValid([pos('a', 60), pos('b', 39.995)])).toBe(true); // 99.995, within 0.01
    expect(isSumValid([pos('a', 60), pos('b', 39.9)])).toBe(false); // 99.9, outside
    expect(isSumValid([pos('a', 87.5)])).toBe(false);
  });

  test('positionFromSearchResult adds a position at weight 0', () => {
    const built = positionFromSearchResult({
      id: 'id-1',
      providerId: 'yahoo',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      type: 'stock',
      currency: 'USD',
      isCustom: false,
    });
    expect(built).toMatchObject({ assetId: 'id-1', symbol: 'AAPL', weightPct: 0, locked: false });
  });

  test('canAddPosition rejects duplicates and enforces the 50-position cap', () => {
    const existing = [pos('a', 10)];
    expect(canAddPosition(existing, 'b')).toEqual({ ok: true });
    expect(canAddPosition(existing, 'a').ok).toBe(false);

    const full = Array.from({ length: 50 }, (_, i) => pos(`a${i}`, 1));
    expect(canAddPosition(full, 'new').ok).toBe(false);
  });

  test('auto-balance distributes 100 − Σ(locked) equally and Σ lands on 100', () => {
    const balanced = autoBalance([pos('a', 0), pos('b', 0), pos('c', 0), pos('d', 0)]);
    expect(balanced.map((p) => p.weightPct)).toEqual([25, 25, 25, 25]);
    expect(sumWeights(balanced)).toBe(100);
  });

  test('auto-balance leaves locked positions untouched', () => {
    const balanced = autoBalance([pos('a', 40, true), pos('b', 0), pos('c', 0)]);
    // 100 − 40 locked = 60 split across the two unlocked positions.
    expect(balanced.map((p) => p.weightPct)).toEqual([40, 30, 30]);
    expect(balanced[0]?.locked).toBe(true);
    expect(sumWeights(balanced)).toBe(100);
  });

  test('auto-balance across 3 positions still sums to exactly 100 (remainder on last)', () => {
    const balanced = autoBalance([pos('a', 0), pos('b', 0), pos('c', 0)]);
    expect(sumWeights(balanced)).toBe(100);
    expect(balanced[0]?.weightPct).toBeCloseTo(33.333, 3);
  });

  test('normalize scales unlocked proportionally to hit exactly 100', () => {
    const result = normalize([pos('a', 30), pos('b', 10)]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 30:10 preserved, scaled to 75:25.
      expect(result.positions.map((p) => p.weightPct)).toEqual([75, 25]);
      expect(sumWeights(result.positions)).toBe(100);
    }
  });

  test('normalize leaves locked positions untouched and fills the remainder', () => {
    const result = normalize([pos('a', 50, true), pos('b', 20), pos('c', 20)]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The locked 50 is untouched; the two unlocked 20s scale to 25 each.
      expect(result.positions.map((p) => p.weightPct)).toEqual([50, 25, 25]);
      expect(result.positions.every((p, i) => (i === 0 ? p.locked : !p.locked))).toBe(true);
      expect(sumWeights(result.positions)).toBe(100);
    }
  });

  test('normalize errors when locked positions alone total ≥ 100', () => {
    const result = normalize([pos('a', 60, true), pos('b', 45, true), pos('c', 10)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/100%/);
  });

  test('normalize errors when there are no unlocked positions', () => {
    const result = normalize([pos('a', 40, true), pos('b', 40, true)]);
    expect(result.ok).toBe(false);
  });

  test('canActivate requires Σ = 100 ± 0.01 and every persisted weight > 0', () => {
    expect(canActivate([pos('a', 60), pos('b', 40)])).toBe(true);
    expect(canActivate([pos('a', 60), pos('b', 30)])).toBe(false); // sum 90
    // A weight-0 row is ignored (dropped on save); the rest still sum to 100.
    expect(canActivate([pos('a', 60), pos('b', 40), pos('c', 0)])).toBe(true);
    expect(canActivate([])).toBe(false);
  });
});
