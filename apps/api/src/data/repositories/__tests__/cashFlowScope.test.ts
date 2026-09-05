import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cashMonthBounds, cashPeriodKey } from '../cashSummaryRepository';

/**
 * THE GUARD THAT KEEPS EVERY CASH AGGREGATE ON ONE ROW SET AND ONE CLOCK (#1792).
 *
 * The transfer-leg exclusion first landed in `cashSummaryRepository` alone, so
 * `outflowByTag` — the measure a BUDGET is judged against — kept counting the
 * legs of an internal transfer and reported €9,000 of "spend" against a summary
 * that reported €0 for the same tag, month and portfolio. Nothing failed when
 * that aggregate was written, because nothing could: the predicate was a local
 * const in the other file.
 *
 * ── THE MECHANISM ──
 *
 * Every SQL aggregate over `portfolioCashMovements.amountEur` anywhere in the
 * API source must either
 *
 *  1. build its WHERE with `cashFlowScope(...)` — it is a FLOW roll-up, so the
 *     transfer legs are excluded and the window is a cash-clock month; or
 *  2. be named in {@link BALANCE_AGGREGATES} — it is a BALANCE, where both legs
 *     of a transfer genuinely move the sources they touch.
 *
 * A new aggregate written without either fails this test with the choice spelled
 * out, so "flow or balance?" has to be answered deliberately rather than by
 * whichever predicate got copied.
 */

/** `apps/api/src` — the whole API source, because §"all SQL lives in data/" is a
 * convention this guard should not have to trust. */
const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Aggregates that must NOT exclude transfer legs, with the reason. Both legs of
 * `POST /cash/transfer` change a source balance — Main goes down, Savings goes
 * up — so a balance that dropped them would be wrong by the transferred amount.
 */
const BALANCE_AGGREGATES = new Map<string, string>([
  [
    'data/repositories/cashMovementRepository.ts#balancesForPortfolio',
    'per-source balances: a transfer moves both sources it touches',
  ],
]);

/** `sum(...)`/`avg(...)`/`min(...)`/`max(...)` over the ledger's money column. */
const AGGREGATE = /(?:sum|avg|min|max)\(\s*-?\$\{portfolioCashMovements\.amountEur\}/g;
/** The nearest enclosing `async name(` / `function name(` before an offset. */
const ENCLOSING = /(?:async\s+|function\s+)([A-Za-z0-9_]+)\s*\(/g;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

interface FoundAggregate {
  /** `<path relative to src>#<enclosing function>` — the allowlist key. */
  id: string;
  scoped: boolean;
}

function aggregatesIn(file: string): FoundAggregate[] {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('portfolioCashMovements.amountEur')) return [];
  const relative = path.relative(API_SRC, file).split(path.sep).join('/');
  const found: FoundAggregate[] = [];
  for (const match of source.matchAll(AGGREGATE)) {
    const at = match.index;
    // The query builder is written select → from → where, so the first `.where(`
    // after the aggregate expression is the one that scopes it.
    const where = source.indexOf('.where(', at);
    const scoped =
      where >= 0 && /^\.where\(\s*cashFlowScope\(/.test(source.slice(where, where + 40));
    let name = '(top level)';
    for (const enclosing of source.slice(0, at).matchAll(ENCLOSING)) name = enclosing[1]!;
    found.push({ id: `${relative}#${name}`, scoped });
  }
  return found;
}

describe('cash aggregate guard', () => {
  it('routes every cash-flow aggregate through cashFlowScope, or names it a balance', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(API_SRC)) {
      for (const aggregate of aggregatesIn(file)) {
        seen += 1;
        if (BALANCE_AGGREGATES.has(aggregate.id) || aggregate.scoped) continue;
        offenders.push(aggregate.id);
      }
    }
    // The census itself has to keep working: a regex that stops matching would
    // otherwise report a clean sweep over nothing.
    expect(seen).toBeGreaterThanOrEqual(6);
    expect(
      offenders,
      'A cash aggregate must either build its WHERE with cashFlowScope(...) — a FLOW ' +
        'roll-up, transfer legs excluded — or be listed in BALANCE_AGGREGATES in this ' +
        'test with the reason both legs must count.',
    ).toEqual([]);
  });

  it('keeps the balance allowlist honest — every entry still exists', () => {
    const ids = new Set(
      sourceFiles(API_SRC).flatMap((file) => aggregatesIn(file).map((a) => a.id)),
    );
    for (const id of BALANCE_AGGREGATES.keys()) expect(ids).toContain(id);
  });
});

describe('the cash clock', () => {
  it('buckets an instant into the month the ledger displays it in', () => {
    // 01:15 on 1 October in Vienna (CEST, UTC+2) — the instant behind (b).
    expect(cashPeriodKey(new Date('2026-09-30T23:15:00.000Z'))).toBe('2026-10');
    // Noon UTC, what every day the app writes is anchored at: same day either way.
    expect(cashPeriodKey(new Date('2026-09-30T12:00:00.000Z'))).toBe('2026-09');
    // Midnight UTC, where the cash-fusion migration parked carried-over rows:
    // 01:00/02:00 Vienna on the SAME day, so those rows keep their month.
    expect(cashPeriodKey(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10');
  });

  it('windows a month on local midnight, in both offsets and across the year edge', () => {
    // CEST (+2): October opens at 22:00 UTC on 30 September.
    expect(cashMonthBounds('2026-10')).toEqual({
      from: new Date('2026-09-30T22:00:00.000Z'),
      toExclusive: new Date('2026-10-31T23:00:00.000Z'),
    });
    // CET (+1) after the last-Sunday-of-October shift.
    expect(cashMonthBounds('2026-11')).toEqual({
      from: new Date('2026-10-31T23:00:00.000Z'),
      toExclusive: new Date('2026-11-30T23:00:00.000Z'),
    });
    expect(cashMonthBounds('2026-12')).toEqual({
      from: new Date('2026-11-30T23:00:00.000Z'),
      toExclusive: new Date('2026-12-31T23:00:00.000Z'),
    });
    // The windows tile: one month's upper bound is the next one's lower bound,
    // so no instant is counted twice and none falls between two months.
    expect(cashMonthBounds('2026-06').toExclusive).toEqual(cashMonthBounds('2026-07').from);
  });
});
