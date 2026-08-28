import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  importPreviewResponseSchema,
  type ApplyImportResponse,
  type ImportPreviewResponse,
  type SearchResultItem,
} from '@bettertrack/contracts';

import { createCashRuleRepository } from '../../../data/repositories/cashRuleRepository';
import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createCashTagRepository } from '../../../data/repositories/cashTagRepository';
import { createImportRepository } from '../../../data/repositories/importRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import * as schema from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import type { SearchService } from '../../search/searchService';
import { createImportService } from '../importService';
import type { BrokerMapper, NormalizedImportRow } from '../types';

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

  /**
   * THE ONE DRIFT CELL. Everywhere else "every previewed tag lands" holds
   * exactly; here it cannot, and the trade-off is deliberate.
   *
   * If the TAG ITSELF is deleted between preview and apply, the id the preview
   * promised no longer names anything. `attachTagWithinPortfolio` joins
   * `cash_tags` and therefore inserts nothing, and it must NOT throw: the money
   * is booked and the batch claimed by the time the replay runs, so failing the
   * row would report a `failed` row whose cash is nonetheless in the ledger —
   * a strictly worse lie than a missing label.
   *
   * So: the row applies, the money books, and the previewed tag is silently
   * absent. Pinned here so that outcome is a decision on record rather than
   * something a future reader discovers in production.
   */
  it('applies the row and books the money when the previewed TAG was deleted before apply', async () => {
    const { agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });

    const preview = await upload(agent, pid, RULES_FIXTURE);
    const staged = rowByNote(preview, 'Gehalt ACME');
    expect(staged.ruleTagIds).toEqual([salary]);

    // The tag, not the rule: the id on the staged row now points at nothing.
    const del = await agent.delete(`/api/v1/cash/tags/${salary}`).set(...XRW);
    expect(del.status).toBe(204);

    const result = await apply(agent, preview.batch.id);

    // Applied and booked — a vanished label never fails a row.
    expect(result.failed).toBe(0);
    expect(result.rows.find((r) => r.rowIndex === staged.rowIndex)?.result).toBe('applied');
    const booked = await ledgerTagsByNote(agent, pid);
    expect(booked.has('Einzahlung SEPA Gehalt ACME GmbH')).toBe(true);
    // …and the previewed tag is simply absent. This is the exception.
    expect(booked.get('Einzahlung SEPA Gehalt ACME GmbH')).not.toContain(salary);
  });
});

/**
 * THE REPLAY'S OWNERSHIP GUARDS (§10).
 *
 * `attachTagWithinPortfolio` scopes its INSERT on three axes at once — the tag
 * belongs to the portfolio's owner, the movement is in the named portfolio, and
 * the portfolio is not vaulted — and it does so in the repository, not in a
 * caller. Those axes were dormant while the function had no caller; this slice
 * gave it one, so they are live guards now and are pinned as such.
 *
 * The rule engine can never produce a foreign tag id (it only ever returns ids
 * from the caller's OWN rules), so the only way to reach the first guard from
 * outside the repository is to FORGE the id onto the staged row — which is
 * exactly the shape of a compromised or corrupted `import_rows` row, and
 * exactly what the guard is defence-in-depth against.
 */
describe("apply's tag replay is scoped in the repository, not by its caller", () => {
  /** Overwrite what staging computed for one staged row — the forged-row harness. */
  async function forgeRuleTagIds(
    batchId: string,
    noteNeedle: string,
    tagIds: string[],
  ): Promise<void> {
    const rows = await harness.db
      .select({ id: schema.importRows.id, note: schema.importRows.note })
      .from(schema.importRows)
      .where(eq(schema.importRows.batchId, batchId));
    const target = rows.find((row) => (row.note ?? '').includes(noteNeedle));
    if (!target) throw new Error(`No staged row with a note containing "${noteNeedle}"`);
    await harness.db
      .update(schema.importRows)
      .set({ ruleTagIds: tagIds })
      .where(eq(schema.importRows.id, target.id));
  }

  /** The booked movement whose note contains `needle`. */
  async function movementIdByNote(portfolioId: string, needle: string): Promise<string> {
    const rows = await harness.db
      .select({ id: schema.portfolioCashMovements.id, note: schema.portfolioCashMovements.note })
      .from(schema.portfolioCashMovements)
      .where(eq(schema.portfolioCashMovements.portfolioId, portfolioId));
    const target = rows.find((row) => (row.note ?? '').includes(needle));
    if (!target) throw new Error(`No booked movement with a note containing "${needle}"`);
    return target.id;
  }

  /** How many link rows exist for exactly this (movement, tag) pair. */
  async function pairCount(movementId: string, tagId: string): Promise<number> {
    const rows = await harness.db
      .select({ id: schema.cashMovementTags.id })
      .from(schema.cashMovementTags)
      .where(
        and(
          eq(schema.cashMovementTags.movementId, movementId),
          eq(schema.cashMovementTags.tagId, tagId),
        ),
      );
    return rows.length;
  }

  /** How many link rows exist for this tag ANYWHERE, across every movement. */
  async function tagRowsAnywhere(tagId: string): Promise<number> {
    const rows = await harness.db
      .select({ id: schema.cashMovementTags.id })
      .from(schema.cashMovementTags)
      .where(eq(schema.cashMovementTags.tagId, tagId));
    return rows.length;
  }

  it("refuses a FOREIGN tag id forged onto a staged row, while the caller's own still lands", async () => {
    const { agent, pid } = await setup();
    const ownTag = await createTag(agent, 'Salary');

    const other = await harness.seedUser({
      email: 'forge-other@bettertrack.test',
      username: 'forgeother',
    });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const foreignTag = await createTag(otherAgent, 'Their Salary');

    // No rule exists, so staging legitimately tagged nothing …
    const preview = await upload(agent, pid, RULES_FIXTURE);
    const staged = rowByNote(preview, 'Gehalt ACME');
    expect(staged.ruleTagIds).toBeUndefined();
    // … and the pair below is planted straight into the staged row.
    await forgeRuleTagIds(preview.batch.id, 'Gehalt ACME', [ownTag, foreignTag]);

    const result = await apply(agent, preview.batch.id);
    expect(result.failed).toBe(0);
    expect(result.rows.find((r) => r.rowIndex === staged.rowIndex)?.result).toBe('applied');

    const movementId = await movementIdByNote(pid, 'Gehalt ACME');
    // The caller's own forged id IS replayed — which is what proves the replay
    // ran at all, so the foreign id's absence below cannot be a dead code path.
    expect(await pairCount(movementId, ownTag)).toBe(1);
    // The other account's tag is refused by the repository, on this movement …
    expect(await pairCount(movementId, foreignTag)).toBe(0);
    // … and nowhere else either.
    expect(await tagRowsAnywhere(foreignTag)).toBe(0);
  });

  it('refuses a movement that lives in a DIFFERENT portfolio of the same owner', async () => {
    const { agent, pid } = await setup();
    const scoped = await createTag(agent, 'Scoped');

    const preview = await upload(agent, pid, RULES_FIXTURE);
    await apply(agent, preview.batch.id);
    const movementId = await movementIdByNote(pid, 'Gehalt ACME');

    const created = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Second ledger' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const otherPid = created.body.portfolio.id as string;

    const tagRepo = createCashTagRepository(harness.db);
    // Same owner, same real tag, a real movement — only the PORTFOLIO is wrong.
    expect(await tagRepo.attachTagWithinPortfolio(otherPid, movementId, scoped)).toBe(false);
    expect(await pairCount(movementId, scoped)).toBe(0);

    // The positive control: name the right portfolio and the identical call
    // succeeds, so the refusal above is the portfolio scope and nothing else.
    expect(await tagRepo.attachTagWithinPortfolio(pid, movementId, scoped)).toBe(true);
    expect(await pairCount(movementId, scoped)).toBe(1);
  });

  it('refuses a movement whose portfolio has been moved into a vault', async () => {
    const { user, agent, pid } = await setup();
    const before = await createTag(agent, 'Before vaulting');
    const after = await createTag(agent, 'After vaulting');

    const preview = await upload(agent, pid, RULES_FIXTURE);
    await apply(agent, preview.batch.id);
    const movementId = await movementIdByNote(pid, 'Gehalt ACME');

    const tagRepo = createCashTagRepository(harness.db);
    // Positive control FIRST, on the very same movement, while the portfolio is
    // still plain: everything about this call is legal.
    expect(await tagRepo.attachTagWithinPortfolio(pid, movementId, before)).toBe(true);

    // Now vault the portfolio and change nothing else. A vaulted portfolio's
    // plaintext is the vault's business (§13.5); the server must not write into
    // it, and the guard is the last line that says so.
    const vaultId = randomUUID();
    await harness.db.insert(schema.vaults).values({
      id: vaultId,
      userId: user.id,
      name: 'Rule-tagging replay vault',
      headerDocId: randomUUID(),
      commonDocId: randomUUID(),
      media: ['server'],
      retirementProofPublicKey: 'test-retirement-proof-public-key',
      keyFingerprint: 'test-key-fingerprint',
    });
    await harness.db
      .update(schema.portfolios)
      .set({ vaultId })
      .where(eq(schema.portfolios.id, pid));

    expect(await tagRepo.attachTagWithinPortfolio(pid, movementId, after)).toBe(false);
    expect(await pairCount(movementId, after)).toBe(0);
  });
});

/**
 * THE SCOPE OF THE SUGGESTION: `deposit` and `withdrawal`, nothing else.
 *
 * A buy, a sell and a dividend all book a cash leg, and the book-time engine
 * keeps tagging that leg exactly as it always has — but their leg is a
 * CONSEQUENCE of a trade, not the statement line a user wrote a merchant rule
 * for, and the preview would be claiming a suggestion for a money movement it
 * does not even display.
 *
 * No shipped broker mapper ever puts a memo on a trade row (they all hard-code
 * `note: null` on the instrument kinds), so the boundary is unreachable through
 * a fixture: a stub mapper supplies the one shape a real file cannot, four rows
 * carrying the SAME matching memo and differing only in `kind`.
 */
describe('rule tagging previews cash rows only', () => {
  /** A mapper emitting the given normalized rows, one per CSV record. */
  function rowsMapper(rows: NormalizedImportRow[]): BrokerMapper {
    return {
      id: 'rule_scope_probe',
      label: 'Rule scope probe',
      detect: () => 1,
      map: (csv) =>
        csv.records.map((record, index) => ({
          line: record.line,
          raw: record.raw,
          ok: true,
          row: rows[index]!,
        })),
    };
  }

  /** Seed a global catalog asset; its id is what a resolved row stages (FK). */
  async function seedAsset(symbol: string, name: string) {
    const [row] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: symbol,
        type: 'stock',
        symbol,
        name,
        currency: 'EUR',
        exchange: 'XETRA',
      })
      .returning();
    if (!row) throw new Error('Failed to seed asset');
    return row;
  }

  /** A catalog search hit carrying the REAL seeded asset id, as the search does. */
  const catalogHit = (id: string, symbol: string, name: string): SearchResultItem => ({
    id,
    providerId: 'yahoo',
    providerRef: symbol,
    symbol,
    name,
    exchange: 'XETRA',
    type: 'stock',
    currency: 'EUR',
    isCustom: false,
  });

  function stubSearch(resultsByQuery: Record<string, SearchResultItem[]>): SearchService {
    const searchCatalog = vi.fn(
      async (_userId: string, query: string, _options?: { allowEnrichment?: boolean }) => ({
        results: resultsByQuery[query] ?? [],
        enriching: false,
      }),
    );
    return {
      search: searchCatalog,
      searchWithFreshness: async (userId, query) => ({
        ...(await searchCatalog(userId, query)),
        freshness: null,
      }),
      catalogFreshness: async () => null,
      enrichmentSettled: async () => {},
    };
  }

  it('gives a buy, a sell and a dividend NO ruleTagIds even when their memo matches', async () => {
    const { user, agent, pid } = await setup();
    const salary = await createTag(agent, 'Salary');
    await createRule(agent, { tagIds: [salary], pattern: 'gehalt' });

    const asset = await seedAsset('TAGSCOPE', 'Tag Scope AG');
    // ONE memo, matching the rule, on all four rows. Only `kind` differs.
    const MEMO = 'Einzahlung SEPA Gehalt ACME GmbH';
    const base = {
      executedAt: new Date('2024-01-15T12:00:00.000Z'),
      isin: null,
      symbol: 'TAGSCOPE',
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: null,
      currency: 'EUR',
      note: MEMO,
    } satisfies Omit<NormalizedImportRow, 'kind'>;
    const rows: NormalizedImportRow[] = [
      { ...base, kind: 'buy', quantity: 3, price: 10, fee: 0 },
      { ...base, kind: 'sell', quantity: 2, price: 12, fee: 0 },
      { ...base, kind: 'dividend', amountEur: 7 },
      // The positive control: the same memo on the kind the slice IS about.
      { ...base, kind: 'deposit', symbol: null, amountEur: 100 },
    ];

    const imports = createImportService({
      importRepo: createImportRepository(harness.db),
      portfolioRepo: createPortfolioRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      cashRuleRepo: createCashRuleRepository(harness.db),
      cashTagRepo: createCashTagRepository(harness.db),
      // The stub answers with the REAL catalog row id, as the search does.
      search: stubSearch({ TAGSCOPE: [catalogHit(asset.id, 'TAGSCOPE', 'Tag Scope AG')] }),
      portfolio: harness.ctx.portfolio,
      tax: harness.ctx.tax,
      mappers: [rowsMapper(rows)],
    });

    const preview = importPreviewResponseSchema.parse(
      await imports.createBatch(user.id, {
        portfolioId: pid,
        filename: 'scope.csv',
        content: 'h\na\nb\nc\nd',
        brokerId: 'rule_scope_probe',
      }),
    );

    const byKind = new Map(preview.rows.map((row) => [row.kind, row]));
    // Every instrument row RESOLVED — without this the assertions below would
    // pass for the wrong reason (an `unmapped` row is never pre-tagged either).
    for (const kind of ['buy', 'sell', 'dividend'] as const) {
      expect(byKind.get(kind)?.flag, `${kind} flag`).toBe('mapped');
      expect(byKind.get(kind)?.note, `${kind} note`).toBe(MEMO);
      expect(byKind.get(kind)?.ruleTagIds, `${kind} ruleTagIds`).toBeUndefined();
    }
    // …and the deposit, same memo and same rule, IS pre-tagged.
    expect(byKind.get('deposit')?.flag).toBe('mapped');
    expect(byKind.get('deposit')?.ruleTagIds).toEqual([salary]);
  });
});
