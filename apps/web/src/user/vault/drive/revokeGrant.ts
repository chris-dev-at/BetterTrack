import type { GoogleDriveTokenClient } from './gisTokenClient';

/** Hands the granted access token back to Google. Injected in tests. */
export type DriveGrantRevoker = (accessToken: string) => Promise<void>;

async function revokeThroughGis(accessToken: string): Promise<void> {
  const oauth2 = window.google?.accounts?.oauth2;
  const revoke = oauth2?.revoke;
  // GIS was never loaded (or an older build exposes no `revoke`): there is
  // nothing to hand back through, and the browser-memory capability is dropped
  // by the caller either way.
  if (oauth2 == null || revoke == null) return;
  await new Promise<void>((resolve) => {
    revoke.call(oauth2, accessToken, () => resolve());
  });
}

export interface RevokeDriveGrantOptions {
  /** Hands the token back to Google. Injected in tests. */
  revoke?: DriveGrantRevoker;
  /**
   * Answers whether anything OTHER than this token client still depends on the
   * app's Google grant for the account. `true` keeps the grant and releases only
   * the local capability.
   *
   * Required because `google.accounts.oauth2.revoke` is GRANT-level, not
   * token-level: it drops every scope the user granted the app for that Google
   * account, so every other in-browser token client minted for it dies with the
   * call. An account can hold registered Drive connections (§8) whose sync is
   * live while this wizard-taken grant is being released — revoking there would
   * break a shipped path to clean up a zero-file consent.
   *
   * Omitted (or resolving `false`) means the grant is this client's alone.
   * A rejection is read as "shared": an unusable-but-kept consent is recoverable,
   * a wrongly revoked one is not.
   */
  grantIsShared?: () => Promise<boolean>;
}

/**
 * Release a `drive.file` grant the user consented to but never used — the
 * abandoned-wizard residue from the #1354 review (F4). The grant reaches zero
 * files, so it leaks no data, but a consent nothing will ever use again is
 * exactly the kind of thing a privacy mode should hand back rather than keep.
 *
 * Best effort by design: the local capability is dropped first and a failed
 * round trip to Google stays silent, because the surface that triggers this has
 * already been left by the user. The Google-side half is skipped entirely when
 * the grant is shared — see `grantIsShared`.
 */
export async function revokeDriveGrant(
  tokens: Pick<GoogleDriveTokenClient, 'getAccessToken' | 'markRevoked'>,
  options: RevokeDriveGrantOptions = {},
): Promise<void> {
  const { revoke = revokeThroughGis, grantIsShared } = options;
  const current = tokens.getAccessToken();
  if (current.status !== 'ok') return;
  // Unconditional: this client is done either way. Only the Google round trip
  // is conditional, because only that half can reach another client's token.
  tokens.markRevoked();
  if (grantIsShared != null && (await sharedGrant(grantIsShared))) return;
  try {
    await revoke(current.accessToken);
  } catch {
    // Nothing actionable is left: the token is already unusable locally.
  }
}

async function sharedGrant(grantIsShared: () => Promise<boolean>): Promise<boolean> {
  try {
    return await grantIsShared();
  } catch {
    // Unknown state. Keep the grant: the residue this function targets is
    // explicitly low severity, breaking a bound connection's sync is not.
    return true;
  }
}
