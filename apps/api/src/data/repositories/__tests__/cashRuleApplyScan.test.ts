import { PgDialect } from 'drizzle-orm/pg-core';
import type { sql as sqlTag } from 'drizzle-orm';
import { expect, it } from 'vitest';

import {
  applyCashRulesForOwner,
  CASH_RULE_APPLY_MOVEMENT_SCAN_MAX,
  type RuleTagStampExecutor,
} from '../cashRuleTagStamp';

/**
 * THE RE-APPLY SCAN IS PAGED AND BOUNDED (#1743).
 *
 * `POST /cash/rules/apply` used to issue one `SELECT "id", "note" FROM
 * "portfolio_cash_movements" WHERE …` per portfolio with no LIMIT and no
 * cursor, and match in JS — so a long-lived ledger was materialized whole, on a
 * freely repeatable request.
 *
 * Driven against a recording executor rather than a database, because what is
 * being pinned is the SHAPE OF THE TRAFFIC: how many statements, with which
 * LIMIT, carrying which cursor. A PGlite test would tag the right movements
 * while saying nothing about whether it read them 500 at a time or all at once.
 * `cashRuleTagging.test.ts` covers the end-to-end result over a real ledger.
 */

const USER = '018f0000-0000-7000-8000-0000000000aa';
const PORTFOLIO = '018f0000-0000-7000-8000-0000000000b1';
const TAG = '018f0000-0000-7000-8000-0000000000c1';

const dialect = new PgDialect();

interface Recorded {
  text: string;
  params: unknown[];
}

/** One synthetic movement, newest first by construction. */
function ledger(size: number): { id: string; note: string; cursorExecutedAt: string }[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `018f0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    note: `SPAR market ${i}`,
    cursorExecutedAt: `2026-01-01 00:00:00.${String(1_000_000 - i).padStart(6, '0')}+00`,
  }));
}

/**
 * Serves the rules, the portfolio list and keyset pages of `rows`, honouring
 * the LIMIT and the cursor the statement actually carries — so a scan that
 * forgot either would read the same page forever and fail loudly here.
 */
function executor(rows: ReturnType<typeof ledger>): {
  executor: RuleTagStampExecutor;
  scans: Recorded[];
} {
  const scans: Recorded[] = [];
  const inst: RuleTagStampExecutor = {
    async execute(query: ReturnType<typeof sqlTag>) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (text.includes('FROM "cash_rules"')) {
        return {
          rows: [
            {
              id: '018f0000-0000-7000-8000-0000000000d1',
              matchType: 'contains',
              pattern: 'SPAR',
              priority: 0,
              enabled: true,
              tagIds: [TAG],
            },
          ],
        };
      }
      if (text.includes('FROM "portfolios"')) return { rows: [{ id: PORTFOLIO }] };
      if (text.includes('INSERT INTO "cash_movement_tags"')) {
        // Echo one row per (movement, tag) pair, as the RETURNING would. The
        // params are the pairs in order, then the portfolio id the statement
        // re-proves ownership through.
        const movementIds = params.slice(0, -1).filter((_, i) => i % 2 === 0);
        return { rows: movementIds.map((movement_id) => ({ movement_id })) };
      }
      if (text.includes('FROM "portfolio_cash_movements"')) {
        scans.push({ text, params });
        const limit = Number(params.at(-1));
        const cursorId = text.includes('("executed_at", "id") <') ? String(params[2]) : null;
        const start = cursorId === null ? 0 : rows.findIndex((row) => row.id === cursorId) + 1;
        expect(start, 'cursor names a row that exists').toBeGreaterThanOrEqual(0);
        return { rows: rows.slice(start, start + limit) };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return { executor: inst, scans };
}

it('walks a ledger larger than one page in keyset pages, and reports a complete pass', async () => {
  const rows = ledger(1_200);
  const { executor: exec, scans } = executor(rows);

  const outcome = await applyCashRulesForOwner(exec, USER);

  expect(outcome).toEqual({ movementsTagged: 1_200, complete: true });
  // 500 + 500 + 200: three pages, and the short one ends the walk without a
  // fourth round trip to prove the ledger is exhausted.
  expect(scans).toHaveLength(3);
  for (const scan of scans) {
    expect(scan.text).toContain('LIMIT');
    expect(Number(scan.params.at(-1))).toBe(500);
  }
  // The first page is unanchored; every later one carries the previous page's
  // last row as its cursor, on both halves of the tie-break.
  expect(scans[0]!.text).not.toContain('("executed_at", "id") <');
  expect(scans[1]!.params[2]).toBe(rows[499]!.id);
  expect(scans[1]!.params[1]).toBe(rows[499]!.cursorExecutedAt);
  expect(scans[2]!.params[2]).toBe(rows[999]!.id);
});

it('stops at the scan bound and says the pass was partial', async () => {
  const rows = ledger(CASH_RULE_APPLY_MOVEMENT_SCAN_MAX + 1_000);
  const { executor: exec, scans } = executor(rows);

  const outcome = await applyCashRulesForOwner(exec, USER);

  expect(outcome.complete).toBe(false);
  // Exactly the bound was read — no page overshoots it, and the count reported
  // is the work actually done rather than the ledger's size.
  const scanned = scans.reduce((total, scan) => total + Number(scan.params.at(-1)), 0);
  expect(scanned).toBe(CASH_RULE_APPLY_MOVEMENT_SCAN_MAX);
  expect(outcome.movementsTagged).toBe(CASH_RULE_APPLY_MOVEMENT_SCAN_MAX);
});

it('reads nothing at all when the owner has no rules', async () => {
  const { executor: exec, scans } = executor(ledger(10));
  const noRules: RuleTagStampExecutor = {
    async execute(query: ReturnType<typeof sqlTag>) {
      const { sql: text } = dialect.sqlToQuery(query);
      if (text.includes('FROM "cash_rules"')) return { rows: [] };
      return exec.execute(query);
    },
  };

  expect(await applyCashRulesForOwner(noRules, USER)).toEqual({
    movementsTagged: 0,
    complete: true,
  });
  expect(scans).toHaveLength(0);
});
