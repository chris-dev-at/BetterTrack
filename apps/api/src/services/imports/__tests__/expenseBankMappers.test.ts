import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import {
  ALL_BANK_MAPPERS,
  createBankMapperRegistry,
  ersteGeorgeMapper,
  n26Mapper,
  parseEnglishAmount,
  raiffeisenElbaMapper,
  revolutMapper,
  type BankStatementMapper,
  type NormalizedExpenseRow,
} from '../expenseBank';

/**
 * Bank-statement mappers (PROJECTPLAN.md §13.5 V5-P9, issue 2/3): each anonymized
 * fixture normalizes to its exact golden row set, the header fingerprints
 * autodetect the right mapper, and the four exports never cross-detect (a missing
 * signature column disqualifies). Malformed rows fail individually.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(path.join(fixtureDir, name), 'utf8');

const ERSTE = fixture('erste-george.csv');
const ELBA = fixture('raiffeisen-elba.csv');
const N26 = fixture('n26.csv');
const REVOLUT = fixture('revolut.csv');

// Derived from the fixtures so a header edit cannot leave the inline cases
// asserting against a shape the real export no longer has.
const N26_HEADER = N26.split('\n')[0]!;
const REVOLUT_HEADER = REVOLUT.split('\n')[0]!;

const okRows = (mapper: BankStatementMapper, csv: string): NormalizedExpenseRow[] =>
  mapper.map(parseCsv(csv)).map((line) => {
    if (!line.ok) throw new Error(`Expected ok row, got error: ${line.error}`);
    return line.row;
  });

describe('bank statement autodetection', () => {
  const registry = createBankMapperRegistry(ALL_BANK_MAPPERS);

  it('resolves each fixture to its own mapper', () => {
    expect(registry.detect(parseCsv(ERSTE))?.id).toBe('erste_george');
    expect(registry.detect(parseCsv(ELBA))?.id).toBe('raiffeisen_elba');
    expect(registry.detect(parseCsv(N26))?.id).toBe('n26');
    expect(registry.detect(parseCsv(REVOLUT))?.id).toBe('revolut');
  });

  it('lists every bank for the picker', () => {
    expect(registry.list()).toEqual([
      { id: 'erste_george', label: 'Erste / George' },
      { id: 'raiffeisen_elba', label: 'Raiffeisen ELBA' },
      { id: 'n26', label: 'N26' },
      { id: 'revolut', label: 'Revolut' },
    ]);
  });

  it('never cross-detects — every mapper scores 0 on the other banks’ exports', () => {
    const files: Record<string, string> = {
      erste_george: ERSTE,
      raiffeisen_elba: ELBA,
      n26: N26,
      revolut: REVOLUT,
    };
    for (const mapper of ALL_BANK_MAPPERS) {
      for (const [id, csv] of Object.entries(files)) {
        const score = mapper.detect(parseCsv(csv));
        if (id === mapper.id) expect(score).toBeGreaterThanOrEqual(0.6);
        else expect(score).toBe(0);
      }
    }
  });

  it('scores a generic/broker CSV below the threshold', () => {
    const generic = parseCsv('Date,Type,Symbol,Quantity,Price\n2024-01-01,BUY,AAPL,1,100');
    expect(registry.detect(generic)).toBeNull();
    for (const mapper of ALL_BANK_MAPPERS) expect(mapper.detect(generic)).toBeLessThan(0.6);
  });
});

describe('ersteGeorgeMapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture to its exact row set', () => {
    expect(okRows(ersteGeorgeMapper, ERSTE)).toEqual([
      {
        bookedOn: '2024-01-02',
        direction: 'expense',
        amount: 38.2,
        currency: 'EUR',
        description: 'BILLA',
      },
      {
        bookedOn: '2024-01-15',
        direction: 'expense',
        amount: 9.99,
        currency: 'EUR',
        description: 'SPOTIFY AB',
      },
      {
        bookedOn: '2024-01-31',
        direction: 'income',
        amount: 2500,
        currency: 'EUR',
        description: 'Muster GmbH',
      },
      {
        bookedOn: '2024-02-05',
        direction: 'expense',
        amount: 14.9,
        currency: 'EUR',
        description: 'OEBB',
      },
    ]);
  });

  it('falls back to the purpose text when the partner name is blank', () => {
    const csv = parseCsv(
      'Buchungsdatum;Valutadatum;Partnername;Verwendungszweck;Betrag;Währung\n' +
        '02.01.2024;02.01.2024;;Bankomat Behebung;-100,00;EUR',
    );
    expect(ersteGeorgeMapper.map(csv)[0]).toMatchObject({
      ok: true,
      row: { description: 'Bankomat Behebung', direction: 'expense', amount: 100 },
    });
  });
});

describe('raiffeisenElbaMapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture to its exact row set', () => {
    expect(okRows(raiffeisenElbaMapper, ELBA)).toEqual([
      {
        bookedOn: '2024-01-03',
        direction: 'expense',
        amount: 52.3,
        currency: 'EUR',
        description: 'HOFER DANKT KARTE 5678',
      },
      {
        bookedOn: '2024-01-18',
        direction: 'expense',
        amount: 780,
        currency: 'EUR',
        description: 'MIETE JAENNER',
      },
      {
        bookedOn: '2024-01-31',
        direction: 'income',
        amount: 2100,
        currency: 'EUR',
        description: 'GEHALT ARBEITGEBER AG',
      },
    ]);
  });
});

describe('n26Mapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture to its exact row set', () => {
    expect(okRows(n26Mapper, N26)).toEqual([
      {
        bookedOn: '2024-01-05',
        direction: 'expense',
        amount: 42.5,
        currency: 'EUR',
        description: 'REWE',
      },
      {
        bookedOn: '2024-01-10',
        direction: 'expense',
        amount: 12.99,
        currency: 'EUR',
        description: 'Netflix',
      },
      {
        bookedOn: '2024-01-28',
        direction: 'income',
        amount: 2400,
        currency: 'EUR',
        description: 'ACME GmbH',
      },
      // A thousands-GROUPED English amount: read with the German framework
      // parser `2,400.00` books as 2.4 — 1000× understated, silently.
      {
        bookedOn: '2024-02-28',
        direction: 'income',
        amount: 2400,
        currency: 'EUR',
        description: 'ACME GmbH',
      },
    ]);
  });

  // `1,200` (grouped, no decimal part) is the sharper case: the GENERIC sniffer
  // refuses it as `ambiguous-grouped-number`, because in an unknown file it is
  // 1200 the English way and 1.2 the German way. A hardcoded mapper has no such
  // ambiguity — N26 declares its notation — so it must read 1200. It stays out
  // of the committed fixture only because that file is also pinned as a
  // clean-sniff sample for the generic-import lane.
  it('books a bare comma-grouped amount at full magnitude, not 1000× under', () => {
    const csv = parseCsv(
      N26_HEADER + '\n2024-02-02,Furniture Store,,MasterCard Payment,,"-1,200",,,',
    );
    expect(n26Mapper.map(csv)[0]).toMatchObject({
      ok: true,
      row: { amount: 1200, direction: 'expense', currency: 'EUR' },
    });
  });
});

describe('revolutMapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture (using the completion day) to its exact row set', () => {
    expect(okRows(revolutMapper, REVOLUT)).toEqual([
      {
        bookedOn: '2024-01-03',
        direction: 'expense',
        amount: 9.99,
        currency: 'EUR',
        description: 'Spotify',
      },
      {
        bookedOn: '2024-01-07',
        direction: 'expense',
        amount: 4.5,
        currency: 'EUR',
        description: 'Starbucks',
      },
      {
        bookedOn: '2024-01-01',
        direction: 'income',
        amount: 1500,
        currency: 'EUR',
        description: 'Payment from Employer',
      },
      // A thousands-GROUPED English amount: read with the German framework
      // parser `2,400.00` books as 2.4 — 1000× understated, silently.
      {
        bookedOn: '2024-02-28',
        direction: 'income',
        amount: 2400,
        currency: 'EUR',
        description: 'Payment from Employer',
      },
    ]);
  });

  // See the N26 counterpart above for why `1,200` is asserted inline rather
  // than from the committed fixture.
  it('books a bare comma-grouped amount at full magnitude, not 1000× under', () => {
    const csv = parseCsv(
      REVOLUT_HEADER +
        '\nCARD_PAYMENT,Current,2024-02-02 10:00:00,2024-02-02 11:00:00,Furniture Store,' +
        '"-1,200",0.00,EUR,COMPLETED,1530.06',
    );
    expect(revolutMapper.map(csv)[0]).toMatchObject({
      ok: true,
      row: { amount: 1200, direction: 'expense', currency: 'EUR' },
    });
  });

  it('flags a non-COMPLETED row as an error (excluded from apply)', () => {
    const csv = parseCsv(
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
        'CARD_PAYMENT,Current,2024-02-01 10:00:00,,Pending Shop,-5.00,0.00,EUR,PENDING,100.00',
    );
    const line = revolutMapper.map(csv)[0];
    expect(line?.ok).toBe(false);
    expect(line?.ok === false && line.error).toContain('PENDING');
  });

  it('keeps a non-EUR row’s own currency (no FX)', () => {
    const csv = parseCsv(
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
        'CARD_PAYMENT,Current,2024-01-09 10:00:00,2024-01-09 12:00:00,London Cab,-18.40,0.00,GBP,COMPLETED,50.00',
    );
    expect(revolutMapper.map(csv)[0]).toMatchObject({
      ok: true,
      row: { currency: 'GBP', amount: 18.4, direction: 'expense' },
    });
  });
});

describe('parseEnglishAmount — the English-notation guard', () => {
  it('reads comma-grouped English amounts at full magnitude', () => {
    expect(parseEnglishAmount('2,400.00')).toBe(2400);
    expect(parseEnglishAmount('-1,200')).toBe(-1200);
    expect(parseEnglishAmount('1,234,567.89')).toBe(1234567.89);
    expect(parseEnglishAmount('-42.50')).toBe(-42.5);
    expect(parseEnglishAmount('-42.50 EUR')).toBe(-42.5);
  });

  it('REFUSES what it cannot read unambiguously rather than guessing', () => {
    // Not 3-digit grouping — German `1,20` or a truncated group, either way
    // guessing costs money. Refusing costs one reported row.
    expect(parseEnglishAmount('1,20')).toBeNull();
    expect(parseEnglishAmount('1,2345')).toBeNull();
    // German notation fed to the English parser: refused, never read as 1200.5.
    expect(parseEnglishAmount('1.200,50')).toBeNull();
    // A trailing sign dropped silently would flip the booking's direction.
    expect(parseEnglishAmount('1,200-')).toBeNull();
    // Accounting negatives and non-numeric cells stay refused.
    expect(parseEnglishAmount('(1,200.00)')).toBeNull();
    expect(parseEnglishAmount('')).toBeNull();
    expect(parseEnglishAmount('n/a')).toBeNull();
  });
});

describe('English-notation mappers reject an unreadable amount instead of misbooking', () => {
  it('fails the N26 row whose amount is not unambiguous English notation', () => {
    const csv = parseCsv(
      'Date,Payee,Account number,Transaction type,Payment reference,Amount (EUR),' +
        'Amount (Foreign Currency),Type Foreign Currency,Exchange Rate\n' +
        '2024-03-01,Furniture Store,,MasterCard Payment,,"-1,20",,,',
    );
    const line = n26Mapper.map(csv)[0];
    expect(line?.ok).toBe(false);
    expect(line?.ok === false && line.error).toContain('amount');
  });

  it('fails the Revolut row whose amount is German notation', () => {
    const csv = parseCsv(
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
        'CARD_PAYMENT,Current,2024-03-01 10:00:00,2024-03-01 11:00:00,Furniture Store,' +
        '"-1.200,50",0.00,EUR,COMPLETED,100.00',
    );
    const line = revolutMapper.map(csv)[0];
    expect(line?.ok).toBe(false);
    expect(line?.ok === false && line.error).toContain('amount');
  });
});

describe('German-notation mappers keep the framework parser', () => {
  it('reads a dot-grouped German amount at full magnitude', () => {
    const csv = parseCsv(
      'Buchungsdatum;Valutadatum;Partnername;Verwendungszweck;Betrag;Währung\n' +
        '31.01.2024;31.01.2024;Muster GmbH;Gehalt;2.500,00;EUR',
    );
    expect(ersteGeorgeMapper.map(csv)[0]).toMatchObject({
      ok: true,
      row: { amount: 2500, direction: 'income' },
    });
    const elba = parseCsv(
      'Kontonummer;Buchungsdatum;Valutadatum;Buchungstext;Betrag;Währung\n' +
        'AT483200000012345678;31.01.2024;31.01.2024;GEHALT;2.100,00;EUR',
    );
    expect(raiffeisenElbaMapper.map(elba)[0]).toMatchObject({
      ok: true,
      row: { amount: 2100, direction: 'income' },
    });
  });
});

describe('per-row validation (buildExpenseRow)', () => {
  it('fails an unparseable date, a zero amount and an empty description individually', () => {
    const csv = parseCsv(
      'Buchungsdatum;Valutadatum;Partnername;Verwendungszweck;Betrag;Währung\n' +
        'gestern;02.01.2024;BILLA;Kartenzahlung;-10,00;EUR\n' +
        '03.01.2024;03.01.2024;HOFER;Kartenzahlung;0,00;EUR\n' +
        '04.01.2024;04.01.2024;;;-5,00;EUR',
    );
    const lines = ersteGeorgeMapper.map(csv);
    expect(lines.map((l) => l.ok)).toEqual([false, false, false]);
    expect(lines[0]?.ok === false && lines[0].error).toContain('date');
    expect(lines[1]?.ok === false && lines[1].error).toContain('zero');
    expect(lines[2]?.ok === false && lines[2].error).toContain('description');
  });
});
