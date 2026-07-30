import { request } from 'node:https';

import type { Logger } from '../../logger';
import {
  createPinnedHttpsAgent,
  resolveSafeOutboundUrl,
  type ResolvedOutboundUrl,
} from '../security/outboundUrlGuard';

/** Hard ceiling for a persisted OAuth client logo (512 KiB). */
export const OAUTH_LOGO_MAX_BYTES = 512 * 1024;
export const OAUTH_LOGO_FETCH_TIMEOUT_MS = 5_000;

export const OAUTH_LOGO_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type OAuthLogoContentType = (typeof OAUTH_LOGO_CONTENT_TYPES)[number];

export interface CachedOAuthLogo {
  bytes: Buffer;
  contentType: OAuthLogoContentType;
}

export interface OAuthLogoFetcher {
  /**
   * Fetch and validate a logo once, during client registration. Callers persist
   * the returned bytes; consent reads never contact the source URL.
   */
  fetch(sourceUrl: string): Promise<CachedOAuthLogo | null>;
}

export interface OAuthLogoTransportResponse {
  statusCode: number;
  contentType: string | null;
  contentLength: string | null;
  body: Buffer;
}

export type OAuthLogoTransport = (
  target: ResolvedOutboundUrl,
) => Promise<OAuthLogoTransportResponse>;

export interface CreateOAuthLogoFetcherDeps {
  logger?: Pick<Logger, 'warn'>;
  /** Test seam; production always uses the shared outbound-URL guard. */
  resolveUrl?: (sourceUrl: string) => Promise<ResolvedOutboundUrl>;
  /** Test seam; production pins the guard-vetted DNS answer into node:https. */
  transport?: OAuthLogoTransport;
}

class OAuthLogoFetchError extends Error {}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalizedContentType(value: string | null): OAuthLogoContentType | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  return OAUTH_LOGO_CONTENT_TYPES.find((candidate) => candidate === normalized) ?? null;
}

function hasExpectedSignature(bytes: Buffer, contentType: OAuthLogoContentType): boolean {
  switch (contentType) {
    case 'image/png':
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return (
        bytes.length >= 6 &&
        (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
          bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
      );
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
  }
}

/**
 * Make one non-redirecting GET through the guard-pinned HTTPS agent. Redirects
 * deliberately fail closed: following one would require a fresh guard pass and
 * registered logo URLs can point directly at their final raster asset.
 */
async function requestLogo(target: ResolvedOutboundUrl): Promise<OAuthLogoTransportResponse> {
  const agent = createPinnedHttpsAgent(target);
  try {
    return await new Promise<OAuthLogoTransportResponse>((resolve, reject) => {
      let settled = false;
      const finish = (
        outcome: { ok: true; value: OAuthLogoTransportResponse } | { ok: false; error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };

      const req = request(
        target.url,
        {
          agent,
          method: 'GET',
          headers: {
            Accept: OAUTH_LOGO_CONTENT_TYPES.join(', '),
            'User-Agent': 'BetterTrack-OAuth-Logo-Cache/1',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer | Uint8Array | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > OAUTH_LOGO_MAX_BYTES) {
              response.destroy(new OAuthLogoFetchError('logo exceeds size cap'));
              return;
            }
            chunks.push(bytes);
          });
          response.once('end', () => {
            finish({
              ok: true,
              value: {
                statusCode: response.statusCode ?? 0,
                contentType: firstHeader(response.headers['content-type']),
                contentLength: firstHeader(response.headers['content-length']),
                body: Buffer.concat(chunks, size),
              },
            });
          });
          response.once('error', (error) => finish({ ok: false, error }));
        },
      );
      req.once('error', (error) => finish({ ok: false, error }));
      const timer = setTimeout(() => {
        req.destroy(new OAuthLogoFetchError('logo fetch timed out'));
      }, OAUTH_LOGO_FETCH_TIMEOUT_MS);
      timer.unref();
      req.end();
    });
  } finally {
    agent.destroy();
  }
}

/**
 * Save-time OAuth logo fetcher. The source is resolved by the shared
 * outbound-URL guard immediately before egress, and the resulting IP set is
 * pinned into the HTTPS connection to close DNS-rebinding races.
 */
export function createOAuthLogoFetcher(deps: CreateOAuthLogoFetcherDeps = {}): OAuthLogoFetcher {
  const resolveUrl = deps.resolveUrl ?? resolveSafeOutboundUrl;
  const transport = deps.transport ?? requestLogo;

  return {
    async fetch(sourceUrl) {
      try {
        const target = await resolveUrl(sourceUrl);
        // Never allow a registered URL to smuggle HTTP Basic credentials into
        // the server-side request.
        if (target.url.username || target.url.password) return null;

        const response = await transport(target);
        if (response.statusCode !== 200) return null;

        const contentType = normalizedContentType(response.contentType);
        if (!contentType) return null; // SVG and every non-raster type fail closed.

        const declaredLength =
          response.contentLength == null ? null : Number(response.contentLength);
        if (
          declaredLength != null &&
          (!Number.isSafeInteger(declaredLength) ||
            declaredLength < 0 ||
            declaredLength > OAUTH_LOGO_MAX_BYTES)
        ) {
          return null;
        }
        if (
          response.body.length === 0 ||
          response.body.length > OAUTH_LOGO_MAX_BYTES ||
          !hasExpectedSignature(response.body, contentType)
        ) {
          return null;
        }

        return { bytes: response.body, contentType };
      } catch (error) {
        // Logo failure must never prevent app registration. Do not log the URL
        // (it may contain a tenant identifier or token); the placeholder is the
        // intentional failure state.
        deps.logger?.warn(
          { errorName: error instanceof Error ? error.name : 'unknown' },
          'OAuth client logo fetch failed; using placeholder',
        );
        return null;
      }
    },
  };
}
