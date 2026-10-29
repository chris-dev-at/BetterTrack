import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { ParanoidDisableRehydrationRequest } from '@bettertrack/contracts';

import { assets, paranoidVaultHistory, paranoidVaults, portfolios, users } from '../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * WHAT A CLIENT RECEIVES WHEN THE PARANOID EXIT REFUSES ITS DOCUMENT (#1973,
 * #2039 review).
 *
 * #1973 states every restore-reachable unique key as a document invariant, each
 * with its own stable code, so that a vault the server cannot restore is refused
 * at the door with a reason the client can show — not as a `23505` raised inside
 * the open rehydration transaction, which is a 500 and, on the one exit where
 * the server holds no second copy, a dead end.
 *
 * The review found that no client ever saw one of those codes. The contract put
 * each on the zod issue's `params.code`, while the HTTP validator lifts only
 * `params.apiErrorCode`, so every refusal reached the wire as a bare
 * `VALIDATION_ERROR`. Every test at the time read `params.code` or a service's
 * own collapsed error, so all of them stayed green. This suite therefore asserts
 * `body.error.code` on the real route, because that is the only place the
 * defect was visible.
 *
 * It pins three things:
 *  - each key answers `400` with ITS OWN code, and the account is untouched;
 *  - the same rows with distinct keys restore (`200`), so the refusals are
 *    precise rather than eager — a gate that refused the legal shape would lock
 *    the exit;
 *  - an id an EXISTING row already holds (here a global catalog asset's id,
 *    which every client can read) answers `409 VAULT_RESTORE_ID_TAKEN` before
 *    any write. No document check can see that key.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const AT = '2026-07-24T10:00:00.000Z';
const REHYDRATION_ID = '018f0000-0000-7000-8000-0000000a0001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-0000000a0002';
const ASSET_ID = '018f0000-0000-7000-8000-0000000a0003';
const SOURCE_ID = '018f0000-0000-7000-8000-0000000a0004';
const TX_ID = '018f0000-0000-7000-8000-0000000a0005';
const MOVEMENT_ID = '018f0000-0000-7000-8000-0000000a0006';
const TAG_A = '018f0000-0000-7000-8000-0000000a0007';
const TAG_B = '018f0000-0000-7000-8000-0000000a0008';
const SECOND_MOVEMENT_ID = '018f0000-0000-7000-8000-0000000a0009';
const RULE_ID = '018f0000-0000-7000-8000-0000000a000a';
const row = (n: number) => `018f0000-0000-7000-8000-0000000b${n.toString(16).padStart(4, '0')}`;

type Document = ParanoidDisableRehydrationRequest['document'];
type StrictEntity = Document['entities'][number];

function entity(id: string, kind: string, editedBy: string, data: unknown): StrictEntity {
  return { id, rev: 1, editedAt: AT, editedBy, deletedAt: null, kind, data } as StrictEntity;
}

/** A complete, solvent, one-portfolio graph the exit accepts on its own. */
function baseDocument(userId: string, dedupHash: string | null = null): Document {
  return {
    schemaVersion: 1,
    entities: [
      entity(PORTFOLIO_ID, 'portfolio', userId, {
        userId,
        name: 'Main',
        visibility: 'private',
        sortOrder: 0,
        defaultPayFromCash: false,
        vaultId: null,
        alias: null,
        vaultAlias: null,
        archivedAt: null,
      }),
      entity(ASSET_ID, 'customAsset', userId, {
        providerId: 'manual',
        providerRef: ASSET_ID,
        ownerId: userId,
        type: 'custom',
        symbol: 'HOME',
        name: 'House',
        exchange: null,
        currency: 'EUR',
        meta: { category: 'other', smoothing: false, recategorize: false },
        searchText: "'home':1 'house':2",
      }),
      entity(SOURCE_ID, 'cashSource', userId, {
        portfolioId: PORTFOLIO_ID,
        name: 'Main',
        type: 'cash',
        isMain: true,
        archivedAt: null,
        createdAt: AT,
      }),
      entity(TX_ID, 'transaction', userId, {
        portfolioId: PORTFOLIO_ID,
        assetId: ASSET_ID,
        side: 'buy',
        quantity: '1.00000000',
        price: '100.000000',
        fee: '0.000000',
        executedAt: AT,
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
      }),
      deposit(userId, MOVEMENT_ID, dedupHash),
    ],
    mergeLog: [],
    mirrorProvenance: [],
  };
}

function deposit(userId: string, id: string, dedupHash: string | null): StrictEntity {
  return entity(id, 'cashMovement', userId, {
    dedupHash,
    originalCurrency: null,
    portfolioId: PORTFOLIO_ID,
    sourceId: SOURCE_ID,
    kind: 'deposit',
    amountEur: '100.000000',
    transactionId: null,
    transferId: null,
    counterpartSourceId: null,
    dividendId: null,
    taxYear: null,
    executedAt: AT,
    createdAt: AT,
    note: null,
    source: 'manual',
  });
}

const tag = (userId: string, id: string, name: string, systemKey: string | null = null) =>
  entity(id, 'cashTag', userId, {
    userId,
    name,
    color: '#112233',
    system: systemKey !== null,
    systemKey,
    createdAt: AT,
    updatedAt: AT,
  });

const movementTag = (userId: string, id: string, movementId: string, tagId: string) =>
  entity(id, 'cashMovementTag', userId, { movementId, tagId, createdAt: AT });

const budget = (userId: string, id: string, tagId: string, periodKey: string | null) =>
  entity(id, 'cashBudget', userId, {
    portfolioId: PORTFOLIO_ID,
    tagId,
    periodKey,
    amount: '100.00',
    currency: 'EUR',
    createdAt: AT,
    updatedAt: AT,
  });

const rule = (userId: string) =>
  entity(RULE_ID, 'cashRule', userId, {
    userId,
    matchType: 'contains',
    pattern: 'SPAR',
    priority: 0,
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
  });

const ruleTag = (userId: string, id: string, tagId: string) =>
  entity(id, 'cashRuleTag', userId, { ruleId: RULE_ID, tagId, createdAt: AT });

async function paranoidPrincipal(harness: TestHarness) {
  const user = await harness.seedUser();
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server', 'drive'],
      paranoidDriveAttestedVersion: 4,
    })
    .where(eq(users.id, user.id));
  await harness.db.insert(paranoidVaults).values({
    userId: user.id,
    version: 4,
    formatVersion: 1,
    sizeBytes: 10,
    blob: Buffer.from('ciphertext'),
  });
  await harness.db.insert(paranoidVaultHistory).values({
    userId: user.id,
    version: 3,
    formatVersion: 1,
    sizeBytes: 10,
    blob: Buffer.from('old-ciphertext'),
  });
  const agent = request.agent(harness.app);
  const login = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { user, agent };
}

function disable(agent: ReturnType<typeof request.agent>, user: SeededUser, document: Document) {
  return agent
    .post('/api/v1/account/paranoid/disable')
    .set(...XRW)
    .send({ confirm: true, rehydrationId: REHYDRATION_ID, document, password: user.password });
}

/** A refused exit is non-destructive: nothing restored, still paranoid, ciphertext kept. */
async function expectUntouched(harness: TestHarness, userId: string): Promise<void> {
  expect(await harness.db.select().from(portfolios).where(eq(portfolios.userId, userId))).toEqual(
    [],
  );
  expect(
    await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId)),
  ).toHaveLength(1);
  const [account] = await harness.db
    .select({ mode: users.privacyMode })
    .from(users)
    .where(eq(users.id, userId));
  expect(account?.mode).toBe('paranoid');
}

/**
 * One row per restore-reachable unique key: the base graph plus exactly the rows
 * that would meet that index. Every other fact in the document is valid (the
 * distinct-keys control below restores the same shapes), so the key is the only
 * thing that can refuse it.
 */
const OFFENDERS: readonly {
  readonly index: string;
  readonly code: string;
  readonly dedupHash?: string;
  readonly rows: (userId: string) => readonly StrictEntity[];
}[] = [
  {
    index: 'cash_tags_user_name_lower_unique',
    code: 'CASH_TAG_NAME_DUPLICATE',
    rows: (u) => [tag(u, TAG_A, 'Groceries'), tag(u, TAG_B, 'GROCERIES')],
  },
  {
    index: 'cash_tags_user_system_key_unique',
    code: 'CASH_TAG_SYSTEM_KEY_DUPLICATE',
    rows: (u) => [tag(u, TAG_A, 'Fees', 'fees'), tag(u, TAG_B, 'Fees (built-in)', 'fees')],
  },
  {
    index: 'portfolio_cash_movements_dedup_unique',
    code: 'CASH_MOVEMENT_DEDUP_DUPLICATE',
    dedupHash: 'statement-row-7',
    rows: (u) => [deposit(u, SECOND_MOVEMENT_ID, 'statement-row-7')],
  },
  {
    index: 'cash_movement_tags_movement_tag_unique',
    code: 'CASH_MOVEMENT_TAG_DUPLICATE',
    rows: (u) => [
      tag(u, TAG_A, 'Groceries'),
      movementTag(u, row(1), MOVEMENT_ID, TAG_A),
      movementTag(u, row(2), MOVEMENT_ID, TAG_A),
    ],
  },
  {
    index: 'cash_budgets_portfolio_tag_period_unique',
    code: 'CASH_BUDGET_PERIOD_DUPLICATE',
    rows: (u) => [
      tag(u, TAG_A, 'Groceries'),
      budget(u, row(3), TAG_A, '2026-01'),
      budget(u, row(4), TAG_A, '2026-01'),
    ],
  },
  {
    index: 'cash_budgets_portfolio_tag_recurring_unique',
    code: 'CASH_BUDGET_RECURRING_DUPLICATE',
    rows: (u) => [
      tag(u, TAG_A, 'Groceries'),
      budget(u, row(5), TAG_A, null),
      budget(u, row(6), TAG_A, null),
    ],
  },
  {
    index: 'cash_rule_tags_rule_tag_unique',
    code: 'CASH_RULE_TAG_DUPLICATE',
    rows: (u) => [
      tag(u, TAG_A, 'Groceries'),
      rule(u),
      ruleTag(u, row(7), TAG_A),
      ruleTag(u, row(8), TAG_A),
    ],
  },
];

describe('POST /account/paranoid/disable answers each restore-reachable unique key with its own code', () => {
  it.each(OFFENDERS)('$index → 400 $code, nothing written', async ({ code, dedupHash, rows }) => {
    const harness = await createTestApp();
    const { user, agent } = await paranoidPrincipal(harness);
    const document = baseDocument(user.id, dedupHash ?? null);
    document.entities.push(...rows(user.id));

    const res = await disable(agent, user, document);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe(code);
    await expectUntouched(harness, user.id);
  });

  it('restores the same row kinds once every key is distinct', async () => {
    // The negative space of every refusal above, in ONE document: if the base
    // graph or any row shape were itself invalid, this would not be a 200 and
    // the table above would prove nothing about its keys.
    const harness = await createTestApp();
    const { user, agent } = await paranoidPrincipal(harness);
    const u = user.id;
    const document = baseDocument(u, 'statement-row-7');
    document.entities.push(
      tag(u, TAG_A, 'Groceries'),
      tag(u, TAG_B, 'Fees', 'fees'),
      deposit(u, SECOND_MOVEMENT_ID, 'statement-row-8'),
      movementTag(u, row(11), MOVEMENT_ID, TAG_A),
      movementTag(u, row(12), MOVEMENT_ID, TAG_B),
      budget(u, row(13), TAG_A, null),
      budget(u, row(14), TAG_A, '2026-01'),
      rule(u),
      ruleTag(u, row(15), TAG_A),
      ruleTag(u, row(16), TAG_B),
    );

    const res = await disable(agent, user, document);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe('normal');
  });
});

describe('POST /account/paranoid/disable refuses a restored id an existing row already holds', () => {
  it('a manual custom asset carrying a GLOBAL catalog asset id → 409 VAULT_RESTORE_ID_TAKEN, not a 500', async () => {
    // Before the #2039 review this passed every document check — the asset is
    // `manual`, owned by the caller, `providerRef` equal to its id — and then
    // raised `23505 assets_pkey` inside the open rehydration transaction. The
    // primary key fires before the AFTER INSERT identity trigger, so that guard
    // never got its turn either.
    const harness = await createTestApp();
    const { user, agent } = await paranoidPrincipal(harness);
    const [market] = await harness.db
      .insert(assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'ACME',
        ownerId: null,
        type: 'stock',
        symbol: 'ACME',
        name: 'Acme',
        exchange: 'XETRA',
        currency: 'EUR',
      })
      .returning();
    if (!market) throw new Error('expected market asset');

    const document = baseDocument(user.id);
    document.entities.push(
      entity(market.id, 'customAsset', user.id, {
        providerId: 'manual',
        providerRef: market.id,
        ownerId: user.id,
        type: 'custom',
        symbol: 'X',
        name: 'Shadow',
        exchange: null,
        currency: 'EUR',
        meta: { category: 'other', smoothing: false, recategorize: false },
        searchText: "'x':1 'shadow':2",
      }),
    );

    const res = await disable(agent, user, document);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('VAULT_RESTORE_ID_TAKEN');
    await expectUntouched(harness, user.id);
    // And the catalog row is exactly what it was.
    const [after] = await harness.db.select().from(assets).where(eq(assets.id, market.id));
    expect(after).toMatchObject({ ownerId: null, providerId: 'yahoo', symbol: 'ACME' });
  });
});
