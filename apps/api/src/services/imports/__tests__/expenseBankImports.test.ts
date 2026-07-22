import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  expenseImportApplyResponseSchema,
  expenseImportPreviewResponseSchema,
  type ExpenseCategory,
  type ExpenseImportApplyResponse,
  type ExpenseImportOverride,
  type ExpenseImportPreviewResponse,
  type ExpenseTransaction,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * Bank-statement CSV import through the HTTP surface (PROJECTPLAN.md §13.5 V5-P9,
 * issue 2/3): each anonymized fixture autodetects, auto-categorizes via the user's
 * rules and applies to its exact golden set; applied rows carry `import:<bank>`
 * source tags; re-import is a zero-write no-op; a manual recategorize survives it;
 * preview-time overrides win. Broker imports are untouched (their own registry).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(path.join(fixtureDir, name), 'utf8');
const ERSTE = fixture('erste-george.csv');
const ELBA = fixture('raiffeisen-elba.csv');
const N26 = fixture('n26.csv');
const REVOLUT = fixture('revolut.csv');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

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
  return { user, agent };
}

async function listCategories(agent: Agent): Promise<ExpenseCategory[]> {
  const res = await agent.get('/api/v1/expenses/categories');
  expect(res.status).toBe(200);
  return res.body.categories as ExpenseCategory[];
}

/** Seed the defaults + return the id of a category by name (creates the map). */
async function categoryId(agent: Agent, name: string): Promise<string> {
  const found = (await listCategories(agent)).find((c) => c.name === name);
  if (!found) throw new Error(`No default category "${name}"`);
  return found.id;
}

async function createRule(
  agent: Agent,
  body: { categoryId: string; pattern: string; matchType?: string; priority?: number },
): Promise<void> {
  const res = await agent
    .post('/api/v1/expenses/rules')
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function previewImport(
  agent: Agent,
  csv: string,
  bankId?: string,
): Promise<ExpenseImportPreviewResponse> {
  const req = agent.post('/api/v1/expenses/import/preview').set(...XRW);
  if (bankId) void req.field('bankId', bankId);
  const res = await req.attach('file', Buffer.from(csv, 'utf8'), 'statement.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return expenseImportPreviewResponseSchema.parse(res.body);
}

async function applyImport(
  agent: Agent,
  csv: string,
  opts: { bankId?: string; overrides?: ExpenseImportOverride[] } = {},
): Promise<ExpenseImportApplyResponse> {
  const req = agent.post('/api/v1/expenses/import/apply').set(...XRW);
  if (opts.bankId) void req.field('bankId', opts.bankId);
  if (opts.overrides) void req.field('overrides', JSON.stringify(opts.overrides));
  const res = await req.attach('file', Buffer.from(csv, 'utf8'), 'statement.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return expenseImportApplyResponseSchema.parse(res.body);
}

async function listTransactions(agent: Agent): Promise<ExpenseTransaction[]> {
  const res = await agent.get('/api/v1/expenses/transactions');
  expect(res.status).toBe(200);
  return res.body.transactions as ExpenseTransaction[];
}

const byDescription = (txs: ExpenseTransaction[]): Map<string, ExpenseTransaction> =>
  new Map(txs.map((t) => [t.description, t]));

describe('GET /expenses/import/banks', () => {
  it('lists the four supported banks', async () => {
    const { agent } = await setup();
    const res = await agent.get('/api/v1/expenses/import/banks');
    expect(res.status).toBe(200);
    expect(res.body.banks.map((b: { id: string }) => b.id)).toEqual([
      'erste_george',
      'raiffeisen_elba',
      'n26',
      'revolut',
    ]);
  });
});

describe('Erste / George import — golden set + auto-categorization', () => {
  it('autodetects, previews with rule-suggested categories, and applies the exact set', async () => {
    const { agent } = await setup();
    const groceries = await categoryId(agent, 'Groceries');
    const subs = await categoryId(agent, 'Subscriptions');
    await createRule(agent, { categoryId: groceries, pattern: 'billa' });
    await createRule(agent, { categoryId: subs, pattern: 'spotify' });

    const preview = await previewImport(agent, ERSTE);
    expect(preview.bankId).toBe('erste_george');
    expect(preview.counts).toEqual({ total: 4, new: 4, duplicate: 0, error: 0 });
    const previewRows = new Map(preview.rows.map((r) => [r.description, r]));
    expect(previewRows.get('BILLA')?.categoryName).toBe('Groceries');
    expect(previewRows.get('SPOTIFY AB')?.categoryName).toBe('Subscriptions');
    expect(previewRows.get('Muster GmbH')?.categoryId).toBeNull();

    const result = await applyImport(agent, ERSTE);
    expect(result).toMatchObject({ bankId: 'erste_george', applied: 4, duplicate: 0, error: 0 });

    const txs = byDescription(await listTransactions(agent));
    expect(txs.size).toBe(4);
    expect(txs.get('BILLA')).toMatchObject({
      direction: 'expense',
      amount: 38.2,
      currency: 'EUR',
      bookedOn: '2024-01-02',
      categoryId: groceries,
      source: 'import:erste_george',
    });
    expect(txs.get('SPOTIFY AB')).toMatchObject({ amount: 9.99, categoryId: subs });
    expect(txs.get('Muster GmbH')).toMatchObject({
      direction: 'income',
      amount: 2500,
      categoryId: null,
      source: 'import:erste_george',
    });
  });

  it('re-importing the fixture writes nothing (idempotent via content hashing)', async () => {
    const { agent } = await setup();
    await applyImport(agent, ERSTE);
    expect(await listTransactions(agent)).toHaveLength(4);

    const preview = await previewImport(agent, ERSTE);
    expect(preview.counts).toMatchObject({ new: 0, duplicate: 4 });
    const second = await applyImport(agent, ERSTE);
    expect(second).toMatchObject({ applied: 0, duplicate: 4 });
    expect(second.rows.every((r) => r.result === 'skipped_duplicate')).toBe(true);
    expect(await listTransactions(agent)).toHaveLength(4);
  });

  it('a manual recategorize wins and survives a re-import', async () => {
    const { agent } = await setup();
    const groceries = await categoryId(agent, 'Groceries');
    const dining = await categoryId(agent, 'Dining & Takeout');
    await createRule(agent, { categoryId: groceries, pattern: 'billa' });
    await applyImport(agent, ERSTE);

    const billa = (await listTransactions(agent)).find((t) => t.description === 'BILLA');
    expect(billa?.categoryId).toBe(groceries);
    const recat = await agent
      .put(`/api/v1/expenses/transactions/${billa!.id}/category`)
      .set(...XRW)
      .send({ categoryId: dining });
    expect(recat.status).toBe(200);

    // Re-import: the row dedupes, so the manual category is never overwritten.
    const second = await applyImport(agent, ERSTE);
    expect(second).toMatchObject({ applied: 0, duplicate: 4 });
    const billaAfter = (await listTransactions(agent)).find((t) => t.description === 'BILLA');
    expect(billaAfter?.categoryId).toBe(dining);
  });
});

describe('every bank fixture applies + carries its source tag', () => {
  const cases: Array<{ bankId: string; csv: string; count: number; source: string }> = [
    { bankId: 'erste_george', csv: ERSTE, count: 4, source: 'import:erste_george' },
    { bankId: 'raiffeisen_elba', csv: ELBA, count: 3, source: 'import:raiffeisen_elba' },
    { bankId: 'n26', csv: N26, count: 3, source: 'import:n26' },
    { bankId: 'revolut', csv: REVOLUT, count: 3, source: 'import:revolut' },
  ];

  for (const { bankId, csv, count, source } of cases) {
    it(`${bankId}: applies ${count} rows tagged ${source}`, async () => {
      const { agent } = await setup();
      const preview = await previewImport(agent, csv);
      expect(preview.bankId).toBe(bankId);
      expect(preview.counts).toMatchObject({ total: count, new: count, duplicate: 0, error: 0 });

      const result = await applyImport(agent, csv);
      expect(result).toMatchObject({ bankId, applied: count, duplicate: 0, error: 0 });

      const txs = await listTransactions(agent);
      expect(txs).toHaveLength(count);
      expect(txs.every((t) => t.source === source)).toBe(true);
    });
  }
});

describe('preview-time category overrides', () => {
  it('a user override wins over the rule suggestion (and null keeps it uncategorized)', async () => {
    const { agent } = await setup();
    const groceries = await categoryId(agent, 'Groceries');
    const transport = await categoryId(agent, 'Transport');
    // A rule would file REWE under Groceries…
    await createRule(agent, { categoryId: groceries, pattern: 'rewe' });

    const preview = await previewImport(agent, N26);
    const rewe = preview.rows.find((r) => r.description === 'REWE');
    const netflix = preview.rows.find((r) => r.description === 'Netflix');
    expect(rewe?.categoryId).toBe(groceries);

    // …but the user overrides REWE → Transport and clears Netflix's suggestion.
    const result = await applyImport(agent, N26, {
      overrides: [
        { rowIndex: rewe!.rowIndex, categoryId: transport },
        { rowIndex: netflix!.rowIndex, categoryId: null },
      ],
    });
    expect(result.applied).toBe(3);

    const txs = byDescription(await listTransactions(agent));
    expect(txs.get('REWE')?.categoryId).toBe(transport);
    expect(txs.get('Netflix')?.categoryId).toBeNull();
  });

  it('rejects an override pointing at a category the caller does not own', async () => {
    const { agent } = await setup();
    const preview = await previewImport(agent, N26);
    const res = await agent
      .post('/api/v1/expenses/import/apply')
      .set(...XRW)
      .field(
        'overrides',
        JSON.stringify([
          {
            rowIndex: preview.rows[0]!.rowIndex,
            categoryId: '00000000-0000-4000-8000-000000000000',
          },
        ]),
      )
      .attach('file', Buffer.from(N26, 'utf8'), 'statement.csv');
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('EXPENSE_CATEGORY_REF_NOT_FOUND');
    expect(await listTransactions(agent)).toHaveLength(0);
  });
});

describe('import guards', () => {
  it('rejects an unrecognized file, then accepts it with a manual bank pick', async () => {
    const { agent } = await setup();
    const generic = 'Foo,Bar,Baz\n1,2,3';
    const rejected = await agent
      .post('/api/v1/expenses/import/preview')
      .set(...XRW)
      .attach('file', Buffer.from(generic, 'utf8'), 'statement.csv');
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe('EXPENSE_IMPORT_BANK_UNRECOGNIZED');

    // A manual pick still runs the mapper — the generic row then fails per-row.
    const picked = await previewImport(agent, generic, 'n26');
    expect(picked.bankId).toBe('n26');
    expect(picked.counts.error).toBe(1);
  });
});
