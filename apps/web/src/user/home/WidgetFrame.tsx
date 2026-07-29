// Aliased: `SettingsPopover` below binds a *DOM* `MouseEvent` listener, which an
// unaliased React import would shadow.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
import { Badge, Button, Field, Select, Seg } from '../../ui/origin';
import type { WidgetConfig, WidgetSettings, WidgetSize } from './config';
import type { WidgetDefinition } from './widgets';

/**
 * The chrome around one widget: a tiny label header row (title, the scope tag
 * when the instance is pinned to one portfolio, and — in edit mode — the edit
 * controls) over un-boxed content.
 *
 * Deliberately flat. No card border, no nested container, and never a left-edge
 * accent bar on the active/armed item: state reads through background and ink
 * only.
 */

/** One place this widget could go: the gold line the user clicks. */
export interface PlacementTarget {
  /** Accessible name — names the position, e.g. "Place before Net worth". */
  label: string;
  onSelect: () => void;
}

export interface WidgetFrameProps {
  definition: WidgetDefinition;
  widget: WidgetConfig;
  index: number;
  count: number;
  editing: boolean;
  /** The scoped portfolio's name, or null when the widget spans everything. */
  scopeLabel: string | null;
  portfolios: readonly PortfolioSummary[];
  /** This widget is the one picked up and waiting to be placed. */
  armed: boolean;
  /**
   * Insertion target sitting in the gap *before* this widget, or null when that
   * position is illegal (nothing armed, or it is where the armed widget already
   * is). {@link placeAfter} is set only on the last widget, for "at the end".
   */
  placeBefore: PlacementTarget | null;
  placeAfter: PlacementTarget | null;
  onRemove: () => void;
  onResize: (size: WidgetSize) => void;
  onMove: (to: number) => void;
  onSettingsChange: (patch: WidgetSettings) => void;
  /** Pick this widget up, or put it back down if it is already armed. */
  onArmToggle: () => void;
  /** Cancel placement — fired by a click on the armed widget itself. */
  onCancelPlacement: () => void;
  children: ReactNode;
}

export function WidgetFrame({
  definition,
  widget,
  index,
  count,
  editing,
  scopeLabel,
  portfolios,
  armed,
  placeBefore,
  placeAfter,
  onRemove,
  onResize,
  onMove,
  onSettingsChange,
  onArmToggle,
  onCancelPlacement,
  children,
}: WidgetFrameProps) {
  const t = useT();
  const title = t(definition.labelKey);
  const configurable =
    definition.supportsScope ||
    definition.rangeOptions !== undefined ||
    definition.SettingsExtra !== undefined;

  /**
   * Clicking the armed widget puts it back down. Clicks on its own edit chrome
   * are excluded so the size, settings and ↑/↓ controls keep working while it is
   * picked up — only the widget's *body* reads as "never mind".
   */
  function onSectionClick(event: ReactMouseEvent<HTMLElement>) {
    if (!armed) return;
    if ((event.target as HTMLElement).closest('.bt-home-w__chrome') !== null) return;
    onCancelPlacement();
  }

  return (
    <section
      aria-label={title}
      className={cx('bt-home-w', editing && 'is-editing', armed && 'is-armed')}
      data-size={widget.size}
      data-widget-id={widget.id}
      onClick={onSectionClick}
    >
      {placeBefore !== null ? <PlacementLine target={placeBefore} where="before" /> : null}
      {placeAfter !== null ? <PlacementLine target={placeAfter} where="after" /> : null}
      <div className="bt-home-w__head">
        <span className="bt-label bt-home-w__title">{title}</span>
        {scopeLabel !== null ? <Badge>{scopeLabel}</Badge> : null}
        {editing ? (
          <span className="bt-home-w__chrome">
            <button
              aria-label={
                armed
                  ? t('home.builder.placeCancel', { title })
                  : t('home.builder.dragHandle', { title })
              }
              aria-pressed={armed}
              className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon bt-home-w__grip"
              onClick={onArmToggle}
              type="button"
            >
              <GripIcon />
            </button>
            <Button
              aria-label={t('home.builder.moveUp', { title })}
              disabled={index === 0}
              icon="chevron-up"
              iconOnly
              onClick={() => onMove(index - 1)}
              size="sm"
              variant="quiet"
            />
            <Button
              aria-label={t('home.builder.moveDown', { title })}
              disabled={index === count - 1}
              icon="chevron-down"
              iconOnly
              onClick={() => onMove(index + 1)}
              size="sm"
              variant="quiet"
            />
            {definition.allowedSizes.length > 1 ? (
              <Seg
                ariaLabel={t('home.builder.sizeAriaLabel', { title })}
                onChange={onResize}
                options={definition.allowedSizes.map((size) => ({
                  value: size,
                  label: t(`home.builder.size.${size}`),
                }))}
                value={widget.size}
              />
            ) : null}
            {configurable ? (
              <SettingsPopover
                definition={definition}
                onSettingsChange={onSettingsChange}
                portfolios={portfolios}
                settings={widget.settings}
                title={title}
              />
            ) : null}
            <Button
              aria-label={t('home.builder.remove', { title })}
              icon="x"
              iconOnly
              onClick={onRemove}
              size="sm"
              variant="quiet"
            />
          </span>
        ) : null}
      </div>
      <div className="bt-home-w__body">{children}</div>
    </section>
  );
}

/**
 * One gold insertion line. Absolutely positioned into the grid's own gap — the
 * column gap on the desktop grid, the row gap in the ≤760px single column — so
 * showing the targets never reflows the board: the widgets do not move while the
 * user is deciding where to move one.
 *
 * A real `<button>` rather than a styled div, so it is keyboard-reachable in
 * visual order and announces the position it represents. The hit area is the
 * whole gap; the 2px line inside it is drawn by the stylesheet.
 */
function PlacementLine({ target, where }: { target: PlacementTarget; where: 'before' | 'after' }) {
  return (
    <button
      aria-label={target.label}
      className={cx('bt-home-place', `bt-home-place--${where}`)}
      onClick={target.onSelect}
      type="button"
    />
  );
}

/**
 * The pick-up grip. Drawn here rather than added to the shared icon set: the icon
 * module is owned by the design-system workstream, and this is the only surface
 * that needs a two-row grip.
 */
function GripIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height={16} viewBox="0 0 24 24" width={16}>
      <circle cx="9" cy="6.5" r="1.3" />
      <circle cx="15" cy="6.5" r="1.3" />
      <circle cx="9" cy="12" r="1.3" />
      <circle cx="15" cy="12" r="1.3" />
      <circle cx="9" cy="17.5" r="1.3" />
      <circle cx="15" cy="17.5" r="1.3" />
    </svg>
  );
}

/**
 * Per-widget settings: the portfolio scope picker, where relevant a range, and
 * whatever extra fields the widget type declares (a row count, a watchlist, an
 * asset) — in that order, generic before specific.
 */
function SettingsPopover({
  definition,
  settings,
  portfolios,
  onSettingsChange,
  title,
}: {
  definition: WidgetDefinition;
  settings: WidgetSettings;
  portfolios: readonly PortfolioSummary[];
  onSettingsChange: (patch: WidgetSettings) => void;
  title: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const scopeId = useId();
  const rangeId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const allowsAll = definition.scopeAllowsAll !== false;

  return (
    <span className="bt-home-w__anchor" ref={rootRef}>
      <Button
        aria-expanded={open}
        aria-label={t('home.builder.settings', { title })}
        icon="settings"
        iconOnly
        onClick={() => setOpen((value) => !value)}
        size="sm"
        variant="quiet"
      />
      {open ? (
        <div
          className="bt-popover bt-home-w__popover"
          role="group"
          aria-label={t('home.builder.settings', { title })}
        >
          {definition.supportsScope ? (
            <Field htmlFor={scopeId} label={t('home.builder.scopeLabel')}>
              <Select
                id={scopeId}
                onChange={(event) => onSettingsChange({ scope: event.target.value })}
                value={settings.scope ?? (allowsAll ? 'all' : (portfolios[0]?.id ?? 'all'))}
              >
                {allowsAll ? <option value="all">{t('home.builder.scopeAll')}</option> : null}
                {portfolios.map((portfolio) => (
                  <option key={portfolio.id} value={portfolio.id}>
                    {portfolio.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {definition.rangeOptions ? (
            <Field htmlFor={rangeId} label={t('home.builder.rangeLabel')}>
              <Select
                id={rangeId}
                onChange={(event) => onSettingsChange({ range: event.target.value })}
                value={settings.range ?? definition.defaultSettings.range ?? ''}
              >
                {definition.rangeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {definition.SettingsExtra ? (
            <definition.SettingsExtra onSettingsChange={onSettingsChange} settings={settings} />
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
