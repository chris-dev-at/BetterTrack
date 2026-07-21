import { useState } from 'react';

import type {
  CustomTaxParams,
  TaxCountry,
  TaxMode,
  TaxSettingsResponse,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { cx } from '../components/ui';

/**
 * The shared tax-mode option list + picker (issue #636). One presentational
 * radio group used by BOTH the user-level "new portfolio default" surface and
 * the per-portfolio override control, so the two never drift. Which layer a
 * pick writes to is the caller's concern — the picker only reports the chosen
 * `UpdateTaxSettingsRequest`. The V5-P4c extras render inside the picker
 * (anti-bloat: folded away under their mode's row): the compact "Custom" rule
 * builder while `custom` is selected, the manual-default field while
 * `manual_per_trade` is selected.
 */

/**
 * One selectable row of the picker: a plain mode, or `country_specific` with a
 * concrete country (V5-P4: the country picker is the option list itself — one
 * compact row per shipped country, no nested controls).
 */
export interface TaxOption {
  /** i18n key under `settings.taxes.mode.` */
  i18nKey: string;
  mode: TaxMode;
  country?: TaxCountry;
}

export const TAX_OPTIONS: readonly TaxOption[] = [
  { i18nKey: 'none', mode: 'none' },
  { i18nKey: 'manual_per_trade', mode: 'manual_per_trade' },
  { i18nKey: 'country_specific', mode: 'country_specific', country: 'AT' },
  { i18nKey: 'country_specific_de', mode: 'country_specific', country: 'DE' },
  { i18nKey: 'custom', mode: 'custom' },
];

/**
 * The starting parameter set when "Custom rules" is first picked: the AT
 * shape (the documented expressibility example) — a sensible, fully-working
 * baseline the builder card then edits.
 */
export const DEFAULT_CUSTOM_PARAMS: CustomTaxParams = {
  ratePct: 27.5,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'moving-average',
};

/**
 * Turn a picked option into the mode-consistent body: a country option carries
 * its country, `custom` carries a parameter set (the current one, else the
 * default), every other mode carries nothing extra — mirroring the contract's
 * refinement so the request is always valid on either endpoint.
 */
export function bodyForOption(
  option: TaxOption,
  current?: TaxSettingsResponse,
): UpdateTaxSettingsRequest {
  if (option.mode === 'custom') {
    return { mode: 'custom', custom: current?.custom ?? DEFAULT_CUSTOM_PARAMS };
  }
  return option.country !== undefined
    ? { mode: option.mode, country: option.country }
    : { mode: option.mode };
}

/** Whether an option matches the given mode/country. */
export function isTaxOptionSelected(
  option: TaxOption,
  settings: TaxSettingsResponse | undefined,
): boolean {
  const mode = settings?.mode ?? 'none';
  if (option.mode !== mode) return false;
  if (option.country === undefined) return true;
  // Legacy country_specific rows without a country are Austria (V3-P4).
  return (settings?.country ?? 'AT') === option.country;
}

/** One selectable tax-option row: a radio + its label and explanation. */
function ModeOption({
  option,
  name,
  selected,
  disabled,
  onSelect,
}: {
  option: TaxOption;
  name: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 transition-colors',
        selected
          ? 'border-sky-500/60 bg-sky-500/5'
          : 'border-neutral-800 bg-neutral-900 hover:border-neutral-700',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name={name}
        value={option.country ?? option.mode}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-sky-500"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-100">
          {t(`settings.taxes.mode.${option.i18nKey}.label`)}
        </span>
        <span className="text-xs leading-relaxed text-neutral-500">
          {t(`settings.taxes.mode.${option.i18nKey}.description`)}
        </span>
      </span>
    </label>
  );
}

/** A tiny "ⓘ" info-point carrying its explanation as a native tooltip. */
function InfoPoint({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-neutral-800 text-[10px] font-semibold text-neutral-400"
    >
      i
    </span>
  );
}

const fieldClass = cx(
  'rounded-md bg-neutral-950 px-2 py-1 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500',
);

/** One labelled on/off switch row of the custom builder (checkbox + info-point). */
function ParamToggle({
  label,
  info,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  info: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-200">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-sky-500"
      />
      <span>{label}</span>
      <InfoPoint text={info} />
    </label>
  );
}

/**
 * The folded-away "Custom" rule builder (V5-P4c): ONE compact parameter card —
 * rate, cost basis, four switches with info-points — applied as a whole. A
 * parameter change is a mode switch: it applies forward only, recorded rows
 * keep the snapshot they were taxed under.
 */
function CustomParamsCard({
  value,
  busy,
  onApply,
}: {
  value: CustomTaxParams;
  busy: boolean;
  onApply: (params: CustomTaxParams) => void;
}) {
  const t = useT();
  const [rate, setRate] = useState(String(value.ratePct));
  const [params, setParams] = useState<CustomTaxParams>(value);
  const parsedRate = Number(rate);
  const rateValid =
    rate.trim() !== '' && Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 100;
  const set = (patch: Partial<CustomTaxParams>) => setParams((p) => ({ ...p, ...patch }));
  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <span>{t('settings.taxes.custom.rateLabel')}</span>
          <input
            type="number"
            min={0}
            max={100}
            step="any"
            value={rate}
            disabled={busy}
            aria-label={t('settings.taxes.custom.rateAria')}
            onChange={(e) => setRate(e.target.value)}
            className={cx(fieldClass, 'w-24')}
          />
          <InfoPoint text={t('settings.taxes.custom.rateInfo')} />
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <span>{t('settings.taxes.custom.costBasisLabel')}</span>
          <select
            value={params.costBasis}
            disabled={busy}
            aria-label={t('settings.taxes.custom.costBasisAria')}
            onChange={(e) => set({ costBasis: e.target.value as CustomTaxParams['costBasis'] })}
            className={fieldClass}
          >
            <option value="moving-average">
              {t('settings.taxes.custom.costBasis.movingAverage')}
            </option>
            <option value="fifo">{t('settings.taxes.custom.costBasis.fifo')}</option>
          </select>
          <InfoPoint text={t('settings.taxes.custom.costBasisInfo')} />
        </label>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <ParamToggle
          label={t('settings.taxes.custom.lossOffsetLabel')}
          info={t('settings.taxes.custom.lossOffsetInfo')}
          checked={params.lossOffset}
          disabled={busy}
          onChange={(lossOffset) => set({ lossOffset })}
        />
        <ParamToggle
          label={t('settings.taxes.custom.refundLabel')}
          info={t('settings.taxes.custom.refundInfo')}
          checked={params.refund}
          disabled={busy}
          onChange={(refund) => set({ refund })}
        />
        <ParamToggle
          label={t('settings.taxes.custom.yearResetLabel')}
          info={t('settings.taxes.custom.yearResetInfo')}
          checked={params.yearReset}
          disabled={busy}
          onChange={(yearReset) => set({ yearReset })}
        />
        <ParamToggle
          label={t('settings.taxes.custom.carryForwardLabel')}
          info={t('settings.taxes.custom.carryForwardInfo')}
          checked={params.carryForward}
          disabled={busy}
          onChange={(carryForward) => set({ carryForward })}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !rateValid}
          onClick={() => onApply({ ...params, ratePct: parsedRate })}
          className="w-fit rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('settings.taxes.custom.apply')}
        </button>
        {!rateValid ? (
          <span className="text-xs text-rose-400">{t('settings.taxes.custom.invalid')}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The manual mode's configurable default (V5-P4c), visible only while manual
 * mode is selected: one compact amount-or-% row, prefilled into every sell and
 * dividend tax field server-side and still editable per trade. Blank = no
 * default (today's behavior).
 */
function ManualDefaultField({
  value,
  busy,
  onApply,
}: {
  value: TaxSettingsResponse | undefined;
  busy: boolean;
  onApply: (body: UpdateTaxSettingsRequest) => void;
}) {
  const t = useT();
  const [unit, setUnit] = useState<'amount' | 'rate'>(
    value?.manualDefaultRatePct !== undefined ? 'rate' : 'amount',
  );
  const [raw, setRaw] = useState(
    value?.manualDefaultAmountEur !== undefined
      ? String(value.manualDefaultAmountEur)
      : value?.manualDefaultRatePct !== undefined
        ? String(value.manualDefaultRatePct)
        : '',
  );
  const hasStored =
    value?.manualDefaultAmountEur !== undefined || value?.manualDefaultRatePct !== undefined;
  const parsed = Number(raw);
  const valid =
    raw.trim() !== '' &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    (unit === 'amount' || parsed <= 100);
  const unitButton = (target: 'amount' | 'rate', label: string) => (
    <button
      type="button"
      aria-pressed={unit === target}
      disabled={busy}
      onClick={() => setUnit(target)}
      className={cx(
        'rounded-md px-2 py-1 text-xs font-medium',
        unit === target
          ? 'bg-sky-500/15 text-sky-300'
          : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-neutral-100">
          {t('settings.taxes.manualDefault.title')}
        </span>
        <InfoPoint text={t('settings.taxes.manualDefault.info')} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t('settings.taxes.manualDefault.unitAria')}
          className="flex gap-1"
        >
          {unitButton('amount', t('settings.taxes.manualDefault.unitAmount'))}
          {unitButton('rate', t('settings.taxes.manualDefault.unitRate'))}
        </div>
        <input
          type="number"
          min={0}
          step="any"
          value={raw}
          disabled={busy}
          aria-label={t('settings.taxes.manualDefault.valueAria')}
          placeholder={t('settings.taxes.manualDefault.placeholder')}
          onChange={(e) => setRaw(e.target.value)}
          className={cx(fieldClass, 'w-28')}
        />
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() =>
            onApply(
              unit === 'rate'
                ? { mode: 'manual_per_trade', manualDefaultRatePct: parsed }
                : { mode: 'manual_per_trade', manualDefaultAmountEur: parsed },
            )
          }
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('settings.taxes.manualDefault.apply')}
        </button>
        {hasStored ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRaw('');
              onApply({ mode: 'manual_per_trade' });
            }}
            className="text-sm font-medium text-neutral-400 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('settings.taxes.manualDefault.clear')}
          </button>
        ) : null}
        {raw.trim() !== '' && !valid ? (
          <span className="text-xs text-rose-400">{t('settings.taxes.manualDefault.invalid')}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The tax-mode radio group. `value` is the currently-selected mode/country (the
 * user default on the defaults surface, the effective value on a portfolio's
 * override surface); `name` scopes the radio group so two pickers never collide.
 * The manual-default field and the custom builder fold away under their mode
 * (rendered only while that mode is selected — anti-bloat).
 */
export function TaxModePicker({
  value,
  name,
  busy,
  ariaLabel,
  onSelect,
}: {
  value: TaxSettingsResponse | undefined;
  name: string;
  busy: boolean;
  ariaLabel: string;
  onSelect: (body: UpdateTaxSettingsRequest) => void;
}) {
  const mode = value?.mode ?? 'none';
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-3">
        {TAX_OPTIONS.map((option) => {
          const selected = isTaxOptionSelected(option, value);
          return (
            <ModeOption
              key={option.i18nKey}
              option={option}
              name={name}
              selected={selected}
              disabled={busy}
              onSelect={() => {
                if (!selected && !busy) onSelect(bodyForOption(option, value));
              }}
            />
          );
        })}
      </div>
      {mode === 'manual_per_trade' ? (
        <ManualDefaultField
          key={`${value?.manualDefaultAmountEur ?? ''}|${value?.manualDefaultRatePct ?? ''}`}
          value={value}
          busy={busy}
          onApply={onSelect}
        />
      ) : null}
      {mode === 'custom' ? (
        <CustomParamsCard
          value={value?.custom ?? DEFAULT_CUSTOM_PARAMS}
          busy={busy}
          onApply={(params) => onSelect({ mode: 'custom', custom: params })}
        />
      ) : null}
    </div>
  );
}
