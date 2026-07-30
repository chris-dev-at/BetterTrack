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
import { Badge, Button, Field, Icon, Input, Select, Seg } from '../../ui/origin';
import {
  SCOPE_ALL,
  SCOPE_IDS_MAX,
  SCOPE_SELECTED,
  widgetVariant,
  type WidgetConfig,
  type WidgetSettings,
  type WidgetSize,
} from './config';
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

/**
 * What a widget's header states about its scope: a short label plus, for a chosen
 * set, the member names for the tooltip and accessible name. Never a label that
 * implies "all" while a subset is on screen.
 */
export interface ScopeTag {
  label: string;
  detail: string | null;
}

/** Which grid boundary a slot divides, and therefore how its line is drawn. */
export type PlacementAxis = 'h' | 'v';

/**
 * One position on the board the user can act on. Both actions live on the same
 * lines, distinguished by what is currently held:
 *
 *  - `move` — a widget is armed, and this slot is somewhere it may go;
 *  - `add`  — nothing is armed, and this slot will receive a brand-new widget
 *             chosen from the drawer.
 */
export interface PlacementTarget {
  /**
   * Accessible name, which always says *where*: "Place before Upcoming", "Add a
   * widget at the end". Screen-reader users get the position they cannot see.
   */
  label: string;
  /** Which boundary this slot divides — decides how its line is drawn. */
  axis: PlacementAxis;
  mode: 'move' | 'add';
  onSelect: () => void;
}

export interface WidgetFrameProps {
  definition: WidgetDefinition;
  widget: WidgetConfig;
  index: number;
  count: number;
  editing: boolean;
  /** What the header says about scope, or null when the widget spans everything. */
  scopeTag: ScopeTag | null;
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
  scopeTag,
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
    definition.variants !== undefined ||
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
      {placeBefore !== null ? <PlacementSlot target={placeBefore} where="before" /> : null}
      {placeAfter !== null ? <PlacementSlot target={placeAfter} where="after" /> : null}
      <div className="bt-home-w__head">
        <span className="bt-label bt-home-w__title">{title}</span>
        {scopeTag !== null ? (
          <Badge
            aria-label={
              scopeTag.detail === null ? undefined : `${scopeTag.label} — ${scopeTag.detail}`
            }
            title={scopeTag.detail ?? undefined}
          >
            {scopeTag.label}
          </Badge>
        ) : null}
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
 * One insertion position: a gold line with a round glyph sitting on it — an
 * arrow to move the picked-up widget here, a plus to add a new one here. Glyph
 * only, no words (owner): the label was long enough to break the line it sat on,
 * and two icons carry the difference on their own.
 *
 * Absolutely positioned into the grid's own gap (widened while editing, see the
 * stylesheet), so revealing the slots never reflows the board — the widgets hold
 * still while the user decides. `axis` comes from the *measured* layout rather
 * than from the widget's declared size, so a line can never end up drawn across
 * the boundary it is not dividing.
 *
 * A real `<button>`: keyboard-reachable in visual order, named by `aria-label`
 * (which still says *where* it lands, the thing a sighted user reads off the
 * position); the glyph is `aria-hidden`, and the hit area is the whole gap.
 */
function PlacementSlot({ target, where }: { target: PlacementTarget; where: 'before' | 'after' }) {
  return (
    <button
      aria-label={target.label}
      className={cx(
        'bt-home-place',
        `bt-home-place--${where}`,
        `is-${target.axis}`,
        `is-${target.mode}`,
      )}
      onClick={target.onSelect}
      type="button"
    >
      <span aria-hidden="true" className="bt-home-place__pill">
        <Icon name={target.mode === 'move' ? 'arrow-right' : 'plus'} size={13} />
      </span>
    </button>
  );
}

/**
 * Switching scope mode from the Select.
 *
 * Choosing "Selected portfolios…" seeds the set with whatever the widget was
 * already showing — the single portfolio it was pinned to, else the first one —
 * so the picker never opens on an empty set that would silently resolve back to
 * "all" and make the choice look like it did nothing. Leaving the mode clears
 * `scopeIds`, so a stale set cannot linger invisibly behind an `all` widget and
 * reappear later.
 */
function scopePatch(next: string, portfolios: readonly PortfolioSummary[]): WidgetSettings {
  if (next !== SCOPE_SELECTED) return { scope: next, scopeIds: undefined };
  const seed = portfolios[0]?.id;
  return { scope: SCOPE_SELECTED, scopeIds: seed === undefined ? undefined : [seed] };
}

/** Past this many portfolios the picker grows a filter box rather than a long scroll. */
const SCOPE_FILTER_THRESHOLD = 8;

/**
 * The checkbox list behind "Selected portfolios…".
 *
 * Compact by construction — it lives inside a 236px popover, so the list scrolls
 * rather than growing, and a filter box appears only once there are enough
 * portfolios for scrolling alone to be annoying.
 *
 * Unchecking the last one is refused rather than allowed: an empty set resolves to
 * "all portfolios", so permitting it would turn a deliberate narrowing into a
 * silent widening, with the checkbox left looking as if it had been honoured.
 */
function ScopePicker({
  portfolios,
  scopeIds,
  onSettingsChange,
}: {
  portfolios: readonly PortfolioSummary[];
  scopeIds: readonly string[] | undefined;
  onSettingsChange: (patch: WidgetSettings) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const chosen = scopeIds ?? [];
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ''
      ? portfolios
      : portfolios.filter((portfolio) => portfolio.name.toLowerCase().includes(needle));

  function toggle(id: string, checked: boolean) {
    const next = checked
      ? [...chosen, id].slice(0, SCOPE_IDS_MAX)
      : chosen.filter((entry) => entry !== id);
    if (next.length === 0) return;
    onSettingsChange({ scopeIds: next });
  }

  if (portfolios.length === 0) {
    return <p className="bt-meta">{t('home.builder.scopeNone')}</p>;
  }

  return (
    <div className="bt-home-scope">
      {portfolios.length > SCOPE_FILTER_THRESHOLD ? (
        <Input
          aria-label={t('home.builder.scopeFilter')}
          className="bt-home-scope__filter"
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('home.builder.scopeFilter')}
          type="search"
          value={filter}
        />
      ) : null}
      <ul className="bt-home-scope__list">
        {shown.map((portfolio) => {
          const checked = chosen.includes(portfolio.id);
          return (
            <li key={portfolio.id}>
              <label className="bt-home-scope__item">
                <input
                  checked={checked}
                  className="bt-home-scope__box"
                  // The last remaining choice cannot be cleared — see the note above.
                  disabled={checked && chosen.length === 1}
                  onChange={(event) => toggle(portfolio.id, event.target.checked)}
                  type="checkbox"
                />
                <span className="bt-home-scope__name">{portfolio.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 ? <p className="bt-meta">{t('home.builder.scopeNoMatch')}</p> : null}
    </div>
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
            <>
              <Field htmlFor={scopeId} label={t('home.builder.scopeLabel')}>
                <Select
                  id={scopeId}
                  onChange={(event) => onSettingsChange(scopePatch(event.target.value, portfolios))}
                  value={
                    settings.scope ?? (allowsAll ? SCOPE_ALL : (portfolios[0]?.id ?? SCOPE_ALL))
                  }
                >
                  {allowsAll ? (
                    <option value={SCOPE_ALL}>{t('home.builder.scopeAll')}</option>
                  ) : null}
                  {/* Only offered where a set is meaningful: a type that cannot
                      aggregate would silently collapse it to one portfolio. */}
                  {allowsAll ? (
                    <option value={SCOPE_SELECTED}>{t('home.builder.scopeSelected')}</option>
                  ) : null}
                  {portfolios.map((portfolio) => (
                    <option key={portfolio.id} value={portfolio.id}>
                      {portfolio.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {allowsAll && settings.scope === SCOPE_SELECTED ? (
                <ScopePicker
                  onSettingsChange={onSettingsChange}
                  portfolios={portfolios}
                  scopeIds={settings.scopeIds}
                />
              ) : null}
            </>
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
          {definition.variants ? (
            <Field label={t('home.builder.variantLabel')}>
              {/* A Seg, not a Select: two or three forms shown at once let the
                  user see what the alternative even is before switching. */}
              <Seg
                ariaLabel={t('home.builder.variantAriaLabel', { title })}
                onChange={(next) => onSettingsChange({ variant: next })}
                options={definition.variants.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={widgetVariant(definition.type, settings) ?? ''}
              />
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
