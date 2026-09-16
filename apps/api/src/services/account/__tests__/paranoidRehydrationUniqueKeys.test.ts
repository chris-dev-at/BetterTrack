import type { VaultStrictEntity } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../errors';
import { assertRestoredUniqueKeys } from '../paranoidRehydrationService';

/**
 * THE SERVICE SEAM, WITH THE DOCUMENT SCHEMA BYPASSED (#1973).
 *
 * `vaultStrictDocumentV1Schema` refuses these keys at parse time and that is the
 * refusal the HTTP restore route meets. This file tests the OTHER seam — the one
 * that protects the TABLES from a caller that parsed somewhere else, or did not
 * parse at all: a second restore surface, a migration, a test harness. §13.5's
 * rule is that the server does not trust a vault payload, not that it trusts one
 * parser, so the entities below are hand-built and never see the schema.
 *
 * It is also the only seam that can state the CODE it answers with: the schema's
 * refusal reaches `validateParanoidRestoreDocument` as a bare parse failure and
 * collapses into one generic "malformed document", while this gate throws an
 * `ApiError` both transition services rethrow untouched.
 */

const USER = '018f0000-0000-7000-8000-0000000000a1';
const OTHER_USER = '018f0000-0000-7000-8000-0000000000a2';
const PORTFOLIO = '018f0000-0000-7000-8000-0000000000b1';
const OTHER_PORTFOLIO = '018f0000-0000-7000-8000-0000000000b2';
const SOURCE = '018f0000-0000-7000-8000-0000000000b3';
const TAG = '018f0000-0000-7000-8000-0000000000c1';
const OTHER_TAG = '018f0000-0000-7000-8000-0000000000c2';
const RULE = '018f0000-0000-7000-8000-0000000000d1';
const MOVEMENT = '018f0000-0000-7000-8000-0000000000e1';
const OTHER_MOVEMENT = '018f0000-0000-7000-8000-0000000000e2';
const AT = '2026-07-24T10:00:00.000Z';
const TOMBSTONED = '2026-08-01T10:00:00.000Z';

function entity<K extends VaultStrictEntity['kind']>(
  index: number,
  kind: K,
  data: Extract<VaultStrictEntity, { kind: K }>['data'],
  deletedAt: string | null = null,
): VaultStrictEntity {
  return {
    id: `018f0000-0000-7000-8000-f${index.toString(16).padStart(11, '0')}`,
    rev: 1,
    editedAt: AT,
    editedBy: USER,
    deletedAt,
    kind,
    data,
  } as VaultStrictEntity;
}

const cashTag = (
  index: number,
  name: string,
  systemKey: string | null = null,
  deletedAt: string | null = null,
  userId: string = USER,
) =>
  entity(
    index,
    'cashTag',
    {
      userId,
      name,
      color: '#64748b',
      system: systemKey !== null,
      systemKey,
      createdAt: AT,
      updatedAt: AT,
    },
    deletedAt,
  );

const cashMovement = (
  index: number,
  portfolioId: string,
  dedupHash: string | null,
  deletedAt: string | null = null,
) =>
  entity(
    index,
    'cashMovement',
    {
      portfolioId,
      sourceId: SOURCE,
      kind: 'deposit',
      amountEur: '10.000000',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt: AT,
      note: null,
      source: 'manual',
      dedupHash,
      originalCurrency: null,
      createdAt: AT,
    },
    deletedAt,
  );

const movementTag = (
  index: number,
  movementId: string,
  tagId: string,
  deletedAt: string | null = null,
) => entity(index, 'cashMovementTag', { movementId, tagId, createdAt: AT }, deletedAt);

const ruleTag = (index: number, ruleId: string, tagId: string, deletedAt: string | null = null) =>
  entity(index, 'cashRuleTag', { ruleId, tagId, createdAt: AT }, deletedAt);

const cashBudget = (
  index: number,
  portfolioId: string,
  tagId: string,
  periodKey: string | null,
  deletedAt: string | null = null,
) =>
  entity(
    index,
    'cashBudget',
    {
      portfolioId,
      tagId,
      periodKey,
      amount: '100.00',
      currency: 'EUR',
      createdAt: AT,
      updatedAt: AT,
    },
    deletedAt,
  );

/** The gate's refusal, proved to be an `ApiError` rather than anything else. */
function refusal(...entities: VaultStrictEntity[]): ApiError {
  try {
    assertRestoredUniqueKeys(entities);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected a refusal');
}

function accepts(...entities: VaultStrictEntity[]): void {
  expect(() => assertRestoredUniqueKeys(entities)).not.toThrow();
}

describe('the restore gate refuses every unique key it can reach (#1973)', () => {
  it('answers a 400 with the key’s own stable code, never a 500 from the index', () => {
    // The whole point of the issue: each of these was a Postgres 23505 raised
    // INSIDE the open rehydration transaction — a 500 for a client-authored
    // payload the server could name at the door.
    const err = refusal(cashTag(1, 'Groceries'), cashTag(2, 'GROCERIES'));
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('CASH_TAG_NAME_DUPLICATE');
  });

  it('cash_tags_user_name_lower_unique — case-insensitively, per account', () => {
    expect(refusal(cashTag(1, 'Fuel'), cashTag(2, 'fuel')).code).toBe('CASH_TAG_NAME_DUPLICATE');
    accepts(cashTag(1, 'Fuel'), cashTag(2, 'Groceries'));
    // (user_id, lower(name)) — the same name on another account is another row.
    accepts(cashTag(1, 'Fuel'), cashTag(2, 'Fuel', null, null, OTHER_USER));
  });

  it('cash_tags_user_system_key_unique — NULL keys are distinct, so user tags never collide', () => {
    expect(refusal(cashTag(1, 'Fees', 'fees'), cashTag(2, 'Fees (built-in)', 'fees')).code).toBe(
      'CASH_TAG_SYSTEM_KEY_DUPLICATE',
    );
    accepts(cashTag(1, 'Fees', 'fees'), cashTag(2, 'Tax', 'tax'));
    accepts(cashTag(1, 'Fuel'), cashTag(2, 'Groceries'));
  });

  it('portfolio_cash_movements_dedup_unique — the import idempotency key', () => {
    expect(refusal(cashMovement(1, PORTFOLIO, 'h1'), cashMovement(2, PORTFOLIO, 'h1')).code).toBe(
      'CASH_MOVEMENT_DEDUP_DUPLICATE',
    );
    // A hand-entered movement carries no hash, and NULLs are distinct — a ledger
    // of them must stay restorable.
    accepts(
      cashMovement(1, PORTFOLIO, null),
      cashMovement(2, PORTFOLIO, null),
      cashMovement(3, PORTFOLIO, null),
    );
    accepts(cashMovement(1, PORTFOLIO, 'h1'), cashMovement(2, OTHER_PORTFOLIO, 'h1'));
  });

  it('cash_movement_tags_movement_tag_unique — a pair, not an id', () => {
    expect(refusal(movementTag(1, MOVEMENT, TAG), movementTag(2, MOVEMENT, TAG)).code).toBe(
      'CASH_MOVEMENT_TAG_DUPLICATE',
    );
    accepts(
      movementTag(1, MOVEMENT, TAG),
      movementTag(2, MOVEMENT, OTHER_TAG),
      movementTag(3, OTHER_MOVEMENT, TAG),
    );
  });

  it('cash_budgets_portfolio_tag_period_unique — one override per tag and month', () => {
    expect(
      refusal(cashBudget(1, PORTFOLIO, TAG, '2026-01'), cashBudget(2, PORTFOLIO, TAG, '2026-01'))
        .code,
    ).toBe('CASH_BUDGET_PERIOD_DUPLICATE');
    accepts(
      cashBudget(1, PORTFOLIO, TAG, '2026-01'),
      cashBudget(2, PORTFOLIO, TAG, '2026-02'),
      cashBudget(3, PORTFOLIO, OTHER_TAG, '2026-01'),
    );
  });

  it('cash_budgets_portfolio_tag_recurring_unique — the NULL period is its OWN index', () => {
    // NULLs are distinct, so the three-column index cannot see this pair at all;
    // the partial index is what holds. Naming the index the document actually
    // hit is what makes a per-key code worth having.
    expect(
      refusal(cashBudget(1, PORTFOLIO, TAG, null), cashBudget(2, PORTFOLIO, TAG, null)).code,
    ).toBe('CASH_BUDGET_RECURRING_DUPLICATE');
    // The recurring target beside a single-month override is the design, not a
    // duplicate ("December is different").
    accepts(cashBudget(1, PORTFOLIO, TAG, null), cashBudget(2, PORTFOLIO, TAG, '2026-12'));
  });

  it('cash_rule_tags_rule_tag_unique — #1963’s pair, now stated in the same place', () => {
    expect(refusal(ruleTag(1, RULE, TAG), ruleTag(2, RULE, TAG)).code).toBe(
      'CASH_RULE_TAG_DUPLICATE',
    );
    accepts(ruleTag(1, RULE, TAG), ruleTag(2, RULE, OTHER_TAG));
  });

  it('lets a TOMBSTONE sit beside its live twin, on EVERY key', () => {
    /**
     * Delete-then-recreate is an ordinary edit (#1961/#1972), and the paranoid
     * EXIT pushes every row of the unlocked vault — tombstones included —
     * through the same invariant. A gate that compared them would refuse
     * documents the rest of the restore accepts and could leave an account
     * unable to disable paranoid mode at all.
     */
    accepts(cashTag(1, 'Fuel', null, TOMBSTONED), cashTag(2, 'Fuel'));
    accepts(cashTag(1, 'Fees', 'fees', TOMBSTONED), cashTag(2, 'Fees again', 'fees'));
    accepts(cashMovement(1, PORTFOLIO, 'h1', TOMBSTONED), cashMovement(2, PORTFOLIO, 'h1'));
    accepts(movementTag(1, MOVEMENT, TAG, TOMBSTONED), movementTag(2, MOVEMENT, TAG));
    accepts(
      cashBudget(1, PORTFOLIO, TAG, '2026-01', TOMBSTONED),
      cashBudget(2, PORTFOLIO, TAG, '2026-01'),
    );
    accepts(cashBudget(1, PORTFOLIO, TAG, null, TOMBSTONED), cashBudget(2, PORTFOLIO, TAG, null));
    accepts(ruleTag(1, RULE, TAG, TOMBSTONED), ruleTag(2, RULE, TAG));

    // Two tombstones of one key are equally harmless — neither is ever written.
    accepts(cashTag(1, 'Fuel', null, TOMBSTONED), cashTag(2, 'Fuel', null, TOMBSTONED));
  });

  it('says nothing about a document that breaks none of them', () => {
    accepts();
    accepts(
      cashTag(1, 'Fuel'),
      cashTag(2, 'Fees', 'fees'),
      cashMovement(3, PORTFOLIO, 'h1'),
      movementTag(4, MOVEMENT, TAG),
      cashBudget(5, PORTFOLIO, TAG, null),
      cashBudget(6, PORTFOLIO, TAG, '2026-12'),
      ruleTag(7, RULE, TAG),
    );
  });
});
