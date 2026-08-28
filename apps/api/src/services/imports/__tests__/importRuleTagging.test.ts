import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  importPreviewResponseSchema,
  type ApplyImportResponse,
  type ImportPreviewResponse,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';

/**
 * CASH-RULE TAGGING AT IMPORT STAGING (#964, §16 2026-07-31).
 *
 * Imported cash movements arrive PRE-TAGGED by the user's own cash rules, and
 * the suggestion is visible in the preview BEFORE apply — the same rule
 * machinery (`cashRuleEngine.tagsByRules`, first match wins) that tags a
 * hand-recorded movement, run once per staged batch.
 *
 * The invariant these tests exist for is NO DRIFT: what the preview showed is
 * what apply books. The suggestion is computed once, at staging, PERSISTED on
 * the staged row, and REPLAYED at apply — so editing or deleting the rule
 * between preview and apply can never make a confirmed tag disappear.
 *
 * Driven through a real broker fixture (Flatex cash export, real mapper, real
 * `Buchungsinformationen` memos) over the real HTTP surface, because the memo
 * a rule matches is produced by the mapper, not by the test.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RULES_FIXTURE = readFileSync(path.join(fixtureDir, 'flatex-cash-rules.csv'), 'utf8');

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

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  return { user, agent, pid };
}

/** Create a cash tag, returning its id. */
async function createTag(agent: Agent, name: string): Promise<string> {
  const res = await agent
    .post('/api/v1/cash/tags')
    .set(...XRW)
    .send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.tag.id as string;
}

/** Create a cash rule, returning its id. */
async function createRule(
  agent: Agent,
  input: {
    tagIds: string[];
    pattern: string;
    matchType?: 'contains' | 'equals' | 'starts_with' | 'regex';
    priority?: number;
    enabled?: boolean;
  },
): Promise<string> {
  const res = await agent
    .post('/api/v1/cash/rules')
    .set(...XRW)
    .send(input);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.rule.id as string;
}

async function upload(agent: Agent, pid: string, csv: string): Promise<ImportPreviewResponse> {
  const res = await agent
    .post('/api/v1/imports')
    .set(...XRW)
    .field('portfolioId', pid)
    .field('brokerId', 'flatex')
    .attach('file', Buffer.from(csv, 'utf8'), 'flatex-cash.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return importPreviewResponseSchema.parse(res.body);
}

async function apply(agent: Agent, batchId: string): Promise<ApplyImportResponse> {
  const res = await agent
    .post(`/api/v1/imports/${batchId}/apply`)
    .set(...XRW)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ApplyImportResponse;
}

/** The applied ledger, movement note → tag ids. */
async function ledgerTagsByNote(agent: Agent, pid: string): Promise<Map<string, string[]>> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  const out = new Map<string, string[]>();
  for (const m of res.body.movements as Array<{ note: string | null; tags?: string[] }>) {
    out.set(m.note ?? '', m.tags ?? []);
  }
  return out;
}

/** The staged preview row whose memo contains `needle`. */
function rowByNote(preview: ImportPreviewResponse, needle: string) {
  const row = preview.rows.find((r) => (r.note ?? '').includes(needle));
  if (!row) throw new Error(`No preview row with a note containing "${needle}"`);
  return row;
}

describe('cash-rule tagging at import staging', () => {
  it('pre-tags a matching cash row in the preview, before anything is applied', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    // The deposit whose memo carries "Gehalt" is suggested the Salary tag …
    expect(rowByNote(preview, 'Gehalt ACME').ruleTagIds).toEqual([salary]);
    // … and staging still writes nothing portfolio-visible (§13.4).
    expect((await ledgerTagsByNote(agent, pid)).size).toBe(0);
  });

  it('leaves a row no rule matches without a suggestion (absent, not empty)', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    // A rule that matches nothing on a row costs that row nothing: the key is
    // absent exactly like `candidates` is on a resolved row.
    expect(rowByNote(preview, 'Unbekannter Empfaenger').ruleTagIds).toBeUndefined();
  });

  it('a rule matching zero imported rows adds nothing anywhere', async () => {
    const { agent, pid } = await setup();
    const nope = await createTag(agent, 'Never');
    await createRule(agent, { tagIds: [nope], pattern: 'this-memo-does-not-exist' });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    expect(preview.rows.every((r) => r.ruleTagIds === undefined)).toBe(true);
  });

  it('matches case-insensitively and across unicode memos, per the existing engine', async () => {
    const { agent, pid } = await setup();
    const rent = await createTag(agent, 'Rent');
    const office = await createTag(agent, 'Office');
    // The memo is "MIETE" (upper); the pattern is "miete" (lower).
    await createRule(agent, { tagIds: [rent], pattern: 'miete' });
    // The memo is "BÜRO" (upper, umlaut); the pattern is "büro" (lower, umlaut).
    await createRule(agent, { tagIds: [office], pattern: 'büro' });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    expect(rowByNote(preview, 'MIETE').ruleTagIds).toEqual([rent]);
    expect(rowByNote(preview, 'BÜRO').ruleTagIds).toEqual([office]);
  });

  it('pins first-match-wins by priority when a memo matches several rules', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    const bonus = await createTag(agent, 'Bonus');
    // "Einzahlung SEPA Bonus Gehalt Sonderzahlung" matches BOTH patterns.
    // Lower priority runs first and its WHOLE tag set wins — no union.
    await createRule(agent, { tagIds: [bonus], pattern: 'bonus', priority: 1 });
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt', priority: 5 });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    const row = rowByNote(preview, 'Bonus Gehalt');
    expect(row.ruleTagIds).toEqual([bonus]);
    expect(row.ruleTagIds).not.toContain(salary);
  });

  it('carries a whole multi-tag rule set onto the row', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    const income = await createTag(agent, 'Income');
    await createRule(agent, { tagIds: [salary, income], pattern: 'gehalt', priority: 0 });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    expect(rowByNote(preview, 'Gehalt ACME').ruleTagIds?.sort()).toEqual([salary, income].sort());
  });

  it('ignores a disabled rule', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt', enabled: false });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    expect(rowByNote(preview, 'Gehalt ACME').ruleTagIds).toBeUndefined();
  });

  it('matches an anchored regex rule at staging, and books the same tag', async () => {
    // Regex rules run through RE2 and are the one match type whose result can
    // depend on the exact string handed to the engine (an anchor sees leading
    // whitespace; `contains` never does). The fixture row's memo is written
    // with leading spaces for that reason — note that `parseCsv` trims every
    // cell, so the note arrives already trimmed and this asserts the ANCHORED
    // match itself, not the trim. The trim in `stagedRuleTags` is defensive
    // parity with book time for callers that are not the CSV parser.
    const { agent, pid } = await setup();
    const donation = await createTag(agent, 'Donations');
    await createRule(agent, {
      tagIds: [donation],
      matchType: 'regex',
      pattern: '^einzahlung sepa spende',
    });

    const preview = await upload(agent, pid, RULES_FIXTURE);
    expect(rowByNote(preview, 'Spende Rotes Kreuz').ruleTagIds).toEqual([donation]);

    // …and the booked movement agrees, which is what "same engine, same input"
    // is supposed to buy: staging and book time reach the same verdict.
    await apply(agent, preview.batch.id);
    const booked = await ledgerTagsByNote(agent, pid);
    const spende = [...booked.entries()].find(([note]) => note.includes('Spende Rotes Kreuz'));
    expect(spende?.[1]).toContain(donation);
  });

  it('is stable across re-reads of the same staged batch', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });

    const first = await upload(agent, pid, RULES_FIXTURE);
    const reread = importPreviewResponseSchema.parse(
      (await agent.get(`/api/v1/imports/${first.batch.id}`)).body,
    );

    expect(rowByNote(reread, 'Gehalt ACME').ruleTagIds).toEqual(
      rowByNote(first, 'Gehalt ACME').ruleTagIds,
    );
  });

  it('applies exactly the tags the preview showed — no drift', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    const rent = await createTag(agent, 'Rent');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });
    await createRule(agent, { tagIds: [rent], pattern: 'miete' });

    const preview = await upload(agent, pid, RULES_FIXTURE);
    const previewedSalary = rowByNote(preview, 'Gehalt ACME').ruleTagIds ?? [];
    const previewedRent = rowByNote(preview, 'MIETE').ruleTagIds ?? [];
    await apply(agent, preview.batch.id);

    const booked = await ledgerTagsByNote(agent, pid);
    // Every previewed tag is on the booked movement (the movement additionally
    // carries its app-owned system tag, which the preview never claimed).
    for (const tagId of previewedSalary) {
      expect(booked.get('Einzahlung SEPA Gehalt ACME GmbH')).toContain(tagId);
    }
    for (const tagId of previewedRent) {
      expect(booked.get('Auszahlung SEPA MIETE Wohnung Wien')).toContain(tagId);
    }
    expect(previewedSalary).toEqual([salary]);
    expect(previewedRent).toEqual([rent]);
  });

  it('honours the PREVIEWED tag even when the rule is deleted before apply', async () => {
    // THE DRIFT TEST. The user confirmed a preview that promised "Salary". If
    // apply re-evaluated the rules instead of replaying the preview, deleting
    // the rule in another tab would silently drop the tag they confirmed.
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    const ruleId = await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });

    const preview = await upload(agent, pid, RULES_FIXTURE);
    expect(rowByNote(preview, 'Gehalt ACME').ruleTagIds).toEqual([salary]);

    const del = await agent.delete(`/api/v1/cash/rules/${ruleId}`).set(...XRW);
    expect(del.status).toBe(204);

    await apply(agent, preview.batch.id);

    const booked = await ledgerTagsByNote(agent, pid);
    expect(booked.get('Einzahlung SEPA Gehalt ACME GmbH')).toContain(salary);
  });

  it("never lets another user's rules tag this user's import", async () => {
    const { agent, pid } = await setup();
    const other = await harness.seedUser({
      email: 'other@bettertrack.test',
      username: 'otheruser',
    });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const otherTag = await createTag(otherAgent, 'Their Salary');
    await createRule(otherAgent, { tagIds: [otherTag], pattern: 'gehalt' });

    const preview = await upload(agent, pid, RULES_FIXTURE);

    expect(preview.rows.every((r) => r.ruleTagIds === undefined)).toBe(true);

    await apply(agent, preview.batch.id);
    const booked = await ledgerTagsByNote(agent, pid);
    for (const tagIds of booked.values()) expect(tagIds).not.toContain(otherTag);
  });
});
