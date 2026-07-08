import { z } from 'zod';

/**
 * i18n foundation (PROJECTPLAN.md §13.3 V3-P1). One shared definition of what a
 * user's UI-language preference looks like, used by both the API (validating the
 * `PATCH /settings/account` body and shaping the `/auth/me` response) and the SPA
 * (which reads `me.locale` to initialise its runtime).
 *
 * **EN is the source of truth and the default.** A brand-new account, an unknown
 * stored code, or a code the client can't render all resolve to {@link
 * DEFAULT_LOCALE} at render time.
 *
 * The locale is validated **leniently** — a short BCP-47-ish code (`en`, `de`, or
 * a region-tagged form like `de-AT`) — rather than as a fixed enum. This is
 * deliberate: the V3-P1 acceptance requires that adding a language be *one locale
 * file + one registry entry on the web client, with zero code edits*. A hardcoded
 * enum here would force a contract edit for every new language, so the authoritative
 * list of renderable locales lives in the web locale registry; the API only has to
 * persist a well-formed preference string. See `docs/i18n.md`.
 */

/** The source-of-truth / fallback UI language. */
export const DEFAULT_LOCALE = 'en';

/**
 * A UI-language preference: a lowercase primary subtag, optionally region-tagged
 * (`en`, `de`, `de-AT`, `pt-BR`). Deliberately lenient — see the module doc.
 */
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Must be a BCP-47 code like "en" or "de-AT".');

export type Locale = z.infer<typeof localeSchema>;
