import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { useT } from '../../i18n';
import {
  EDGE,
  EDGE_ACTIVE,
  EDGE_ACTIVE_IDLE,
  EDGE_BOTTOM,
  EDGE_STRONG,
  FOCUS,
  FOCUS_WITHIN,
  LINK,
  PAD_CELL,
  SURFACE_HEADER,
  SURFACE_PANEL,
  SURFACE_WELL,
  TEXT_MICRO,
  TEXT_MUTED,
  TEXT_NUM,
  TEXT_SECTION,
  TEXT_TITLE,
  TONE_BADGE,
  TONE_BAR,
  TONE_PANEL,
  type Tone,
} from './tokens';

/** Tiny class-name joiner — avoids pulling in a dependency for one helper. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * The admin console's control kit (#1406 W2 restyle).
 *
 * Every page in the console composes from here, which is what makes the sharp
 * language a property of the console rather than of whichever page was written
 * last. The visual rules live in `./tokens`; this module is where they become
 * components. See that file for the owner mandate behind the geometry.
 */

// ── Buttons ─────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-sky-600 text-white hover:bg-sky-500 disabled:bg-sky-950 disabled:text-sky-400 border-sky-500 hover:border-sky-400 disabled:border-sky-900',
  secondary:
    'bg-neutral-900 text-neutral-100 border-neutral-700 hover:bg-neutral-800 hover:border-neutral-600 disabled:text-neutral-500',
  danger:
    'bg-red-700 text-white hover:bg-red-600 disabled:bg-red-950 disabled:text-red-400 border-red-600 hover:border-red-500 disabled:border-red-900',
  ghost:
    'bg-transparent text-neutral-300 border-transparent hover:bg-neutral-900 hover:text-white hover:border-neutral-800',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Compact height for toolbars and table rows. */
  size?: 'md' | 'sm';
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-none border font-medium transition-colors',
        size === 'sm'
          ? 'min-h-[30px] px-2.5 py-1 text-[12px]'
          : 'min-h-[36px] px-3 py-1.5 text-[13px]',
        'disabled:cursor-not-allowed',
        FOCUS,
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A one-of-N switch drawn as abutting cells rather than separate pills — the
 * shared edges are what make it read as a single control. Used for sort
 * direction, page size, and the registration-mode-adjacent choices.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cx('inline-flex', EDGE_STRONG)} role="group" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cx(
              'min-h-[30px] px-2.5 py-1 text-[12px] font-medium transition-colors',
              index > 0 ? 'border-l border-neutral-700' : null,
              selected
                ? 'bg-sky-600 text-white'
                : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
              'disabled:cursor-not-allowed disabled:opacity-60',
              FOCUS,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Fields ──────────────────────────────────────────────────────────────────

const FIELD_BASE = cx(
  'rounded-none px-2.5 py-1.5 text-[13px] text-neutral-100',
  'border border-neutral-700 placeholder:text-neutral-500',
  SURFACE_WELL,
  FOCUS_WITHIN,
);

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  /** Hide the label visually but keep it for assistive tech (toolbar filters). */
  hideLabel?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  hideLabel,
  id,
  className,
  ...rest
}: TextFieldProps) {
  const inputId = id ?? rest.name ?? label.toLowerCase().replace(/\s+/g, '-');
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const hasError = error !== undefined;
  const describedBy = [
    rest['aria-describedby'],
    hint ? hintId : undefined,
    hasError ? errorId : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={cx('bt-field__label', hideLabel ? 'sr-only' : null)}>
        <label htmlFor={inputId} className={TEXT_MICRO}>
          {label}
        </label>
        {rest.required ? (
          <span aria-hidden="true" className="bt-field__required-marker">
            {'*'}
          </span>
        ) : null}
      </span>
      <input
        id={inputId}
        className={cx(FIELD_BASE, hasError ? 'border-red-700' : null, className)}
        {...rest}
        aria-describedby={describedBy || undefined}
        aria-invalid={hasError || undefined}
      />
      {hint ? (
        <p id={hintId} className={TEXT_MUTED}>
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="text-[12px] text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hideLabel?: boolean;
  options: readonly { value: string; label: string }[];
}

/** The filter control. Native `<select>` on purpose: keyboard and mobile behaviour
 *  for free, and an operator filter is not worth a custom listbox. */
export function SelectField({
  label,
  hideLabel,
  options,
  id,
  className,
  ...rest
}: SelectFieldProps) {
  const generated = useId();
  const selectId = id ?? rest.name ?? generated;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={selectId} className={cx(TEXT_MICRO, hideLabel ? 'sr-only' : null)}>
        {label}
      </label>
      <select id={selectId} className={cx(FIELD_BASE, 'pr-7', className)} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  hideLabel?: boolean;
}

export function TextAreaField({
  label,
  hint,
  hideLabel,
  id,
  className,
  ...rest
}: TextAreaFieldProps) {
  const generated = useId();
  const areaId = id ?? rest.name ?? generated;
  const hintId = `${areaId}-hint`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={areaId} className={cx(TEXT_MICRO, hideLabel ? 'sr-only' : null)}>
        {label}
      </label>
      <textarea
        id={areaId}
        className={cx(FIELD_BASE, 'resize-y leading-relaxed', className)}
        aria-describedby={hint ? hintId : undefined}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className={TEXT_MUTED}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

type AlertTone = 'error' | 'success' | 'info';

const ALERT_TONE: Record<AlertTone, Tone> = {
  error: 'red',
  success: 'green',
  info: 'neutral',
};

export function Alert({ tone, children }: { tone: AlertTone; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cx(
        'rounded-none border border-l-[3px] px-3 py-2 text-[13px]',
        TONE_PANEL[ALERT_TONE[tone]],
      )}
    >
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className={cx('flex items-center gap-3 text-[13px] text-neutral-400')} role="status">
      {/* A square that spins, not a ring: the console has no round corners. */}
      <span
        className="h-3 w-3 animate-spin border-2 border-neutral-700 border-t-sky-400"
        aria-hidden="true"
      />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

interface AsyncReadStateProps {
  loading: boolean;
  error: string | null;
  retryable: boolean;
  onRetry: () => void;
  loadingLabel?: string;
}

/** Admin counterpart to the user async-read state, fed by `useResource`. */
export function AsyncReadState({
  loading,
  error,
  retryable,
  onRetry,
  loadingLabel,
}: AsyncReadStateProps) {
  const t = useT();

  if (loading) return <Spinner label={loadingLabel} />;
  if (error === null) return null;

  return (
    <Alert tone={retryable ? 'error' : 'info'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{retryable ? error : t('common.unavailable')}</span>
        {retryable ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-none px-1.5 py-0.5 ring-1 ring-inset',
        'text-[10px] font-semibold uppercase tracking-[0.1em]',
        TONE_BADGE[tone],
      )}
    >
      {children}
    </span>
  );
}

// ── Structure ───────────────────────────────────────────────────────────────

/**
 * The console's container. A hard-edged box; content that needs its own padding
 * asks for `padded`, and content that manages its own (a table) does not.
 */
export function Panel({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx(EDGE, SURFACE_PANEL, padded ? 'p-4' : null, className)}>
      {children}
    </section>
  );
}

/** A panel's title strip: micro-label left, controls right, hard rule beneath. */
export function PanelHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header
      className={cx(
        'flex flex-wrap items-start justify-between gap-3 px-4 py-2.5',
        SURFACE_HEADER,
        EDGE_BOTTOM,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className={TEXT_SECTION}>{title}</h2>
        {description ? <p className={TEXT_MUTED}>{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Page title block. The eyebrow names the workspace so a deep link orients. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <span className={TEXT_MICRO}>{eyebrow}</span> : null}
        <h1 className={TEXT_TITLE}>{title}</h1>
        {description ? <p className="text-[13px] text-neutral-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-none border border-dashed border-neutral-800 px-6 py-8',
        'text-center text-[13px] text-neutral-500',
      )}
    >
      {children}
    </div>
  );
}

/**
 * One tab in a workspace strip. The active tab carries a 2 px sky underline plus
 * a panel-coloured fill so it reads as connected to the content below it —
 * colour alone would fail for anyone who cannot see it.
 */
export interface TabDefinition {
  key: string;
  label: string;
  /** A count rendered as a trailing chip. Omit for "no number to show". */
  count?: number;
  /**
   * A short word rendered instead of a count — "soon" for a tab whose workspace
   * exists but whose package has not shipped. It stays selectable: a tab that
   * explains what is coming is worth more to an operator than a dead one.
   */
  marker?: string;
  disabled?: boolean;
  /** Shown as a title on a disabled tab, so "why can't I click this" is answered. */
  disabledReason?: string;
}

/** Shared geometry, so a route strip and an in-page strip read as one control. */
const TAB_BASE =
  'flex min-h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap px-3 border-b-2 text-[13px] font-medium transition-colors';

function tabSkin(active: boolean): string {
  return active
    ? 'border-b-sky-500 bg-neutral-900 text-neutral-50'
    : 'border-b-transparent text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-200';
}

/** The trailing chip: a count, or a word like "soon". */
function TabChip({ tab, active }: { tab: TabDefinition; active: boolean }) {
  if (tab.marker !== undefined) {
    return (
      <span className="ml-0.5 border border-amber-900 bg-amber-950 px-1 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-400">
        {tab.marker}
      </span>
    );
  }
  if (tab.count === undefined) return null;
  return (
    <span
      className={cx(
        'ml-0.5 border px-1 py-px text-[10px] font-semibold',
        TEXT_NUM,
        active
          ? 'border-sky-800 bg-sky-950 text-sky-300'
          : 'border-neutral-800 bg-neutral-950 text-neutral-500',
      )}
    >
      {tab.count}
    </span>
  );
}

/**
 * IN-PAGE tabs: selecting one swaps the content below without leaving the page,
 * which is exactly what `tablist`/`tab`/`tabpanel` describes. Pair it with
 * {@link TabPanel} so the panel is announced with its tab.
 *
 * For a strip whose "tabs" are separate ROUTES use {@link NavTabs} instead —
 * telling a screen reader "tab 2 of 4" and then navigating the whole page away
 * is a promise the control does not keep.
 */
export function Tabs({
  label,
  tabs,
  activeKey,
  onSelect,
  idPrefix = 'tab',
}: {
  label: string;
  tabs: readonly TabDefinition[];
  activeKey: string;
  onSelect: (key: string) => void;
  idPrefix?: string;
}) {
  return (
    <div
      className={cx('flex overflow-x-auto no-scrollbar', EDGE_BOTTOM)}
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            id={`${idPrefix}-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            // Only the selected tab is in the tab order; arrow keys are the
            // documented way through a tablist and Tab moves on to the panel.
            tabIndex={active ? 0 : -1}
            disabled={tab.disabled}
            title={tab.disabled ? tab.disabledReason : undefined}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const selectable = tabs.filter((candidate) => !candidate.disabled);
              const at = selectable.findIndex((candidate) => candidate.key === activeKey);
              const next = selectable[(at + step + selectable.length) % selectable.length];
              if (next) onSelect(next.key);
            }}
            className={cx(
              TAB_BASE,
              FOCUS,
              tabSkin(active),
              tab.disabled ? 'cursor-not-allowed text-neutral-700 hover:bg-transparent' : null,
            )}
          >
            {tab.label}
            <TabChip tab={tab} active={active} />
          </button>
        );
      })}
    </div>
  );
}

/** The panel {@link Tabs} points at. */
export function TabPanel({
  tabKey,
  idPrefix = 'tab',
  children,
}: {
  tabKey: string;
  idPrefix?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tabKey}`}
      aria-labelledby={`${idPrefix}-${tabKey}`}
      tabIndex={0}
      className="focus:outline-none"
    >
      {children}
    </div>
  );
}

export interface NavTabDefinition extends TabDefinition {
  /** The route this tab navigates to. */
  to: string;
}

/**
 * ROUTE tabs: the workspace strip (#1406 W2). Each one is a real link, so it
 * opens in a new tab, copies as a URL and works with the back button — and it is
 * announced as navigation, not as a tab, because that is what it does. The
 * active item is marked with `aria-current="page"`.
 */
export function NavTabs({
  label,
  tabs,
  activeTo,
}: {
  label: string;
  tabs: readonly NavTabDefinition[];
  activeTo: string;
}) {
  return (
    <nav aria-label={label} className={cx('flex overflow-x-auto no-scrollbar', EDGE_BOTTOM)}>
      {tabs.map((tab) => {
        const active = tab.to === activeTo;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? 'page' : undefined}
            title={tab.disabledReason}
            className={cx(TAB_BASE, FOCUS, tabSkin(active))}
          >
            {tab.label}
            <TabChip tab={tab} active={active} />
          </Link>
        );
      })}
    </nav>
  );
}

/** A dense figure tile. `tone` puts a coloured bar on the leading edge. */
export function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: Tone;
}) {
  return (
    // The bar colour comes from the TONE_BAR map, never from an interpolated
    // class name: Tailwind scans source text, so `border-l-${tone}-500` would
    // compile to nothing at all.
    <div className={cx(EDGE, SURFACE_PANEL, 'border-l-[3px] px-3 py-2', TONE_BAR[tone])}>
      <div className={TEXT_MICRO}>{label}</div>
      <div className={cx('mt-1 text-[20px] font-semibold text-neutral-50', TEXT_NUM)}>{value}</div>
      {detail ? <div className={cx('mt-0.5', TEXT_MUTED)}>{detail}</div> : null}
    </div>
  );
}

/**
 * A definition list drawn as rows with hard rules — the console's answer to
 * "show me everything the server knows about this". Values are tabular so a
 * column of timestamps lines up.
 */
export function KeyValueList({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-neutral-800 border-t border-neutral-800">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className={TEXT_MICRO}>{row.label}</dt>
          <dd className={cx('min-w-0 text-right text-[13px] text-neutral-200', TEXT_NUM)}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Table chrome, so every console table has the same rules and density. */
export function DataTable({
  children,
  minWidth = '48rem',
}: {
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <div className={cx('overflow-x-auto', EDGE)}>
      <table className="w-full text-left" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th className={cx(PAD_CELL, TEXT_MICRO, 'whitespace-nowrap', className)} {...rest}>
      {children}
    </th>
  );
}

/**
 * A column head that sorts. Clicking the active column flips direction; the
 * arrow is a text glyph so it survives a missing icon font, and
 * `aria-sort` carries the state for assistive tech.
 */
export function SortableTh({
  children,
  active,
  direction,
  onSort,
  className,
}: {
  children: ReactNode;
  active: boolean;
  direction: 'asc' | 'desc';
  onSort: () => void;
  className?: string;
}) {
  return (
    <th
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx(PAD_CELL, 'whitespace-nowrap p-0', className)}
    >
      <button
        type="button"
        onClick={onSort}
        className={cx(
          'flex w-full items-center gap-1 px-3 py-2 text-left transition-colors',
          TEXT_MICRO,
          active ? 'text-sky-400' : 'hover:text-neutral-300',
          FOCUS,
        )}
      >
        {children}
        <span aria-hidden="true" className="text-[9px]">
          {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

export function Td({
  children,
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td className={cx(PAD_CELL, 'text-[13px] text-neutral-300', className)} {...rest}>
      {children}
    </td>
  );
}

/** A read-only secret (temp password / invite URL) with a copy button. */
export function CopyField({
  value,
  label,
  onCopied,
}: {
  value: string;
  label: string;
  onCopied?: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <span className={TEXT_MICRO}>{label}</span>
      <div className="flex items-stretch gap-2">
        <code
          className={cx(
            'flex-1 overflow-x-auto border border-neutral-700 px-2.5 py-1.5',
            'font-mono text-[12px] text-neutral-100',
            SURFACE_WELL,
          )}
        >
          {value}
        </code>
        <Button variant="secondary" onClick={copy}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

/** The active/idle leading-bar pair, exported for nav consumers. */
export const ACTIVE_EDGE = EDGE_ACTIVE;
export const IDLE_EDGE = EDGE_ACTIVE_IDLE;
export const INLINE_LINK = LINK;
