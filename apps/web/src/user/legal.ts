/**
 * The legal document set shipped on the product site (#461 / Play launch,
 * PROJECTPLAN.md §16). Each page lives at `/<page>/` in EN and `/<page>/de/` for
 * DE, so a locale-aware URL lands the reader on the right document directly.
 * Consumed by the app footer ({@link AppLayout}) and the register-form consent
 * notice (V4-P0 (e)) — a single source of truth so the two never drift.
 */
export type LegalPage = 'terms' | 'privacy' | 'impressum' | 'cookies';

export function legalUrl(page: LegalPage, locale: string): string {
  return `https://bettertrack.at/${page}/${locale === 'de' ? 'de/' : ''}`;
}
