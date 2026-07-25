import { parseVaultEtag, VAULT_CONTENT_TYPE } from '@bettertrack/contracts';

import { apiBaseUrl } from '../../lib/runtimeConfig';

import {
  type DataHome,
  type DataHomeCorruptCandidate,
  type DataHomeInfo,
  type DataHomeInfoResult,
  type DataHomeReadResult,
  type DataHomeWriteOptions,
  type DataHomeWriteResult,
} from './dataHome';
import { inspectVaultEnvelope } from './envelope';

const VAULT_PATH = '/vault';
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'BetterTrack';

export interface ServerBlobDataHomeOptions {
  /** Defaults to the current runtime API base plus `/vault`. */
  url?: string;
  fetch?: typeof fetch;
}

/**
 * The server DataHome maps the shipped blind blob-store contract exactly. It
 * deliberately does not use the JSON apiRequest helper: vault reads and writes
 * are opaque bytes, and error response bodies must stay opaque too.
 */
export function createServerBlobDataHome(options: ServerBlobDataHomeOptions = {}): DataHome {
  const url = options.url ?? `${apiBaseUrl()}${VAULT_PATH}`;
  const request = options.fetch ?? globalThis.fetch;

  return {
    medium: 'server',

    async read(): Promise<DataHomeReadResult> {
      let response: Response;
      try {
        response = await request(url, { credentials: 'include' });
      } catch (cause) {
        return failure('GET vault failed.', cause);
      }

      if (response.status === 404) return { status: 'absent', medium: 'server' };
      if (!response.ok) return failure('GET vault failed.', undefined, response.status);

      let envelope: Uint8Array;
      try {
        envelope = new Uint8Array(await response.arrayBuffer());
      } catch (cause) {
        return failure('Could not read vault bytes.', cause, response.status);
      }
      return parseReadEnvelope(envelope, response.headers.get('ETag'));
    },

    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const headers: Record<string, string> = {
        'Content-Type': VAULT_CONTENT_TYPE,
        [CSRF_HEADER]: CSRF_VALUE,
      };
      if (ifVersion === null) headers['If-None-Match'] = '*';
      else headers['If-Match'] = `"${ifVersion}"`;

      let response: Response;
      try {
        response = await request(url, {
          method: 'PUT',
          headers,
          credentials: 'include',
          body: envelope.slice(),
        });
      } catch (cause) {
        // A network error after a request is sent is intentionally indeterminate:
        // the coordinator pulls before retrying so it never assumes remote success.
        return {
          status: 'transport-failure',
          medium: 'server',
          failure: { message: 'PUT vault failed.', cause, indeterminate: true },
        };
      }

      if (response.status === 412) {
        return { status: 'conflict', medium: 'server', currentVersion: parseVersion(response) };
      }
      if (!response.ok) return failure('PUT vault failed.', undefined, response.status, true);

      const responseVersion = parseVersion(response);
      const envelopeInfo = envelopeInfoFor(envelope, responseVersion);
      if ('status' in envelopeInfo) return envelopeInfo;
      if (responseVersion === null || responseVersion !== envelopeInfo.version) {
        return corrupt(
          envelope,
          responseVersion,
          'version-mismatch',
          'The server ETag does not match the authenticated vault version.',
        );
      }
      return { status: 'ok', medium: 'server', info: envelopeInfo };
    },

    async info(): Promise<DataHomeInfoResult> {
      const result = await this.read();
      switch (result.status) {
        case 'ok':
          return { status: 'ok', medium: 'server', info: result.info };
        case 'absent':
          return result;
        case 'corrupt':
          return result;
        case 'transport-failure':
          return result;
      }
    },
  };
}

/** Public named adapter matching the architecture note nomenclature. */
export const serverBlobDataHome = createServerBlobDataHome;

function parseReadEnvelope(envelope: Uint8Array, etag: string | null): DataHomeReadResult {
  const version = parseVaultEtag(etag);
  const info = envelopeInfoFor(envelope, version);
  if ('status' in info) return info;
  if (version === null) {
    return corrupt(
      envelope,
      null,
      'missing-version',
      'The server returned vault bytes without a valid ETag version.',
    );
  }
  if (version !== info.version) {
    return corrupt(
      envelope,
      version,
      'version-mismatch',
      'The server ETag does not match the authenticated vault version.',
    );
  }
  return { status: 'ok', medium: 'server', envelope, info };
}

function envelopeInfoFor(
  envelope: Uint8Array,
  responseVersion: number | null,
): DataHomeInfo | DataHomeCorruptCandidate {
  try {
    const inspected = inspectVaultEnvelope(envelope);
    if (inspected.status === 'update-required') {
      return corrupt(
        envelope,
        responseVersion,
        'unsupported-version',
        'The vault was written by a newer app version.',
      );
    }
    return {
      medium: 'server',
      version: inspected.envelope.header.vaultVersion,
      sizeBytes: envelope.byteLength,
      updatedAt: inspected.envelope.header.writtenAt,
    };
  } catch (cause) {
    return corrupt(
      envelope,
      responseVersion,
      'malformed-envelope',
      cause instanceof Error ? cause.message : 'The vault envelope is malformed.',
    );
  }
}

function parseVersion(response: Response): number | null {
  return parseVaultEtag(response.headers.get('ETag'));
}

function corrupt(
  envelope: Uint8Array | undefined,
  version: number | null,
  reason: DataHomeCorruptCandidate['reason'],
  message: string,
): DataHomeCorruptCandidate {
  return {
    status: 'corrupt',
    medium: 'server',
    envelope,
    version,
    updatedAt: null,
    reason,
    message,
  };
}

function failure(
  message: string,
  cause?: unknown,
  httpStatus?: number,
  indeterminate = false,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: { message, cause, httpStatus, indeterminate },
  };
}
