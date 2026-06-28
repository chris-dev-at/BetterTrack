import { describe, expect, it } from 'vitest';

import {
  autoBalance,
  normalizeWeights,
  sumPillState,
  updatePositionWeight,
  type BuilderPosition,
} from './conglomerateBuilderMath';

function pos(id: string, weightPct: number, locked = false): BuilderPosition {
  return {
    localId: id,
    assetId: id,
    symbol: id,
    name: id,
    currency: 'EUR',
    weightPct,
    locked,
  };
}

describe('conglomerate builder math', () => {
  it.each([
    {
      name: 'splits 100 equally across all unlocked rows',
      input: [pos('A', 0), pos('B', 0)],
      expected: [50, 50],
    },
    {
      name: 'leaves locked rows untouched and splits the remainder',
      input: [pos('A', 25, true), pos('B', 0), pos('C', 0)],
      expected: [25, 37.5, 37.5],
    },
    {
      name: 'caps unlocked rows at zero when locked rows exceed 100',
      input: [pos('A', 120, true), pos('B', 20), pos('C', 30)],
      expected: [120, 0, 0],
    },
    {
      name: 'keeps the rounded unlocked split summing to the available remainder',
      input: [pos('A', 0), pos('B', 0), pos('C', 0)],
      expected: [33.334, 33.333, 33.333],
    },
  ])('$name', ({ input, expected }) => {
    expect(autoBalance(input).map((position) => position.weightPct)).toEqual(expected);
  });

  it.each([
    {
      name: 'scales unlocked rows proportionally',
      input: [pos('A', 20), pos('B', 30)],
      expected: [40, 60],
      error: null,
    },
    {
      name: 'leaves locked rows untouched and scales unlocked rows to the remainder',
      input: [pos('A', 40, true), pos('B', 10), pos('C', 20)],
      expected: [40, 20, 40],
      error: null,
    },
    {
      name: 'errors when locked rows are already 100',
      input: [pos('A', 100, true), pos('B', 25)],
      expected: [100, 25],
      error: /Locked weights/,
    },
    {
      name: 'errors when there is no unlocked positive weight to scale',
      input: [pos('A', 50, true), pos('B', 0)],
      expected: [50, 0],
      error: /unlocked weight/,
    },
  ])('$name', ({ input, expected, error }) => {
    const result = normalizeWeights(input);
    expect(result.positions.map((position) => position.weightPct)).toEqual(expected);
    if (error === null) {
      expect(result.error).toBeNull();
    } else {
      expect(result.error).toMatch(error);
    }
  });

  it.each([
    { weights: [60, 40], label: '100.0%', valid: true },
    { weights: [60, 27.5], label: '87.5% - 12.5% left', valid: false },
    { weights: [60, 50], label: '110.0% - 10.0% over', valid: false },
    { weights: [60, 40.005], label: '100.0%', valid: true },
  ])('builds sum pill state for $label', ({ weights, label, valid }) => {
    const state = sumPillState(weights.map((weight, index) => pos(String(index), weight)));
    expect(state.label).toBe(label);
    expect(state.valid).toBe(valid);
  });

  it('clamps and rounds direct weight edits to the allowed 0..100 range', () => {
    expect(updatePositionWeight([pos('A', 10)], 'A', 101.234)[0]?.weightPct).toBe(100);
    expect(updatePositionWeight([pos('A', 10)], 'A', -5)[0]?.weightPct).toBe(0);
    expect(updatePositionWeight([pos('A', 10)], 'A', 12.3456)[0]?.weightPct).toBe(12.346);
  });
});
