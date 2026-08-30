export type EndpointKeystoreErrorCode =
  | 'acknowledgment-required'
  | 'crypto-failed'
  /** Device custody exists but the browser refused to hold or return the key. */
  | 'custody-failed'
  /** "Keep unlocked on this device" was asked for where custody cannot exist. */
  | 'custody-unavailable'
  | 'device-password-invalid'
  | 'device-password-not-configured'
  | 'device-password-required'
  | 'locked-out'
  | 'phrase-locked'
  | 'session-ended'
  | 'storage-invalid'
  | 'vault-not-stored'
  | 'vault-header-unavailable'
  | 'verification-failed'
  | 'wrong-password';

/** Fail-closed error exposed by the headless endpoint-keystore API. */
export class EndpointKeystoreError extends Error {
  constructor(
    public readonly code: EndpointKeystoreErrorCode,
    message: string,
    public readonly details: { failures?: number; retryAt?: number } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EndpointKeystoreError';
  }
}

export function asEndpointKeystoreError(
  code: EndpointKeystoreErrorCode,
  message: string,
  cause: unknown,
): EndpointKeystoreError {
  return cause instanceof EndpointKeystoreError
    ? cause
    : new EndpointKeystoreError(code, message, {}, { cause });
}
