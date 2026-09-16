import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { alias, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { friendships, users } from '../../schema';
import { activeFriendOf, activeFriendPair } from '../activeFriend';

/**
 * The structural half of #1897. The behavioural half lives in
 * `social.groups.test.ts`: it pins what a disabled account may not do. This one
 * pins WHY the seams agree — they read one definition,
 * {@link activeFriendOf} — so a future read path cannot quietly reintroduce the
 * split by writing the predicate inline for the sixth time.
 *
 * The rule is narrow on purpose: it governs the seams that decide whether a
 * FRIEND or a group MEMBER counts. An owner-liveness join elsewhere (is the
 * subject's owner still active?) is a different question and is not in scope
 * here.
 */

const repositories = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');
const apiSrc = resolve(repositories, '../..');

const read = (relative: string) => readFileSync(resolve(apiSrc, relative), 'utf8');

/** Where the definition itself is allowed to live. */
const DEFINITION = 'data/repositories/activeFriend.ts';

/**
 * Every seam that answers "is this person a friend who counts?" — the inputs
 * (`listFriends`, `isFriend`, `friendIdsOf`), the rosters, the reach counts and
 * the ceiling. Each must ask the shared definition and express none of its own.
 */
const SEAMS: readonly { file: string; method: string }[] = [
  { file: 'data/repositories/friendshipRepository.ts', method: 'listFriends' },
  // The chat + mirror-invite gate, joined to the definition in #1949 — through
  // `activeFriendPair`, which is `activeFriendOf` composed in both directions.
  { file: 'data/repositories/friendshipRepository.ts', method: 'areFriends' },
  { file: 'data/repositories/friendGroupRepository.ts', method: 'rostersOf' },
  { file: 'data/repositories/friendGroupRepository.ts', method: 'listMemberIds' },
  { file: 'data/repositories/friendGroupRepository.ts', method: 'countActiveMembers' },
  { file: 'data/repositories/friendGroupRepository.ts', method: 'pruneUnreachableMembers' },
  { file: 'data/repositories/friendGroupRepository.ts', method: 'isFriend' },
  { file: 'data/repositories/shareAudienceRepository.ts', method: 'audienceSummariesForSubjects' },
  { file: 'data/repositories/shareAudienceRepository.ts', method: 'getOwnedState' },
  { file: 'data/repositories/shareAudienceRepository.ts', method: 'friendIdsOf' },
];

/**
 * One method's body: from its signature to whatever starts the next sibling (a
 * doc comment or another method). Deliberately textual — the point is to police
 * what the source says, not what it evaluates to.
 */
function bodyOf(source: string, method: string): string {
  const start = source.search(new RegExp(`\\n\\s*(?:async )?(?:function )?${method}\\(`));
  expect(start, `${method} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const ends = [/\n\s{2,4}\/\*\*/, /\n\s{2,4}(?:async )?(?:function )?[a-zA-Z]\w*\(/]
    .map((re) => rest.search(re))
    .filter((at) => at > 0);
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
}

describe('the "friend who counts" predicate is expressed once (#1897)', () => {
  it.each(SEAMS)('$file › $method asks the shared definition', ({ file, method }) => {
    const source = read(file);
    expect(source).toContain("from './activeFriend'");
    const body = bodyOf(source, method);
    // `activeFriendPair` counts: it is the same fragment composed in both
    // directions, not a second definition (#1949).
    expect(body).toMatch(/activeFriend(Of|Pair)\(/);
    // An inline account-status predicate beside a friendship/roster read is the
    // recurrence that let the two halves drift apart.
    expect(body).not.toMatch(/status/);
    expect(body).not.toContain("'active'");
  });

  it('keeps the account-status half of the definition in exactly one place', () => {
    const definition = read(DEFINITION);
    // Once as SQL; the other mention is prose explaining why.
    expect(definition.match(/\$\{users\.status\}/g)).toHaveLength(1);
    expect(definition).toContain('ACTIVE_ACCOUNT_STATUS');
  });

  it('gates an add on the same definition the roster applies', () => {
    // The service does not write SQL; it routes the add through `isFriend`,
    // which the seams above already pin to the shared definition. What matters
    // here is that it still REFUSES rather than storing a row the roster drops.
    const social = read('services/social/socialService.ts');
    expect(social).toMatch(
      /if \(!\(await groups\.isFriend\(userId, memberId\)\)\) throw NOT_A_FRIEND\(\);/,
    );
    expect(social).toContain('groups.countActiveMembers(groupId)');
  });
});

/**
 * The definition was safe to READ and unsafe to CALL (#1949). Passing an outer
 * `users` column as `memberRef` rendered `users.id = users.id` inside the
 * subquery — always true — so the predicate silently became "does the owner have
 * ANY active friend", which admitted a disabled friend and a complete non-friend
 * at `isFriend` and `friendIdsOf`. It fails OPEN, it generates valid SQL, and the
 * structural test above cannot see it: every call site greps the same.
 *
 * So the misuse throws instead. These tests pin BOTH halves — that the refusal
 * fires for either self-declared table on either parameter, and that the forms
 * callers legitimately use still build, still correlate to the OUTER row, and are
 * therefore not collateral damage of the guard.
 */
describe('the fragment refuses a reference its own scope would capture (#1949)', () => {
  const OWNER = '019c8620-0000-7000-8000-00000000da1a';
  const MEMBER = '019c8620-0000-7000-8000-00000000da1b';
  const render = (fragment: ReturnType<typeof activeFriendOf>) =>
    new PgDialect().sqlToQuery(fragment).sql;
  // A query builder is needed only to construct a subquery; nothing is executed.
  const db = drizzle(new PGlite(), { schema: { users, friendships } });

  const BASE_COLUMNS = [
    { label: 'users.id', column: users.id, table: 'users' },
    { label: 'users.status', column: users.status, table: 'users' },
    { label: 'friendships.userA', column: friendships.userA, table: 'friendships' },
    { label: 'friendships.userB', column: friendships.userB, table: 'friendships' },
  ] as const;

  it.each(BASE_COLUMNS)('refuses base $label as memberRef', ({ column, table }) => {
    expect(() => activeFriendOf(OWNER, column)).toThrow(
      new RegExp(`memberRef is a column of the base \`${table}\` table`),
    );
  });

  it.each(BASE_COLUMNS)('refuses base $label as ownerRef', ({ column, table }) => {
    expect(() => activeFriendOf(column, MEMBER)).toThrow(
      new RegExp(`ownerRef is a column of the base \`${table}\` table`),
    );
  });

  it('names the failure mode, so the message is actionable at the call site', () => {
    expect(() => activeFriendOf(OWNER, users.id)).toThrow(/admits non-friends and disabled/);
    expect(() => activeFriendOf(OWNER, users.id)).toThrow(/alias\(\)ed/);
  });

  it('still accepts a bound id on both sides, correlated to neither table', () => {
    const rendered = render(activeFriendOf(OWNER, MEMBER));
    // The member side is a bound parameter, NOT the subquery's own `users.id`.
    expect(rendered).toMatch(/"users"\."id" = \$\d/);
    expect(rendered).not.toContain('"users"."id" = "users"."id"');
  });

  it('still accepts an alias()ed users column, and keeps it correlated to the OUTER row', () => {
    const friend = alias(users, 'friend');
    const rendered = render(activeFriendOf(OWNER, friend.id));
    // This is the whole point of the guard: the alias survives into the
    // subquery as a DIFFERENT relation, so the comparison is a real
    // correlation rather than the tautology the base column produced.
    expect(rendered).toContain('"users"."id" = "friend"."id"');
    expect(rendered).not.toContain('"users"."id" = "users"."id"');
  });

  it('still accepts a column of some other table (the reach counts)', () => {
    const other = alias(friendships, 'roster');
    expect(() => activeFriendOf(OWNER, other.userB)).not.toThrow();
  });

  /**
   * Object identity is NOT the whole capture rule. Postgres resolves names, not
   * JavaScript objects: an alias or subquery named after one of the fragment's
   * own relations is a different object that still renders under a name the
   * fragment declared, and is captured exactly like the base table. Each of
   * these passed the identity check and rendered the tautology.
   */
  describe('and refuses a DIFFERENT object that renders under a declared name', () => {
    it('refuses alias(users, "users") — renders the tautology verbatim', () => {
      const shadow = alias(users, 'users');
      // Proof the bypass is real rather than theoretical: this is the exact
      // string the original bug produced.
      expect(render(activeFriendOf(OWNER, alias(users, 'friend').id))).not.toContain(
        '"users"."id" = "users"."id"',
      );
      expect(() => activeFriendOf(OWNER, shadow.id)).toThrow(
        /renders under the relation name `users`/,
      );
      expect(() => activeFriendOf(shadow.id, MEMBER)).toThrow(/ownerRef renders under/);
    });

    it('refuses alias(friendships, "friendships") — binds to the fragment\'s own join', () => {
      const shadow = alias(friendships, 'friendships');
      expect(() => activeFriendOf(OWNER, shadow.userB)).toThrow(
        /renders under the relation name `friendships`/,
      );
      expect(() => activeFriendOf(shadow.userA, MEMBER)).toThrow(/ownerRef renders under/);
    });

    it('refuses a subquery aliased .as("users")', () => {
      const shadowed = db.select({ id: users.id }).from(users).as('users');
      expect(() => activeFriendOf(OWNER, shadowed.id)).toThrow(
        /renders under the relation name `users`/,
      );
    });

    it('still accepts an alias named anything else, which is the whole point', () => {
      // The guard refuses a NAME COLLISION, not aliasing. Every alias a real
      // call site uses must survive it, including the near-misses `user` and
      // `friendship` — singular, so no collision.
      expect(() => activeFriendOf(OWNER, alias(users, 'friend').id)).not.toThrow();
      expect(() => activeFriendOf(OWNER, alias(users, 'candidate').id)).not.toThrow();
      expect(() => activeFriendOf(OWNER, alias(users, 'party').id)).not.toThrow();
      expect(() => activeFriendOf(OWNER, alias(users, 'user').id)).not.toThrow();
      expect(() => activeFriendOf(OWNER, alias(friendships, 'friendship').userB)).not.toThrow();
    });
  });

  it('carries the guard through the symmetric form, on both sides', () => {
    expect(() => activeFriendPair(OWNER, users.id)).toThrow(/memberRef/);
    expect(() => activeFriendPair(users.id, MEMBER)).toThrow(/ownerRef/);
    const rendered = render(activeFriendPair(OWNER, MEMBER));
    // Both directions, so neither account's status depends on argument order.
    expect(rendered.match(/"users"\."status"/g)).toHaveLength(2);
    expect(rendered.match(/exists/g)).toHaveLength(2);
  });
});
