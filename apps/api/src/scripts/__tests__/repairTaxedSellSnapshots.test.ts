import { describe, expect, it } from 'vitest';

import type { SnapshotRepairTarget } from '../../data/repositories/portfolioSnapshotRepository';
import { parseRepairArgs, repairTaxedSellSnapshots } from '../repairTaxedSellSnapshots';

interface FakeCall {
  portfolioId: string;
  fromDay: string;
}

function fakeRepo(targets: SnapshotRepairTarget[], failOn = new Set<string>()) {
  const marked: FakeCall[] = [];
  const deleted: FakeCall[] = [];
  return {
    marked,
    deleted,
    async listTaxedSellFlowRepairTargets(): Promise<SnapshotRepairTarget[]> {
      return targets;
    },
    async markDirty(portfolioId: string, fromDay: string): Promise<void> {
      if (failOn.has(portfolioId)) throw new Error('write failed');
      marked.push({ portfolioId, fromDay });
    },
    async deleteFrom(portfolioId: string, fromDay: string): Promise<void> {
      deleted.push({ portfolioId, fromDay });
    },
  };
}

const TARGETS: SnapshotRepairTarget[] = [
  { portfolioId: 'p1', firstEventDay: '2024-01-05' },
  { portfolioId: 'p2', firstEventDay: '2023-06-30' },
];

describe('repairTaxedSellSnapshots', () => {
  it('invalidates every affected portfolio from its own inception day', async () => {
    const repo = fakeRepo(TARGETS);
    const report = await repairTaxedSellSnapshots({ dryRun: false, snapshotRepo: repo });

    expect(report.mode).toBe('apply');
    expect(report.affected).toBe(2);
    expect(report.invalidated).toBe(2);
    expect(report.failed).toBe(0);
    // Each portfolio rebuilds from ITS first event, never a shared cutoff —
    // a shared one would either truncate an older series or do needless work.
    expect(repo.deleted).toEqual([
      { portfolioId: 'p1', fromDay: '2024-01-05' },
      { portfolioId: 'p2', fromDay: '2023-06-30' },
    ]);
  });

  it('marks dirty before deleting so an interleaving reader never sees a gap', async () => {
    const order: string[] = [];
    const report = await repairTaxedSellSnapshots({
      dryRun: false,
      snapshotRepo: {
        async listTaxedSellFlowRepairTargets() {
          return [TARGETS[0]!];
        },
        async markDirty() {
          order.push('markDirty');
        },
        async deleteFrom() {
          order.push('deleteFrom');
        },
      },
    });
    expect(report.invalidated).toBe(1);
    expect(order).toEqual(['markDirty', 'deleteFrom']);
  });

  it('writes nothing in dry-run but still reports the work', async () => {
    const repo = fakeRepo(TARGETS);
    const report = await repairTaxedSellSnapshots({ dryRun: true, snapshotRepo: repo });

    expect(report.mode).toBe('dry-run');
    expect(report.affected).toBe(2);
    expect(report.invalidated).toBe(0);
    expect(report.portfolios.every((p) => !p.invalidated)).toBe(true);
    expect(repo.marked).toEqual([]);
    expect(repo.deleted).toEqual([]);
  });

  it('keeps going when one portfolio fails and reports a non-zero failure count', async () => {
    const repo = fakeRepo(TARGETS, new Set(['p1']));
    const report = await repairTaxedSellSnapshots({ dryRun: false, snapshotRepo: repo });

    expect(report.failed).toBe(1);
    expect(report.invalidated).toBe(1);
    // The healthy portfolio was still repaired — a single bad row must not
    // abandon the rest of a production run.
    expect(repo.deleted).toEqual([{ portfolioId: 'p2', fromDay: '2023-06-30' }]);
  });

  it('reports an empty run cleanly when nothing matches', async () => {
    const report = await repairTaxedSellSnapshots({ dryRun: false, snapshotRepo: fakeRepo([]) });
    expect(report).toMatchObject({ affected: 0, invalidated: 0, failed: 0, portfolios: [] });
  });

  it('streams each portfolio to the progress sink as it is repaired', async () => {
    const seen: string[] = [];
    await repairTaxedSellSnapshots({
      dryRun: false,
      snapshotRepo: fakeRepo(TARGETS),
      onPortfolio: (entry) => seen.push(entry.portfolioId),
    });
    expect(seen).toEqual(['p1', 'p2']);
  });
});

describe('parseRepairArgs', () => {
  it('requires exactly one of --dry-run or --apply', () => {
    expect(() => parseRepairArgs(['node', 'script'])).toThrow(/exactly one/);
    expect(() => parseRepairArgs(['node', 'script', '--dry-run', '--apply'])).toThrow(
      /exactly one/,
    );
  });

  it('accepts each mode on its own', () => {
    expect(parseRepairArgs(['node', 'script', '--dry-run'])).toEqual({ dryRun: true });
    expect(parseRepairArgs(['node', 'script', '--apply'])).toEqual({ dryRun: false });
  });

  it('rejects unknown arguments rather than silently ignoring them', () => {
    expect(() => parseRepairArgs(['node', 'script', '--apply', '--force'])).toThrow(/Unknown/);
  });
});
