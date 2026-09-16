import { getTableName, sql, type SQL } from 'drizzle-orm';
import { PgDialect, type AnyPgColumn } from 'drizzle-orm/pg-core';

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
 * Every one of those seams now routes through {@link activeFriendOf} — or its
 * symmetric form {@link activeFriendPair} — so the predicate is expressed once.
 * Re-adding it inline anywhere else is what let the halves diverge, and
 * `activeFriend.contract.test.ts` fails the build for it.
 */

/** The account status the social layer treats as a person who can be reached. */
export const ACTIVE_ACCOUNT_STATUS = 'active';

/** Either side of the definition: a bound user id, or a column holding one. */
export type UserRef = AnyPgColumn | string;

/**
 * The tables this fragment declares in its OWN FROM, and therefore the relation
 * NAMES that are spoken for inside it. A reference that renders under one of
 * these names cannot be passed in: Postgres resolves it against the innermost
 * declaration, so it binds to the subquery's own row instead of the outer one
 * (#1949).
 */
const SELF_DECLARED_TABLES: readonly { readonly table: object; readonly name: string }[] = [
  { table: users, name: 'users' },
  { table: friendships, name: 'friendships' },
];
const SELF_DECLARED_NAMES = new Set(SELF_DECLARED_TABLES.map((declared) => declared.name));

/** Only ever used to read back the relation name a ref will render under. */
const RENDER_DIALECT = new PgDialect();

/**
 * The relation name `ref` will carry in the GENERATED SQL — the only thing that
 * decides whether Postgres captures it.
 *
 * `getTableName` reports the ALIAS for an aliased table and for a subquery
 * (`alias(users, 'friend')` → `friend`, `.as('users')` → `users`), which is
 * exactly the name that reaches the query. The dialect render is the fallback
 * for any ref shape whose table metadata is not readable, so an exotic
 * reference degrades to being inspected rather than to being trusted.
 */
function renderedRelationName(ref: AnyPgColumn): string | undefined {
  try {
    const name = getTableName(ref.table);
    if (typeof name === 'string' && name.length > 0) return name;
  } catch {
    // Not a table-backed column — fall through to rendering it.
  }
  return /^"([^"]+)"\./.exec(RENDER_DIALECT.sqlToQuery(sql`${ref}`).sql)?.[1];
}

/**
 * Refuse a capture-prone reference LOUDLY at query-build time instead of
 * shipping a predicate that quietly means something weaker.
 *
 * Passing an outer `users.id` as `memberRef` rendered `users.id = users.id`
 * inside the subquery — always true — collapsing the whole definition to "does
 * the owner have ANY active friend at all". That fails OPEN: proven on PGlite,
 * the misuse admitted a disabled friend AND an outright non-friend at `isFriend`
 * and `friendIdsOf`, i.e. a §6.9 boundary break. An outer `friendships` column
 * degrades the same way, correlating the join to itself. Neither is visible in
 * the generated SQL, because the generated SQL is perfectly valid.
 *
 * TWO checks, because they catch different mistakes and neither subsumes the
 * other in practice:
 *
 * 1. **Object identity** — the base `users`/`friendships` objects. The ordinary
 *    slip, and worth its own message.
 * 2. **Rendered relation name** — identity alone is not enough, since
 *    `alias(users, 'users')`, `alias(friendships, 'friendships')` and a
 *    subquery `.as('users')` are all DIFFERENT objects that still render under a
 *    name this fragment has declared, and so are captured identically.
 *
 * What this does NOT claim: the fragment is not made impossible to misuse. A ref
 * that renders under some other name is accepted on trust, and a caller can
 * still correlate the wrong column. What is refused is precisely the capture
 * class — a reference the subquery's own FROM would swallow.
 */
function assertReachableFromSubquery(ref: UserRef, parameter: 'ownerRef' | 'memberRef'): void {
  if (typeof ref === 'string') return;
  const table: object = ref.table;
  for (const declared of SELF_DECLARED_TABLES) {
    if (table !== declared.table) continue;
    throw new Error(
      `activeFriendOf(): ${parameter} is a column of the base \`${declared.name}\` table, which ` +
        `this fragment re-declares in its own scope. Postgres would resolve it against the ` +
        `INNER \`${declared.name}\`, silently weakening the predicate to "the owner has any ` +
        `active friend" — which admits non-friends and disabled accounts (#1949). Pass a bound ` +
        `user id, a column of a different table, or an alias()ed \`${declared.name}\` column ` +
        `(see \`listFriends\`, \`friendIdsOf\`).`,
    );
  }
  const relation = renderedRelationName(ref);
  if (relation !== undefined && SELF_DECLARED_NAMES.has(relation)) {
    throw new Error(
      `activeFriendOf(): ${parameter} renders under the relation name \`${relation}\`, which ` +
        `this fragment declares in its own FROM — so Postgres captures it exactly like the base ` +
        `table would be captured, and the predicate silently weakens to "the owner has any ` +
        `active friend" (#1949). An alias() or subquery named after one of the fragment's own ` +
        `relations is not a different relation to Postgres. Re-alias it to a name of its own ` +
        `(see \`listFriends\`, \`friendIdsOf\`).`,
    );
  }
}

/**
 * `memberRef` is an ACTIVE account AND an accepted friend of `ownerRef` — the
 * whole definition, as one correlated `exists` usable in a WHERE, a join
 * condition or a `count(*)` subquery alike.
 *
 * The friendship row is stored once per pair, canonically ordered
 * (`user_a < user_b`, see `schema.ts`; `deleteFriendship` relies on it). Both
 * orientations are still tried here because this fragment receives ids and
 * columns it cannot sort — the OR is what lets a caller pass either side
 * without pre-canonicalising, and it keeps the read correct even for a row that
 * somehow landed unordered. Deriving friendship here (rather than trusting a
 * roster or membership row) means a row that outlived its friendship grants nothing,
 * counts as nothing and is notified about nothing — which is exactly what the
 * enforcement reads already do.
 *
 * Note the deliberate asymmetry: this asserts the ACCOUNT STATUS of `memberRef`
 * only. `ownerRef` is the authenticated caller at every WHERE-side use and is
 * active by construction (a disabled account holds no session). Where both sides
 * are untrusted ids — an invite accepted long after it was sent — use
 * {@link activeFriendPair}.
 *
 * **Caller contract (now enforced):** the fragment re-declares `users` and
 * `friendships` in its OWN scope, so a column passed in must not come from the
 * base `users`/`friendships` objects. That misuse throws (see
 * {@link assertReachableFromSubquery}) rather than rendering a predicate that
 * fails open. Pass a bound id, a column of another table, or an {@link alias}ed
 * `users` column (see `friendIdsOf`, `listFriends`).
 */
export function activeFriendOf(ownerRef: UserRef, memberRef: UserRef): SQL {
  assertReachableFromSubquery(ownerRef, 'ownerRef');
  assertReachableFromSubquery(memberRef, 'memberRef');
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

/**
 * The symmetric reading of the SAME definition: `a` and `b` are accepted friends
 * and BOTH accounts are active.
 *
 * Composed from {@link activeFriendOf} in both directions rather than written
 * out again, so the account-status half still lives in exactly one place.
 *
 * It exists because `areFriends(a, b)` reads symmetric and is called with the
 * untrusted party on either side: `mirrorService` re-checks an invite at accept
 * time as `areFriends(invite.fromUser, userId)`, where the account that may have
 * been disabled since the invite was sent is the FIRST argument. A one-sided
 * check there would be an argument-order footgun — the exact class of drift
 * #1897 spent nine seams removing (#1949).
 */
export function activeFriendPair(a: UserRef, b: UserRef): SQL {
  return sql`(${activeFriendOf(a, b)} and ${activeFriendOf(b, a)})`;
}
