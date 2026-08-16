import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { useT } from '../../i18n';

/** Tiny class-name joiner — avoids pulling in a dependency for one helper. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bt-admin-btn--primary',
  secondary: 'bt-admin-btn--secondary',
  danger: 'bt-admin-btn--danger',
  ghost: 'bt-admin-btn--ghost',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx('bt-admin-btn', BUTTON_VARIANTS[variant], className)}
      {...rest}
    />
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextField({ label, hint, error, id, className, ...rest }: TextFieldProps) {
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
    <div className="bt-admin-field">
      <label htmlFor={inputId} className="bt-admin-field__label">
        {label}
      </label>
      <input
        id={inputId}
        className={cx('bt-admin-input', className)}
        {...rest}
        aria-describedby={describedBy || undefined}
        aria-invalid={hasError || undefined}
      />
      {hint ? (
        <p id={hintId} className="bt-admin-field__hint">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="bt-admin-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type AlertTone = 'error' | 'success' | 'info';

const ALERT_TONES: Record<AlertTone, string> = {
  error: 'bt-admin-alert--error',
  success: 'bt-admin-alert--success',
  info: 'bt-admin-alert--info',
};

export function Alert({ tone, children }: { tone: AlertTone; children: ReactNode }) {
  return (
    <div role="alert" className={cx('bt-admin-alert', ALERT_TONES[tone])}>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="bt-admin-spinner" role="status">
      <span className="bt-admin-spinner__mark animate-spin" aria-hidden="true" />
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
          <Button variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}

type BadgeTone = 'green' | 'amber' | 'red' | 'neutral' | 'sky';

const BADGE_TONES: Record<BadgeTone, string> = {
  green: 'bt-admin-badge--green',
  amber: 'bt-admin-badge--amber',
  red: 'bt-admin-badge--red',
  neutral: 'bt-admin-badge--neutral',
  sky: 'bt-admin-badge--sky',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={cx('bt-admin-badge', BADGE_TONES[tone])}>{children}</span>;
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
    <div className="bt-admin-copy">
      <span className="bt-admin-copy__label">{label}</span>
      <div className="bt-admin-copy__row">
        <code className="bt-admin-copy__value">{value}</code>
        <Button variant="secondary" onClick={copy}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

/** Section wrapper used by every admin page for a consistent header + body. */
export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="bt-admin-page-head">
      <h1 className="bt-admin-page-head__title">{title}</h1>
      {description ? <p className="bt-admin-page-head__description">{description}</p> : null}
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="bt-admin-empty">{children}</div>;
}
