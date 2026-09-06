import {
  customTaxParamsSchema,
  SOURCE_TAG_MANUAL,
  SOURCE_TAG_STANDING_ORDER,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  sourceTagSchema,
  type UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

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

// ─── The manual-per-trade default gate (V5-P4c, V5-P7) ───────────────────────

/**
 * How a row's V5-P0c source tag reads to the tax service. The tag grammar
 * (`sourceTagSchema`) admits `manual`, `standing-order`, `import:<slug>` and
 * `sync:<slug>`; this narrows that string space to the classes the manual
 * default has to decide between, so the decision below can be exhaustive.
 *
 * `sync:mirrorchain` is called out separately from the rest of the `sync:`
 * space on purpose: it is a MIRRORCHAIN replica of a write a member of this
 * chain made by hand (§6.17), not a third-party feed. A future
 * `sync:<provider>` broker feed is provider data like an import, so it must
 * not silently inherit the replica's answer.
 */
export type SourceTagClass =
  | 'manual'
  | 'standing-order'
  | 'mirror-replica'
  | 'import'
  | 'provider-sync'
  | 'unrecognized';

/** Narrow a stored/assigned source tag into its {@link SourceTagClass}. */
export function classifySourceTag(source: string): SourceTagClass {
  if (!sourceTagSchema.safeParse(source).success) return 'unrecognized';
  if (source === SOURCE_TAG_MANUAL) return 'manual';
  if (source === SOURCE_TAG_STANDING_ORDER) return 'standing-order';
  if (source === SOURCE_TAG_SYNC_MIRRORCHAIN) return 'mirror-replica';
  return source.startsWith('import:') ? 'import' : 'provider-sync';
}

/**
 * Does the configured `manual_per_trade` default apply to a row that entered
 * with this source tag? The single named answer for every path that plans tax
 * (sells and dividends alike) — the question is "is this a row this account's
 * owner is responsible for entering, so their configured default is what they
 * meant?", not "did a human type it into this browser".
 *
 *  - `manual` — hand-entered here. The mode's whole point.
 *  - `standing-order` — the owner's own standing instruction, booked on
 *    schedule (V5-P6b). Their default is exactly what they configured for it.
 *  - `sync:mirrorchain` — a chain member's write replicated into this copy
 *    (V5-P7). §6.17 computes tax **per copy**: this copy taxes the row under
 *    ITS owner's settings, and skipping the default there made two members of
 *    one chain book different tax on one logical trade.
 *  - `import:<broker>` — broker history that already settled its taxes at the
 *    broker (V5-P4c). Freezing today's default onto it would invent tax.
 *  - `sync:<provider>` — a third-party feed, an import by another name until a
 *    provider that carries no tax data argues otherwise here.
 *  - anything else — not a tag this build knows; the grammar makes it
 *    unreachable, and inventing tax from an unknown origin is the worse error.
 *
 * Absent = `manual` (every caller that does not stamp a tag records by hand).
 */
export function manualDefaultAppliesToSource(source: string | undefined): boolean {
  const tagClass = classifySourceTag(source ?? SOURCE_TAG_MANUAL);
  switch (tagClass) {
    case 'manual':
    case 'standing-order':
    case 'mirror-replica':
      return true;
    case 'import':
    case 'provider-sync':
    case 'unrecognized':
      return false;
    default: {
      // Exhaustiveness guard: a new source-tag class must answer here.
      const _never: never = tagClass;
      return _never;
    }
  }
}
