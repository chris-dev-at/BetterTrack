import { describe, expect, it } from 'vitest';

import { vaultStrictEntitySchema } from '@bettertrack/contracts';

import { expenseDedupHash } from '../expenseImportService';

const uuid = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;

describe('strict vault expense dedup regression', () => {
  it('keeps H(original bank row) after an edit so re-import remains a duplicate', () => {
    const originalBankRow = {
      bookedOn: '2026-07-01',
      direction: 'expense' as const,
      amount: 42.5,
      currency: 'EUR',
      description: 'Original merchant',
    };
    const originalHash = expenseDedupHash(originalBankRow);
    const editedRow = {
      ...originalBankRow,
      bookedOn: '2026-07-02',
      direction: 'income' as const,
      amount: 45,
      description: 'User-edited description',
    };
    expect(expenseDedupHash(editedRow)).not.toBe(originalHash);

    const restored = vaultStrictEntitySchema.parse(
      JSON.parse(
        JSON.stringify({
          id: uuid(1),
          kind: 'expenseTransaction',
          rev: 2,
          editedAt: '2026-07-25T10:00:00.000Z',
          editedBy: uuid(2),
          deletedAt: null,
          data: {
            userId: uuid(3),
            categoryId: null,
            direction: editedRow.direction,
            amount: editedRow.amount.toFixed(2),
            currency: editedRow.currency,
            bookedOn: editedRow.bookedOn,
            description: editedRow.description,
            source: 'import:n26',
            dedupHash: originalHash,
            createdAt: '2026-07-01T10:00:00.000Z',
            updatedAt: '2026-07-25T10:00:00.000Z',
          },
        }),
      ),
    );
    if (restored.kind !== 'expenseTransaction') throw new Error('expense kind changed');

    const hashesAfterRestore = new Set([restored.data.dedupHash]);
    expect(hashesAfterRestore.has(expenseDedupHash(originalBankRow))).toBe(true);
  });
});
