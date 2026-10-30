import { describe, expect, test } from 'vitest';

import { API_KEY_SCOPES } from './apiKeys';
import {
  createOAuthClientRequestSchema,
  createThirdPartyOAuthClientRequestSchema,
  isOAuthFirstPartyOnlyScope,
  OAUTH_FIRST_PARTY_ONLY_SCOPES,
  withoutOAuthFirstPartyOnlyScopes,
} from './oauth';

/** Pinned literally: removing a scope from the set must fail here, not vanish. */
const PINNED_FIRST_PARTY_ONLY = ['account:security', 'vault:sync'];
const ORDINARY_SCOPES = API_KEY_SCOPES.filter((scope) => !PINNED_FIRST_PARTY_ONLY.includes(scope));

const registration = (scopes: readonly string[]) => ({
  name: 'An app',
  redirectUris: ['https://app.example/callback'],
  scopes,
});

describe('OAuth first-party-only scopes (OpSec R-05)', () => {
  test('the set is exactly account:security and vault:sync', () => {
    expect([...OAUTH_FIRST_PARTY_ONLY_SCOPES]).toEqual(PINNED_FIRST_PARTY_ONLY);
  });

  test('the predicate matches the set and nothing else', () => {
    for (const scope of PINNED_FIRST_PARTY_ONLY) {
      expect(isOAuthFirstPartyOnlyScope(scope), scope).toBe(true);
    }
    for (const scope of ORDINARY_SCOPES) {
      expect(isOAuthFirstPartyOnlyScope(scope), scope).toBe(false);
    }
    for (const lookalike of [
      'account:security ',
      'ACCOUNT:SECURITY',
      'account',
      'vault',
      'vault:read',
    ]) {
      expect(isOAuthFirstPartyOnlyScope(lookalike), lookalike).toBe(false);
    }
  });

  test('the third-party ceiling drops exactly the set and keeps order', () => {
    expect(withoutOAuthFirstPartyOnlyScopes([...API_KEY_SCOPES])).toEqual(ORDINARY_SCOPES);
    expect(
      withoutOAuthFirstPartyOnlyScopes(['vault:sync', 'market:read', 'account:security']),
    ).toEqual(['market:read']);
  });

  test('third-party registration refuses each first-party-only scope', () => {
    for (const scope of PINNED_FIRST_PARTY_ONLY) {
      expect(
        createThirdPartyOAuthClientRequestSchema.safeParse(registration([scope])).success,
        scope,
      ).toBe(false);
      expect(
        createThirdPartyOAuthClientRequestSchema.safeParse(registration(['market:read', scope]))
          .success,
        scope,
      ).toBe(false);
    }
  });

  test('third-party registration accepts every other scope and stays strict', () => {
    expect(
      createThirdPartyOAuthClientRequestSchema.safeParse(registration(ORDINARY_SCOPES)).success,
    ).toBe(true);
    expect(
      createThirdPartyOAuthClientRequestSchema.safeParse({
        ...registration(['market:read']),
        firstParty: true,
      }).success,
    ).toBe(false);
  });

  test('the admin first-party registration schema still accepts them', () => {
    expect(
      createOAuthClientRequestSchema.safeParse(registration([...API_KEY_SCOPES])).success,
    ).toBe(true);
  });
});
