import type { VaultMedium } from '@bettertrack/contracts';

/**
 * Blind encrypted-blob persistence seam from the paranoid-vault design (§4,
 * §11). A DataHome never receives a decrypted document or vault key.
 */
export type DataHomeMedium = VaultMedium | 'local';

export interface DataHomeInfo {
  medium: DataHomeMedium;
  /** Monotonic envelope/CAS version. */
  version: number;
  /** Envelope byte count, not a decrypted-content size. */
  sizeBytes: number;
  /** A medium may not expose a modification time (the current server GET does not). */
  updatedAt: string | null;
}

export interface DataHomeTransportFailure {
  message: string;
  /** HTTP failures retain their status for diagnostics without parsing response bodies. */
  httpStatus?: number;
  /** A response may have committed remotely before its metadata was lost. */
  indeterminate?: boolean;
  cause?: unknown;
}

export type DataHomeCorruptionReason =
  | 'malformed-envelope'
  | 'missing-version'
  | 'version-mismatch'
  | 'unsupported-version'
  | 'invalid-response';

export interface DataHomeCorruptCandidate {
  status: 'corrupt';
  medium: DataHomeMedium;
  /** The original opaque bytes are retained whenever the medium returned any. */
  envelope?: Uint8Array;
  /** Metadata is deliberately optional when the malformed source did not provide it. */
  version: number | null;
  updatedAt: string | null;
  reason: DataHomeCorruptionReason;
  message: string;
}

export type DataHomeReadResult =
  | {
      status: 'ok';
      medium: DataHomeMedium;
      envelope: Uint8Array;
      info: DataHomeInfo;
    }
  | { status: 'absent'; medium: DataHomeMedium }
  | DataHomeCorruptCandidate
  | { status: 'transport-failure'; medium: DataHomeMedium; failure: DataHomeTransportFailure };

export interface DataHomeWriteOptions {
  /**
   * `null` means create-only (`If-None-Match: *` on the server); a number means
   * replace only if that concrete version is current (`If-Match`). CAS is never
   * optional.
   */
  ifVersion: number | null;
}

export type DataHomeWriteResult =
  | { status: 'ok'; medium: DataHomeMedium; info: DataHomeInfo }
  | {
      status: 'conflict';
      medium: DataHomeMedium;
      /** Absent when a medium could establish a conflict but supplied no valid current ETag. */
      currentVersion: number | null;
    }
  | DataHomeCorruptCandidate
  | { status: 'transport-failure'; medium: DataHomeMedium; failure: DataHomeTransportFailure };

export type DataHomeInfoResult =
  | { status: 'ok'; medium: DataHomeMedium; info: DataHomeInfo }
  | { status: 'absent'; medium: DataHomeMedium }
  | DataHomeCorruptCandidate
  | { status: 'transport-failure'; medium: DataHomeMedium; failure: DataHomeTransportFailure };

/**
 * A storage medium for encrypted vault envelopes. Every outcome is explicit so
 * callers cannot accidentally turn malformed data, a CAS loss, or a transport
 * outage into an empty vault.
 */
export interface DataHome {
  readonly medium: DataHomeMedium;
  read(): Promise<DataHomeReadResult>;
  write(envelope: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult>;
  info(): Promise<DataHomeInfoResult>;
}

export function transportFailure(
  medium: DataHomeMedium,
  message: string,
  options: Omit<DataHomeTransportFailure, 'message'> = {},
): Extract<DataHomeReadResult, { status: 'transport-failure' }> {
  return { status: 'transport-failure', medium, failure: { message, ...options } };
}
