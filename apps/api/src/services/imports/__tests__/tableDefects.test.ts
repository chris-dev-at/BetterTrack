import { describe, expect, it } from 'vitest';

import { countKnownHeaderAliases, understandTable } from '../columnMapping';
import {
  parseLocalizedDay,
  parseLocalizedDecimal,
  sniffTable,
  trimTrailingPunctuation,
  type NumberLocale,
} from '../table';

/**
 * The seven PROVEN defects of the merged sniffer (#1493 / #964), each of which
 * produced `issues: []` + `needsReview: false` while returning wrong data. Every
 * test here fails on the merged code and is the acceptance criterion for its
 * fix; the silent-confidence combination is what each one kills.
 */

const buf = (text: string): Buffer => Buffer.from(text, 'utf8');

// --- Finding 1: catastrophic regex backtracking (single-upload DoS) ----------

describe('finding 1 — punctuation trimming is linear, not quadratic', () => {
  it('trims a 256k-character punctuation run in well under a second', () => {
    // The merged `/[.,;]+$/` is quadratic on `'.'.repeat(n) + 'x'`: 16k→132ms,
    // 32k→519ms, 64k→2055ms — a clean 4x per doubling. 256k would be ~33s.
    const cell = `${'.'.repeat(256_000)}x`;
    const started = performance.now();
    expect(trimTrailingPunctuation(cell)).toBe(cell);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
  });

  it('scales linearly across doublings instead of 4x per doubling', { timeout: 20_000 }, () => {
    // CHANGED, AND SAID OUT LOUD — this test used to sample `'.'.repeat(n) + 'x'`,
    // the vector that makes the merged `/[.,;]+$/` backtrack. Against the FIXED
    // code that input is O(1): the trailing `x` is not punctuation, so the walk
    // in `trimTrailingFrom` stops on its first step and returns `cell` by
    // reference. Both samples were therefore ~0.01ms of pure timer noise — and
    // because `Math.max(small, 1)` pinned the bound at a flat 8ms whenever
    // `small < 1ms`, which was always, the assertion really read "the large
    // sample must not be interrupted for 8ms". Any GC pause or scheduler
    // preempt on a shared runner failed it; measured ratios on an IDLE machine
    // ranged 1.7x to 25.6x. It failed CI on #1691 at 9.198ms.
    //
    // Appending a trailing punctuation run makes the walk — and its `slice` —
    // do the real O(n) work, so a sample is milliseconds instead of
    // microseconds, while the LEADING run keeps the regex's catastrophic
    // backtracking fully intact. Re-measured against `/[.,;]+$/` on this exact
    // input: 8k→31ms, 16k→126ms, 32k→496ms — still a clean 4x per doubling, so
    // this still fails on the merged code it was written to kill.
    const cell = (n: number): string => `${'.'.repeat(n)}x${'.'.repeat(n)}`;
    const trimmed = (n: number): string => `${'.'.repeat(n)}x`;

    // Fail FAST if the quadratic form ever comes back: one call at 128k costs
    // 0.4ms linear against 9.7s quadratic, so 100ms is unreachable by machine
    // noise from either side. Without this the timing loop below would grind
    // for ~16 minutes before the suite timed out.
    const big = cell(128_000);
    const startedOne = performance.now();
    expect(trimTrailingPunctuation(big)).toBe(trimmed(128_000));
    expect(performance.now() - startedOne).toBeLessThan(100);

    // `min` over repeats is the right estimator for "what does this cost":
    // interference can only ever ADD time, so the fastest observed run is the
    // one closest to the true cost.
    const best = (n: number): number => {
      const input = cell(n);
      let sink = 0;
      const once = (): number => {
        const started = performance.now();
        for (let i = 0; i < 100; i++) sink += trimTrailingPunctuation(input).length;
        return performance.now() - started;
      };
      once(); // warm up the JIT so the first sample is not an outlier
      const samples = [once(), once(), once()];
      expect(sink).toBeGreaterThan(0); // the work is observed, never optimized away
      return Math.min(...samples);
    };

    const small = best(32_000);
    const large = best(128_000);
    // Guard the measurement before trusting it. A sample too small to rise
    // above timer granularity makes the ratio meaningless — that is precisely
    // how the previous version stopped testing anything without saying so. If
    // a faster machine ever trips this, raise the iteration count in `best`.
    expect(small).toBeGreaterThan(1);
    // 4x the input. Quadratic ⇒ ~16x the time; linear ⇒ ~4x. Allow a very
    // generous 8x so this measures the COMPLEXITY CLASS, not the machine.
    // Measured 3.98x–4.03x across 20 trials, both samples tens of ms.
    expect(large).toBeLessThan(small * 8);
  });

  it(
    'sniffs a file full of punctuation runs without pinning the worker',
    { timeout: 20_000 },
    () => {
      // The reviewer's end-to-end repro, scaled down: 60 rows x 16000 dots.
      // On the merged code every cell costs ~132ms in EACH of five trimming
      // call sites, so this file takes ~40s and blows the timeout below.
      const cell = `${'.'.repeat(16_000)}x`;
      const rows = Array.from(
        { length: 60 },
        (_unused, i) => `0${(i % 9) + 1}.01.2024;${cell};1,00`,
      );
      const started = performance.now();
      const table = sniffTable(buf(['Datum;Text;Betrag', ...rows].join('\n')), 'dots.csv');
      const elapsed = performance.now() - started;
      expect(table?.rows).toHaveLength(60);
      expect(elapsed).toBeLessThan(3_000);
    },
  );

  it(
    'sniffs a summary-word row carrying a punctuation run without pinning the worker',
    { timeout: 20_000 },
    () => {
      // `rowHasSummaryWord`'s own `/[.:;]+$/` is the second quadratic site.
      const cell = `${':'.repeat(200_000)}x`;
      const started = performance.now();
      const table = sniffTable(
        buf(
          [
            'Buchtag;Buchungstext;Betrag',
            '02.01.2024;Einzahlung;500,00',
            `Summe;${cell};450,00`,
          ].join('\n'),
        ),
        'summe-dots.csv',
      );
      const elapsed = performance.now() - started;
      expect(table?.rows).toHaveLength(2);
      expect(elapsed).toBeLessThan(3_000);
    },
  );

  it('normalizes a header padded with whitespace in linear time', { timeout: 20_000 }, () => {
    // A THIRD site of the same class, found while fixing the two reported ones:
    // `normalizeHeader`'s `/^["'\s]+|["'\s]+$/g` is quadratic on
    // `'a' + ' '.repeat(n) + 'x'` (measured 4k→24ms, 8k→104ms, 16k→418ms,
    // 32k→1535ms). `countKnownHeaderAliases` runs it over every cell of every
    // modal-width row, so the sniffer reaches it on any upload.
    const padded = `a${' '.repeat(200_000)}x`;
    const started = performance.now();
    expect(countKnownHeaderAliases([padded, 'Betrag'])).toBe(1);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('caps oversized cells with a LOUD issue instead of parsing them silently', () => {
    const table = sniffTable(
      buf(`Datum;Text;Betrag\n02.01.2024;${'x'.repeat(50_000)};1,00`),
      'huge-cell.csv',
    );
    const issue = table?.issues.find((i) => i.kind === 'oversized-cell');
    expect(issue).toBeDefined();
    expect(issue?.line).toBe(2);
    // The row is still visible — flagged, never silently dropped.
    expect(table?.rows).toHaveLength(1);
  });
});

// --- Finding 2: the 1000x guard is defeated by currency decoration -----------

/**
 * Value x locale x decoration, asserting EXACT outputs. The merged guard passed
 * its tests precisely because it was only ever shown four BARE strings, while
 * `parseDecimal` strips currency symbols/letters before the guard could see
 * them: `parseLocalizedDecimal('1,234.56 EUR','de')` returned 1.23456.
 */
const DECORATIONS: readonly ((v: string) => string)[] = [
  (v) => v,
  (v) => `${v} EUR`,
  (v) => `${v} USD`,
  (v) => `${v} €`,
  (v) => `${v}€`,
  (v) => (v.startsWith('-') ? `-$${v.slice(1)}` : `$${v}`),
  (v) => (v.startsWith('-') ? `-€${v.slice(1)}` : `€${v}`),
  (v) => `  ${v} CHF  `,
];

/** [value, expected under `de`, expected under `en`]. */
const DECIMAL_VECTORS: readonly (readonly [string, number | null, number | null])[] = [
  // Unmistakably ENGLISH grouping: refused under `de` (it would read 1/1000th),
  // parsed under `en`.
  ['1,234.56', null, 1234.56],
  ['12,345.67', null, 12345.67],
  ['1,234,567.89', null, 1234567.89],
  ['-9,999.99', null, -9999.99],
  ['-1,234.56', null, -1234.56],
  // Unmistakably GERMAN grouping: the mirror image.
  ['1.234,56', 1234.56, null],
  ['12.345,67', 12345.67, null],
  ['1.234.567,89', 1234567.89, null],
  ['-9.999,99', -9999.99, null],
  // Plain notation — no grouping separator at all.
  ['1234.56', 1234.56, 1234.56],
  ['-751.00', -751, -751],
  ['1234,56', 1234.56, null],
  ['-751,00', -751, null],
  ['0.5', 0.5, 0.5],
  ['0,5', 0.5, null],
  // Mirror-ambiguous integers: refused in the locale that cannot tell them
  // apart from the other notation's decimal (see finding 3).
  ['1.000', null, null],
  ['1,000', 1, null],
  ['1,250', 1.25, null],
  // Multi-group integers are unambiguous — only ENGLISH can produce them.
  ['1,234,567', null, 1234567],
];

describe('finding 2 — the 1000x guard survives currency decoration', () => {
  for (const [value, deExpected, enExpected] of DECIMAL_VECTORS) {
    for (const decorate of DECORATIONS) {
      const decorated = decorate(value);
      it(`${JSON.stringify(decorated)} → de=${deExpected} en=${enExpected}`, () => {
        expect(parseLocalizedDecimal(decorated, 'de'), 'de').toBe(deExpected);
        expect(parseLocalizedDecimal(decorated, 'en'), 'en').toBe(enExpected);
      });
    }
  }

  it('never returns a thousandth of a decorated English amount under `de`', () => {
    // The exact reported regression, restated as its own guard.
    for (const decorated of ['1,234.56 EUR', '$1,234.56', '1,234.56 €', '1,234.56 USD']) {
      expect(parseLocalizedDecimal(decorated, 'de'), decorated).not.toBe(1.23456);
      expect(parseLocalizedDecimal(decorated, 'de'), decorated).toBeNull();
    }
  });

  it('parses decorated amounts in BOTH locales, not only under `de`', () => {
    // `-751,00 EUR` was already supported under `de`; its English mirror
    // returned null, silently losing the amount.
    expect(parseLocalizedDecimal('-751,00 EUR', 'de')).toBe(-751);
    expect(parseLocalizedDecimal('-751.00 EUR', 'en')).toBe(-751);
    expect(parseLocalizedDecimal('$1,234.56', 'en')).toBe(1234.56);
  });

  it('still refuses junk that only LOOKS numeric after decoration stripping', () => {
    for (const locale of ['de', 'en'] as const) {
      expect(parseLocalizedDecimal('1e5', locale), locale).toBeNull();
      expect(parseLocalizedDecimal('12/34', locale), locale).toBeNull();
      expect(parseLocalizedDecimal('(1,234.56)', locale), locale).toBeNull();
      expect(parseLocalizedDecimal('751,00-', locale), locale).toBeNull();
      expect(parseLocalizedDecimal('EUR', locale), locale).toBeNull();
      expect(parseLocalizedDecimal('', locale), locale).toBeNull();
    }
  });
});

// --- Finding 3: DD.MM.YY flips the file to `en` and inflates quantities ------

const GERMAN_TWO_DIGIT_YEAR_FILE = [
  'Datum;Wertpapier;Stück;Kurs;Betrag',
  '15.01.24;Beispiel ETF;1,250;80,00;-100,00',
  '16.01.24;Beispiel ETF;2,750;80,00;-220,00',
  '17.01.24;Beispiel ETF;0,500;80,00;-40,00',
].join('\n');

describe('finding 3 — two-digit-year German dates do not flip the file to `en`', () => {
  it('sniffs the file as German and parses its 3-decimal quantities correctly', () => {
    const understood = understandTable(buf(GERMAN_TWO_DIGIT_YEAR_FILE), 'de-yy.csv');
    expect(understood).not.toBeNull();
    const { table, mapping } = understood!;

    expect(table.numberLocale).toBe('de');
    expect(table.dateLocale).toBe('de');

    const quantityIndex = mapping.fieldWinners.quantity?.index;
    expect(quantityIndex).toBe(2);
    const quantities = table.rows.map((r) =>
      parseLocalizedDecimal(r[quantityIndex!]!, table.numberLocale),
    );
    // The merged code reported [1250, 2750, 500] at 0.95 confidence.
    expect(quantities).toEqual([1.25, 2.75, 0.5]);
  });

  it('parses every date and every amount instead of returning null across the board', () => {
    const understood = understandTable(buf(GERMAN_TWO_DIGIT_YEAR_FILE), 'de-yy.csv')!;
    const { table, mapping } = understood;
    const dateIndex = mapping.fieldWinners.date!.index;
    const amountIndex = mapping.fieldWinners.amount!.index;

    expect(
      table.rows.map((r) => parseLocalizedDay(r[dateIndex]!, table.dateLocale)?.toISOString()),
    ).toEqual(['2024-01-15T12:00:00.000Z', '2024-01-16T12:00:00.000Z', '2024-01-17T12:00:00.000Z']);
    expect(
      table.rows.map((r) => parseLocalizedDecimal(r[amountIndex]!, table.numberLocale)),
    ).toEqual([-100, -220, -40]);
  });

  it('says LOUDLY that the century was inferred rather than presenting a green light', () => {
    const table = sniffTable(buf(GERMAN_TWO_DIGIT_YEAR_FILE), 'de-yy.csv');
    const issue = table?.issues.find((i) => i.kind === 'two-digit-year');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/two-digit|century/i);
  });

  it('keeps a two-digit-year date out of the number-locale vote entirely', () => {
    // Nothing but dates and one unambiguous German amount: the dotted dates
    // must not vote `en` through `/\d\.\d{1,2}(?!\d)/`.
    const table = sniffTable(
      buf(['Datum;Betrag', '15.01.24;-751,00', '16.01.24;-42,50'].join('\n')),
      'yy-only.csv',
    );
    expect(table?.numberLocale).toBe('de');
  });

  it('falls back to the DATE locale when only mirror-ambiguous numbers are present', () => {
    // Every value is `d,ddd` — a half-vote each way — so the German dates
    // decide, exactly as the ISO/German fallback already intends.
    const table = sniffTable(
      buf(['Datum;Stück', '15.01.24;1,250', '16.01.24;2,750'].join('\n')),
      'yy-tie.csv',
    );
    expect(table?.dateLocale).toBe('de');
    expect(table?.numberLocale).toBe('de');
  });

  it('refuses a single 3-decimal comma group under `en` instead of reinterpreting it', () => {
    // The mirror of `parseDecimal`'s refusal of `1.000` under `de`: `1,250` is
    // either English 1250 or German 1.25, and guessing books ~1000x off.
    expect(parseLocalizedDecimal('1,250', 'en')).toBeNull();
    expect(parseLocalizedDecimal('0,500', 'en')).toBeNull();
    // …while an unambiguous multi-group integer still parses.
    expect(parseLocalizedDecimal('1,234,567', 'en')).toBe(1234567);
    // …and so does anything carrying an explicit decimal point.
    expect(parseLocalizedDecimal('1,250.00', 'en')).toBe(1250);
  });

  it('still reads four-digit German dates and ISO dates exactly as before', () => {
    expect(parseLocalizedDay('15.01.2024', 'de')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseLocalizedDay('2024-01-15', 'de')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseLocalizedDay('31.02.24', 'de')).toBeNull();
    expect(parseLocalizedDay('15.01.24', 'iso')).toBeNull();
  });
});

// --- Finding 4: ragged rows are silently misaligned --------------------------

describe('finding 4 — a row narrower than the header is reported', () => {
  const RAGGED = [
    'Datum;Beschreibung;Anzahl;Kurs;Betrag',
    '15.01.2024;Beispiel ETF;10;50,00;-505,90',
    '16.01.2024;Beispiel ETF;-80,00',
  ].join('\n');

  it('raises row-width-mismatch instead of reading the amount as a quantity', () => {
    const table = sniffTable(buf(RAGGED), 'ragged.csv');
    const issues = table?.issues.filter((i) => i.kind === 'row-width-mismatch') ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(3);
    expect(issues[0]?.row).toBe(1);
    expect(issues[0]?.message).toContain('3');
    expect(issues[0]?.message).toContain('5');
    // Flagged, never dropped — the user can still see the row in the preview.
    expect(table?.rows).toHaveLength(2);
  });

  it('reports a row WIDER than the header too', () => {
    const table = sniffTable(
      buf(['Datum;Betrag', '15.01.2024;-505,90', '16.01.2024;-80,00;extra'].join('\n')),
      'wide.csv',
    );
    expect(table?.issues.filter((i) => i.kind === 'row-width-mismatch')).toHaveLength(1);
  });

  it('stays silent on a well-formed file', () => {
    const table = sniffTable(
      buf(['Datum;Betrag', '15.01.2024;-505,90', '16.01.2024;-80,00'].join('\n')),
      'even.csv',
    );
    expect(table?.issues).toEqual([]);
  });

  it('bounds the issue list on a file with many ragged rows', () => {
    // The well-formed rows stay the majority so the header keeps the modal
    // width — otherwise the file has no header at all and the older
    // `header-width-mismatch` path handles it instead. Five columns, so `;`
    // still beats the `,` inside every German decimal in the delimiter sniff.
    const good = Array.from(
      { length: 40 },
      (_u, i) => `0${(i % 9) + 1}.01.2024;Text;Extra;80,00;-1,00`,
    );
    const bad = Array.from({ length: 30 }, (_u, i) => `0${(i % 9) + 1}.02.2024;Text;-1,00`);
    const table = sniffTable(
      buf(['Datum;Text;Extra;Kurs;Betrag', ...good, ...bad].join('\n')),
      'all-ragged.csv',
    );
    const issues = table?.issues.filter((i) => i.kind === 'row-width-mismatch') ?? [];
    // 25 individual + 1 aggregate — never one per offending row.
    expect(issues).toHaveLength(26);
    expect(issues[25]?.message).toContain('further');
    expect(issues[25]?.message).toContain('5');
  });
});

// --- Finding 5: a quoted newline splits one booking in two -------------------

describe('finding 5 — quoted newlines keep one booking in one row', () => {
  const EMBEDDED = [
    'Datum;Beschreibung;Anzahl;Kurs;Betrag',
    '15.01.2024;"Beispiel ETF',
    'Vorzugsaktie";10;50,00;-505,90',
    '16.01.2024;Anderes Papier;5;10,00;-50,00',
  ].join('\n');

  it('does not truncate the booking or invent a phantom row', () => {
    const table = sniffTable(buf(EMBEDDED), 'embedded.csv');
    expect(table?.rows).toEqual([
      ['15.01.2024', 'Beispiel ETF\nVorzugsaktie', '10', '50,00', '-505,90'],
      ['16.01.2024', 'Anderes Papier', '5', '10,00', '-50,00'],
    ]);
    // The audit trail points at the line the record STARTS on.
    expect(table?.lineNumbers).toEqual([2, 4]);
    expect(table?.issues).toEqual([]);
  });

  it('reads an inch mark as an ordinary character instead of a quote', () => {
    // CHANGED, AND SAID OUT LOUD — this test used to assert
    // `issues.some(kind === 'unbalanced-quote')` on this exact file. That
    // assertion ENCODED THE BUG that finding S1 proved: the sniffer decided
    // quoting by counting `"` per line and flipping state on an ODD count, so
    // an inch mark looked like an unterminated quote. Two such lines within
    // MAX_RECORD_LINES then merged their two physical rows into ONE record that
    // still matched the header's width — this PR's own row-width check never
    // fired — and the first booking silently took the second booking's amount
    // while the second booking vanished, at 0.95 confidence with `issues: []`.
    //
    // Under RFC 4180 a `"` only opens a field at FIELD START, so `27" Monitor`
    // is simply a cell containing an inch mark. There is nothing ambiguous to
    // report, no fallback is needed, and warning about it would train operators
    // to ignore the warning on the files where it is real (see the next test).
    // Coverage is not reduced: the assertion that mattered — both bookings
    // survive intact — is now checked cell by cell rather than by counting rows.
    const table = sniffTable(
      buf(
        [
          'Datum;Beschreibung;Betrag',
          '15.01.2024;27" Monitor;-505,90',
          '16.01.2024;Kabel;-9,90',
        ].join('\n'),
      ),
      'inch.csv',
    );
    expect(table?.rows).toEqual([
      ['15.01.2024', '27" Monitor', '-505,90'],
      ['16.01.2024', 'Kabel', '-9,90'],
    ]);
    expect(table?.lineNumbers).toEqual([2, 3]);
    expect(table?.issues).toEqual([]);
  });

  it('still reports a genuinely broken quote rather than trusting it', () => {
    // The mirror of the test above: here the `"` IS at field start, so it does
    // open a field — and that field is never closed. The quote-aware reading is
    // untrustworthy, so the sniff degrades to physical lines and says so.
    const table = sniffTable(
      buf(
        [
          'Datum;Beschreibung;Betrag',
          '15.01.2024;"Beispiel ETF;-505,90',
          '16.01.2024;Kabel;-9,90',
        ].join('\n'),
      ),
      'broken-quote.csv',
    );
    const issue = table?.issues.find((i) => i.kind === 'unbalanced-quote');
    expect(issue).toBeDefined();
    expect(issue?.line).toBe(2);
    // Degrades to the physical-line reading, which keeps both bookings visible.
    expect(table?.rows).toHaveLength(2);
  });

  it('leaves an ordinary quoted file byte-identical to before', () => {
    const table = sniffTable(
      buf('Date,Description,Amount\n2024-01-16,"ACME, Inc.",-42.50'),
      'quoted.csv',
    );
    expect(table?.rows).toEqual([['2024-01-16', 'ACME, Inc.', '-42.50']]);
    expect(table?.issues).toEqual([]);
  });
});

// --- Finding 6: latin-1 / windows-1252 exports lose fee and quantity ---------

describe('finding 6 — a windows-1252 export keeps its umlauts', () => {
  const LATIN1 = Buffer.from(
    [
      'Datum;Wertpapier;Stück;Kurs;Gebühr;Betrag',
      '15.01.2024;Beispiel ETF;10;50,00;1,50;-505,90',
      '16.01.2024;Beispiel ETF;5;50,00;1,50;-251,50',
    ].join('\n'),
    'latin1',
  );

  it('decodes the file instead of dropping fee and quantity into unmapped', () => {
    const understood = understandTable(LATIN1, 'latin1.csv');
    expect(understood).not.toBeNull();
    const { table, mapping } = understood!;
    expect(table.encoding).toBe('windows-1252');
    expect(table.headers).toEqual(['Datum', 'Wertpapier', 'Stück', 'Kurs', 'Gebühr', 'Betrag']);
    expect(mapping.fieldWinners.quantity?.header).toBe('Stück');
    expect(mapping.fieldWinners.fee?.header).toBe('Gebühr');
    expect(mapping.unmapped).toEqual([]);
  });

  it('never lets a replacement character reach the caller unannounced', () => {
    const table = sniffTable(LATIN1, 'latin1.csv')!;
    const everything = [...table.headers, ...table.rows.flat()].join('');
    expect(everything).not.toContain('�');
    const issue = table.issues.find((i) => i.kind === 'encoding-fallback');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/Windows-1252|UTF-8/i);
  });

  it('leaves a genuine UTF-8 file on utf-8 with no encoding issue', () => {
    const table = sniffTable(buf('Datum;Gebühr\n15.01.2024;1,50'), 'utf8.csv');
    expect(table?.encoding).toBe('utf-8');
    expect(table?.headers).toEqual(['Datum', 'Gebühr']);
    expect(table?.issues.filter((i) => i.kind === 'encoding-fallback')).toEqual([]);
  });
});

// --- Finding 7: a DATED summary row is booked as a transaction ---------------

describe('finding 7 — a dated Endsaldo row is still a summary row', () => {
  it('flags the German period-end balance the module’s JSDoc promises to catch', () => {
    const table = sniffTable(
      buf(
        [
          'Buchtag;Buchungstext;Betrag',
          '02.01.2024;Einzahlung;500,00',
          '31.01.2024;Gehalt;2.500,00',
          '31.01.2024;Endsaldo;3.000,00',
        ].join('\n'),
      ),
      'endsaldo.csv',
    );
    const summaries = table?.issues.filter((i) => i.kind === 'summary-row') ?? [];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.line).toBe(4);
    expect(summaries[0]?.row).toBe(2);
    expect(table?.rows[summaries[0]!.row]).toEqual(['31.01.2024', 'Endsaldo', '3.000,00']);
  });

  it.each(['Saldo', 'Schlusssaldo', 'Summe', 'Übertrag', 'Total'])(
    'flags a dated `%s` row',
    (word: string) => {
      const table = sniffTable(
        buf(
          [
            'Buchtag;Buchungstext;Betrag',
            '02.01.2024;Einzahlung;500,00',
            `31.01.2024;${word};3.000,00`,
          ].join('\n'),
        ),
        'dated-summary.csv',
      );
      expect(table?.issues.filter((i) => i.kind === 'summary-row')).toHaveLength(1);
    },
  );

  it('never flags a genuine dated booking whose text merely STARTS with a summary word', () => {
    // A dated row must match a summary word EXACTLY; the looser first-token
    // rule stays reserved for undated rows, where datelessness corroborates.
    for (const text of ['Saldenmitteilung Gebuehr', 'Summe Sport GmbH', 'Totalise AG']) {
      const table = sniffTable(
        buf(
          [
            'Buchtag;Buchungstext;Betrag',
            '02.01.2024;Einzahlung;500,00',
            `03.01.2024;${text};-1,00`,
          ].join('\n'),
        ),
        'genuine.csv',
      );
      expect(
        table?.issues.filter((i) => i.kind === 'summary-row'),
        text,
      ).toEqual([]);
    }
  });

  it('still flags the classic UNDATED summary row', () => {
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
    );
    expect(table?.issues.filter((i) => i.kind === 'summary-row')).toHaveLength(1);
  });
});

// --- Cross-cutting: no silent confidence -------------------------------------

describe('no defect returns a confident wrong answer any more', () => {
  const CASES: readonly (readonly [string, string])[] = [
    [
      'ragged row',
      ['Datum;Beschreibung;Anzahl;Kurs;Betrag', '16.01.2024;Beispiel ETF;-80,00'].join('\n'),
    ],
    [
      'dated summary',
      [
        'Buchtag;Buchungstext;Betrag',
        '02.01.2024;Einzahlung;500,00',
        '31.01.2024;Endsaldo;3.000,00',
      ].join('\n'),
    ],
    ['two-digit years', GERMAN_TWO_DIGIT_YEAR_FILE],
  ];

  it.each(CASES)('%s reports at least one issue', (_name: string, text: string) => {
    const table = sniffTable(buf(text), 'x.csv');
    expect(table?.issues.length).toBeGreaterThan(0);
  });
});

/** Type-level guard: the locale union the vectors above are written against. */
const LOCALES: readonly NumberLocale[] = ['de', 'en'];
describe('locale coverage', () => {
  it('exercises both number locales', () => {
    expect(LOCALES).toEqual(['de', 'en']);
  });
});
