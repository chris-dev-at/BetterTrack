import { describe, expect, test } from 'vitest';

import { FRIEND_GROUP_MEMBER_LIMIT_ERROR_CODE, GROUP_AUDIENCE_INVALID_ERROR_CODE } from './social';

/**
 * The social error codes are WIRE contract, not server implementation detail
 * (§8 error envelope, §6.9): the SPA branches on them to replace the generic
 * "please try again" with a refusal the owner can actually act on. A rename on
 * either side that is not made here is a silent loss of that repair UX — the
 * branch simply stops matching — so the literal is pinned in the package both
 * sides import, and nowhere else (#1978).
 */
describe('social wire error codes', () => {
  test('a `group` audience write refusal is GROUP_AUDIENCE_INVALID', () => {
    // `audienceService.GROUP_AUDIENCE_INVALID` throws exactly this, and
    // `AudiencePicker` shows its deleted-circle repair state on exactly this.
    expect(GROUP_AUDIENCE_INVALID_ERROR_CODE).toBe('GROUP_AUDIENCE_INVALID');
  });

  test('a full circle roster is FRIEND_GROUP_MEMBER_LIMIT_REACHED', () => {
    expect(FRIEND_GROUP_MEMBER_LIMIT_ERROR_CODE).toBe('FRIEND_GROUP_MEMBER_LIMIT_REACHED');
  });
});
