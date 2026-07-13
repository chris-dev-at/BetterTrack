import type { RememberedDeviceResponse } from '@bettertrack/contracts';

/**
 * Device-level "remember me" record for the OAuth account chooser (PROJECTPLAN.md
 * §16; owner spec #399 §B, V4-P2b). Purely client-side (localStorage), it drives
 * the "Log in as [username]?" chooser INDEPENDENTLY of any live session. The
 * server-side half is the signed httpOnly `bt_rdid` cookie + its Redis binding;
 * this record is only what the page needs to *render* the chooser.
 *
 * It may hold AT MOST what the server hands back from `POST /auth/remembered-device`:
 * user id + username + avatar url — NEVER a token or scope (owner note). Storage
 * failures degrade to "nobody remembered" (a blank login), never a throw.
 */
export type RememberedAccount = RememberedDeviceResponse;

/** The remembered identity (drives the chooser). Absent ⇒ blank login. */
const REMEMBERED_KEY = 'bettertrack.oauthRemembered';
/**
 * Which user ids this device has already shown the one-time remember-me prompt
 * to (owner: "asked once"). A separate key so declining is remembered without
 * remembering the identity.
 */
const ASKED_KEY = 'bettertrack.oauthRememberAsked';

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable/full: the chooser simply falls back to a blank login.
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Non-fatal — see safeSet.
  }
}

function isRememberedAccount(value: unknown): value is RememberedAccount {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' &&
    typeof v.username === 'string' &&
    (v.avatarUrl === null || typeof v.avatarUrl === 'string')
  );
}

/** The remembered identity for this device, or `null` when nobody is remembered. */
export function readRememberedAccount(): RememberedAccount | null {
  const raw = safeGet(REMEMBERED_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Keep only the three allowed fields — never let an extra field (a stray
    // token) survive a round-trip, even if one were somehow written.
    if (!isRememberedAccount(parsed)) {
      safeRemove(REMEMBERED_KEY);
      return null;
    }
    return { userId: parsed.userId, username: parsed.username, avatarUrl: parsed.avatarUrl };
  } catch {
    safeRemove(REMEMBERED_KEY);
    return null;
  }
}

/** Persist the remembered identity after a remember-me opt-in. */
export function writeRememberedAccount(account: RememberedAccount): void {
  // Store only the three allowed fields, defensively — never a token/scope.
  const record: RememberedAccount = {
    userId: account.userId,
    username: account.username,
    avatarUrl: account.avatarUrl,
  };
  safeSet(REMEMBERED_KEY, JSON.stringify(record));
}

/** Forget the remembered identity — "Another account" / explicit forget. */
export function clearRememberedAccount(): void {
  safeRemove(REMEMBERED_KEY);
}

function readAskedIds(): string[] {
  const raw = safeGet(ASKED_KEY);
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether this device already showed the one-time remember-me prompt to `userId`. */
export function hasBeenAskedToRemember(userId: string): boolean {
  return readAskedIds().includes(userId);
}

/** Record that this device showed the remember-me prompt to `userId` (accept or decline). */
export function markAskedToRemember(userId: string): void {
  const ids = readAskedIds();
  if (ids.includes(userId)) return;
  ids.push(userId);
  safeSet(ASKED_KEY, JSON.stringify(ids));
}
