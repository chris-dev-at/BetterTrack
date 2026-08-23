import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractRowFields, understandTable } from '../columnMapping';
import { parseCsv } from '../csv';
import { georgeMapper } from '../mappers/george';
import { tradeRepublicMapper } from '../mappers/tradeRepublic';
import { classifyRows, type ClassifiableRow, type ClassifiedKind } from '../rowClassifier';
import { parseLocalizedDecimal } from '../table';

/**
 * The classifier against the repo's OWN committed fixtures, end to end:
 * slice A's `understandTable` sniffs and maps the real CSV, this projects each
 * data row into a {@link ClassifiableRow} exactly as the wizard will, and the
 * cascade classifies it with NO ai seam configured.
 *
 * This file exists because its absence is the root cause of a shipped defect,
 * not as extra coverage. The unit suite next door had 41 green tests written
 * against synthetic rows, and not one row came from `fixtures/*.csv` — so
 * `fixtures/flatex-cash.csv` line 3, `Ertragsgutschrift DE0001234567 Muster Tech
 * AG`, classified as an unreviewed `deposit` (contributed capital, excluded from
 * return, invisible to the tax report) while the suite stayed green. A synthetic
 * row can be written to match the implementation; a committed fixture cannot.
 *
 * Every row of every fixture is pinned — kind AND `needsReview` — so a row
 * drifting into review (unattended operation lost) or out of it (a guess booked
 * silently) both fail here.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string): string => readFileSync(path.join(fixtureDir, name), 'utf8');

/** Project a sniffed+mapped fixture into the classifier's input rows. */
function classifiableRows(buffer: Buffer, filename: string): ClassifiableRow[] {
  const understood = understandTable(buffer, filename);
  expect(understood, filename).not.toBeNull();
  const { table, mapping } = understood!;
  const decimal = (raw: string | undefined): number | null =>
    raw === undefined || raw.trim() === '' ? null : parseLocalizedDecimal(raw, table.numberLocale);
  const text = (raw: string | undefined): string | null =>
    raw === undefined || raw.trim() === '' ? null : raw.trim();

  return table.rows.map((cells) => {
    const raw = extractRowFields(mapping, cells);
    return {
      text: text(raw.description),
      kindHint: text(raw.kindHint),
      quantity: decimal(raw.quantity),
      price: decimal(raw.price),
      amount: decimal(raw.amount),
      symbol: text(raw.symbol),
      isin: text(raw.isin),
    };
  });
}

/** `[kind, needsReview]` per data row, in file order. */
type ExpectedRow = readonly [ClassifiedKind, boolean];

const EXPECTED: Record<string, readonly ExpectedRow[]> = {
  // Every row settles deterministically from the declared `Typ` column, EXCEPT
  // the last: `Auszahlung;250,00` prints an UNSIGNED magnitude, so the declared
  // withdrawal and the positive amount disagree. The kind stays right and the
  // row is flagged — the loud refusal, not a silently inverted booking.
  'trade-republic.csv': [
    ['deposit', false],
    ['buy', false],
    ['buy', false],
    ['dividend', false],
    ['sell', false],
    ['deposit', false], // Zinsen — interest, booked as an external deposit
    ['withdrawal', true], // unsigned Betrag contradicts the declared Auszahlung
  ],
  // `Auftragsart` carries Kauf/Verkauf/Ertrag; the Ertrag row has a Stück count
  // but no Kurs, so it is not trade-shaped and the declared hint decides.
  'george.csv': [
    ['buy', false],
    ['buy', false],
    ['dividend', false],
    ['sell', false],
  ],
  // Trade shape plus a `Buchungsinformationen` memo that AGREES with it.
  'flatex-securities.csv': [
    ['buy', false],
    ['buy', false],
    ['sell', false],
  ],
  // Line 3 is the shipped defect: `Ertragsgutschrift …` used to book as an
  // unreviewed `deposit` because the dividend group had no `ertrag` term and
  // `gutschrift` in the deposit group matched first.
  'flatex-cash.csv': [
    ['deposit', false],
    ['dividend', false],
    ['withdrawal', false],
  ],
  // A pure bank statement: the memo is a merchant name, so nothing but the
  // amount sign speaks. Provisional and flagged — honest, not resolved.
  'erste-george.csv': [
    ['withdrawal', true],
    ['withdrawal', true],
    ['deposit', true],
    ['withdrawal', true],
  ],
  'raiffeisen-elba.csv': [
    ['withdrawal', true],
    ['withdrawal', true],
    ['deposit', true],
  ],
  // Row 1's `Direct Debit` type resolves; `MasterCard Payment` and `Income` are
  // vocabulary the table does not carry, so those two stay provisional.
  'n26.csv': [
    ['withdrawal', true],
    ['withdrawal', false],
    ['deposit', true],
  ],
  'revolut.csv': [
    ['withdrawal', true],
    ['withdrawal', true],
    ['deposit', false], // TOPUP is a canonical hint token
  ],
};

describe('the committed fixtures, classified end to end (sniff → map → classify)', () => {
  for (const [fixture, expected] of Object.entries(EXPECTED)) {
    it(`classifies every row of ${fixture}`, async () => {
      const rows = classifiableRows(Buffer.from(readFixture(fixture), 'utf8'), fixture);
      expect(rows, fixture).toHaveLength(expected.length);
      const results = await classifyRows(rows);

      expect(results.map((result) => result.kind)).toEqual(expected.map(([kind]) => kind));
      expect(results.map((result) => result.needsReview)).toEqual(
        expected.map(([, review]) => review),
      );
      // A resolved row must be resolved for a REASON that clears the bar; a
      // flagged row must not be sitting just under it by accident.
      for (const [i, result] of results.entries()) {
        if (expected[i]![1]) continue;
        expect(result.confidence, `${fixture} row ${i}`).toBeGreaterThanOrEqual(0.8);
      }
    });
  }

  it('spends zero model calls on any fixture — the deterministic stages carry them', async () => {
    let calls = 0;
    const seam = {
      complete: async () => {
        calls += 1;
        return { text: 'NEVER', model: 'stub' };
      },
    };
    for (const fixture of Object.keys(EXPECTED)) {
      const rows = classifiableRows(Buffer.from(readFixture(fixture), 'utf8'), fixture);
      await classifyRows(rows, { ai: seam });
    }
    // Some rows ARE ambiguous (bare merchant memos) and would legitimately
    // reach stage 3 — but only the rows this file pins as needsReview.
    expect(calls).toBe(
      Object.values(EXPECTED).filter((rows) => rows.some(([, review]) => review)).length,
    );
  });
});

/**
 * The IBKR Activity Statement is MULTI-SECTION: one physical file holds several
 * tables. `fixtureParity.test.ts` slices it the same way; the classifier has to
 * hold on each section, including the `Total` summary rows the sniffer flags.
 */
describe('the IBKR multi-section statement, per section', () => {
  const raw = readFixture('ibkr.csv');

  function section(name: string): Buffer {
    const lines = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${name},`) && /,(Header|Data),/.test(line))
      .map((line) => line.slice(line.indexOf(',', line.indexOf(',') + 1) + 1));
    return Buffer.from(lines.join('\n'), 'utf8');
  }

  const SECTIONS: Record<string, readonly ExpectedRow[]> = {
    Trades: [
      ['buy', false],
      ['buy', false],
      ['sell', false], // negative Quantity + positive Proceeds
    ],
    Dividends: [
      ['dividend', false],
      ['deposit', true], // the section Total row — flagged, never booked as income
    ],
    'Deposits & Withdrawals': [
      ['deposit', true], // `Cash Transfer SEPA` — no vocabulary hit, sign only
      ['withdrawal', true], // `Disbursement`
      ['deposit', true], // the section Total row
    ],
  };

  for (const [name, expected] of Object.entries(SECTIONS)) {
    it(`classifies the ${name} section`, async () => {
      const rows = classifiableRows(section(name), 'ibkr.csv');
      const results = await classifyRows(rows);
      expect(results.map((result) => result.kind)).toEqual(expected.map(([kind]) => kind));
      expect(results.map((result) => result.needsReview)).toEqual(
        expected.map(([, review]) => review),
      );
    });
  }
});

/**
 * Parity with the shipped hardcoded mappers. Those mappers ARE the reviewed
 * definition of what each fixture row means; the generic cascade reproducing
 * them without a per-broker branch is the acceptance criterion (§16 2026-07-31).
 */
describe('parity — the generic cascade agrees with the hardcoded broker mappers', () => {
  it('trade-republic: same kind per row as tradeRepublicMapper', async () => {
    const rows = classifiableRows(Buffer.from(readFixture('trade-republic.csv'), 'utf8'), 'tr.csv');
    const results = await classifyRows(rows);
    const lines = tradeRepublicMapper.map(parseCsv(readFixture('trade-republic.csv')));
    expect(lines.every((line) => line.ok)).toBe(true);
    lines.forEach((line, i) => {
      if (!line.ok) return;
      expect(results[i]!.kind, `row ${i}`).toBe(line.row.kind);
    });
  });

  it('george: same kind per row as georgeMapper', async () => {
    const rows = classifiableRows(Buffer.from(readFixture('george.csv'), 'utf8'), 'george.csv');
    const results = await classifyRows(rows);
    const lines = georgeMapper.map(parseCsv(readFixture('george.csv')));
    expect(lines.every((line) => line.ok)).toBe(true);
    lines.forEach((line, i) => {
      if (!line.ok) return;
      expect(results[i]!.kind, `row ${i}`).toBe(line.row.kind);
    });
  });
});
