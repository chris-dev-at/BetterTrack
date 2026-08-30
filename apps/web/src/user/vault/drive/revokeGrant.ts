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

/**
 * Release a `drive.file` grant the user consented to but never used — the
 * abandoned-wizard residue from the #1354 review (F4). The grant reaches zero
 * files, so it leaks no data, but a consent nothing will ever use again is
 * exactly the kind of thing a privacy mode should hand back rather than keep.
 *
 * Best effort by design: the local capability is dropped first and a failed
 * round trip to Google stays silent, because the surface that triggers this has
 * already been left by the user.
 */
export async function revokeDriveGrant(
  tokens: Pick<GoogleDriveTokenClient, 'getAccessToken' | 'markRevoked'>,
  revoke: DriveGrantRevoker = revokeThroughGis,
): Promise<void> {
  const current = tokens.getAccessToken();
  if (current.status !== 'ok') return;
  tokens.markRevoked();
  try {
    await revoke(current.accessToken);
  } catch {
    // Nothing actionable is left: the token is already unusable locally.
  }
}
