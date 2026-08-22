import type { VaultMedium } from '@bettertrack/contracts';

/** A blind encrypted-blob persistence medium. */
export type DataHomeMedium = VaultMedium | 'local';

export interface DataHomeInfo {
  medium: DataHomeMedium;
  /** Monotonic envelope/CAS version. */
  version: number;
  /** Encrypted envelope size, never a decrypted-content size. */
  sizeBytes: number;
  updatedAt: string | null;
  /** Local-only durable acknowledgement metadata. */
  pendingRemote?: boolean;
}

export interface DataHomeTransportFailure {
  message: string;
  httpStatus?: number;
  /** Machine-readable recovery state used by Drive-aware status projection. */
  code?:
    | 'offline'
    | 'consent-required'
    | 'token-expired'
    | 'gesture-required'
    | 'revoked'
    | 'permission-denied'
    | 'api-failure';
  /** The remote may have committed before the response was lost. */
  indeterminate?: boolean;
  cause?: unknown;
}

export type DataHomeCorruptionReason =
  | 'malformed-envelope'
  | 'missing-version'
  | 'version-mismatch'
  | 'unsupported-version'
  | 'invalid-response'
  | 'malformed-metadata'
  | 'corrupt-bytes';

export interface DataHomeCorruptCandidate {
  status: 'corrupt';
  medium: DataHomeMedium;
  /** Original opaque bytes, when the failed medium returned any. */
  envelope?: Uint8Array;
  version: number | null;
  updatedAt: string | null;
  reason: DataHomeCorruptionReason;
  message: string;
}

export type DataHomeReadResult =
  | { status: 'ok'; medium: DataHomeMedium; envelope: Uint8Array; info: DataHomeInfo }
  | { status: 'absent'; medium: DataHomeMedium }
  | DataHomeCorruptCandidate
  | { status: 'transport-failure'; medium: DataHomeMedium; failure: DataHomeTransportFailure };

export interface DataHomeWriteOptions {
  /**
   * The version the caller reasoned about. `null` is create-only; a number
   * replaces only that exact version. A DataHome write never discovers its own
   * compare-and-swap token.
   */
  ifVersion: number | null;
}

export type DataHomeWriteResult =
  | { status: 'ok'; medium: DataHomeMedium; info: DataHomeInfo }
  | { status: 'conflict'; medium: DataHomeMedium; currentVersion: number | null }
  | DataHomeCorruptCandidate
  | { status: 'transport-failure'; medium: DataHomeMedium; failure: DataHomeTransportFailure };

export type DataHomeInfoResult =
  | { status: 'ok'; medium: DataHomeMedium; info: DataHomeInfo }
  | { status: 'absent'; medium: DataHomeMedium }
  | DataHomeCorruptCandidate
  | { status: 'transport-failure'; medium: DataHomeMedium; failure: DataHomeTransportFailure };

/**
 * A storage seam that receives only encrypted envelopes. Every boundary outcome
 * is explicit: absent data, corruption, CAS loss and transport failure are not
 * interchangeable.
 */
export interface DataHome {
  readonly medium: DataHomeMedium;
  read(): Promise<DataHomeReadResult>;
  write(envelope: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult>;
  info(): Promise<DataHomeInfoResult>;
}
