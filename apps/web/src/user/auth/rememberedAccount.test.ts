import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLastLoginIdentifier,
  clearRememberedAccount,
  hasBeenAskedToRemember,
  markAskedToRemember,
  readLastLoginIdentifier,
  readRememberedAccount,
  refreshRememberedAccount,
  writeLastLoginIdentifier,
  writeRememberedAccount,
} from './rememberedAccount';

const REMEMBERED_KEY = 'bettertrack.oauthRemembered';
const LAST_IDENTIFIER_KEY = 'bettertrack.lastLoginIdentifier';
const rememberedAccount = {
  userId: '8d7cf3d6-e8b8-4fa4-98a4-8712cddc05bf',
  username: 'jane',
  profileIcon: null,
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('rememberedAccount — the client-side chooser record', () => {
  it('round-trips the remembered identity', () => {
    writeRememberedAccount(rememberedAccount);
    expect(readRememberedAccount()).toEqual(rememberedAccount);
  });

  it('stores AT MOST user id + username + profile icon — never a token or scope', () => {
    // A caller (or a compromised earlier write) tries to smuggle secrets in.
    writeRememberedAccount({
      ...rememberedAccount,
      // @ts-expect-error — extra fields must never be persisted.
      token: 'super-secret',
      scopes: ['portfolio:read'],
    });
    const raw = localStorage.getItem(REMEMBERED_KEY) ?? '{}';
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['profileIcon', 'userId', 'username']);
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('portfolio:read');
    expect(readRememberedAccount()).toEqual(rememberedAccount);
  });

  it('keeps a record written before the icon field, degrading it to no icon (V5-P0 (c))', () => {
    // The pre-#1684 shape: the dead `avatarUrl`, no `profileIcon`. An in-place
    // upgrade must NOT log the device out of its own memory.
    localStorage.setItem(
      REMEMBERED_KEY,
      JSON.stringify({
        userId: rememberedAccount.userId,
        username: rememberedAccount.username,
        avatarUrl: null,
      }),
    );
    expect(readRememberedAccount()).toEqual({ ...rememberedAccount, profileIcon: null });
    expect(localStorage.getItem(REMEMBERED_KEY)).not.toBeNull();
  });

  it('still clears a legacy-shaped record that smuggles anything else in', () => {
    // The one-key migration above is not a licence for arbitrary extra fields.
    localStorage.setItem(
      REMEMBERED_KEY,
      JSON.stringify({
        userId: rememberedAccount.userId,
        username: rememberedAccount.username,
        avatarUrl: null,
        token: 'leak',
      }),
    );
    expect(readRememberedAccount()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  });

  it('rejects and clears a stored icon id outside the curated set', () => {
    localStorage.setItem(
      REMEMBERED_KEY,
      JSON.stringify({ ...rememberedAccount, profileIcon: 'not-a-real-avatar' }),
    );
    expect(readRememberedAccount()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  });

  it('round-trips a picked curated icon', () => {
    writeRememberedAccount({ ...rememberedAccount, profileIcon: 'fox' });
    expect(readRememberedAccount()).toEqual({ ...rememberedAccount, profileIcon: 'fox' });
  });

  it('rejects and clears a contract-invalid stored record', () => {
    localStorage.setItem(
      REMEMBERED_KEY,
      JSON.stringify({ ...rememberedAccount, userId: 'not-a-uuid' }),
    );
    expect(readRememberedAccount()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  });

  it('rejects and clears extra stored fields required by the strict contract', () => {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ ...rememberedAccount, token: 'leak' }));
    expect(readRememberedAccount()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  });

  it('returns null and clears corrupt storage', () => {
    localStorage.setItem(REMEMBERED_KEY, '{not json');
    expect(readRememberedAccount()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  });

  it('fails closed when local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(readRememberedAccount()).toBeNull();
  });

  it('clears the remembered identity', () => {
    writeRememberedAccount(rememberedAccount);
    clearRememberedAccount();
    expect(readRememberedAccount()).toBeNull();
  });

  // ── Refreshing an existing record (§13.5 V5-P0 (c)) ──────────────────────
  // The record is written once, at the opt-in; a rename or a later icon choice
  // must reach it, and nothing else may.

  it('refreshes an existing record\u2019s username and icon for the same user', () => {
    writeRememberedAccount(rememberedAccount);
    refreshRememberedAccount({ ...rememberedAccount, username: 'jane.doe', profileIcon: 'panda' });
    expect(readRememberedAccount()).toEqual({
      ...rememberedAccount,
      username: 'jane.doe',
      profileIcon: 'panda',
    });
  });

  it('writes only the three allowed fields when refreshing', () => {
    writeRememberedAccount(rememberedAccount);
    refreshRememberedAccount({
      ...rememberedAccount,
      profileIcon: 'panda',
      // @ts-expect-error — a refresh is no more a door for secrets than a write.
      token: 'super-secret',
    });
    const raw = localStorage.getItem(REMEMBERED_KEY) ?? '{}';
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['profileIcon', 'userId', 'username']);
    expect(raw).not.toContain('super-secret');
  });

  it('never creates a record for a device that remembers nobody', () => {
    refreshRememberedAccount({ ...rememberedAccount, profileIcon: 'panda' });
    expect(readRememberedAccount()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  });

  it('leaves a record belonging to a different user untouched', () => {
    writeRememberedAccount(rememberedAccount);
    refreshRememberedAccount({
      userId: '2a2f9b4e-2f4d-4d4b-9a6a-2f5f4f0a1c77',
      username: 'bob',
      profileIcon: 'panda',
    });
    expect(readRememberedAccount()).toEqual(rememberedAccount);
  });

  it('does not touch the one-shot remember-me prompt gate', () => {
    writeRememberedAccount(rememberedAccount);
    refreshRememberedAccount({ ...rememberedAccount, profileIcon: 'panda' });
    // Never asked ⇒ still never asked: a refresh must not stand in for the
    // prompt, nor re-open it for someone who already declined.
    expect(hasBeenAskedToRemember(rememberedAccount.userId)).toBe(false);
    markAskedToRemember(rememberedAccount.userId);
    refreshRememberedAccount({ ...rememberedAccount, profileIcon: 'fox' });
    expect(hasBeenAskedToRemember(rememberedAccount.userId)).toBe(true);
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

describe('lastLoginIdentifier — username-only prefill after a successful login (V4-P0 (g))', () => {
  it('round-trips the last identifier for prefill', () => {
    writeLastLoginIdentifier('jane@bettertrack.test');
    expect(readLastLoginIdentifier()).toBe('jane@bettertrack.test');
  });

  it('trims whitespace on write and ignores a blank identifier', () => {
    writeLastLoginIdentifier('  jane  ');
    expect(readLastLoginIdentifier()).toBe('jane');
    writeLastLoginIdentifier('   ');
    // Blank write is a no-op — the earlier value stands.
    expect(readLastLoginIdentifier()).toBe('jane');
  });

  it('clears the stored identifier', () => {
    writeLastLoginIdentifier('jane');
    clearLastLoginIdentifier();
    expect(readLastLoginIdentifier()).toBeNull();
  });

  it('is stored under a key separate from the OAuth device binding (#419)', () => {
    writeLastLoginIdentifier('jane');
    writeRememberedAccount(rememberedAccount);
    // The two records are independent — clearing one leaves the other alone.
    clearLastLoginIdentifier();
    expect(localStorage.getItem(LAST_IDENTIFIER_KEY)).toBeNull();
    expect(readRememberedAccount()).not.toBeNull();
    clearRememberedAccount();
    writeLastLoginIdentifier('jane');
    expect(readRememberedAccount()).toBeNull();
    expect(readLastLoginIdentifier()).toBe('jane');
  });
});
