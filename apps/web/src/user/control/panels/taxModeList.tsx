import { useState } from 'react';

import type {
  CustomTaxParams,
  TaxSettingsResponse,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Select } from '../../../ui/origin';
import { cx } from '../../components/ui';
import {
  DEFAULT_CUSTOM_PARAMS,
  TAX_OPTIONS,
  bodyForOption,
  isTaxOptionSelected,
} from '../../settings/taxModePicker';
import { PanelFold, Row } from './panelKit';

/**
 * The Control Center's tax-mode list — the popup-scale presentation of the same
 * choice `TaxModePicker` offers on a full page.
 *
 * Why a second presentation instead of a variant prop on the shared picker: the
 * page picker gives every mode a large card and a 2–4 sentence description, so
 * ONE option filled the 960×660 popup (owner: "one tax version is way too big on
 * the screen"). This renders the identical option set as a dense two-column
 * radio list — mode name left, one qualifying line right — and leaves
 * `apps/web/src/user/settings/taxModePicker.tsx` completely untouched, so the
 * portfolio tax surface and the first-run step keep the page-scale control they
 * were designed around (and neither file blocks the other).
 *
 * The CONTRACT is single-sourced, not duplicated: the option set
 * ({@link TAX_OPTIONS}), the selection test ({@link isTaxOptionSelected}), the
 * request shaping ({@link bodyForOption}) and the custom-mode baseline
 * ({@link DEFAULT_CUSTOM_PARAMS}) are all imported from the shared module. Only
 * layout differs — a mode added there appears here automatically.
 */

/** The one qualifying line a mode gets here, in place of its full description. */
function compactHint(i18nKey: string): string {
  return `settings.taxes.mode.${i18nKey}.compact`;
}

/** One dense radio row: name left, its qualifying line right. */
function ModeRow({
  i18nKey,
  name,
  selected,
  disabled,
  onSelect,
}: {
  i18nKey: string;
  name: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <label
      className={cx('bt-cc-mode', selected && 'is-selected', disabled && 'is-disabled')}
      // Selection reads through background and ink only — never an edge marker.
      data-selected={selected ? 'true' : undefined}
    >
      <input
        checked={selected}
        className="bt-cc-mode__radio"
        disabled={disabled}
        name={name}
        onChange={onSelect}
        type="radio"
        value={i18nKey}
      />
      <span className="bt-cc-mode__name">{t(`settings.taxes.mode.${i18nKey}.label`)}</span>
      <span className="bt-cc-mode__hint">{t(compactHint(i18nKey))}</span>
    </label>
  );
}

/**
 * The manual mode's configurable default (V5-P4c), compacted to ONE row: an
 * amount-or-% value prefilled into every sell and dividend tax field
 * server-side, still editable per trade. Blank = no default.
 */
function ManualDefaultRow({
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
  // Same bounds the shared picker and the server enforce: a rate is a percentage.
  const valid =
    raw.trim() !== '' &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    (unit === 'amount' || parsed <= 100);

  const unitButton = (target: 'amount' | 'rate', label: string) => (
    <button
      aria-pressed={unit === target}
      className={cx(unit === target && 'is-active')}
      disabled={busy}
      onClick={() => setUnit(target)}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <Row
      hint={t('settings.taxes.manualDefault.info')}
      label={t('settings.taxes.manualDefault.title')}
    >
      <div aria-label={t('settings.taxes.manualDefault.unitAria')} className="bt-seg" role="group">
        {unitButton('amount', t('settings.taxes.manualDefault.unitAmount'))}
        {unitButton('rate', t('settings.taxes.manualDefault.unitRate'))}
      </div>
      <input
        aria-label={t('settings.taxes.manualDefault.valueAria')}
        className="bt-input"
        disabled={busy}
        min={0}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={t('settings.taxes.manualDefault.placeholder')}
        step="any"
        style={{ width: 88 }}
        type="number"
        value={raw}
      />
      <Button
        disabled={busy || !valid}
        onClick={() =>
          onApply(
            unit === 'rate'
              ? { mode: 'manual_per_trade', manualDefaultRatePct: parsed }
              : { mode: 'manual_per_trade', manualDefaultAmountEur: parsed },
          )
        }
        size="sm"
        type="button"
      >
        {t('settings.taxes.manualDefault.apply')}
      </Button>
      {hasStored ? (
        <Button
          disabled={busy}
          onClick={() => {
            setRaw('');
            onApply({ mode: 'manual_per_trade' });
          }}
          size="sm"
          type="button"
          variant="quiet"
        >
          {t('settings.taxes.manualDefault.clear')}
        </Button>
      ) : null}
      {raw.trim() !== '' && !valid ? (
        <span className="bt-field__error">{t('settings.taxes.manualDefault.invalid')}</span>
      ) : null}
    </Row>
  );
}

/** One switch row of the custom builder. */
function ParamRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Row hint={hint} label={label}>
      <input
        aria-label={label}
        checked={checked}
        className="h-4 w-4"
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--bt-gold-graphic)' }}
        type="checkbox"
      />
    </Row>
  );
}

/**
 * The custom rule builder (V5-P4c), folded away under its mode: rate, cost
 * basis and four switches as rows, applied as a whole. A parameter change is a
 * mode switch — it applies forward only, and recorded rows keep the snapshot
 * they were taxed under.
 */
function CustomParamsFold({
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
    <PanelFold open summary={t('settings.taxes.mode.custom.label')}>
      <div className="bt-cc-rows">
        <Row
          hint={t('settings.taxes.custom.rateInfo')}
          label={t('settings.taxes.custom.rateLabel')}
        >
          <input
            aria-label={t('settings.taxes.custom.rateAria')}
            className="bt-input"
            disabled={busy}
            max={100}
            min={0}
            onChange={(e) => setRate(e.target.value)}
            step="any"
            style={{ width: 88 }}
            type="number"
            value={rate}
          />
        </Row>
        <Row
          hint={t('settings.taxes.custom.costBasisInfo')}
          label={t('settings.taxes.custom.costBasisLabel')}
        >
          <Select
            aria-label={t('settings.taxes.custom.costBasisAria')}
            disabled={busy}
            onChange={(e) => set({ costBasis: e.target.value as CustomTaxParams['costBasis'] })}
            style={{ width: 'auto' }}
            value={params.costBasis}
          >
            <option value="moving-average">
              {t('settings.taxes.custom.costBasis.movingAverage')}
            </option>
            <option value="fifo">{t('settings.taxes.custom.costBasis.fifo')}</option>
          </Select>
        </Row>
        <ParamRow
          checked={params.lossOffset}
          disabled={busy}
          hint={t('settings.taxes.custom.lossOffsetInfo')}
          label={t('settings.taxes.custom.lossOffsetLabel')}
          onChange={(lossOffset) => set({ lossOffset })}
        />
        <ParamRow
          checked={params.refund}
          disabled={busy}
          hint={t('settings.taxes.custom.refundInfo')}
          label={t('settings.taxes.custom.refundLabel')}
          onChange={(refund) => set({ refund })}
        />
        <ParamRow
          checked={params.yearReset}
          disabled={busy}
          hint={t('settings.taxes.custom.yearResetInfo')}
          label={t('settings.taxes.custom.yearResetLabel')}
          onChange={(yearReset) => set({ yearReset })}
        />
        <ParamRow
          checked={params.carryForward}
          disabled={busy}
          hint={t('settings.taxes.custom.carryForwardInfo')}
          label={t('settings.taxes.custom.carryForwardLabel')}
          onChange={(carryForward) => set({ carryForward })}
        />
        <Row>
          <Button
            disabled={busy || !rateValid}
            onClick={() => onApply({ ...params, ratePct: parsedRate })}
            size="sm"
            type="button"
          >
            {t('settings.taxes.custom.apply')}
          </Button>
          {!rateValid ? (
            <span className="bt-field__error">{t('settings.taxes.custom.invalid')}</span>
          ) : null}
        </Row>
      </div>
    </PanelFold>
  );
}

/**
 * The dense tax-mode list. `value` is the currently-selected mode/country,
 * `name` scopes the radio group so two lists never collide. The manual default
 * and the custom builder fold in under their own mode only.
 */
export function TaxModeList({
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
    <>
      <div aria-label={ariaLabel} className="bt-cc-modes" role="radiogroup">
        {TAX_OPTIONS.map((option) => {
          const selected = isTaxOptionSelected(option, value);
          return (
            <ModeRow
              disabled={busy}
              i18nKey={option.i18nKey}
              key={option.i18nKey}
              name={name}
              onSelect={() => {
                if (!selected && !busy) onSelect(bodyForOption(option, value));
              }}
              selected={selected}
            />
          );
        })}
      </div>
      {mode === 'manual_per_trade' ? (
        <ManualDefaultRow
          busy={busy}
          key={`${value?.manualDefaultAmountEur ?? ''}|${value?.manualDefaultRatePct ?? ''}`}
          onApply={onSelect}
          value={value}
        />
      ) : null}
      {mode === 'custom' ? (
        <CustomParamsFold
          busy={busy}
          onApply={(params) => onSelect({ mode: 'custom', custom: params })}
          value={value?.custom ?? DEFAULT_CUSTOM_PARAMS}
        />
      ) : null}
    </>
  );
}
