import {
  cloneElement,
  isValidElement,
  useId,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, type LinkProps, type NavLinkProps } from 'react-router-dom';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
import { useOverlayEscape } from '../overlayStack';
import { useFocusTrap } from '../useFocusTrap';
import { Icon, type IconName } from './icons';

/*
 * Origin primitives (REAL_APP_REDESIGN_PROMPT.md): the reusable control and
 * structure layer every rebuilt screen composes. Visual rules live entirely in
 * styles/origin.css — these components only bind markup, classes and the
 * small amount of behavior (dialog focus, switch semantics) they need.
 */

type ButtonVariant = 'primary' | 'neutral' | 'quiet' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  iconOnly?: boolean;
  loading?: boolean;
  /**
   * React 19 passes `ref` through props, so declaring it here is all a caller
   * needs to keep the primitive instead of hand-rolling a `<button>` just to
   * reach the DOM node (menu triggers need one for focus restoration).
   */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'neutral',
  size = 'md',
  icon,
  iconOnly = false,
  loading = false,
  className,
  children,
  type,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx(
        'bt-btn',
        variant !== 'neutral' && `bt-btn--${variant}`,
        size === 'sm' && 'bt-btn--sm',
        iconOnly && 'bt-btn--icon',
        loading && 'is-loading',
        className,
      )}
      disabled={disabled || loading}
      type={type ?? 'button'}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 16} /> : null}
      {iconOnly ? null : children}
    </button>
  );
}

/**
 * A route that LOOKS like a button and stays a link.
 *
 * The vault surfaces were a field of bare `<Link className="bt-link">` anchors
 * ("just text and hyperlink anchor text"), so the fix is the button skin — but
 * navigation must not become `onClick={navigate}`: that costs middle-click,
 * open-in-new-tab, the status-bar preview and the `link` role every one of
 * these targets is asserted by. Same classes as {@link Button}, same `href`.
 */
export function LinkButton({
  variant = 'neutral',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: LinkProps & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
}) {
  return (
    <Link
      className={cx(
        'bt-btn',
        variant !== 'neutral' && `bt-btn--${variant}`,
        size === 'sm' && 'bt-btn--sm',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 16} /> : null}
      {children}
    </Link>
  );
}

export function PageHead({
  title,
  sub,
  actions,
  media,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /**
   * Leading media for the title block — the owner's avatar on the shared-item
   * pages (§6.9: a curated profile icon renders wherever a user appears). It
   * sits INSIDE the titles column, next to the heading, so the header keeps its
   * `space-between` split with the actions and gains no extra row.
   */
  media?: ReactNode;
  children?: ReactNode;
}) {
  const titles = (
    <>
      <h1 className="bt-page-title">{title}</h1>
      {sub ? <p className="bt-page-sub">{sub}</p> : null}
      {children}
    </>
  );
  return (
    <header className="bt-page-head">
      {media ? (
        <div className="bt-page-head__titles flex items-center gap-3">
          {media}
          <div className="min-w-0">{titles}</div>
        </div>
      ) : (
        <div className="bt-page-head__titles">{titles}</div>
      )}
      {actions ? <div className="bt-page-head__actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="bt-section__head">
      <div>
        <h2 className="bt-h2">{title}</h2>
        {sub ? (
          <p className="bt-meta" style={{ marginTop: 2 }}>
            {sub}
          </p>
        ) : null}
      </div>
      {actions ? <div className="bt-page-head__actions">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  pad = true,
  soft = false,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { pad?: boolean; soft?: boolean }) {
  return (
    <div
      className={cx('bt-panel', pad && 'bt-panel--pad', soft && 'bt-panel--soft', className)}
      {...rest}
    />
  );
}

export type BadgeTone = 'neutral' | 'pos' | 'neg' | 'gold' | 'blue';

export function Badge({
  tone = 'neutral',
  outline = false,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; outline?: boolean }) {
  return (
    <span
      className={cx(
        'bt-badge',
        tone !== 'neutral' && `bt-badge--${tone}`,
        outline && 'bt-badge--outline',
        className,
      )}
      {...rest}
    />
  );
}

export function Stat({
  label,
  value,
  delta,
  deltaTone,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: 'pos' | 'neg' | 'muted';
}) {
  return (
    <div className="bt-stat">
      <div className="bt-stat__label">{label}</div>
      <div className="bt-stat__value">{value}</div>
      {delta !== undefined && delta !== null ? (
        <div
          className={cx(
            'bt-stat__delta',
            deltaTone === 'pos' && 'bt-pos',
            deltaTone === 'neg' && 'bt-neg',
            (deltaTone === 'muted' || !deltaTone) && 'bt-muted',
          )}
        >
          {delta}
        </div>
      ) : null}
    </div>
  );
}

export function StatStrip({
  panel = false,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { panel?: boolean }) {
  return <div className={cx('bt-stats', panel && 'bt-stats--panel', className)} {...rest} />;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const generatedErrorId = useId();
  const hasError = Boolean(error);
  const isRequired =
    isValidElement<{ required?: boolean }>(children) && Boolean(children.props.required);
  const errorId = `${htmlFor ?? generatedErrorId}-error`;
  const control =
    hasError && isValidElement<Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'>>(children)
      ? cloneElement(children, {
          'aria-describedby': [children.props['aria-describedby'], errorId]
            .filter((value): value is string => Boolean(value))
            .join(' '),
          'aria-invalid': true,
        })
      : children;

  return (
    <div className={cx('bt-field', className)}>
      {label ? (
        <span className="bt-field__label">
          <label htmlFor={htmlFor}>{label}</label>
          {isRequired ? (
            <span aria-hidden="true" className="bt-field__required-marker">
              {'*'}
            </span>
          ) : null}
        </span>
      ) : null}
      {control}
      {hasError ? (
        <span className="bt-field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="bt-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('bt-input', className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx('bt-select', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('bt-textarea', className)} {...rest} />;
}

/** Accessible on/off switch rendered as a `role="switch"` button. */
export function Switch({
  checked,
  onChange,
  disabled,
  ...rest
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>) {
  return (
    <button
      aria-checked={checked}
      className="bt-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
      {...rest}
    />
  );
}

/** Segmented control for compact, mutually exclusive choices (chart ranges…). */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div aria-label={ariaLabel} className="bt-seg" role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cx(option.value === value && 'is-active')}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One-of-N, in this app's own grammar: hairline-ruled rows inside a single
 * bordered group — NOT a card per option.
 *
 * That is a house rule with two prior statements, and this primitive exists so
 * the third surface stops re-deciding it: "One choice per line, separated by a
 * rule rather than boxed into cards" (`.bt-pfw__choices`) and "A one-of-N choice
 * as hairline-ruled rows instead of a card per option… there is no edge marker"
 * (`.bt-cc-modes`). Selection is background + ink only.
 *
 * The NATIVE radio stays the control. Every alternative — a `role="radio"` div,
 * a visually-hidden input, a `Seg` — would trade away arrow-key group
 * navigation or the label-text accessible name these options already carry, to
 * buy a custom glyph. `accent-color` gets the gold for free, exactly as the
 * Control Center's own mode list does.
 */
export function ChoiceGroup({
  children,
  label,
}: {
  children: ReactNode;
  /** Names the group for assistive tech; the rows are its radios. */
  label?: string;
}) {
  return (
    <div aria-label={label} className="bt-choices" role="radiogroup">
      {children}
    </div>
  );
}

export function Choice({
  badge,
  children,
  description,
  disabled = false,
  muted = false,
  name,
  note,
  onSelect,
  selected,
  title,
}: {
  badge?: ReactNode;
  children?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /**
   * The option a flow steers AWAY from — the risky custody, the Drive-only
   * medium. It de-emphasises; it never hides. An option a user cannot find is
   * not a choice, and a `<details>` wrapped around it was how these surfaces
   * used to pretend otherwise.
   */
  muted?: boolean;
  name?: string;
  /** A caption inside the row: why this option is unavailable, or its cost. */
  note?: ReactNode;
  onSelect: () => void;
  selected: boolean;
  title: ReactNode;
}) {
  return (
    <label
      className={cx(
        'bt-choice',
        selected && 'is-selected',
        muted && 'bt-choice--muted',
        disabled && 'is-disabled',
      )}
    >
      <input
        checked={selected}
        className="bt-choice__control"
        disabled={disabled}
        name={name}
        onChange={onSelect}
        type="radio"
      />
      <span className="bt-choice__body">
        <span className="bt-choice__head">
          <span className="bt-choice__name">{title}</span>
          {badge}
        </span>
        {description ? <span className="bt-choice__desc">{description}</span> : null}
        {note ? <span className="bt-choice__note">{note}</span> : null}
        {children}
      </span>
    </label>
  );
}

/**
 * The acknowledgment row — a native checkbox on a real surface, so a consent
 * that gates a destructive step reads as a decision instead of a stray tick
 * beside a sentence. Same reasoning as {@link Choice}: the input stays native,
 * the design lives around it.
 */
export function CheckRow({
  checked,
  children,
  className,
  disabled = false,
  onChange,
  tone = 'neutral',
  ...rest
}: {
  checked: boolean;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** `gold` for the consequence a ceremony must not let pass unread. */
  tone?: 'neutral' | 'gold';
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'checked' | 'className' | 'disabled' | 'onChange' | 'type'
>) {
  return (
    <label
      className={cx(
        'bt-check',
        checked && 'is-checked',
        disabled && 'is-disabled',
        tone === 'gold' && 'bt-check--gold',
        className,
      )}
    >
      <input
        checked={checked}
        className="bt-check__control"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
        {...rest}
      />
      <span className="bt-check__body">{children}</span>
    </label>
  );
}

/**
 * A fold, in the Control Center's disclosure grammar — the marker-less
 * `<summary>` with the chevron pushed to the right edge — promoted out of
 * `panelKit` so surfaces outside the popup stop hand-rolling
 * `<summary className="bt-link">`.
 *
 * Native `<details>` on purpose: the keyboard behaviour, the open state and the
 * find-in-page reveal are the platform's, not ours. It follows that a closed
 * fold still YIELDS ITS TEXT to content scripts and find-in-page — anything
 * whose mere presence in the DOM is the risk (a recovery phrase) must gate its
 * own render on the open state as well, which is why this takes `open`.
 */
export function Disclosure({
  children,
  onToggle,
  open,
  summary,
}: {
  children: ReactNode;
  onToggle?: (open: boolean) => void;
  /** Controlled open state; omit to let the browser own it. */
  open?: boolean;
  summary: ReactNode;
}) {
  return (
    <details
      className="bt-disclosure"
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      open={open}
    >
      <summary>{summary}</summary>
      <div className="bt-disclosure__body">{children}</div>
    </details>
  );
}

/**
 * The step header of a multi-step flow, in the portfolio/import wizards' own
 * chrome: filling dots plus one "Step N of M" line.
 *
 * The dots are `aria-hidden`; the position is stated in the text line, which is
 * the only thing assistive tech needs. Deliberately NOT list markup — a
 * `<ol>`/`<li>` stepper would inject items into wizards whose own step body is
 * a list (the creation ceremony's twelve recovery words are asserted by count)
 * and would announce steps that are not navigable.
 */
export function Stepper({
  current,
  total,
  label,
  title,
}: {
  /** 1-based. */
  current: number;
  total: number;
  /** The "Step 2 of 6" line, already localized and interpolated. */
  label: ReactNode;
  title?: ReactNode;
}) {
  return (
    <div className="bt-pfw__stepper">
      <div aria-hidden="true" className="bt-pfw__dots">
        {Array.from({ length: total }, (_, position) => (
          <span
            className="bt-pfw__dot"
            data-state={
              position === current - 1 ? 'current' : position < current - 1 ? 'done' : 'upcoming'
            }
            key={position}
          />
        ))}
      </div>
      <p className="bt-pfw__stepnow">{label}</p>
      {title ? <h3 className="bt-h2">{title}</h3> : null}
    </div>
  );
}

export function TabLink({ className, ...rest }: NavLinkProps & { className?: string }) {
  return (
    <NavLink
      className={({ isActive }) => cx('bt-tab', isActive && 'is-active', className)}
      {...rest}
    />
  );
}

export function SubTabLink({ className, ...rest }: NavLinkProps & { className?: string }) {
  return (
    <NavLink
      className={({ isActive }) => cx('bt-subtab', isActive && 'is-active', className)}
      {...rest}
    />
  );
}

export function Empty({
  title,
  children,
  action,
  center = false,
  icon,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  center?: boolean;
  icon?: IconName;
}) {
  return (
    <div className={cx('bt-empty', center && 'bt-empty--center')}>
      {icon ? <Icon name={icon} size={22} /> : null}
      <div className="bt-empty__title">{title}</div>
      {children ? <div>{children}</div> : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

/**
 * A parked feature surface: the destination is part of the product structure
 * today, its build lands later. Always designed — never a bare stub — so the
 * suite reads complete while staying honest about what is live.
 */
export function Parked({
  flag,
  title,
  body,
  points,
  foot,
  actions,
}: {
  flag: ReactNode;
  title: ReactNode;
  body: ReactNode;
  points?: ReactNode[];
  foot?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="bt-parked">
      <span className="bt-parked__flag">
        <Icon name="clock" size={13} />
        {flag}
      </span>
      <h2 className="bt-parked__title">{title}</h2>
      <p className="bt-parked__body">{body}</p>
      {points && points.length ? (
        <ul className="bt-parked__points">
          {points.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ul>
      ) : null}
      {actions ? <div style={{ marginTop: 18 }}>{actions}</div> : null}
      {foot ? <p className="bt-parked__foot">{foot}</p> : null}
    </section>
  );
}

/** Modal dialog: scrim + centered panel, Escape/scrim close, labelled title. */
export function ODialog({
  open,
  onClose,
  title,
  children,
  foot,
  wide = false,
  size = 'default',
  phoneSheet = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  wide?: boolean;
  /** Fill the phone viewport while preserving the centred desktop dialog. */
  phoneSheet?: boolean;
  /**
   * `'wizard'` gives the panel the Control Center's geometry — a big centred
   * popup with room for a stepper — instead of the default form-sized panel.
   */
  size?: 'default' | 'wizard';
}) {
  const t = useT();
  const titleId = useId();
  const { containerRef: rootRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    active: open,
    inertBackground: true,
  });
  useOverlayEscape(open, onClose, rootRef);

  if (!open) return null;
  // Portalled to <body>: rendered in place, `position: fixed` resolves against
  // the nearest ancestor that is a containing block for it, and the topbar's
  // `backdrop-filter` makes the topbar one — so a dialog opened from the
  // portfolio switcher laid itself out inside that 56px strip. The portal root
  // carries `bt-app`, which is where the ink, type scale and focus ring live.
  return createPortal(
    <div className="bt-app bt-dialog-root" onKeyDown={onKeyDown} ref={rootRef} tabIndex={-1}>
      <div aria-hidden="true" className="bt-scrim" onClick={onClose} />
      <div className={cx('bt-dialog', phoneSheet && 'bt-dialog--phone-sheet')}>
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className={cx(
            'bt-dialog__panel',
            size === 'wizard' && 'bt-dialog__panel--wizard',
            phoneSheet && 'bt-dialog__panel--phone-sheet',
          )}
          role="dialog"
          style={wide ? { width: 'min(760px, 100%)' } : undefined}
          tabIndex={-1}
        >
          <div className="bt-dialog__head">
            <h2 className="bt-dialog__title" id={titleId}>
              {title}
            </h2>
            <Button
              aria-label={t('common.close')}
              icon="x"
              iconOnly
              onClick={onClose}
              size="sm"
              variant="quiet"
            />
          </div>
          <div className="bt-dialog__body">{children}</div>
          {foot ? <div className="bt-dialog__foot">{foot}</div> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Right-hand drawer for secondary workspaces (Control Center, inspectors). */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const { containerRef: rootRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    active: open,
    inertBackground: true,
  });
  useOverlayEscape(open, onClose, rootRef);

  if (!open) return null;
  return (
    <div onKeyDown={onKeyDown} ref={rootRef} tabIndex={-1}>
      <div aria-hidden="true" className="bt-scrim" onClick={onClose} />
      <aside
        aria-labelledby={titleId}
        aria-modal="true"
        className="bt-drawer"
        role="dialog"
        tabIndex={-1}
      >
        <div className="bt-drawer__head">
          <h2 className="bt-dialog__title" id={titleId}>
            {title}
          </h2>
          <Button
            aria-label={t('common.close')}
            icon="x"
            iconOnly
            onClick={onClose}
            size="sm"
            variant="quiet"
          />
        </div>
        <div className="bt-drawer__body">{children}</div>
      </aside>
    </div>
  );
}

export function SkeletonBlock({
  height = 16,
  width,
  className,
}: {
  height?: number | string;
  width?: number | string;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cx('bt-skeleton', className)}
      style={{ height, width: width ?? '100%' }}
    />
  );
}
