import { customTaxParamsSchema, type UpdateTaxSettingsRequest } from '@bettertrack/contracts';

import type { UserTaxSettingsRecord } from '../../data/repositories/taxRepository';
import { resolvePortfolioSetting } from '../../domain/settingsScope';
import {
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type CustomTaxParams,
} from '../../domain/tax';

/** The generic portfolio-setting key used by the tax scoping cascade. */
export const PORTFOLIO_SETTING_KEY_TAX = 'tax';

/** The bottom layer of `portfolio override ?? user default ?? system default`. */
export const TAX_SYSTEM_DEFAULT: UserTaxSettingsRecord = {
  mode: 'none',
  country: null,
  manualDefaultAmountEur: null,
  manualDefaultRatePct: null,
  customParams: null,
};

/** A finite non-negative number, else null (stored override-value hygiene). */
const asNonNegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Narrow a stored `portfolio_settings.value` into the tax record written by
 * the public settings service. An unreadable value is treated as no override,
 * matching the normal read path's existing fall-through semantics.
 */
export function parseTaxOverride(raw: unknown): UserTaxSettingsRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const mode = (raw as { mode?: unknown }).mode;
  if (
    mode !== 'none' &&
    mode !== 'manual_per_trade' &&
    mode !== 'country_specific' &&
    mode !== 'custom'
  ) {
    return null;
  }
  const rawCountry = (raw as { country?: unknown }).country;
  const country =
    rawCountry === TAX_COUNTRY_AT || rawCountry === TAX_COUNTRY_DE || rawCountry === TAX_COUNTRY_FI
      ? rawCountry
      : null;
  if (mode === 'custom') {
    const parsed = customTaxParamsSchema.safeParse((raw as { custom?: unknown }).custom);
    if (!parsed.success) return null;
    return { ...TAX_SYSTEM_DEFAULT, mode, customParams: parsed.data };
  }
  const record: UserTaxSettingsRecord = {
    ...TAX_SYSTEM_DEFAULT,
    mode,
    country: mode === 'country_specific' ? (country ?? TAX_COUNTRY_AT) : null,
  };
  if (mode === 'manual_per_trade') {
    const amount = asNonNegative(
      (raw as { manualDefaultAmountEur?: unknown }).manualDefaultAmountEur,
    );
    const rate = asNonNegative((raw as { manualDefaultRatePct?: unknown }).manualDefaultRatePct);
    record.manualDefaultAmountEur = amount;
    record.manualDefaultRatePct = amount === null && rate !== null && rate <= 100 ? rate : null;
  }
  return record;
}

/** Resolve the exact effective setting used by normal portfolio tax reads. */
export function resolveEffectiveTaxSettings(
  userDefault: UserTaxSettingsRecord | null,
  rawOverride: unknown,
): UserTaxSettingsRecord {
  return resolvePortfolioSetting(parseTaxOverride(rawOverride), userDefault, TAX_SYSTEM_DEFAULT)
    .value;
}

/** Parse the parameter set of an active custom setting; persisted corruption fails loud. */
export function activeCustomParams(settings: UserTaxSettingsRecord): CustomTaxParams {
  const parsed = customTaxParamsSchema.safeParse(settings.customParams);
  if (!parsed.success) {
    throw new Error('Tax engine: custom mode is active without a readable parameter set');
  }
  return parsed.data;
}

/** Normalize the public update body into its persisted mode-dependent shape. */
export function settingsRecordFromInput(input: UpdateTaxSettingsRequest): UserTaxSettingsRecord {
  return {
    mode: input.mode,
    country: input.mode === 'country_specific' ? (input.country ?? TAX_COUNTRY_AT) : null,
    manualDefaultAmountEur:
      input.mode === 'manual_per_trade' ? (input.manualDefaultAmountEur ?? null) : null,
    manualDefaultRatePct:
      input.mode === 'manual_per_trade' ? (input.manualDefaultRatePct ?? null) : null,
    customParams: input.mode === 'custom' ? (input.custom ?? null) : null,
  };
}
