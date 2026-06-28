import { describe, expect, it } from 'vitest';

import { formatDefaultDraftName } from './conglomerateBuilderDraftName';

describe('conglomerate builder draft names', () => {
  it.each([
    {
      name: 'uses the UTC date and uppercases an alphanumeric suffix',
      now: new Date('2026-06-28T23:59:59.000Z'),
      entropy: 'a1b2c3d4-e5',
      expected: 'Draft 2026-06-28 A1B2C3D4',
    },
    {
      name: 'strips non-alphanumeric entropy before truncating',
      now: new Date('2026-01-02T00:00:00.000Z'),
      entropy: '--xy_98.zz!!76',
      expected: 'Draft 2026-01-02 XY98ZZ76',
    },
    {
      name: 'falls back when entropy has no usable characters',
      now: new Date('2026-12-31T12:00:00.000Z'),
      entropy: '---',
      expected: 'Draft 2026-12-31 NEW',
    },
  ])('$name', ({ now, entropy, expected }) => {
    expect(formatDefaultDraftName(now, entropy)).toBe(expected);
  });
});
