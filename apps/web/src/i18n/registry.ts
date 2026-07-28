import { DEFAULT_LOCALE } from '@bettertrack/contracts';

import de from './messages/de.json';
import en from './messages/en.json';

/**
 * i18n locale registry (PROJECTPLAN.md §13.3 V3-P1). This is the **single source
 * of truth** for which languages the SPA renders. EN is the source of truth and
 * the default; DE is the first translation (machine-seeded, human-corrected at
 * V3-P13).
 *
 * **Adding a language is exactly two edits, ZERO code elsewhere** (the V3-P1
 * acceptance; see `docs/i18n.md`):
 *   1. add `messages/<code>.json` (a copy of `en.json`, translated), and
 *   2. add one entry to {@link LOCALES} below.
 * The API stores whatever code the client sends and never needs an enum edit, so
 * no server change is required either.
 */

/** A (possibly nested) tree of translation strings. */
export type MessageNode = { [key: string]: string | MessageNode };

export interface LocaleDefinition {
  /** The stored / BCP-47 code persisted server-side and used by the SPA. */
  code: string;
  /** Human label for the language picker, written in that language. */
  label: string;
  /** BCP-47 locale handed to `Intl` for number/date formatting. */
  intlLocale: string;
  /** The message catalog. */
  messages: MessageNode;
}

const ADMIN_EMAIL_LOG_MESSAGES = {
  en: {
    loading: 'Loading email log…',
    error: 'Something went wrong.',
    empty: 'No emails sent yet.',
    headers: {
      when: 'When',
      recipient: 'Recipient',
      template: 'Template',
      subject: 'Subject',
      status: 'Status',
    },
    status: {
      sent: 'Sent',
      failed: 'Failed',
      suppressed: 'Suppressed',
    },
    loadMore: 'Load more',
    loadingMore: 'Loading…',
  },
  de: {
    loading: 'E-Mail-Protokoll wird geladen…',
    error: 'Etwas ist schiefgelaufen.',
    empty: 'Noch keine E-Mails gesendet.',
    headers: {
      when: 'Zeitpunkt',
      recipient: 'Empfänger',
      template: 'Vorlage',
      subject: 'Betreff',
      status: 'Status',
    },
    status: {
      sent: 'Gesendet',
      failed: 'Fehlgeschlagen',
      suppressed: 'Unterdrückt',
    },
    loadMore: 'Mehr laden',
    loadingMore: 'Wird geladen…',
  },
} satisfies Record<'en' | 'de', MessageNode>;

function withAdminEmailLog(messages: MessageNode, emailLog: MessageNode): MessageNode {
  const admin = messages.admin;
  return {
    ...messages,
    admin: {
      ...(typeof admin === 'object' && admin !== null ? admin : {}),
      emailLog,
    },
  };
}

export const LOCALES = {
  en: {
    code: 'en',
    label: 'English',
    intlLocale: 'en-GB',
    messages: withAdminEmailLog(en as unknown as MessageNode, ADMIN_EMAIL_LOG_MESSAGES.en),
  },
  de: {
    code: 'de',
    label: 'Deutsch',
    intlLocale: 'de-AT',
    messages: withAdminEmailLog(de as unknown as MessageNode, ADMIN_EMAIL_LOG_MESSAGES.de),
  },
} satisfies Record<string, LocaleDefinition>;

export type LocaleCode = keyof typeof LOCALES;

/** The default / fallback UI language (EN), shared with the API contract. */
export const DEFAULT_LOCALE_CODE = DEFAULT_LOCALE as LocaleCode;

/** Every renderable locale, in registry order — the picker's option list. */
export const SUPPORTED_LOCALES: LocaleDefinition[] = Object.values(LOCALES);

/** EN messages — the fallback every other locale falls through to. */
export const EN_MESSAGES = LOCALES.en.messages;

/** Resolve one registered message for non-React consumers such as generated files. */
export function localizedMessage(locale: string, key: string): string {
  const resolved = resolveLocaleCode(locale);
  const path = key.split('.');
  return lookupMessage(LOCALES[resolved].messages, path) ?? lookupMessage(EN_MESSAGES, path) ?? key;
}

function lookupMessage(tree: MessageNode, path: readonly string[]): string | undefined {
  let node: string | MessageNode | undefined = tree;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Resolve any stored code (`de`, `de-AT`, an unknown code, or nothing) to a
 * renderable {@link LocaleCode}, falling back to EN — so a new/unknown locale
 * never renders raw keys, it renders English (§13.3 V3-P1 acceptance).
 */
export function resolveLocaleCode(code: string | null | undefined): LocaleCode {
  if (!code) return DEFAULT_LOCALE_CODE;
  if (code in LOCALES) return code as LocaleCode;
  const primary = code.toLowerCase().split('-')[0] ?? '';
  return primary in LOCALES ? (primary as LocaleCode) : DEFAULT_LOCALE_CODE;
}
