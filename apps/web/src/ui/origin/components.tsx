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
import { NavLink, type NavLinkProps } from 'react-router-dom';

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

export function PageHead({
  title,
  sub,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="bt-page-head">
      <div className="bt-page-head__titles">
        <h1 className="bt-page-title">{title}</h1>
        {sub ? <p className="bt-page-sub">{sub}</p> : null}
        {children}
      </div>
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
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
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

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'md' | 'lg';
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return (
    <span aria-hidden className={cx('bt-avatar', size === 'lg' && 'bt-avatar--lg', className)}>
      {initials || '·'}
    </span>
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
