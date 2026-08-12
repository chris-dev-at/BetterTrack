import { describe, expect, it } from 'vitest';

import { ASSET_BATCH_MAX_IDS, assetBatchQuerySchema, searchQuerySchema } from './assets';

const assetId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

describe('searchQuerySchema', () => {
  it('accepts a single-character query (owner override, §13.2)', () => {
    expect(searchQuerySchema.safeParse({ q: 'V' }).success).toBe(true);
  });

  it('rejects an empty query, including whitespace-only', () => {
    expect(searchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('rejects a query over 64 characters', () => {
    expect(searchQuerySchema.safeParse({ q: 'a'.repeat(65) }).success).toBe(false);
  });
});

describe('assetBatchQuerySchema', () => {
  it('parses and de-duplicates a comma-separated id list', () => {
    expect(
      assetBatchQuerySchema.parse({ ids: `${assetId(1)},${assetId(2)},${assetId(1)}` }),
    ).toEqual({ ids: [assetId(1), assetId(2)] });
  });

  it('rejects invalid, empty, and oversized lists', () => {
    expect(assetBatchQuerySchema.safeParse({ ids: '' }).success).toBe(false);
    expect(assetBatchQuerySchema.safeParse({ ids: 'not-an-id' }).success).toBe(false);
    expect(
      assetBatchQuerySchema.safeParse({
        ids: Array.from({ length: ASSET_BATCH_MAX_IDS + 1 }, (_, index) => assetId(index)).join(
          ',',
        ),
      }).success,
    ).toBe(false);
  });
});
