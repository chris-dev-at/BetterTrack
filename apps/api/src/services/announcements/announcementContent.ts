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

/**
 * The content locales an `Accept-Language` header asks for, most preferred
 * first (RFC 9110 §12.5.4): q-values honoured (stable for ties, `q=0`
 * dropped), each tag reduced to its primary subtag, only `en` / `de` kept,
 * duplicates removed. Malformed parts are skipped, never thrown on.
 */
export function parseAcceptLanguage(
  header: string | null | undefined,
): AnnouncementContentLocale[] {
  if (!header) return [];
  const ranked = header
    .slice(0, 1024)
    .split(',')
    .slice(0, 32)
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params
        .map((param) => param.trim())
        .find((param) => param.toLowerCase().startsWith('q='));
      const weight = q === undefined ? 1 : Number.parseFloat(q.slice(2));
      return {
        locale: tag.trim().toLowerCase().split('-')[0] ?? '',
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const out: AnnouncementContentLocale[] = [];
  for (const { locale } of ranked) {
    if ((locale === 'en' || locale === 'de') && !out.includes(locale)) out.push(locale);
  }
  return out;
}

/**
 * The locale a pending acknowledgement's title is shown in (Coordinator Q,
 * mobile build 152): the first `Accept-Language` locale the announcement has;
 * else the account's stored locale if the announcement has it; else the
 * announcement's first available locale (English).
 */
export function chooseTitleLocale(
  row: ContentRow,
  preferred: readonly AnnouncementContentLocale[],
  stored: string | null | undefined,
): AnnouncementContentLocale {
  const available = availableLocales(row);
  const fromHeader = preferred.find((locale) => available.includes(locale));
  if (fromHeader) return fromHeader;
  const storedLocale = resolveEmailLocale(stored);
  if (stored && available.includes(storedLocale)) return storedLocale;
  return available[0]!;
}

export interface RenderedAnnouncement {
  title: string;
  body: string;
  contentLocale: AnnouncementContentLocale;
  availableLocales: AnnouncementContentLocale[];
  bodyDoc: BodyDoc;
  contentSha256: string;
}

function source(
  row: ContentRow,
  locale: AnnouncementContentLocale,
): { title: string; body: string } {
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
      row.kind === 'notice'
        ? plain
        : excerptAnnouncementText(plain, ANNOUNCEMENT_INBOX_EXCERPT_CHARS),
  };
}
