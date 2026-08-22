import type { CreateDriveConnectionRequest } from '@bettertrack/contracts';

import type { GoogleDriveTokenClient } from './gisTokenClient';

const DRIVE_ABOUT_ENDPOINT = 'https://www.googleapis.com/drive/v3/about?fields=user';

interface DriveAboutResponse {
  user?: {
    permissionId?: string;
    emailAddress?: string;
    displayName?: string;
  };
  error?: { status?: string; message?: string } | string;
}

export class DriveIdentityError extends Error {
  constructor(
    public readonly code: 'authorization-required' | 'revoked' | 'invalid-identity' | 'api-failure',
    message: string,
  ) {
    super(message);
    this.name = 'DriveIdentityError';
  }
}

/**
 * Capture the consented Drive principal directly in the browser. Drive's
 * stable `permissionId` is recorded as the registry's opaque `googleSub` — the
 * column name is E0's, the value is a Drive Permission-resource id, NOT an OIDC
 * `sub`. It is used for equality only (the post-consent principal check in
 * `driveConnectionRegistry.proveIdentity`); the GIS `login_hint` takes the
 * captured email, which is the form Google documents. The fresh access token is
 * used only for this Google request and is never part of the returned DTO.
 */
export async function readGoogleDriveIdentity(
  tokens: Pick<GoogleDriveTokenClient, 'getAccessToken' | 'markExpired' | 'markRevoked'>,
  request: typeof fetch = globalThis.fetch,
): Promise<CreateDriveConnectionRequest> {
  const access = tokens.getAccessToken();
  if (access.status !== 'ok') {
    throw new DriveIdentityError('authorization-required', access.message);
  }

  let response: Response;
  try {
    response = await request(DRIVE_ABOUT_ENDPOINT, {
      headers: { Authorization: `Bearer ${access.accessToken}` },
    });
  } catch {
    throw new DriveIdentityError('api-failure', 'Google Drive identity could not be reached.');
  }

  let payload: DriveAboutResponse;
  try {
    payload = (await response.json()) as DriveAboutResponse;
  } catch {
    throw new DriveIdentityError('api-failure', 'Google Drive returned invalid identity data.');
  }

  const googleError =
    typeof payload.error === 'string'
      ? payload.error
      : `${payload.error?.status ?? ''} ${payload.error?.message ?? ''}`;
  if (/invalid[_ -]?(grant|token)/iu.test(googleError)) {
    tokens.markRevoked();
    throw new DriveIdentityError('revoked', 'The Google Drive connection was revoked.');
  }
  if (response.status === 401) {
    tokens.markExpired();
    throw new DriveIdentityError('authorization-required', 'Google sign-in expired.');
  }
  if (!response.ok) {
    throw new DriveIdentityError('api-failure', 'Google Drive identity verification failed.');
  }

  const googleSub = payload.user?.permissionId?.trim();
  const email = payload.user?.emailAddress?.trim();
  const displayName = payload.user?.displayName?.trim();
  if (!googleSub || !email) {
    throw new DriveIdentityError(
      'invalid-identity',
      'Google Drive did not return a stable account identity.',
    );
  }
  return { googleSub, email, displayName: displayName || null };
}
