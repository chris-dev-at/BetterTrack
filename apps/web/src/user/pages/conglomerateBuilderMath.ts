import type { SearchResultItem } from '@bettertrack/contracts';

const WEIGHT_EPSILON = 1e-9;

export interface BuilderPosition {
  localId: string;
  assetId: string;
  symbol: string;
  name: string;
  currency: string;
  weightPct: number;
  locked: boolean;
}

export interface SumPillState {
  valid: boolean;
  total: number;
  remaining: number;
  label: string;
}

export function roundWeight(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function positionFromSearchResult(item: SearchResultItem): BuilderPosition {
  return {
    localId: item.id,
    assetId: item.id,
    symbol: item.symbol,
    name: item.name,
    currency: item.currency,
    weightPct: 0,
    locked: false,
  };
}

export function totalWeight(positions: readonly Pick<BuilderPosition, 'weightPct'>[]): number {
  return roundWeight(positions.reduce((sum, position) => sum + position.weightPct, 0));
}

export function sumPillState(
  positions: readonly Pick<BuilderPosition, 'weightPct'>[],
): SumPillState {
  const total = totalWeight(positions);
  const remaining = roundWeight(100 - total);
  const valid = Math.abs(total - 100) <= 0.01;
  return {
    valid,
    total,
    remaining,
    label: valid
      ? `${total.toFixed(1)}%`
      : total > 100
        ? `${total.toFixed(1)}% - ${Math.abs(remaining).toFixed(1)}% over`
        : `${total.toFixed(1)}% - ${remaining.toFixed(1)}% left`,
  };
}

export function autoBalance(positions: readonly BuilderPosition[]): BuilderPosition[] {
  const lockedTotal = positions
    .filter((position) => position.locked)
    .reduce((sum, position) => sum + position.weightPct, 0);
  const unlocked = positions.filter((position) => !position.locked);
  if (unlocked.length === 0) return [...positions];

  const available = 100 - lockedTotal;
  if (available <= 0) {
    return positions.map((position) =>
      position.locked ? { ...position } : { ...position, weightPct: 0 },
    );
  }

  const rawShare = available / unlocked.length;
  let remainder = roundWeight(100 - lockedTotal - roundWeight(rawShare) * unlocked.length);

  return positions.map((position) => {
    if (position.locked) return { ...position };
    const adjustment =
      Math.abs(remainder) >= 0.001 - WEIGHT_EPSILON ? Math.sign(remainder) * 0.001 : 0;
    remainder = roundWeight(remainder - adjustment);
    return { ...position, weightPct: roundWeight(rawShare + adjustment) };
  });
}

export interface NormalizeResult {
  positions: BuilderPosition[];
  error: string | null;
}

export function normalizeWeights(positions: readonly BuilderPosition[]): NormalizeResult {
  const lockedTotal = positions
    .filter((position) => position.locked)
    .reduce((sum, position) => sum + position.weightPct, 0);
  if (lockedTotal >= 100) {
    return {
      positions: positions.map((position) => ({ ...position })),
      error: 'Locked weights are already 100% or more. Unlock a row or lower a locked weight.',
    };
  }

  const unlocked = positions.filter((position) => !position.locked);
  const unlockedTotal = unlocked.reduce((sum, position) => sum + position.weightPct, 0);
  if (unlocked.length === 0 || unlockedTotal <= 0) {
    return {
      positions: positions.map((position) => ({ ...position })),
      error: 'There must be unlocked weight to normalize.',
    };
  }

  const target = 100 - lockedTotal;
  const scale = target / unlockedTotal;
  let assigned = 0;
  let lastUnlockedIndex = -1;
  positions.forEach((position, index) => {
    if (!position.locked) lastUnlockedIndex = index;
  });

  return {
    error: null,
    positions: positions.map((position, index) => {
      if (position.locked) return { ...position };
      const weight =
        index === lastUnlockedIndex
          ? roundWeight(target - assigned)
          : roundWeight(position.weightPct * scale);
      assigned = roundWeight(assigned + weight);
      return { ...position, weightPct: weight };
    }),
  };
}

export function updatePositionWeight(
  positions: readonly BuilderPosition[],
  localId: string,
  weightPct: number,
): BuilderPosition[] {
  const safeWeight = Math.min(100, Math.max(0, roundWeight(weightPct)));
  return positions.map((position) =>
    position.localId === localId ? { ...position, weightPct: safeWeight } : { ...position },
  );
}
