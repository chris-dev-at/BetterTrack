import { describe, expect, it } from 'vitest';

import { searchQuerySchema } from './assets';

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
