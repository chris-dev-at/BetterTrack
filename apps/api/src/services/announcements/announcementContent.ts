import { createHash } from 'node:crypto';

import {
  ANNOUNCEMENT_INBOX_EXCERPT_CHARS,
  announcementContentHashPreimage,
  excerptAnnouncementText,
  parseAnnouncementBody,
  projectBodyDocToPlainText,
  type AnnouncementContentLocale,
  type BodyDoc,
} from '@bettertrack/contracts';

import type { AnnouncementRow } from '../../data/schema';
import { resolveEmailLocale } from '../email/emailI18n';

/**
 * Rendering one announcement in one locale (PROJECTPLAN §6.19.6, contract
 * §3.1–§3.5). Pure functions over the stored row: the locale fallback, the
 * parsed `bodyDoc`, the `contentSha256` that an acknowledgement must echo, and
 * the plain-text projection the inbox row carries. Every surface — the user
 * routes, the gate payload, the fan-out — renders through here, so the hash a
 * client echoes is always the hash of exactly what it was shown.
 */

type ContentRow = Pick<
  AnnouncementRow,
  'kind' | 'bodyFormat' | 'titleEn' | 'bodyEn' | 'titleDe' | 'bodyDe'
>;

/** EN always; DE when both its title and body exist. */
export function availableLocales(row: ContentRow): AnnouncementContentLocale[] {
  return row.titleDe !== null && row.bodyDe !== null ? ['en', 'de'] : ['en'];
}

/**
 * The locale to render: the requested one (a `?locale=` or the stored locale's
 * primary subtag) when the announcement has content in it, otherwise English.
 */
export function resolveContentLocale(
  row: ContentRow,
  requested: string | null | undefined,
): AnnouncementContentLocale {
  const wanted = resolveEmailLocale(requested);
  return availableLocales(row).includes(wanted) ? wanted : 'en';
}

export interface RenderedAnnouncement {
  title: string;
  body: string;
  contentLocale: AnnouncementContentLocale;
  availableLocales: AnnouncementContentLocale[];
  bodyDoc: BodyDoc;
  contentSha256: string;
}

function source(row: ContentRow, locale: AnnouncementContentLocale): { title: string; body: string } {
  if (locale === 'de' && row.titleDe !== null && row.bodyDe !== null) {
    return { title: row.titleDe, body: row.bodyDe };
  }
  return { title: row.titleEn, body: row.bodyEn };
}

/** SHA-256 over the §3.5 preimage, lowercase hex. */
export function announcementContentSha256(
  row: ContentRow,
  locale: AnnouncementContentLocale,
): string {
  const { title, body } = source(row, locale);
  return createHash('sha256')
    .update(
      announcementContentHashPreimage({
        kind: row.kind,
        locale,
        format: row.bodyFormat,
        title,
        body,
      }),
      'utf8',
    )
    .digest('hex');
}

export function renderAnnouncement(
  row: ContentRow,
  requested: string | null | undefined,
): RenderedAnnouncement {
  const contentLocale = resolveContentLocale(row, requested);
  const { title, body } = source(row, contentLocale);
  return {
    title,
    body,
    contentLocale,
    availableLocales: availableLocales(row),
    bodyDoc: parseAnnouncementBody(body, row.bodyFormat).doc,
    contentSha256: announcementContentSha256(row, contentLocale),
  };
}

/**
 * The inbox copy (contract §6): the title, and the plain-text projection of
 * the body — whole for `notice`, the first 500 characters plus an ellipsis for
 * `once` / `ack_required`, whose full text is read through the per-id route.
 */
export function inboxCopy(
  row: ContentRow,
  locale: AnnouncementContentLocale,
): { title: string; body: string } {
  const { title, body } = source(row, locale);
  const plain = projectBodyDocToPlainText(parseAnnouncementBody(body, row.bodyFormat).doc);
  return {
    title,
    body:
      row.kind === 'notice' ? plain : excerptAnnouncementText(plain, ANNOUNCEMENT_INBOX_EXCERPT_CHARS),
  };
}
