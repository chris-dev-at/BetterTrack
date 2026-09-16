/**
 * The §12 device-locked marker, and the shape K_dev is allowed to take.
 *
 * ── WHY THIS FILE HOLDS NO SECRET ─────────────────────────────────────────
 *
 * `docs/paranoid-design.md` §12 is binding and says it twice: the device
 * password and K_dev "exist only in volatile process memory", and "there is NO
 * 'keep unlocked on this device' checkbox for wrapped custody — v1's
 * persisted-VK convenience is deliberately retired". PR #1604's first shape
 * persisted K_dev in IndexedDB; the Chief upheld §12 and that custody was
 * removed. What survives here is the part that stores no key material:
 *
 *   • `EndpointDeviceKeyMaterial` — K_dev is raw bytes when THIS tab derived it
 *     from the password, and an opaque non-extractable `CryptoKey` when another
 *     tab of the same device handed its live session over (`sessionChannel.ts`).
 *   • The device-locked MARKER — a single `'1'` under an account-scoped
 *     localStorage key. It records that the last deliberate act on this device
 *     was a lock. It is not a credential, it opens nothing, and it is worthless
 *     to anyone who reads it.
 *
 * ── WHY THE MARKER EXISTS AT ALL ──────────────────────────────────────────
 *
 * Cross-tab session sharing is asynchronous: a request goes out, a grant comes
 * back one or more turns later. A lock landing inside that window is exactly
 * the race the reviewer proved (probe P1b: a lock revoked the session and the
 * raced restore handed the seed phrase back anyway). The session generation is
 * the primary guard and catches every lock this keystore instance observed; the
 * marker is the INDEPENDENT second one, written synchronously before any await
 * by whichever tab locked, so a tab that has not yet received the lock message
 * still fails closed.
 *
 * It is read fail-closed on purpose: a localStorage that throws (private mode,
 * a blocked third-party context, a quota-wedged profile) reads as LOCKED, which
 * costs a user one password entry and costs an attacker the session. The one
 * caller that needs the third state spelled out is the hot read path — see
 * {@link readEndpointDeviceLockMarker}.
 */

const DEVICE_LOCKED_STORAGE_PREFIX = 'bettertrack:endpoint-device-locked:';

/**
 * What the keystore holds as K_dev.
 *
 * Raw bytes for a session this tab derived with Argon2id — zeroable, and the
 * only form that can be imported into a shareable key. An opaque `CryptoKey`
 * for a session another tab granted: usable as an AES-GCM key, never readable
 * back as bytes by any script on this origin.
 */
export type EndpointDeviceKeyMaterial = Uint8Array | CryptoKey;

/** Writes the marker. Called BEFORE any await on every user-intended lock. */
export function rememberEndpointDeviceLocked(accountId: string): void {
  try {
    globalThis.localStorage?.setItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${accountId}`, '1');
  } catch {
    // If the marker cannot be written the session still ended synchronously in
    // this tab, and `isEndpointDeviceLocked` fails closed for the same reason
    // storage is unavailable. Nothing here can leave a session standing.
  }
}

/**
 * Cleared by exactly one edge: a successful device-password unlock on this
 * account. The user proved the password, so "the last act on this device was a
 * lock" has stopped being true and sibling tabs may share this session again.
 */
export function forgetEndpointDeviceLocked(accountId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${accountId}`);
  } catch {
    // Keeping the marker is the fail-closed outcome.
  }
}

/**
 * What the marker says, with "I could not read it" kept DISTINCT from "it is
 * set" — because the two callers want opposite answers to an unreadable store.
 *
 *   • `resumeSessionFromOpenTabs`, `sessionStillCurrent` and the grant
 *     responder install or hand OUT a session this tab has not proven. For them
 *     "no news" must mean "no": {@link isEndpointDeviceLocked} folds
 *     `'unreadable'` into `true` and they stay fail-closed, exactly as before.
 *   • The hot path (`stateFor`, `readMnemonic`, #1640) is the opposite case: it
 *     serves a session THIS tab's password already established. A store that
 *     cannot be read cannot have been written either, so it carries no lock news
 *     in either direction — while failing closed there would revoke every
 *     unlock on the next read forever, since `unlock()` clears the marker
 *     through the same broken store. See `core.ts#endSessionIfDeviceLocked`.
 */
export type EndpointDeviceLockMarker = 'locked' | 'clear' | 'unreadable';

export function readEndpointDeviceLockMarker(accountId: string): EndpointDeviceLockMarker {
  try {
    return globalThis.localStorage?.getItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${accountId}`) === '1'
      ? 'locked'
      : 'clear';
  } catch {
    return 'unreadable';
  }
}

export function isEndpointDeviceLocked(accountId: string): boolean {
  return readEndpointDeviceLockMarker(accountId) !== 'clear';
}
