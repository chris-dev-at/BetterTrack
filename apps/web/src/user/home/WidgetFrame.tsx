import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';

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
 * accent bar on the active/dragged item: state reads through background and ink
 * only.
 */

export interface WidgetFrameProps {
  definition: WidgetDefinition;
  widget: WidgetConfig;
  index: number;
  count: number;
  editing: boolean;
  /** The scoped portfolio's name, or null when the widget spans everything. */
  scopeLabel: string | null;
  portfolios: readonly PortfolioSummary[];
  dragging: boolean;
  onRemove: () => void;
  onResize: (size: WidgetSize) => void;
  onMove: (to: number) => void;
  onSettingsChange: (patch: WidgetSettings) => void;
  onDragStart: (event: PointerEvent<HTMLElement>) => void;
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
  dragging,
  onRemove,
  onResize,
  onMove,
  onSettingsChange,
  onDragStart,
  children,
}: WidgetFrameProps) {
  const t = useT();
  const title = t(definition.labelKey);
  const configurable = definition.supportsScope || definition.rangeOptions !== undefined;

  return (
    <section
      aria-label={title}
      className={cx('bt-home-w', editing && 'is-editing', dragging && 'is-dragging')}
      data-size={widget.size}
      data-widget-id={widget.id}
    >
      <div className="bt-home-w__head">
        <span className="bt-label bt-home-w__title">{title}</span>
        {scopeLabel !== null ? <Badge>{scopeLabel}</Badge> : null}
        {editing ? (
          <span className="bt-home-w__chrome">
            <button
              aria-label={t('home.builder.dragHandle', { title })}
              className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon bt-home-w__grip"
              onPointerDown={onDragStart}
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
 * The drag grip. Drawn here rather than added to the shared icon set: the icon
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

/** Per-widget settings: the portfolio scope picker and, where relevant, a range. */
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
        </div>
      ) : null}
    </span>
  );
}
