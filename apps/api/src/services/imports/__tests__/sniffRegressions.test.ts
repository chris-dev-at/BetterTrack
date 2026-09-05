import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { countUnquoted, splitCells } from '../csv';
import { mapColumns, understandTable } from '../columnMapping';
import {
  isAmbiguousGroupedNumber,
  parseLocalizedDay,
  parseLocalizedDecimal,
  sniffFlagsByRow,
  sniffTable,
  tallyNumberLocale,
  type SniffedTable,
  type TableIssueKind,
} from '../table';

/**
 * The regressions the first hardening round introduced, and the rulings that
 * came with them (S1–S7). Every test here fails on `b76c4eae` — the commit that
 * closed the original seven defects — and each one is the acceptance criterion
 * for its fix. The shared failure mode is unchanged from that round: a
 * confidently wrong answer, or data disappearing with `issues: []`.
 */

const buf = (text: string): Buffer => Buffer.from(text, 'utf8');

const kinds = (table: SniffedTable | null, kind: TableIssueKind): SniffedTable['issues'] =>
  (table?.issues ?? []).filter((issue) => issue.kind === kind);

// --- S1: quote-aware record splitting deleted bookings and moved amounts -----

describe('S1 — a stray inch mark never merges two bookings into one', () => {
  const INCHES = [
    'Date,Description,Amount',
    '2024-01-15,27" Monitor,-100.00',
    '2024-01-16,30" TV,-200.00',
    '2024-01-17,Book,-10.00',
  ].join('\n');

  it('keeps all three rows with their own amounts', () => {
    // The measured regression: the two odd-quote lines flipped record state on
    // and off again, so lines 2 and 3 became ONE record whose three cells still
    // matched the header. The 15 Jan booking came back at -200.00 (the 16 Jan
    // amount), the 16 Jan booking was gone, and `issues` was empty.
    const table = sniffTable(buf(INCHES), 'inches.csv');
    expect(table?.rows).toEqual([
      ['2024-01-15', '27" Monitor', '-100.00'],
      ['2024-01-16', '30" TV', '-200.00'],
      ['2024-01-17', 'Book', '-10.00'],
    ]);
    expect(table?.lineNumbers).toEqual([2, 3, 4]);
    expect(table?.issues).toEqual([]);
  });

  it('carries the right amount into every mapped row', () => {
    const { table, mapping } = understandTable(buf(INCHES), 'inches.csv')!;
    const amount = mapping.fieldWinners.amount!.index;
    expect(
      table.rows.map((row) => parseLocalizedDecimal(row[amount]!, table.numberLocale)),
    ).toEqual([-100, -200, -10]);
  });

  it.each([2, 4, 6, 8])(
    'does not halve the file when it carries %s inch marks (an EVEN count)',
    (marks: number) => {
      // An even number of odd-quote lines was the silent case: the state
      // flipped back before EOF, so nothing was ever reported.
      const rows = Array.from(
        { length: marks },
        (_unused, i) => `2024-01-${String(i + 10).padStart(2, '0')},${20 + i}" Screen,-${i + 1}.00`,
      );
      const table = sniffTable(buf(['Date,Description,Amount', ...rows].join('\n')), 'many.csv');
      expect(table?.rows).toHaveLength(marks);
      expect(table?.issues).toEqual([]);
    },
  );

  it('leaves a properly quoted field containing the delimiter untouched', () => {
    // Verified working before the fix — this is the regression guard for it.
    for (const [text, expected] of [
      ['Date,Description,Amount\n2024-01-16,"ACME, Inc.",-42.50', ['ACME, Inc.']],
      ['Datum;Text;Betrag\n15.01.2024;"Kauf; Teilausführung";-42,50', ['Kauf; Teilausführung']],
      ['Date,Description,Amount\n2024-01-16,"He said ""hi""",-1.00', ['He said "hi"']],
    ] as const) {
      const table = sniffTable(buf(text), 'quoted.csv');
      expect(table?.rows[0]?.[1], text).toBe(expected[0]);
      expect(table?.issues, text).toEqual([]);
    }
  });

  it('still stitches a quoted field that really does span lines', () => {
    const table = sniffTable(
      buf(
        [
          'Datum;Beschreibung;Anzahl;Kurs;Betrag',
          '15.01.2024;"Beispiel ETF',
          'Vorzugsaktie";10;50,00;-505,90',
          '16.01.2024;Anderes Papier;5;10,00;-50,00',
        ].join('\n'),
      ),
      'embedded.csv',
    );
    expect(table?.rows[0]?.[1]).toBe('Beispiel ETF\nVorzugsaktie');
    expect(table?.rows).toHaveLength(2);
    expect(table?.issues).toEqual([]);
  });

  it('refuses to trust a field-start quote that closes in the middle of a field', () => {
    // The residual malformed shape: both quotes ARE at field start, so RFC
    // reading opens and closes them — but the close is followed by text, which
    // is exactly how the two-line merge would sneak back in. Loud fallback.
    const table = sniffTable(
      buf(
        [
          'Date,Description,Amount',
          '2024-01-15,"27 Monitor,-100.00',
          '2024-01-16,"30 TV,-200.00',
        ].join('\n'),
      ),
      'merge.csv',
    );
    expect(kinds(table, 'unbalanced-quote')).toHaveLength(1);
    // Both bookings stay visible under the physical-line reading.
    expect(table?.rows).toHaveLength(2);
  });

  describe('the two quote scanners agree, by construction', () => {
    it('splitCells opens a field only at field start', () => {
      expect(splitCells('2024-01-15,27" Monitor,-100.00', ',')).toEqual([
        '2024-01-15',
        '27" Monitor',
        '-100.00',
      ]);
      expect(splitCells('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
      // Padding before the opening quote still counts as field start.
      expect(splitCells('a,  "b,c"  ,d', ',')).toEqual(['a', 'b,c', 'd']);
      // A quote after a field's closing quote is literal, not a re-opening.
      expect(splitCells('a,"b"c",d', ',')).toEqual(['a', 'bc"', 'd']);
    });

    it('countUnquoted counts the same way', () => {
      expect(countUnquoted('2024-01-15,27" Monitor,-100.00', ',')).toBe(2);
      expect(countUnquoted('a,"b,c",d', ',')).toBe(2);
      expect(countUnquoted('a,  "b,c"  ,d', ',')).toBe(2);
    });
  });
});

// --- S2: one stray byte re-decoded the whole file ---------------------------

/** A UTF-8 German export with ONE legacy Windows-1252 byte spliced into it. */
function germanExportWithStrayByte(stray: number, memo: [string, string]): Buffer {
  return Buffer.concat([
    Buffer.from('Datum;Wertpapier;Stück;Kurs;Gebühr;Betrag\n', 'utf8'),
    Buffer.from('15.01.2024;Beispiel ETF;10;50,00;1,50;-505,90\n', 'utf8'),
    Buffer.from(`16.01.2024;${memo[0]}`, 'utf8'),
    Buffer.from([stray]),
    Buffer.from(`${memo[1]};5;50,00;1,50;-251,50\n`, 'utf8'),
    Buffer.from('17.01.2024;Beispiel ETF;2;50,00;1,50;-101,50\n', 'utf8'),
  ]);
}

describe('S2 — one legacy byte does not mojibake the whole file', () => {
  it('keeps every UTF-8 character and still recovers the stray byte', () => {
    // The measured regression: a single 0x92 made the fatal decode fail, the
    // WHOLE buffer was re-read as cp1252, `Stück`/`Gebühr` became
    // `StÃ¼ck`/`GebÃ¼hr`, both landed in `unmapped`, and quantity and fee
    // dropped out of `fieldWinners` — finding 6's loss in reverse.
    const { table, mapping } = understandTable(
      germanExportWithStrayByte(0x92, ['Broker', 's Note']),
      'mixed.csv',
    )!;
    expect(table.headers).toEqual(['Datum', 'Wertpapier', 'Stück', 'Kurs', 'Gebühr', 'Betrag']);
    expect(mapping.fieldWinners.quantity?.header).toBe('Stück');
    expect(mapping.fieldWinners.fee?.header).toBe('Gebühr');
    expect(mapping.unmapped).toEqual([]);
    // 0x92 is a Windows-1252 right single quote — recovered, not lost.
    expect(table.rows[1]?.[1]).toBe('Broker’s Note');
    expect(table.encoding).toBe('utf-8');
  });

  it('says so anyway — the cp1252 reading of that byte is an inference', () => {
    const table = sniffTable(germanExportWithStrayByte(0x92, ['Broker', 's Note']), 'mixed.csv');
    const issue = kinds(table, 'encoding-fallback')[0];
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/Windows-1252/);
  });

  it('repairs a legacy byte sitting NEXT TO a UTF-8 character on the same line', () => {
    // Per-line fallback would still mojibake this line's `ü`; per-byte does not.
    const { table } = understandTable(
      germanExportWithStrayByte(0x92, ['Müller', 's Fonds']),
      'mixed-line.csv',
    )!;
    expect(table.rows[1]?.[1]).toBe('Müller’s Fonds');
  });

  it('still recovers a file that is legacy THROUGHOUT', () => {
    const latin1 = Buffer.from(
      [
        'Datum;Wertpapier;Stück;Kurs;Gebühr;Betrag',
        '15.01.2024;Beispiel ETF;10;50,00;1,50;-505,90',
        '16.01.2024;Beispiel ETF;5;50,00;1,50;-251,50',
      ].join('\n'),
      'latin1',
    );
    const { table, mapping } = understandTable(latin1, 'latin1.csv')!;
    expect(table.encoding).toBe('windows-1252');
    expect(table.headers).toEqual(['Datum', 'Wertpapier', 'Stück', 'Kurs', 'Gebühr', 'Betrag']);
    expect(mapping.unmapped).toEqual([]);
    expect(kinds(table, 'encoding-fallback')).toHaveLength(1);
  });

  it.each([
    ['CJK', '証券コード'],
    ['emoji', '📈 ETF'],
    ['combining marks', 'Amélie SICAV'],
    ['astral plane', '𝕏 Holdings'],
  ])('never touches valid-but-unusual UTF-8 (%s)', (_name: string, value: string) => {
    const table = sniffTable(
      buf(`Datum;Wertpapier;Betrag\n15.01.2024;${value};-505,90`),
      'utf8.csv',
    );
    expect(table?.encoding).toBe('utf-8');
    expect(table?.rows[0]?.[1]).toBe(value);
    expect(kinds(table, 'encoding-fallback')).toEqual([]);
  });

  it.each([
    ['overlong', [0xc0, 0x80]],
    ['bare continuation', [0x80]],
    ['UTF-16 surrogate', [0xed, 0xa0, 0x80]],
    ['above U+10FFFF', [0xf5, 0x80, 0x80, 0x80]],
    ['truncated 3-byte', [0xe2, 0x82]],
  ])(
    'treats %s bytes as legacy without corrupting their neighbours',
    (_name: string, bytes: number[]) => {
      const table = sniffTable(
        Buffer.concat([
          Buffer.from('Datum;Wertpapier;Betrag\n15.01.2024;Grün ', 'utf8'),
          Buffer.from(bytes),
          Buffer.from(' Fonds;-505,90\n', 'utf8'),
        ]),
        'broken.csv',
      );
      // The valid `ü`-class character on the same line survives untouched…
      expect(table?.rows[0]?.[1]).toMatch(/^Grün /);
      expect(table?.rows[0]?.[1]).toMatch(/ Fonds$/);
      expect(table?.rows[0]?.[2]).toBe('-505,90');
      // …and the file is never presented as a clean read.
      expect(kinds(table, 'encoding-fallback')).toHaveLength(1);
    },
  );
});

// --- S3: the ambiguous-number refusal had no issue kind ---------------------

describe('S3 — an unreadable grouped number is reported, not silently null', () => {
  const ENGLISH_AMBIGUOUS = [
    'Date,Description,Quantity,Amount',
    '2024-01-15,ACME Inc,"1,250",-100.00',
    '2024-01-16,ACME Inc,"2,750",-200.00',
    '2024-01-17,ACME Inc,500,-10.00',
  ].join('\n');

  it('raises ambiguous-grouped-number pointing at the offending column', () => {
    // The measured regression: 0.95 confidence, `needsReview: false`,
    // `unmapped: []`, `issues: []` — while two of three share counts were null.
    const table = sniffTable(buf(ENGLISH_AMBIGUOUS), 'qty.csv');
    const issues = kinds(table, 'ambiguous-grouped-number');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.column).toBe(2);
    expect(issues[0]?.row).toBe(0);
    expect(issues[0]?.line).toBe(2);
    expect(issues[0]?.message).toContain('Quantity');
  });

  it('forces needsReview on that column so no caller books it unattended', () => {
    const { table, mapping } = understandTable(buf(ENGLISH_AMBIGUOUS), 'qty.csv')!;
    const quantity = mapping.mappings.find((m) => m.field === 'quantity');
    expect(quantity?.needsReview).toBe(true);
    expect(mapping.fieldWinners.quantity?.needsReview).toBe(true);
    // The values really are unreadable — that is why the flag has to exist.
    const index = mapping.fieldWinners.quantity!.index;
    expect(table.rows.map((r) => parseLocalizedDecimal(r[index]!, table.numberLocale))).toEqual([
      null,
      null,
      500,
    ]);
    // …while columns the file CAN read stay unflagged.
    expect(mapping.mappings.find((m) => m.field === 'amount')?.needsReview).toBe(false);
  });

  it('scopes the ROW flag to the columns something is actually read from', () => {
    // An `Exchange Rate` column is aliased to `ignore` — no value is ever taken
    // from it — yet `1.092` is an unreadable grouping under `en`, so every row
    // of a real month was demoted to one-by-one manual confirmation citing a
    // column nothing reads. The column ISSUE stays (the mapper reads it to mark
    // the column reviewed); what may not survive is the per-row demand.
    const { table, mapping } = understandTable(
      buf(
        [
          'Date,Payee,Transaction type,Amount,Exchange Rate',
          '2024-01-10,Netflix,Direct Debit,-12.99,1.092',
          '2024-01-11,Spar,Card Payment,-31.40,1.087',
        ].join('\n'),
      ),
      'fx.csv',
    )!;
    const issue = kinds(table, 'ambiguous-grouped-number');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.column).toBe(4);
    expect(mapping.ignoredColumns).toContain(4);
    // Unscoped, both rows still carry the flag…
    expect(sniffFlagsByRow(table).get(0)).toEqual(['ambiguous-grouped-number']);
    // …and a reader that knows the mapping sees nothing to review.
    const scoped = sniffFlagsByRow(table, { ignoredColumns: new Set(mapping.ignoredColumns) });
    expect(scoped.get(0)).toBeUndefined();
    expect(scoped.get(1)).toBeUndefined();
  });

  it('keeps the row flag when a READ column is the ambiguous one', () => {
    // The same scoping must not be a way to lose the flag that matters: here
    // the unreadable grouping is in `Quantity`, which the mapper reads.
    const { table, mapping } = understandTable(buf(ENGLISH_AMBIGUOUS), 'qty.csv')!;
    expect(mapping.ignoredColumns).toEqual([]);
    const scoped = sniffFlagsByRow(table, { ignoredColumns: new Set([4]) });
    expect(scoped.get(0)).toEqual(['ambiguous-grouped-number']);
    expect(scoped.get(1)).toEqual(['ambiguous-grouped-number']);
  });

  it('does not flag the same values in the notation that CAN read them', () => {
    // `1,250` is unambiguous German: 1.25. A German file must stay quiet.
    const { table, mapping } = understandTable(
      buf(
        [
          'Datum;Wertpapier;Stück;Betrag',
          '15.01.2024;Beispiel ETF;1,250;-100,00',
          '16.01.2024;Beispiel ETF;2,750;-220,00',
        ].join('\n'),
      ),
      'de-qty.csv',
    )!;
    expect(table.numberLocale).toBe('de');
    expect(kinds(table, 'ambiguous-grouped-number')).toEqual([]);
    const index = mapping.fieldWinners.quantity!.index;
    expect(table.rows.map((r) => parseLocalizedDecimal(r[index]!, 'de'))).toEqual([1.25, 2.75]);
  });

  it('flags the mirror form `1.000`, which NEITHER notation can read', () => {
    for (const [name, text] of [
      ['en', 'Date,Description,Quantity,Amount\n2024-01-15,A,1.000,-10.00'],
      ['de', 'Datum;Text;Stück;Betrag\n15.01.2024;A;1.000;-10,00'],
    ] as const) {
      const table = sniffTable(buf(text), `${name}.csv`);
      expect(kinds(table, 'ambiguous-grouped-number'), name).toHaveLength(1);
    }
  });

  it('never fires on ordinary readable values', () => {
    expect(isAmbiguousGroupedNumber('1,234.56', 'en')).toBe(false);
    expect(isAmbiguousGroupedNumber('1.234,56', 'de')).toBe(false);
    expect(isAmbiguousGroupedNumber('-505,90', 'de')).toBe(false);
    expect(isAmbiguousGroupedNumber('185.50', 'en')).toBe(false);
    expect(isAmbiguousGroupedNumber('Beispiel ETF', 'de')).toBe(false);
    expect(isAmbiguousGroupedNumber('', 'de')).toBe(false);
    // A calendar day's dots are separators, not grouping.
    expect(isAmbiguousGroupedNumber('15.01.2024', 'en')).toBe(false);
    expect(isAmbiguousGroupedNumber('2024-01-15', 'de')).toBe(false);
  });

  it('leaves mapColumns alone when the caller passes no ambiguous columns', () => {
    const result = mapColumns(['Date', 'Quantity'], [['2024-01-15', '10']], {
      numberLocale: 'en',
    });
    expect(result.mappings.every((m) => !m.needsReview)).toBe(true);
  });
});

// --- S3b: per-row flags a downstream classifier can join on ------------------

describe('S3b — every row-level finding is emitted per row', () => {
  it('exposes row index, physical line and the kinds affecting the row', () => {
    const table = sniffTable(
      buf(
        [
          'Buchtag;Buchungstext;Betrag',
          '02.01.2024;Einzahlung;500,00',
          '31.01.2024;Gehalt;2.500,00',
          'Summe;;450,00',
        ].join('\n'),
      ),
      'summe.csv',
    )!;
    // A summary row is a ROW-level finding, so it names no column — `columns`
    // carries entries only for the column-scoped kinds (see RowFlag.columns).
    expect(table.rowFlags).toEqual([{ row: 2, line: 4, flags: ['summary-row'], columns: {} }]);
    expect(sniffFlagsByRow(table).get(2)).toEqual(['summary-row']);
    expect(sniffFlagsByRow(table).get(0)).toBeUndefined();
  });

  it.each([
    [
      'row-width-mismatch',
      ['Datum;Beschreibung;Anzahl;Kurs;Betrag', '16.01.2024;Beispiel ETF;-80,00'].join('\n'),
    ],
    ['ambiguous-grouped-number', ['Date,Description,Quantity', '2024-01-15,A,"1,250"'].join('\n')],
    ['oversized-cell', `Datum;Text;Betrag\n02.01.2024;${'x'.repeat(5_000)};1,00`],
  ])('emits %s on the row it affects', (kind: string, text: string) => {
    const table = sniffTable(buf(text), 'flag.csv')!;
    expect(table.rowFlags.map((f) => f.row)).toContain(0);
    expect(sniffFlagsByRow(table).get(0)).toContain(kind);
  });

  it('collects several kinds on one row, deduped and sorted', () => {
    const table = sniffTable(
      buf(
        [
          'Buchtag;Buchungstext;Betrag;Extra',
          '02.01.2024;Einzahlung;500,00;x',
          '31.01.2024;Gehalt;2.500,00;x',
          '31.01.2024;Summe;3.000,00',
        ].join('\n'),
      ),
      'both.csv',
    )!;
    expect(sniffFlagsByRow(table).get(2)).toEqual(['row-width-mismatch', 'summary-row']);
  });

  it('stays COMPLETE past the issue cap that bounds the operator-facing list', () => {
    // The cap on `issues` exists so a ragged file cannot emit thousands of
    // messages. Applying it to rowFlags too would leave rows 26+ looking clean
    // to the machine — the confidently-wrong outcome, one layer down.
    const good = Array.from({ length: 40 }, (_u, i) => `0${(i % 9) + 1}.01.2024;T;E;80,00;-1,00`);
    const bad = Array.from({ length: 30 }, (_u, i) => `0${(i % 9) + 1}.02.2024;T;-1,00`);
    const table = sniffTable(
      buf(['Datum;Text;Extra;Kurs;Betrag', ...good, ...bad].join('\n')),
      'ragged.csv',
    )!;
    expect(kinds(table, 'row-width-mismatch')).toHaveLength(26); // 25 + 1 aggregate
    expect(table.rowFlags).toHaveLength(30); // …but every ragged row is flagged
    expect(table.rowFlags.every((f) => f.flags.includes('row-width-mismatch'))).toBe(true);
  });

  it('is empty on a clean file, and never carries the quiet trailing kind', () => {
    expect(
      sniffTable(buf('Datum;Betrag\n15.01.2024;-505,90\n16.01.2024;-80,00'), 'clean.csv')?.rowFlags,
    ).toEqual([]);
    const trailing = sniffTable(
      buf(
        ['Date,Description,Amount,Note', '2024-01-15,A,-100.00,', '2024-01-16,B,-200.00'].join(
          '\n',
        ),
      ),
      'trailing.csv',
    )!;
    expect(kinds(trailing, 'trailing-cells-omitted')).toHaveLength(1);
    expect(trailing.rowFlags).toEqual([]);
  });
});

// --- S4: the row-width kind is split -----------------------------------------

describe('S4 — harmless trailing omissions get their own quieter kind', () => {
  it('does not shout about a row that only drops optional trailing columns', () => {
    const table = sniffTable(
      buf(
        [
          'Date,Description,Amount,Note',
          '2024-01-15,A,-100.00,',
          '2024-01-16,B,-200.00,memo',
          '2024-01-17,C,-10.00',
        ].join('\n'),
      ),
      'trailing.csv',
    );
    expect(kinds(table, 'row-width-mismatch')).toEqual([]);
    const quiet = kinds(table, 'trailing-cells-omitted');
    expect(quiet).toHaveLength(1);
    expect(quiet[0]?.line).toBe(4);
    expect(quiet[0]?.row).toBe(2);
    // Still visible in the preview — flagged quietly, never dropped.
    expect(table?.rows).toHaveLength(3);
  });

  it('stays LOUD when the missing columns are never empty elsewhere', () => {
    // The measured money bug: `-80,00` is the AMOUNT, and under a 5-column
    // header it lands in `Anzahl`. Kurs/Betrag are populated in every full row,
    // so this is not an omission — it is misalignment.
    const table = sniffTable(
      buf(
        [
          'Datum;Beschreibung;Anzahl;Kurs;Betrag',
          '15.01.2024;Beispiel ETF;10;50,00;-505,90',
          '16.01.2024;Beispiel ETF;-80,00',
        ].join('\n'),
      ),
      'ragged.csv',
    );
    expect(kinds(table, 'row-width-mismatch')).toHaveLength(1);
    expect(kinds(table, 'trailing-cells-omitted')).toEqual([]);
  });

  it('stays LOUD when a present value does not fit the label above it', () => {
    // The trailing column IS optional here, but the row's second cell is a
    // number where every full row carries text — something slid left.
    const table = sniffTable(
      buf(
        [
          'Date,Description,Amount,Note',
          '2024-01-15,ACME Inc,-100.00,',
          '2024-01-16,ACME Inc,-200.00,memo',
          '2024-01-17,-10.00,-10.00',
        ].join('\n'),
      ),
      'slid.csv',
    );
    expect(kinds(table, 'row-width-mismatch')).toHaveLength(1);
    expect(kinds(table, 'trailing-cells-omitted')).toEqual([]);
  });

  it('stays LOUD for a row WIDER than the header', () => {
    const table = sniffTable(
      buf(['Datum;Betrag', '15.01.2024;-505,90', '16.01.2024;-80,00;extra'].join('\n')),
      'wide.csv',
    );
    expect(kinds(table, 'row-width-mismatch')).toHaveLength(1);
  });

  it('still surfaces all six genuinely misaligned rows of the repo’s ibkr.csv', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
    const table = sniffTable(readFileSync(path.join(dir, 'ibkr.csv')), 'ibkr.csv');
    expect(kinds(table, 'row-width-mismatch')).toHaveLength(6);
    expect(kinds(table, 'trailing-cells-omitted')).toEqual([]);
  });
});

// --- S5: the two-digit-year guarantee is universal --------------------------

describe('S5 — a two-digit year is reported whatever the detected locale', () => {
  it('reports it in an ISO file carrying one dotted short date', () => {
    // The measured regression: `detectDateLocale`'s ISO branch hard-coded
    // `twoDigitYear: false`, so this file sniffed `iso` with `issues: []` while
    // its short date parsed to null.
    const table = sniffTable(
      buf(
        [
          'Date,Description,Amount',
          '2024-01-15,A,-100.00',
          '2024-01-16,B,-200.00',
          '17.01.24,C,-10.00',
        ].join('\n'),
      ),
      'mixed-years.csv',
    );
    expect(table?.dateLocale).toBe('iso');
    expect(kinds(table, 'two-digit-year')).toHaveLength(1);
    // The value itself is still REFUSED under `iso` — a loud null, not a guess.
    expect(parseLocalizedDay('17.01.24', 'iso')).toBeNull();
  });

  it('recognizes a slash file written entirely with two-digit years', () => {
    // Worse than described before the fix: `SLASH_DAY_SAMPLE` requires `\d{4}`,
    // so this file matched NO date sample at all, fell through to the `iso`
    // default with zero evidence, and every date in it parsed to null.
    const table = sniffTable(
      buf(
        [
          'Date,Description,Amount',
          '01/15/24,A,-100.00',
          '02/20/24,B,-200.00',
          '03/25/24,C,-10.00',
        ].join('\n'),
      ),
      'slash-yy.csv',
    );
    expect(table?.dateLocale).toBe('us');
    expect(table?.dateLocaleAmbiguous).toBe(false);
    expect(kinds(table, 'two-digit-year')).toHaveLength(1);
    expect(
      table?.rows.map((r) => parseLocalizedDay(r[0]!, table.dateLocale)?.toISOString()),
    ).toEqual(['2024-01-15T12:00:00.000Z', '2024-02-20T12:00:00.000Z', '2024-03-25T12:00:00.000Z']);
  });

  it('reads the day-first slash short form as its mirror', () => {
    const table = sniffTable(
      buf(['Date,Description,Amount', '15/02/24,A,-100.00', '20/03/24,B,-200.00'].join('\n')),
      'eu-yy.csv',
    );
    expect(table?.dateLocale).toBe('eu-slash');
    expect(kinds(table, 'two-digit-year')).toHaveLength(1);
    expect(parseLocalizedDay('15/02/24', 'eu-slash')?.toISOString()).toBe(
      '2024-02-15T12:00:00.000Z',
    );
  });

  it('still says nothing about a file whose years are all four digits', () => {
    for (const text of [
      'Date,Description,Amount\n2024-01-15,A,-100.00',
      'Datum;Text;Betrag\n15.01.2024;A;-100,00',
      'Date,Description,Amount\n01/15/2024,A,-100.00\n02/20/2024,B,-2.00',
    ]) {
      expect(kinds(sniffTable(buf(text), 'x.csv'), 'two-digit-year'), text).toEqual([]);
    }
  });
});

// --- S6: never infer a FUTURE year ------------------------------------------

describe('S6 — an inferred century never lands in the future', () => {
  const thisYear = new Date().getUTCFullYear();

  it('reads a year the POSIX pivot would put in the future as the previous century', () => {
    // `15.01.30` booked a transaction four years out — outside every holdings
    // window, with no price history to value it against.
    const future = String((thisYear + 4) % 100).padStart(2, '0');
    const parsed = parseLocalizedDay(`15.01.${future}`, 'de');
    expect(parsed?.getUTCFullYear()).toBe(thisYear + 4 - 100);
  });

  it('still reads the current year and the recent past normally', () => {
    for (const back of [0, 1, 5, 20]) {
      const year = thisYear - back;
      const parsed = parseLocalizedDay(`15.01.${String(year % 100).padStart(2, '0')}`, 'de');
      expect(parsed?.getUTCFullYear(), String(year)).toBe(year);
    }
  });

  it.each(Array.from({ length: 100 }, (_u, i) => String(i).padStart(2, '0')))(
    'never returns a future year for `15.01.%s`',
    (yy: string) => {
      expect(parseLocalizedDay(`15.01.${yy}`, 'de')!.getUTCFullYear()).toBeLessThanOrEqual(
        thisYear,
      );
    },
  );

  it('applies the same rule to the slash short form', () => {
    const future = String((thisYear + 4) % 100).padStart(2, '0');
    expect(parseLocalizedDay(`01/15/${future}`, 'us')!.getUTCFullYear()).toBe(thisYear + 4 - 100);
  });

  it('carries no future-dated row through a whole sniffed file', () => {
    const future = String((thisYear + 3) % 100).padStart(2, '0');
    const { table, mapping } = understandTable(
      buf(
        [
          'Datum;Wertpapier;Betrag',
          `15.01.${future};Beispiel ETF;-100,00`,
          `16.01.${future};Beispiel ETF;-200,00`,
        ].join('\n'),
      ),
      'future.csv',
    )!;
    const date = mapping.fieldWinners.date!.index;
    for (const row of table.rows) {
      const parsed = parseLocalizedDay(row[date]!, table.dateLocale);
      expect(parsed!.getUTCFullYear()).toBeLessThanOrEqual(thisYear);
    }
    expect(kinds(table, 'two-digit-year')).toHaveLength(1);
  });
});

// --- S7: the over-long-record message told the operator something false ------

describe('S7 — each way the quoting can fail says what actually happened', () => {
  const overLong = (lines: number): string =>
    [
      'Date,Description,Amount',
      `2024-01-15,"${Array.from({ length: lines }, (_u, i) => `note ${i}`).join('\n')}",-100.00`,
      '2024-01-16,B,-200.00',
    ].join('\n');

  it('does not claim the quotes fail to pair up when a record is merely long', () => {
    const table = sniffTable(buf(overLong(40)), 'long.csv');
    const issue = kinds(table, 'unbalanced-quote')[0];
    expect(issue).toBeDefined();
    // The old message said "The quote characters in this file do not pair up",
    // which is false: they pair perfectly, the description is just long.
    expect(issue?.message).not.toMatch(/do not pair up/);
    expect(issue?.message).toMatch(/still open|lines later|longer than any real description/i);
    expect(issue?.line).toBe(2);
  });

  it('still says exactly that when a quote really is never closed', () => {
    const table = sniffTable(
      buf(['Date,Description,Amount', '2024-01-15,"never closed,-100.00'].join('\n')),
      'open.csv',
    );
    const issue = kinds(table, 'unbalanced-quote')[0];
    expect(issue?.message).toMatch(/do not pair up|never closed/);
    expect(issue?.line).toBe(2);
  });

  it('names the third case — a closing quote with text after it', () => {
    const table = sniffTable(
      buf(
        [
          'Date,Description,Amount',
          '2024-01-15,"27 Monitor,-100.00',
          '2024-01-16,"30 TV,-200.00',
        ].join('\n'),
      ),
      'badclose.csv',
    );
    const issue = kinds(table, 'unbalanced-quote')[0];
    expect(issue?.message).toMatch(/closing quote/i);
  });

  it('keeps a legitimately long quoted description whole when it fits the bound', () => {
    const table = sniffTable(buf(overLong(8)), 'ok.csv');
    expect(table?.issues).toEqual([]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[0]?.[1]?.split('\n')).toHaveLength(8);
  });
});

// --- The AMBIGUOUS_COMMA_GROUP half-vote, no longer held up by one test ------

describe('the mirror-ambiguous grouped forms each count HALF a vote', () => {
  it('tallies `1,250` and `1.000` as half German and half English', () => {
    // Mutation testing found the half-vote was held up by a SINGLE end-to-end
    // test. Asserting the tally directly kills the mutant outright.
    expect(tallyNumberLocale(['1,250'])).toEqual({ de: 0.5, en: 0.5 });
    expect(tallyNumberLocale(['1.000'])).toEqual({ de: 0.5, en: 0.5 });
    expect(tallyNumberLocale(['1,250', '1.000'])).toEqual({ de: 1, en: 1 });
    // …while the UNAMBIGUOUS grouped forms still vote whole.
    expect(tallyNumberLocale(['1,234.56'])).toEqual({ de: 0, en: 1 });
    expect(tallyNumberLocale(['1.234,56'])).toEqual({ de: 1, en: 0 });
    expect(tallyNumberLocale(['1,234,567'])).toEqual({ de: 0, en: 1 });
    expect(tallyNumberLocale(['-751,00'])).toEqual({ de: 1, en: 0 });
    expect(tallyNumberLocale(['-751.00'])).toEqual({ de: 0, en: 1 });
  });

  it('lets one unambiguous German amount outvote three ambiguous ones', () => {
    // Without the half-vote the three `d,ddd` cells would be three full ENGLISH
    // votes, the file would flip to `en`, and every `Stück` value would come
    // back 1000x high — the exact defect finding 3 closed.
    const table = sniffTable(
      buf(
        [
          'Datum;Stück;Betrag',
          '15.01.2024;1,250;-751,00',
          '16.01.2024;2,750;-100,00',
          '17.01.2024;0,500;-40,00',
        ].join('\n'),
      ),
      'half.csv',
    );
    expect(table?.numberLocale).toBe('de');
    expect(table?.rows.map((r) => parseLocalizedDecimal(r[1]!, 'de'))).toEqual([1.25, 2.75, 0.5]);
  });

  it('keeps a genuinely English file English despite ambiguous groups', () => {
    const table = sniffTable(
      buf(
        ['Date,Quantity,Amount', '2024-01-15,"1,250",-751.00', '2024-01-16,"2,750",-100.00'].join(
          '\n',
        ),
      ),
      'en-half.csv',
    );
    expect(table?.numberLocale).toBe('en');
  });
});
