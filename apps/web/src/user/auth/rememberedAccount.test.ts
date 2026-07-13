import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearRememberedAccount,
  hasBeenAskedToRemember,
  markAskedToRemember,
  readRememberedAccount,
  writeRememberedAccount,
} from './rememberedAccount';

const REMEMBERED_KEY = 'bettertrack.oauthRemembered';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('rememberedAccount — the client-side chooser record', () => {
  it('round-trips the remembered identity', () => {
    writeRememberedAccount({ userId: 'u1', username: 'jane', avatarUrl: null });
    expect(readRememberedAccount()).toEqual({ userId: 'u1', username: 'jane', avatarUrl: null });
  });

  it('stores AT MOST user id + username + avatar — never a token or scope', () => {
    // A caller (or a compromised earlier write) tries to smuggle secrets in.
    writeRememberedAccount({
      userId: 'u1',
      username: 'jane',
      avatarUrl: null,
      // @ts-expect-error — extra fields must never be persisted.
      token: 'super-secret',
      scopes: ['portfolio:read'],
    });
    const raw = localStorage.getItem(REMEMBERED_KEY) ?? '{}';
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['avatarUrl', 'userId', 'username']);
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('portfolio:read');
  });

  it('strips stray fields on read, even if something wrote them directly', () => {
    localStorage.setItem(
      REMEMBERED_KEY,
      JSON.stringify({ userId: 'u1', username: 'jane', avatarUrl: null, token: 'leak' }),
    );
    const record = readRememberedAccount();
    expect(record).toEqual({ userId: 'u1', username: 'jane', avatarUrl: null });
    expect(record && 'token' in record).toBe(false);
  });

  it('returns null (and clears) for a malformed record', () => {
    localStorage.setItem(REMEMBERED_KEY, '{not json');
    expect(readRememberedAccount()).toBeNull();
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ userId: 42 }));
    expect(readRememberedAccount()).toBeNull();
  });

  it('clears the remembered identity', () => {
    writeRememberedAccount({ userId: 'u1', username: 'jane', avatarUrl: null });
    clearRememberedAccount();
    expect(readRememberedAccount()).toBeNull();
  });

  it('tracks the one-time "asked to remember" flag per user', () => {
    expect(hasBeenAskedToRemember('u1')).toBe(false);
    markAskedToRemember('u1');
    expect(hasBeenAskedToRemember('u1')).toBe(true);
    // Independent per user.
    expect(hasBeenAskedToRemember('u2')).toBe(false);
    // Idempotent.
    markAskedToRemember('u1');
    expect(hasBeenAskedToRemember('u1')).toBe(true);
  });
});
