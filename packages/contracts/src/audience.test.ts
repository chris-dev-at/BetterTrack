import { describe, expect, test } from 'vitest';

import {
  SHARE_AUDIENCES,
  audienceTransitionRequiresConfirmation,
  classifyAudienceTransition,
  type AudienceSelection,
  type AudienceTransition,
  type ShareAudience,
} from './common';

const FRIEND_A = '00000000-0000-0000-0000-0000000000a1';
const FRIEND_B = '00000000-0000-0000-0000-0000000000b2';
const GROUP_A = '00000000-0000-0000-0000-0000000000c3';
const GROUP_B = '00000000-0000-0000-0000-0000000000d4';

function selection(audience: ShareAudience): AudienceSelection {
  return {
    audience,
    friendIds: audience === 'specific_friends' ? [FRIEND_A] : undefined,
    groupId: audience === 'group' ? GROUP_A : null,
  };
}

const PAIR_EXPECTATIONS: Record<ShareAudience, Record<ShareAudience, AudienceTransition>> = {
  private: {
    private: 'same',
    specific_friends: 'widening',
    group: 'widening',
    all_friends: 'widening',
    public_link: 'widening',
  },
  specific_friends: {
    private: 'narrowing',
    specific_friends: 'same',
    group: 'widening',
    all_friends: 'widening',
    public_link: 'widening',
  },
  group: {
    private: 'narrowing',
    specific_friends: 'widening',
    group: 'same',
    all_friends: 'widening',
    public_link: 'widening',
  },
  all_friends: {
    private: 'narrowing',
    specific_friends: 'narrowing',
    group: 'narrowing',
    all_friends: 'same',
    public_link: 'widening',
  },
  public_link: {
    private: 'narrowing',
    specific_friends: 'narrowing',
    group: 'narrowing',
    all_friends: 'narrowing',
    public_link: 'same',
  },
};

describe('audience transition lattice', () => {
  test.each(
    SHARE_AUDIENCES.flatMap((current) =>
      SHARE_AUDIENCES.map((next) => [current, next, PAIR_EXPECTATIONS[current][next]] as const),
    ),
  )('%s → %s is %s', (current, next, expected) => {
    const transition = classifyAudienceTransition(selection(current), selection(next));
    expect(transition).toBe(expected);
    expect(audienceTransitionRequiresConfirmation(selection(current), selection(next))).toBe(
      expected === 'widening',
    );
  });

  test('specific-friends removals narrow, while additions and replacements widen', () => {
    const current = { audience: 'specific_friends' as const, friendIds: [FRIEND_A, FRIEND_B] };

    expect(
      classifyAudienceTransition(current, {
        audience: 'specific_friends',
        friendIds: [FRIEND_A],
      }),
    ).toBe('narrowing');
    expect(
      classifyAudienceTransition(current, {
        audience: 'specific_friends',
        friendIds: [FRIEND_A, FRIEND_B],
      }),
    ).toBe('same');
    expect(
      classifyAudienceTransition(current, {
        audience: 'specific_friends',
        friendIds: [FRIEND_A, FRIEND_B, GROUP_A],
      }),
    ).toBe('widening');
    expect(
      classifyAudienceTransition(current, {
        audience: 'specific_friends',
        friendIds: [GROUP_A],
      }),
    ).toBe('widening');
  });

  test('changing the selected group is a recipient replacement', () => {
    expect(
      classifyAudienceTransition(
        { audience: 'group', groupId: GROUP_A },
        { audience: 'group', groupId: GROUP_B },
      ),
    ).toBe('widening');
  });
});
