import type { TaxSettingsResponse } from '@bettertrack/contracts';

import { TAX_OPTIONS, isTaxOptionSelected } from '../settings/taxModePicker';

/**
 * Shared bits of one portfolio's tax treatment (issue #636), used by the two
 * surfaces that now split the concern: the **Settings tab** owns configuration
 * (`PortfolioTaxSection`) and the **Tax tab** only names the mode its report was
 * computed under (`TaxReportPage`).
 *
 * Both must agree on the query key — the settings mutation seeds it and the
 * report reads it — and on how a mode/country pair is named, which is the shared
 * option list's own copy (`settings/taxModePicker.tsx`), never a second table of
 * labels that could drift from it.
 */

/** Query key for one portfolio's resolved tax treatment. */
export const portfolioTaxSettingsKey = (portfolioId: string) =>
  ['portfolio', 'taxSettings', portfolioId] as const;

/**
 * The i18n key naming an effective mode/country, resolved through the same
 * option list and the same match rule the picker selects with — so the line on
 * the Tax tab always reads the option the Settings picker shows as chosen.
 * Falls back to the first option (`none`), which is also the API's system default.
 */
export function taxModeLabelKey(settings: TaxSettingsResponse | undefined): string {
  const option = TAX_OPTIONS.find((candidate) => isTaxOptionSelected(candidate, settings));
  return `settings.taxes.mode.${(option ?? TAX_OPTIONS[0]!).i18nKey}.label`;
}
