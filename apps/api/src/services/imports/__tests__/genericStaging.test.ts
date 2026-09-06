import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IMPORT_MAPPABLE_FIELDS, importPreviewResponseSchema } from '@bettertrack/contracts';
import type { ImportPreviewResponse } from '@bettertrack/contracts';

import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { AI_PROPOSAL_CONFIDENCE, MAPPABLE_FIELDS } from '../columnMapping';
import { stageGenericFile } from '../genericStaging';
import type { ImportAiSeam } from '../importAi';

/**
 * THE GENERIC STAGING PATH (#964, §16 2026-07-31: "IMPORT IS A WIZARD THAT
 * UNDERSTANDS A WHOLE FILE, not a CSV parser for one shape").
 *
 * These tests exist for four claims:
 *
 *  1. A file NO broker mapper claims is understood instead of refused — the
 *     `IMPORT_BROKER_UNRECOGNIZED` dead end is gone (directive point 1), while
 *     the four hand-written mappers still win on the files they know.
 *  2. Kind is decided PER ROW, so one file may hold cash movements AND trades
 *     (directive point 2). This is the owner's named failure mode — "IF THERE
 *     IS 1 STOCK TRANSACTION I EITHER BREAK OR ADD IT TO JUST A CASH WITHDRAW"
 *     — so it gets a file that would have triggered it.
 *  3. What could not be worked out is REPORTED with a reason, never guessed and
 *     never dropped (directive point 3).
 *  4. The AI header fallback cannot decide anything: its proposals are surfaced
 *     for confirmation, are structurally excluded from value extraction, and an
 *     absent or FAILING seam degrades to the deterministic pipeline.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string) => readFileSync(path.join(fixtureDir, name), 'utf8');

/** Two REAL fixtures no PORTFOLIO mapper claims — one English, one German. */
const N26 = readFixture('n26.csv');
const ELBA = readFixture('raiffeisen-elba.csv');

type Agent = ReturnType<typeof request.agent>;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ marketData: createStubMarketData() });
});

afterEach(async () => {
  await harness.dispose();
});

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const list = await agent.get('/api/v1/portfolios');
  const pid = list.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
  return { user, agent, pid };
}

async function upload(
  agent: Agent,
  pid: string,
  csv: string,
  opts: { brokerId?: string; filename?: string; expectedStatus?: number } = {},
): Promise<ImportPreviewResponse> {
  let req = agent
    .post('/api/v1/imports')
    .set(...XRW)
    .field('portfolioId', pid);
  if (opts.brokerId) req = req.field('brokerId', opts.brokerId);
  const res = await req.attach('file', Buffer.from(csv, 'utf8'), opts.filename ?? 'statement.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(opts.expectedStatus ?? 201);
  if (res.status !== 201) return res.body as ImportPreviewResponse;
  return importPreviewResponseSchema.parse(res.body);
}

describe('the wire vocabulary and the mapper vocabulary cannot drift', () => {
  it('pins contracts IMPORT_MAPPABLE_FIELDS to columnMapping MAPPABLE_FIELDS', () => {
    // The API list is the AI prompt's security boundary; the contract list is
    // what a client renders a field picker from. Two copies by necessity
    // (contracts must not depend on apps/api), so equality is asserted rather
    // than assumed — order included, both being ordered vocabularies.
    expect([...IMPORT_MAPPABLE_FIELDS]).toEqual([...MAPPABLE_FIELDS]);
  });
});

describe('a file no broker mapper claims is understood, not refused', () => {
  it('stages a real N26 export, booking what it is sure of and asking about the rest', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, N26, { filename: 'n26.csv' });

    expect(preview.batch.brokerId).toBe('generic');
    expect(preview.understanding).toBeDefined();

    // The columns it worked out, from the deterministic dictionary alone.
    const byField = new Map(preview.understanding!.mappings.map((m) => [m.field, m.header]));
    expect(byField.get('date')).toBe('Date');
    expect(byField.get('amount')).toBe('Amount (EUR)');
    expect(byField.get('kindHint')).toBe('Transaction type');

    // Every one of the four statement lines is accounted for — nothing is
    // dropped, which is the property that matters most here.
    expect(preview.rows).toHaveLength(4);
    expect(preview.batch.counts.total).toBe(4);

    // The row whose `Transaction type` says "Direct Debit" is classified
    // structurally and books: a real withdrawal at the file's own magnitude.
    const debit = preview.rows.find((r) => r.raw.includes('Netflix'));
    expect(debit?.kind).toBe('withdrawal');
    expect(debit?.flag).toBe('mapped');
    expect(debit?.amountEur).toBe(12.99);

    // The two rows carrying only a memo and a signed amount are read as
    // deposit/withdrawal by SIGN, which the classifier will not book
    // unattended. They surface with the reason instead of being guessed.
    const salary = preview.rows.find((r) => r.raw.includes('ACME GmbH'));
    expect(salary?.flag).toBe('error');
    expect(salary?.message).toMatch(/needs a human decision/i);
    expect(salary?.message).toMatch(/deposit/);
  });

  it('reads a German semicolon export, and reports every row it will not book alone', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, ELBA, { filename: 'elba.csv' });

    expect(preview.batch.brokerId).toBe('generic');
    expect(preview.understanding?.delimiter).toBe(';');
    expect(preview.understanding?.numberLocale).toBe('de');
    // Dotted German dates are unambiguous — only the two SLASH notations are a
    // coin flip — so the date order is not what holds these rows back.
    expect(preview.understanding?.dateLocaleAmbiguous).toBe(false);
    // `Buchungsdatum` beats `Valutadatum` for the date, per the dictionary's
    // documented booking-over-value-date rank.
    const date = preview.understanding!.mappings.find((m) => m.field === 'date');
    expect(date?.header).toBe('Buchungsdatum');

    // This statement has no booking-type column at all, so every row is a bare
    // memo + signed amount: all three are reported for a human decision, and
    // all three are still visible with their original line.
    expect(preview.rows).toHaveLength(3);
    expect(preview.batch.counts.error).toBe(3);
    for (const row of preview.rows) {
      expect(row.message).toMatch(/needs a human decision/i);
      expect(row.raw).toContain('AT483200000012345678');
      // …and REPORTED IS NOT FINAL (§16 2026-08-29 gap (b)): a row held back
      // only by the kind question keeps everything it parsed, so a person can
      // confirm a kind without re-uploading a file the server never stored.
      // `importRowKindConfirmation.test.ts` owns that flow end to end; what
      // matters here is that staging stopped writing these rows away as nulls.
      expect(row.executedAt).not.toBeNull();
      expect(row.note).not.toBeNull();
      expect(row.amountEur).not.toBeNull();
      expect(row.confirmableKinds?.length).toBeGreaterThan(0);
    }
    // The file signs its amounts (two of the three lines are negative), which is
    // what makes a positive amount mean "money in" on this statement.
    expect(preview.understanding?.amountsSigned).toBe(true);
  });

  it('leaves the hand-written mappers in charge of the files they know', async () => {
    const { agent, pid } = await setup();
    // The Trade Republic fixture keeps importing through the mapper verified
    // against it byte for byte — the generic path never displaces a claim.
    const preview = await upload(agent, pid, readFixture('trade-republic.csv'));
    expect(preview.batch.brokerId).toBe('trade_republic');
    expect(preview.understanding).toBeUndefined();
  });

  it('lets a user FORCE the generic path over a mapper that would claim the file', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, readFixture('trade-republic.csv'), {
      brokerId: 'generic',
    });
    expect(preview.batch.brokerId).toBe('generic');
    expect(preview.understanding).toBeDefined();
  });
});

describe('mixed content is the normal case (directive point 2)', () => {
  // One file: a salary in, a card payment out, and a share purchase. Forced
  // onto the generic path because the Trade-Republic mapper's fingerprint
  // happens to claim this German header shape — the point under test is the
  // PER-ROW kind decision, not autodetection.
  const MIXED = [
    'Datum;Buchungstext;Typ;Stück;Kurs;Betrag;Währung;ISIN',
    '05.01.2024;GEHALT ARBEITGEBER AG;Gutschrift;;;2.100,00;EUR;',
    '11.01.2024;HOFER DANKT KARTE;Lastschrift;;;-52,30;EUR;',
    '12.01.2024;Muster Tech AG;Kauf;10;100,00;-1.000,00;EUR;DE000MUSTER1',
  ].join('\n');

  it('books cash as cash and the trade as a trade, from ONE file', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, MIXED, {
      filename: 'mixed.csv',
      brokerId: 'generic',
    });

    expect(preview.rows).toHaveLength(3);
    const kinds = preview.rows.map((r) => r.kind);
    // The decisive assertion: the trade is NOT swallowed into a cash movement,
    // and the two cash rows are not dragged into being trades.
    expect(kinds).toContain('buy');
    expect(kinds).toContain('deposit');
    expect(kinds).toContain('withdrawal');

    // German grouping is read with the file's own number locale: "2.100,00" is
    // two thousand one hundred, not 2.1.
    const salary = preview.rows.find((r) => r.kind === 'deposit');
    expect(salary?.amountEur).toBe(2100);
    expect(salary?.flag).toBe('mapped');
    expect(salary?.executedAt?.slice(0, 10)).toBe('2024-01-05');

    const card = preview.rows.find((r) => r.kind === 'withdrawal');
    // Direction lives in `kind`; staging stores the positive magnitude.
    expect(card?.amountEur).toBe(52.3);

    const trade = preview.rows.find((r) => r.kind === 'buy');
    expect(trade?.quantity).toBe(10);
    expect(trade?.price).toBe(100);
    expect(trade?.isin).toBe('DE000MUSTER1');
    // No catalog asset was seeded, so the instrument does not resolve — and an
    // unresolved trade is REPORTED, never quietly rewritten into a withdrawal.
    expect(trade?.flag).toBe('unmapped');
  });
});

describe('what it could not work out is reported, never guessed (point 3)', () => {
  it('refuses to book an ambiguous slash date and says why, per row', async () => {
    const { agent, pid } = await setup();
    // Every component is <= 12, so 01/02/2024 is either 1 Feb or 2 Jan. The
    // sniffer cannot resolve the order and no row may book unattended.
    const AMBIGUOUS = [
      'Date,Description,Type,Amount',
      '01/02/2024,Salary,Credit,1500.00',
      '03/04/2024,Rent,Debit,-800.00',
    ].join('\n');
    const preview = await upload(agent, pid, AMBIGUOUS, { filename: 'ambiguous.csv' });

    expect(preview.understanding?.dateLocaleAmbiguous).toBe(true);
    expect(preview.rows).toHaveLength(2);
    for (const row of preview.rows) {
      expect(row.flag).toBe('error');
      expect(row.message).toMatch(/date order is ambiguous/i);
    }
    // Reported, not dropped: the counts still account for every line.
    expect(preview.batch.counts.total).toBe(2);
    expect(preview.batch.counts.error).toBe(2);
  });

  it('refuses a non-EUR cash amount rather than booking it as EUR', async () => {
    const { agent, pid } = await setup();
    const USD = [
      'Date,Description,Type,Amount,Currency',
      '2024-01-05,Salary,Credit,1500.00,USD',
      '2024-01-06,Salary,Credit,900.00,EUR',
    ].join('\n');
    const preview = await upload(agent, pid, USD, { filename: 'usd.csv' });

    const usdRow = preview.rows.find((r) => r.raw.includes('USD'));
    expect(usdRow?.flag).toBe('error');
    expect(usdRow?.message).toMatch(/recorded in EUR/i);

    // …and the EUR row beside it still lands: per-row tolerance, never
    // all-or-nothing across the file.
    const eurRow = preview.rows.find((r) => r.raw.endsWith('EUR'));
    expect(eurRow?.flag).toBe('mapped');
    expect(eurRow?.amountEur).toBe(900);

    // REPORTED IS NOT FINAL: the currency refusal says nothing about the kind,
    // so the row keeps everything it parsed instead of being persisted all-null.
    // Ending it there is what made the refusal unrecoverable — nothing the
    // wizard offers could reach a row with no fields.
    expect(usdRow?.executedAt).toBe('2024-01-05T12:00:00.000Z');
    expect(usdRow?.currency).toBe('USD');
    expect(usdRow?.amountEur).toBe(1500);
  });

  it('keeps a non-EUR row confirmable as the kind its currency does not block', async () => {
    const { agent, pid } = await setup();
    // A trade keeps its native currency exactly as the broker mappers do, so a
    // USD row the classifier read as cash is still a buy a person can confirm.
    const USD_TRADE = [
      'Date,Description,Type,Amount,Currency,ISIN,Quantity,Price',
      '2024-01-05,Muster Tech AG,Credit,-500.00,USD,DE0001234567,10,50.00',
    ].join('\n');
    const preview = await upload(agent, pid, USD_TRADE, { filename: 'usd-trade.csv' });

    const row = preview.rows[0];
    expect(row?.flag).toBe('error');
    expect(row?.currency).toBe('USD');
    expect(row?.confirmableKinds).toContain('buy');
  });

  it('does not let an ignored FX column restate the whole file as non-EUR', async () => {
    const { agent, pid } = await setup();
    // `Type Foreign Currency` is aliased to `ignore` at 0.9 — an informational
    // column no value is read from. It used to set the file's default currency
    // all the same, so every row was refused as non-EUR and deleting just that
    // column imported the identical file cleanly.
    const FX_NOISE = [
      'Buchungsdatum;Buchungsart;Buchungstext;Betrag;Type Foreign Currency',
      '03.01.2024;Auszahlung;HOFER DANKT KARTE;-52,30;USD',
      '31.01.2024;Einzahlung;GEHALT ARBEITGEBER AG;2.100,00;USD',
    ].join('\n');
    const preview = await upload(agent, pid, FX_NOISE, { filename: 'fx-noise.csv' });

    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.map((r) => [r.kind, r.amountEur, r.currency])).toEqual([
      ['withdrawal', 52.3, 'EUR'],
      ['deposit', 2100, 'EUR'],
    ]);
    expect(preview.batch.counts.error).toBe(0);
  });

  it('does not send a row to manual review over an ignored column’s ambiguous number', async () => {
    // `1.092` in an `ignore`-mapped `Exchange Rate` column is an unreadable
    // grouping under `en` — and it used to force `needsReview` on the row,
    // which the staging path turns into a per-row error. On a real month that
    // is 100 % of the file demoted, citing a column nothing reads.
    const NETFLIX = [
      'Date,Payee,Transaction type,Amount,Exchange Rate',
      '2024-01-10,Netflix,Direct Debit,-12.99,1.092',
    ].join('\n');
    const CONTROL = ['Date,Payee,Transaction type,Amount', '2024-01-10,Netflix,Direct Debit,-12.99']
      .join('\n')
      .concat('\n');

    // The control — the identical file with only that column deleted — is what
    // the row must go back to reading as.
    const control = (await stageGenericFile(Buffer.from(CONTROL), 'control.csv'))!.lines[0]!;
    expect(control.ok).toBe(true);

    const withFx = (await stageGenericFile(Buffer.from(NETFLIX), 'fx.csv'))!.lines[0]!;
    expect(withFx.ok).toBe(true);
    expect(withFx.ok && withFx.row).toMatchObject({ kind: 'withdrawal', amountEur: 12.99 });
  });
});

describe('the AI header fallback can never decide anything', () => {
  // The committed fixture built for exactly this: a real Flatex securities
  // export whose last two columns (`Handelsplatz`, `Kurswert`, indexes 10/11)
  // the dictionary cannot name.
  const UNKNOWN_HEADERS = readFileSync(
    path.join(fixtureDir, 'flatex-securities-unknown-headers.csv'),
  );

  function seamAnswering(reply: string): ImportAiSeam {
    return {
      complete: async () => ({ text: reply, model: 'stub-model' }),
    };
  }

  it('surfaces a proposal as needing review, pinned to the floor, badged as ai', async () => {
    const staged = await stageGenericFile(UNKNOWN_HEADERS, 'unknown.csv', {
      header: { ai: seamAnswering('10=ignore\n11=amount') },
    });
    const proposal = staged!.understanding.mappings.find((m) => m.header === 'Kurswert');

    expect(proposal).toBeDefined();
    expect(proposal!.source).toBe('ai');
    // Unconditional, whatever the model said: a model verdict is never the
    // reason a column stops being reviewed.
    expect(proposal!.needsReview).toBe(true);
    expect(proposal!.confidence).toBe(AI_PROPOSAL_CONFIDENCE);
    expect(proposal!.reason).toMatch(/suggestion, not a mapping/i);
    // The contested deterministic winner travels with it, so the wizard can
    // show WHAT it would be displacing rather than just asserting a field.
    expect(proposal!.alternativeOf?.header).toBe('Endbetrag');
  });

  it('never reads a VALUE out of a proposed column — the rows are byte-identical', async () => {
    const withAi = await stageGenericFile(UNKNOWN_HEADERS, 'unknown.csv', {
      header: { ai: seamAnswering('10=ignore\n11=amount') },
    });
    const withoutAi = await stageGenericFile(UNKNOWN_HEADERS, 'unknown.csv');

    // The proposals exist in the understanding, so a human can confirm them…
    expect(withAi!.understanding.mappings.filter((m) => m.source === 'ai')).toHaveLength(2);
    expect(withoutAi!.understanding.mappings.some((m) => m.source === 'ai')).toBe(false);
    expect(withoutAi!.understanding.unmappedHeaders).toEqual(['Handelsplatz', 'Kurswert']);

    // …and change NOT ONE staged value. The model claimed `amount` for a column
    // that contests the one the dictionary picked, and every staged row is
    // still identical to the run that never asked it — because
    // `extractRowFields` reads `fieldWinners`, which a proposal never enters.
    // This is the "a proposal is not a decision" guarantee, asserted.
    expect(withAi!.lines).toEqual(withoutAi!.lines);
  });

  it('degrades to the deterministic pipeline when the seam THROWS', async () => {
    const failing: ImportAiSeam = {
      complete: async () => {
        throw new Error('provider exploded');
      },
    };
    const failed = await stageGenericFile(UNKNOWN_HEADERS, 'unknown.csv', {
      header: { ai: failing },
    });
    const plain = await stageGenericFile(UNKNOWN_HEADERS, 'unknown.csv');

    // No throw, no dead end — exactly what a deployment with no AI configured
    // sees, which is the shipped default.
    expect(failed).not.toBeNull();
    expect(failed!.understanding).toEqual(plain!.understanding);
    expect(failed!.lines).toEqual(plain!.lines);
  });

  it('runs the whole generic path over HTTP with NO seam configured at all', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, N26, { filename: 'n26.csv' });
    // Something actually imported, and nothing claims AI provenance.
    expect(preview.rows.filter((r) => r.flag === 'mapped').length).toBeGreaterThan(0);
    expect(preview.understanding!.mappings.every((m) => m.source === undefined)).toBe(true);
  });
});
