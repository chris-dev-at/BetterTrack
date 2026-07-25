import { parseVaultEtag, VAULT_CONTENT_TYPE, vaultEtag } from '@bettertrack/contracts';

import { apiBaseUrl } from '../../lib/runtimeConfig';

import type {
  DataHome,
  DataHomeCorruptCandidate,
  DataHomeInfo,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from './dataHome';
import { inspectVaultEnvelope } from './envelope';

const VAULT_PATH = '/vault';
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'BetterTrack';

export interface ServerBlobDataHomeOptions {
  url?: string;
  fetch?: typeof fetch;
}

/** Maps the shipped opaque server blob endpoint without parsing error bodies. */
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
        return transportFailure('GET vault failed.', cause);
      }
      if (response.status === 404) return { status: 'absent', medium: 'server' };
      if (!response.ok) {
        return transportFailure('GET vault failed.', undefined, response.status);
      }

      let envelope: Uint8Array;
      try {
        envelope = new Uint8Array(await response.arrayBuffer());
      } catch (cause) {
        return transportFailure('Could not read vault bytes.', cause, response.status);
      }
      return parseReadEnvelope(envelope, response.headers.get('ETag'));
    },

    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const outgoingInfo = inspectEnvelope(envelope, null);
      if ('status' in outgoingInfo) return outgoingInfo;
      if (ifVersion !== null && outgoingInfo.version <= ifVersion) {
        return corrupt(
          envelope,
          outgoingInfo.version,
          'malformed-envelope',
          'The vault envelope version must advance the If-Match version.',
        );
      }

      const headers: Record<string, string> = {
        'Content-Type': VAULT_CONTENT_TYPE,
        [CSRF_HEADER]: CSRF_VALUE,
      };
      if (ifVersion === null) headers['If-None-Match'] = '*';
      else headers['If-Match'] = vaultEtag(ifVersion);

      let response: Response;
      try {
        response = await request(url, {
          method: 'PUT',
          headers,
          credentials: 'include',
          body: envelope.slice(),
        });
      } catch (cause) {
        return {
          status: 'transport-failure',
          medium: 'server',
          failure: {
            message: 'PUT vault failed.',
            cause,
            indeterminate: true,
          },
        };
      }

      if (response.status === 412) {
        return {
          status: 'conflict',
          medium: 'server',
          currentVersion: parseVaultEtag(response.headers.get('ETag')),
        };
      }
      if (response.status === 400) {
        return corrupt(
          envelope,
          outgoingInfo.version,
          'malformed-envelope',
          'The server rejected the vault write as a malformed or non-advancing envelope.',
        );
      }
      if (!response.ok) {
        return transportFailure('PUT vault failed.', undefined, response.status);
      }

      const responseVersion = parseVaultEtag(response.headers.get('ETag'));
      const info = inspectEnvelope(envelope, responseVersion);
      if ('status' in info) return info;
      if (responseVersion === null) {
        return corrupt(
          envelope,
          null,
          'missing-version',
          'The server acknowledged a vault write without a valid ETag.',
        );
      }
      if (responseVersion !== info.version) {
        return corrupt(
          envelope,
          responseVersion,
          'version-mismatch',
          'The server ETag does not match the vault envelope version.',
        );
      }
      return { status: 'ok', medium: 'server', info };
    },

    async info(): Promise<DataHomeInfoResult> {
      const result = await this.read();
      return result.status === 'ok'
        ? { status: 'ok', medium: 'server', info: result.info }
        : result;
    },
  };
}

export const serverBlobDataHome = createServerBlobDataHome;

function parseReadEnvelope(envelope: Uint8Array, etag: string | null): DataHomeReadResult {
  const responseVersion = parseVaultEtag(etag);
  const info = inspectEnvelope(envelope, responseVersion);
  if ('status' in info) return info;
  if (responseVersion === null) {
    return corrupt(
      envelope,
      null,
      'missing-version',
      'The server returned vault bytes without a valid ETag.',
    );
  }
  if (responseVersion !== info.version) {
    return corrupt(
      envelope,
      responseVersion,
      'version-mismatch',
      'The server ETag does not match the vault envelope version.',
    );
  }
  return { status: 'ok', medium: 'server', envelope, info };
}

function inspectEnvelope(
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

function transportFailure(
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
