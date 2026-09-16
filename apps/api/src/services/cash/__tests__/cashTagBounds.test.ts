import { describe, expect, it, vi } from 'vitest';

import { CASH_TAGS_PER_USER_MAX } from '@bettertrack/contracts';

import type { CashRuleRepository } from '../../../data/repositories/cashRuleRepository';
import type {
  CashTagRecord,
  CashTagRepository,
} from '../../../data/repositories/cashTagRepository';
import { ApiError } from '../../../errors';
import { createCashTagService } from '../cashTagService';

/**
 * THE PER-USER CASH TAG CAP (#1963).
 *
 * `cash_tags` was the last uncapped surface in the cash lane: #1743 capped the
 * rule count, #1954 capped a rule's tag fan-out, and the tag table itself could
 * still grow to whatever a 16 MB vault document or a scripted API key wanted.
 * Tags are the SUPPLY side of that fan-out — 20 000 restorable tags are what
 * made 20 000 links to one rule reachable — and every one of them is also a row
 * in an unbounded read and a cascade target of every delete.
 *
 * These tests pin the cap on both seams and, deliberately, the CONSTANT: a limit
 * that can drift silently is not a limit.
 */

const USER = '018f0000-0000-7000-8000-0000000000aa';

const TAG: CashTagRecord = {
  id: '018f0000-0000-7000-8000-0000000000c1',
  userId: USER,
  name: 'Groceries',
  color: '#112233',
  system: false,
  systemKey: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function stubTags(overrides: Partial<CashTagRepository> = {}): CashTagRepository {
  return {
    countForOwner: vi.fn(async () => 0),
    create: vi.fn(async () => TAG),
    ownedTagsIn: vi.fn(async (_u: string, ids: readonly string[]) => [...ids]),
    ...overrides,
  } as unknown as CashTagRepository;
}

function service(tags: CashTagRepository) {
  return createCashTagService({ tags, rules: {} as unknown as CashRuleRepository });
}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected a refusal');
}

describe('per-user tag cap', () => {
  it('pins the cap, so raising it is a deliberate edit', () => {
    expect(CASH_TAGS_PER_USER_MAX).toBe(1000);
  });

  it('refuses a create once the account already holds the maximum', async () => {
    const create = vi.fn(async () => TAG);
    const tags = stubTags({
      countForOwner: vi.fn(async () => CASH_TAGS_PER_USER_MAX),
      create: create as unknown as CashTagRepository['create'],
    });

    const err = await refusal(() => service(tags).createTag(USER, { name: 'One more' }));

    expect(err.code).toBe('CASH_TAG_LIMIT_REACHED');
    // 409, like the rule cap: a tag count is ACCOUNT STATE — a conflict with
    // something the user owns — not a malformed request.
    expect(err.statusCode).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it('still allows the tag that lands exactly ON the cap', async () => {
    const tags = stubTags({ countForOwner: vi.fn(async () => CASH_TAGS_PER_USER_MAX - 1) });

    const res = await service(tags).createTag(USER, { name: 'Groceries' });

    expect(res.tag.id).toBe(TAG.id);
  });

  it('counts BEFORE it writes, so the cap is not a taken-name race away from wrong', async () => {
    // The name-clash 409 comes from the unique index on the INSERT; the cap must
    // not depend on reaching that insert to be applied.
    const create = vi.fn(async () => TAG);
    const tags = stubTags({
      countForOwner: vi.fn(async () => CASH_TAGS_PER_USER_MAX + 50),
      create: create as unknown as CashTagRepository['create'],
    });

    const err = await refusal(() => service(tags).createTag(USER, { name: 'Groceries' }));

    expect(err.code).toBe('CASH_TAG_LIMIT_REACHED');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('restored tags meet the same cap a written one does', () => {
  const restoredTags = (count: number) =>
    Array.from({ length: count }, (_unused, i) => ({ name: `tag-${i}` }));

  it('accepts a document landing exactly ON the cap', async () => {
    const insertTags = vi.fn(async (_rows: readonly { name: string }[]) => {});
    const document = restoredTags(CASH_TAGS_PER_USER_MAX);

    await service(stubTags()).restoreTags(USER, document, { insertTags });

    expect(insertTags).toHaveBeenCalledTimes(1);
    // Rows unchanged, handed straight to the caller's transaction-bound writer.
    expect(insertTags.mock.calls[0]![0]).toBe(document);
  });

  it('refuses the WHOLE document one tag past the cap — never a bounded prefix', async () => {
    const insertTags = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubTags()).restoreTags(USER, restoredTags(CASH_TAGS_PER_USER_MAX + 1), {
        insertTags,
      }),
    );

    expect(err.code).toBe('CASH_TAG_LIMIT_REACHED');
    // A prefix would delete tags the user still believes they own — and every
    // rule, budget and movement link that referenced them — in the one mode
    // where the server holds no second copy.
    expect(insertTags).not.toHaveBeenCalled();
  });

  it('refuses the 20 000-tag shape the bound exists for', async () => {
    const insertTags = vi.fn(async () => {});

    const err = await refusal(() =>
      service(stubTags()).restoreTags(USER, restoredTags(20_000), { insertTags }),
    );

    expect(err.code).toBe('CASH_TAG_LIMIT_REACHED');
    expect(insertTags).not.toHaveBeenCalled();
  });

  it('counts tags the account ALREADY has, so a re-run cannot walk past the cap', async () => {
    const insertTags = vi.fn(async () => {});
    const tags = stubTags({ countForOwner: vi.fn(async () => CASH_TAGS_PER_USER_MAX - 1) });

    const err = await refusal(() =>
      service(tags).restoreTags(USER, restoredTags(2), { insertTags }),
    );

    expect(err.code).toBe('CASH_TAG_LIMIT_REACHED');
    expect(insertTags).not.toHaveBeenCalled();
  });

  it('does not query or write for an empty document', async () => {
    const insertTags = vi.fn(async () => {});
    const countForOwner = vi.fn(async () => 0);

    await service(stubTags({ countForOwner })).restoreTags(USER, [], { insertTags });

    expect(countForOwner).not.toHaveBeenCalled();
    expect(insertTags).not.toHaveBeenCalled();
  });
});
