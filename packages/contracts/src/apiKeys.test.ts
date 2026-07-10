import { describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPES,
  IMPLIED_READ_SCOPE,
  impliedReadScope,
  scopeSatisfies,
  withImpliedReadScopes,
  writeScopeForRead,
} from './apiKeys';

describe('write-implies-read scope model (#371)', () => {
  it('maps every module :write to its :read, and only those', () => {
    for (const scope of API_KEY_SCOPES) {
      const implied = impliedReadScope(scope);
      if (scope.endsWith(':write')) {
        const read = scope.replace(/:write$/, ':read');
        // Every write with a matching read in the taxonomy implies it.
        if ((API_KEY_SCOPES as readonly string[]).includes(read)) {
          expect(implied).toBe(read);
        }
      } else {
        // Reads and the combined account:security scope imply nothing.
        expect(implied).toBeUndefined();
      }
    }
  });

  it('has no write partner for account:security (combined scope)', () => {
    expect(impliedReadScope('account:security')).toBeUndefined();
    expect(writeScopeForRead('portfolio:read')).toBe('portfolio:write');
    expect(writeScopeForRead('market:read')).toBeUndefined();
    // The map is symmetric with writeScopeForRead.
    for (const [write, read] of Object.entries(IMPLIED_READ_SCOPE)) {
      expect(writeScopeForRead(read!)).toBe(write);
    }
  });

  describe('withImpliedReadScopes', () => {
    it('adds the implied read when only the write is present', () => {
      expect(withImpliedReadScopes(['portfolio:write'])).toEqual([
        'portfolio:read',
        'portfolio:write',
      ]);
    });

    it('is idempotent and dedupes, returning canonical order', () => {
      const once = withImpliedReadScopes(['workboard:write', 'portfolio:write', 'market:read']);
      expect(once).toEqual(withImpliedReadScopes(once));
      // Canonical API_KEY_SCOPES order, no duplicates.
      expect(once).toEqual([...new Set(once)]);
      const idx = once.map((s) => API_KEY_SCOPES.indexOf(s));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(once).toContain('workboard:read');
      expect(once).toContain('portfolio:read');
    });

    it('leaves a read-only set unchanged', () => {
      expect(withImpliedReadScopes(['portfolio:read', 'market:read'])).toEqual([
        'portfolio:read',
        'market:read',
      ]);
    });
  });

  describe('scopeSatisfies', () => {
    it('a held :write satisfies the matching :read requirement', () => {
      expect(scopeSatisfies(['portfolio:write'], 'portfolio:read')).toBe(true);
      expect(scopeSatisfies(['chat:write'], 'chat:read')).toBe(true);
    });

    it('does NOT let a :read satisfy a :write requirement', () => {
      expect(scopeSatisfies(['portfolio:read'], 'portfolio:write')).toBe(false);
    });

    it('a direct scope match still satisfies', () => {
      expect(scopeSatisfies(['notifications:read'], 'notifications:read')).toBe(true);
      expect(scopeSatisfies(['account:security'], 'account:security')).toBe(true);
    });

    it('never crosses modules', () => {
      expect(scopeSatisfies(['portfolio:write'], 'workboard:read')).toBe(false);
      expect(scopeSatisfies(['market:read'], 'portfolio:read')).toBe(false);
    });
  });
});
