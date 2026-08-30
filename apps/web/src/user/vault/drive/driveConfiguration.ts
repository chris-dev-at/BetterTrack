import { VaultCryptoError } from '../errors';

/**
 * The DEPLOYMENT has no Google Drive client id, so no Drive flow can start on
 * it at all. It is a distinct failure from "GIS could not be loaded": nothing
 * about the user's browser, network, or Google account is wrong, and retrying
 * can never help. Surfaces map it to their own not-configured copy instead of
 * the connection-blaming preparation message (#1554).
 */
export class DriveNotConfiguredError extends VaultCryptoError {
  constructor(message = 'Google Drive is not configured for this deployment.') {
    super('locked', message);
    this.name = 'DriveNotConfiguredError';
  }
}

export function isDriveNotConfiguredError(cause: unknown): cause is DriveNotConfiguredError {
  return cause instanceof DriveNotConfiguredError;
}
