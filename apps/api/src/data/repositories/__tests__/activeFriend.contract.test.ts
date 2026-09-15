import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
    expect(body).toContain('activeFriendOf(');
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
