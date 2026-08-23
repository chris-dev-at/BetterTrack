import { describe, expect, it } from 'vitest';

import {
  extractRowFields,
  mapColumns,
  type ColumnMapResult,
  type MappableField,
} from '../columnMapping';

/**
 * Universal column mapping (§16 2026-07-31): the alias dictionary's measured
 * traps (Valuta ≠ currency, Nominale ≠ description, …), value-shape evidence
 * for unknown headers, ambiguity surfaced as needsReview instead of a silent
 * pick, and honest unmapped output.
 */

const deRow = (cells: string[]): string[] => cells;

/** The measured failure case: a synthetic German bank header row. Pins 10/10. */
const TRAP_HEADER =
  'Valuta;Wertpapierbezeichnung;WKN/ISIN;Nominale;Ausführungskurs;Betrag;Provision;KESt;Währung;Buchungstext';
const TRAP_ROWS = [
  deRow([
    '17.01.2024',
    'Muster Tech AG',
    'DE0001234567',
    '10',
    '50,00',
    '-505,90',
    '5,90',
    '0,00',
    'EUR',
    'Kauf Xetra',
  ]),
  deRow([
    '18.01.2024',
    'Beispiel Welt ETF',
    'IE0009876543',
    '2,5',
    '40,00',
    '100,00',
    '0,00',
    '1,10',
    'EUR',
    'Ertragsgutschrift',
  ]),
];

describe('mapColumns — the German trap row (pinned)', () => {
  const headers = TRAP_HEADER.split(';');
  const result = mapColumns(headers, TRAP_ROWS);

  it('maps all 10 headers to their correct field', () => {
    const expected: Record<string, MappableField> = {
      Valuta: 'date',
      Wertpapierbezeichnung: 'description',
      'WKN/ISIN': 'isin',
      Nominale: 'quantity',
      Ausführungskurs: 'price',
      Betrag: 'amount',
      Provision: 'fee',
      KESt: 'tax',
      Währung: 'currency',
      Buchungstext: 'description',
    };
    expect(Object.keys(expected)).toHaveLength(10);
    for (const mapping of result.mappings) {
      expect(mapping.field).toBe(expected[mapping.header]);
    }
    expect(result.unmapped).toEqual([]);
    expect(result.mappings).toHaveLength(10);
  });

  it('never mistakes Valuta for currency or Nominale for a description', () => {
    expect(fieldOf(result, 'Valuta').field).not.toBe('currency');
    expect(fieldOf(result, 'Nominale').field).toBe('quantity');
    expect(fieldOf(result, 'Valuta').reason).toContain('value date');
    expect(fieldOf(result, 'Wertpapierbezeichnung').reason).toContain('security NAME');
  });

  it('flags the two-way description claim (name vs memo) as needsReview on BOTH', () => {
    const name = fieldOf(result, 'Wertpapierbezeichnung');
    const memo = fieldOf(result, 'Buchungstext');
    // The security name outranks the booking memo but only just — a human sees both.
    expect(name.needsReview).toBe(true);
    expect(memo.needsReview).toBe(true);
    expect(name.alternative?.header).toBe('Buchungstext');
    expect(memo.alternativeOf?.header).toBe('Wertpapierbezeichnung');
    expect(result.fieldWinners.description?.header).toBe('Wertpapierbezeichnung');
  });
});

function fieldOf(result: ColumnMapResult, header: string) {
  const mapping = result.mappings.find((m) => m.header === header);
  expect(mapping, `no mapping for header ${header}`).toBeDefined();
  return mapping!;
}

describe('mapColumns — measured traps, one header at a time', () => {
  const expects: readonly (readonly [header: string, field: MappableField])[] = [
    ['Valuta', 'date'],
    ['valutadatum', 'date'],
    ['Value Date', 'date'],
    ['Buchungsdatum', 'date'],
    ['Datum', 'date'],
    ['Settle Date', 'date'],
    ['Nominale', 'quantity'],
    ['Stück', 'quantity'],
    ['STUECK', 'quantity'],
    ['Anzahl', 'quantity'],
    ['Menge', 'quantity'],
    ['Quantity', 'quantity'],
    ['Wertpapierbezeichnung', 'description'],
    ['Bezeichnung', 'description'],
    ['Titel', 'description'],
    ['Buchungstext', 'description'],
    ['Verwendungszweck', 'description'],
    ['Partnername', 'description'],
    ['Payee', 'description'],
    ['Kurs', 'price'],
    ['Ausführungskurs', 'price'],
    ['AUSFUEHRUNGSKURS', 'price'],
    ['T. Price', 'price'],
    ['Betrag', 'amount'],
    ['Endbetrag', 'amount'],
    ['Amount', 'amount'],
    ['Provision', 'fee'],
    ['Gebühr', 'fee'],
    ['Gebuehr', 'fee'],
    ['Entgelt', 'fee'],
    ['Spesen', 'fee'],
    ['Comm/Fee', 'fee'],
    ['KESt', 'tax'],
    ['Kapitalertragsteuer', 'tax'],
    ['Quellensteuer', 'tax'],
    ['Withholding Tax', 'tax'],
    ['Währung', 'currency'],
    ['WAEHRUNG', 'currency'],
    ['Currency', 'currency'],
    ['WKN/ISIN', 'isin'],
    ['ISIN', 'isin'],
    ['Symbol', 'symbol'],
    ['Ticker', 'symbol'],
    ['Typ', 'kindHint'],
    ['Auftragsart', 'kindHint'],
    ['Transaction Type', 'kindHint'],
  ];

  it.each(expects)('maps %j → %s', (header: string, field: MappableField) => {
    const result = mapColumns([header], [[]]);
    expect(result.unmapped).toEqual([]);
    expect(result.mappings[0]?.field).toBe(field);
  });

  it('matches WKN / ISIN spelled with spaces via the loose key', () => {
    const result = mapColumns(['WKN / ISIN'], [['DE0001234567']]);
    expect(result.mappings[0]?.field).toBe('isin');
  });
});

describe('mapColumns — value-shape evidence for unknown headers', () => {
  const rows = [
    ['15.01.2024', 'DE0001234567', '-505,90', 'EUR', 'Kauf'],
    ['16.01.2024', 'IE0009876543', '100,00', 'EUR', 'Verkauf'],
    ['17.01.2024', 'DE0001234568', '-50,00', 'USD', 'Dividende'],
  ];

  it('maps date/ISIN/mixed-amount/currency/kind columns without any alias', () => {
    const result = mapColumns(['Spalte A', 'Spalte B', 'Spalte C', 'Spalte D', 'Spalte E'], rows);
    expect(result.unmapped).toEqual([]);
    expect(result.fieldWinners.date?.header).toBe('Spalte A');
    expect(result.fieldWinners.isin?.header).toBe('Spalte B');
    expect(result.fieldWinners.amount?.header).toBe('Spalte C');
    expect(result.fieldWinners.currency?.header).toBe('Spalte D');
    expect(result.fieldWinners.kindHint?.header).toBe('Spalte E');

    expect(fieldOf(result, 'Spalte A').reason).toMatch(/^shape date 3\/3/);
    expect(fieldOf(result, 'Spalte C').reason).toContain('mixed-sign decimals 3/3');
    expect(fieldOf(result, 'Spalte B').reason).toContain('shape isin');
  });

  it('never picks quantity OR price from all-positive decimals alone', () => {
    const result = mapColumns(['Unbekannt'], [['10'], ['2,5'], ['4']]);
    // Below the floor → unmapped; shape alone must not guess qty vs price.
    expect(result.mappings).toEqual([]);
    expect(result.unmapped).toEqual(['Unbekannt']);
  });

  it('combines alias + agreeing shape into one confidence with both reasons', () => {
    const result = mapColumns(['Betrag'], [['-50,00'], ['100,00']]);
    const amount = fieldOf(result, 'Betrag');
    expect(amount.reason).toContain('alias');
    expect(amount.reason).toContain('+ shape mixed-sign decimals');
  });
});

describe('mapColumns — ambiguity is represented, never coin-flipped', () => {
  it('contests two equal same-field columns and keeps the leftmost as winner', () => {
    const rows = [
      ['-1,00', '-2,00'],
      ['3,00', '4,00'],
    ];
    const result = mapColumns(['X', 'Y'], rows);
    const x = fieldOf(result, 'X');
    const y = fieldOf(result, 'Y');
    expect(x.confidence).toBe(y.confidence);
    expect(result.fieldWinners.amount?.header).toBe('X');
    expect(x.needsReview).toBe(true);
    expect(y.needsReview).toBe(true);
    expect(y.alternativeOf?.header).toBe('X');
  });

  it('records a clear loser as a secondary claim without flagging review', () => {
    const rows = [
      ['02.01.2024', '02.01.2024'],
      ['03.01.2024', '03.01.2024'],
    ];
    const result = mapColumns(['Buchtag', 'Valuta'], rows);
    const buchtag = fieldOf(result, 'Buchtag');
    const valuta = fieldOf(result, 'Valuta');
    expect(buchtag.field).toBe('date');
    expect(valuta.field).toBe('date');
    expect(buchtag.needsReview).toBe(false);
    expect(valuta.needsReview).toBe(false);
    expect(valuta.alternativeOf?.header).toBe('Buchtag');
    expect(result.fieldWinners.date?.header).toBe('Buchtag');
  });
});

describe('mapColumns — unmapped and ignore are honest buckets', () => {
  it('lands unknown no-evidence headers in unmapped', () => {
    const result = mapColumns(['Product', 'Zahlart'], [['Current', 'Karte']]);
    expect(result.mappings).toEqual([]);
    expect(result.unmapped).toEqual(['Product', 'Zahlart']);
  });

  it('maps known noise to ignore so it never contests real fields', () => {
    const result = mapColumns(
      ['Balance', 'State', 'Exchange Rate', 'TA-Nr.', 'Account number', 'Realized P/L'],
      [['1234.56', 'COMPLETED', '', '100001', 'AT483200000012345678', '70.98']],
    );
    expect(result.unmapped).toEqual([]);
    expect(result.mappings.every((m) => m.field === 'ignore')).toBe(true);
    expect(Object.keys(result.fieldWinners)).toEqual([]);
  });

  it('keeps an ambiguous-but-plausible weak guess OUT of confident mappings', () => {
    // One lone positive decimal: quantity/price shape is deliberately sub-floor.
    const result = mapColumns(['Mystery'], [['7']]);
    expect(result.mappings).toEqual([]);
    expect(result.unmapped).toEqual(['Mystery']);
  });
});

describe('extractRowFields', () => {
  it('projects raw winner cells per field', () => {
    const headers = TRAP_HEADER.split(';');
    const result = mapColumns(headers, TRAP_ROWS);
    const fields = extractRowFields(result, TRAP_ROWS[1]!);
    expect(fields.date).toBe('18.01.2024');
    expect(fields.isin).toBe('IE0009876543');
    expect(fields.quantity).toBe('2,5');
    expect(fields.amount).toBe('100,00');
    expect(fields.currency).toBe('EUR');
    // description resolves to its WINNER (the security name).
    expect(fields.description).toBe('Beispiel Welt ETF');
  });
});
