import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { friendships, users } from '../schema';

/**
 * ONE definition of "a friend who counts" (§6.9, #1897).
 *
 * The group side of the sharing lane decided that a `disabled` account is not
 * part of a roster — it cannot sign in, every enforcement read joins
 * `users.status = 'active'`, so counting it would claim a reach that does not
 * exist. The seams that FEED those surfaces (the friends list the picker offers,
 * the friendship gate on an add, the `specific_friends` reach count, the
 * `*.shared` fan-out) each expressed their own, weaker predicate, and the two
 * halves drifted apart: a disabled friend was offered as an addable member, the
 * add returned 200 while changing nothing the owner could see, one item shared
 * to `specific_friends: [disabled]` reported reach 1 beside a circle holding the
 * same account reporting 0, and the broad rungs notified an account that 404s on
 * the item.
 *
 * Every one of those seams now routes through {@link activeFriendOf}, so the
 * predicate is expressed once. Re-adding it inline anywhere else is what let the
 * halves diverge, and `activeFriend.contract.test.ts` fails the build for it.
 */

/** The account status the social layer treats as a person who can be reached. */
export const ACTIVE_ACCOUNT_STATUS = 'active';

/** Either side of the definition: a bound user id, or a column holding one. */
export type UserRef = AnyPgColumn | string;

/**
 * `memberRef` is an ACTIVE account AND an accepted friend of `ownerRef` — the
 * whole definition, as one correlated `exists` usable in a WHERE, a join
 * condition or a `count(*)` subquery alike.
 *
 * The friendship row is stored once per pair with no canonical side, so both
 * orientations are tried; deriving it here (rather than trusting a roster or
 * membership row) means a row that outlived its friendship grants nothing,
 * counts as nothing and is notified about nothing — which is exactly what the
 * enforcement reads already do.
 *
 * **Caller contract:** the fragment re-declares `users` and `friendships` in its
 * OWN scope, so a column passed in must not come from an outer `users`/
 * `friendships` — Postgres would resolve it against the inner declaration and
 * the predicate would silently degrade to "any active friend exists". Pass a
 * bound id, a column of another table, or an {@link alias}ed `users` column
 * (see `friendIdsOf`, `listFriends`).
 */
export function activeFriendOf(ownerRef: UserRef, memberRef: UserRef): SQL {
  return sql`exists (
    select 1
    from ${users}
    join ${friendships}
      on (${friendships.userA} = ${ownerRef} and ${friendships.userB} = ${users.id})
      or (${friendships.userB} = ${ownerRef} and ${friendships.userA} = ${users.id})
    where ${users.id} = ${memberRef}
      and ${users.status} = ${ACTIVE_ACCOUNT_STATUS}
  )`;
}
