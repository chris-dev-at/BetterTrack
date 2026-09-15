import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import { flatexMapper } from '../mappers/flatex';
import { tradeRepublicMapper } from '../mappers/tradeRepublic';
import type { MappedLine } from '../types';
import { createMapperRegistry } from '../registry';
import { ALL_MAPPERS } from '../mappers';

/**
 * Trade Republic mapper (§13.4 V4-P8): the anonymized fixture normalizes to its
 * exact golden row set; malformed rows fail individually; the header
 * fingerprint autodetects.
 */

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/trade-republic.csv',
);
const TRADE_REPUBLIC_FIXTURE = readFileSync(fixturePath, 'utf8');

describe('tradeRepublicMapper.detect', () => {
  it('scores the fixture header at 1 and autodetects through the registry', () => {
    const csv = parseCsv(TRADE_REPUBLIC_FIXTURE);
    expect(tradeRepublicMapper.detect(csv)).toBe(1);
    expect(createMapperRegistry(ALL_MAPPERS).detect(csv)?.id).toBe('trade_republic');
  });

  it('scores a foreign header below the threshold', () => {
    const csv = parseCsv('Date,Type,Symbol,Quantity,Price\n2024-01-01,BUY,AAPL,1,100');
    expect(tradeRepublicMapper.detect(csv)).toBeLessThan(0.5);
    expect(createMapperRegistry(ALL_MAPPERS).detect(csv)).toBeNull();
  });
});

describe('tradeRepublicMapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture to its exact row set', () => {
    const lines = tradeRepublicMapper.map(parseCsv(TRADE_REPUBLIC_FIXTURE));
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.ok)).toBe(true);
    const rows = lines.map((l) => (l.ok ? l.row : null));

    expect(rows[0]).toEqual({
      kind: 'deposit',
      executedAt: new Date('2024-01-02T12:00:00.000Z'),
      isin: null,
      symbol: null,
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: 2000,
      currency: 'EUR',
      note: null,
    });
    expect(rows[1]).toEqual({
      kind: 'buy',
      executedAt: new Date('2024-01-15T12:00:00.000Z'),
      isin: 'DE0001234567',
      symbol: null,
      name: 'Muster Tech AG',
      quantity: 10,
      price: 50,
      fee: 1,
      amountEur: null,
      currency: 'EUR',
      note: null,
    });
    // Sparplan executions are buys (savings-plan quirk, docs/imports.md).
    expect(rows[2]).toMatchObject({
      kind: 'buy',
      executedAt: new Date('2024-02-01T12:00:00.000Z'),
      isin: 'IE0009876543',
      name: 'Beispiel World ETF',
      quantity: 2.5,
      price: 40,
      fee: 0,
    });
    expect(rows[3]).toMatchObject({
      kind: 'dividend',
      executedAt: new Date('2024-03-15T12:00:00.000Z'),
      isin: 'DE0001234567',
      name: 'Muster Tech AG',
      quantity: null,
      price: null,
      amountEur: 12.5,
    });
    expect(rows[4]).toMatchObject({
      kind: 'sell',
      executedAt: new Date('2024-04-10T12:00:00.000Z'),
      isin: 'DE0001234567',
      quantity: 4,
      price: 60,
      fee: 1,
    });
    // Zinsen (cash interest) books as a plain deposit with no instrument.
    expect(rows[5]).toMatchObject({
      kind: 'deposit',
      isin: null,
      name: null,
      amountEur: 3.75,
      note: 'Interest payment (Trade Republic)',
    });
    expect(rows[6]).toMatchObject({
      kind: 'withdrawal',
      executedAt: new Date('2024-06-01T12:00:00.000Z'),
      amountEur: 250,
    });
  });
});

describe('tradeRepublicMapper.map — per-row errors', () => {
  const HEADER = 'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung';

  const mapOne = (line: string) => {
    const [result] = tradeRepublicMapper.map(parseCsv(`${HEADER}\n${line}`));
    return result!;
  };

  it('fails an unknown Typ but keeps the raw line + physical line number', () => {
    const result = mapOne('2024-01-02;Steuerkorrektur;;;;;;1,00;EUR');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Steuerkorrektur');
    expect(result.line).toBe(2);
    expect(result.raw).toContain('Steuerkorrektur');
  });

  it('fails unparseable dates, quantities, prices and amounts individually', () => {
    expect(mapOne('gestern;Kauf;X AG;DE0001234567;1;10,00;0;-10,00;EUR').ok).toBe(false);
    expect(mapOne('2024-01-02;Kauf;X AG;DE0001234567;;10,00;0;-10,00;EUR').ok).toBe(false);
    expect(mapOne('2024-01-02;Kauf;X AG;DE0001234567;-1;10,00;0;-10,00;EUR').ok).toBe(false);
    expect(mapOne('2024-01-02;Kauf;X AG;DE0001234567;1;zehn;0;-10,00;EUR').ok).toBe(false);
    expect(mapOne('2024-01-02;Einzahlung;;;;;;nix;EUR').ok).toBe(false);
  });

  it('fails a trade without any instrument identity', () => {
    const result = mapOne('2024-01-02;Kauf;;;1;10,00;0;-10,00;EUR');
    expect(result.ok).toBe(false);
  });

  it('refuses an English-grouped amount instead of booking a thousandth of it', () => {
    // Read as German, `2,000.00` is 2.00 and `1,200` a quantity of 1.2 — the
    // row is reported rather than staged with a silently wrong number.
    const deposit = mapOne('2024-01-02;Einzahlung;;;;;;2,000.00;EUR');
    expect(deposit.ok).toBe(false);
    const quantity = mapOne('2024-01-02;Kauf;X AG;DE0001234567;1,200.00;50.00;0;-10,00;EUR');
    expect(quantity.ok).toBe(false);
    // The German form still parses.
    const german = mapOne('2024-01-02;Einzahlung;;;;;;2.000,00;EUR');
    expect(german.ok && german.row.amountEur).toBe(2000);
  });

  it('reads a negative Zinsen row as money OUT rather than booking it as a deposit', () => {
    // `Zinsen` names no direction — TR books credit interest and negative
    // interest / Verwahrentgelt under the same word — so the sign decides.
    // Absolutising it turned a €5 charge into a €5 credit: a €10 swing per row.
    const charge = mapOne('2024-01-02;Zinsen;;;;;;-5,00;EUR');
    expect(charge.ok).toBe(true);
    expect(charge.ok && charge.row).toMatchObject({
      kind: 'withdrawal',
      amountEur: 5,
      isin: null,
      name: null,
      note: 'Interest payment (Trade Republic)',
    });
    // The positive form is unchanged.
    const credit = mapOne('2024-05-02;Zinsen;;;;;;3,75;EUR');
    expect(credit.ok && credit.row).toMatchObject({ kind: 'deposit', amountEur: 3.75 });
  });

  it('refuses a negative Einzahlung instead of booking €500 of money IN', () => {
    const result = mapOne('2024-01-02;Einzahlung;;;;;;-500,00;EUR');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Storno');
  });

  it('still takes the magnitude of an unsigned Auszahlung (TR does not sign them)', () => {
    // The asymmetry `kindDerivation.ts` states: a minus sign speaks on its own,
    // a plus does not. TR prints Auszahlungen both ways — the golden fixture
    // carries a positive one — so a positive Betrag stays a magnitude.
    const unsigned = mapOne('2024-06-01;Auszahlung;;;;;;250,00;EUR');
    expect(unsigned.ok && unsigned.row).toMatchObject({ kind: 'withdrawal', amountEur: 250 });
    const signed = mapOne('2024-06-01;Auszahlung;;;;;;-250,00;EUR');
    expect(signed.ok && signed.row).toMatchObject({ kind: 'withdrawal', amountEur: 250 });
  });

  it('fails a negative dividend Betrag instead of booking its magnitude as income (#529)', () => {
    // A reversal keeps the Dividende Typ but flips the sign — |Betrag| would
    // double-count the income (George/Flatex refuse the same shape).
    const result = mapOne('2024-03-15;Dividende;Muster Tech AG;DE0001234567;;;;-12,50;EUR');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('reversal');
    // Deposits/withdrawals keep the signed magnitude (Typ names the direction).
    const withdrawal = mapOne('2024-06-01;Auszahlung;;;;;;-250,00;EUR');
    expect(withdrawal.ok).toBe(true);
    expect(withdrawal.ok && withdrawal.row.amountEur).toBe(250);
  });

  it('fails non-EUR cash rows (the cash ledger is EUR-only)', () => {
    const result = mapOne('2024-01-02;Einzahlung;;;;;;100,00;USD');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('EUR');
  });

  it('fails a malformed Währung token on a TRADE row instead of letting it through', () => {
    // Anything but a three-letter code would blow up the char(3) staging column
    // — and with it the whole batch INSERT — if the mapper passed it on.
    for (const currency of ['EURO', 'Euro', 'EUR/USD']) {
      const result = mapOne(`2024-01-02;Kauf;X AG;DE0001234567;1;10,00;0;-10,00;${currency}`);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(currency);
    }
    // An empty cell still defaults to EUR.
    expect(mapOne('2024-01-02;Kauf;X AG;DE0001234567;1;10,00;0;-10,00;').ok).toBe(true);
  });

  it('accepts an unlisted ISIN column value as a name-only instrument', () => {
    const result = mapOne('2024-01-02;Kauf;Muster AG;nicht-eine-isin;1;10,00;0;-10,00;EUR');
    expect(result.ok).toBe(true);
    expect(result.ok && result.row.isin).toBeNull();
    expect(result.ok && result.row.name).toBe('Muster AG');
  });
});

/**
 * ONE sign rule, two mappers. Trade Republic and Flatex both carry a German
 * cash statement whose amount column is signed, and they used to disagree about
 * what the sign means: Flatex derived `Zinsen` from it and refused a
 * text/sign contradiction, while Trade Republic absolutised everything and
 * booked a negative interest charge as a credit. Wherever the sign SPEAKS —
 * every negative amount — the two must now answer alike.
 *
 * A POSITIVE amount is deliberately not part of this parity: it is not evidence
 * of direction (`kindDerivation.ts`), Flatex's cash export signs its
 * Auszahlungen and Trade Republic's does not, so `Auszahlung;250,00` is a
 * magnitude in one file and a contradiction in the other. That divergence is
 * about the two FILES, not about the rule.
 */
describe('sign handling parity — trade republic vs flatex', () => {
  const TR_HEADER = 'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung';
  const FLATEX_CASH_HEADER = 'Buchtag;Valuta;Buchungsinformationen;TA-Nr.;Betrag';

  const outcome = (line: MappedLine): string =>
    line.ok ? `${line.row.kind} ${String(line.row.amountEur)}` : 'refused';

  const cases: Array<{ what: string; tr: string; flatex: string; expected: string }> = [
    {
      what: 'interest credited',
      tr: '02.01.2024;Zinsen;;;;;;1,25;EUR',
      flatex: '02.01.2024;;Zinsen Q1;1;1,25',
      expected: 'deposit 1.25',
    },
    {
      what: 'interest charged (negative interest / Verwahrentgelt)',
      tr: '02.01.2024;Zinsen;;;;;;-5,00;EUR',
      flatex: '02.01.2024;;Zinsen Q1;1;-5,00',
      expected: 'withdrawal 5',
    },
    {
      what: 'a reversed deposit',
      tr: '02.01.2024;Einzahlung;;;;;;-500,00;EUR',
      flatex: '02.01.2024;;Einzahlung SEPA;1;-500,00',
      expected: 'refused',
    },
    {
      what: 'a reversed dividend',
      tr: '15.03.2024;Dividende;Muster Tech AG;DE0001234567;;;;-12,50;EUR',
      flatex: '15.03.2024;;Ertragsgutschrift DE0001234567 Muster Tech AG;1;-12,50',
      expected: 'refused',
    },
  ];

  it.each(cases)('agrees on $what', ({ tr, flatex, expected }) => {
    const [trLine] = tradeRepublicMapper.map(parseCsv(`${TR_HEADER}\n${tr}`));
    const [flatexLine] = flatexMapper.map(parseCsv(`${FLATEX_CASH_HEADER}\n${flatex}`));
    expect(outcome(trLine!)).toBe(expected);
    expect(outcome(flatexLine!)).toBe(expected);
  });
});
