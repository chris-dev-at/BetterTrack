import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** Tiny class-name joiner — avoids pulling in a dependency for one helper. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-500 disabled:bg-sky-900 disabled:text-sky-300',
  secondary:
    'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-950 disabled:text-red-300',
  ghost: 'text-neutral-300 hover:bg-neutral-800 hover:text-white',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
        'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        'disabled:cursor-not-allowed disabled:opacity-80',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function TextField({ label, hint, id, className, ...rest }: TextFieldProps) {
  const inputId = id ?? rest.name ?? label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-300">
        {label}
      </label>
      <input
        id={inputId}
        className={cx(
          'rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
          'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
          'focus:outline-none focus:ring-2 focus:ring-sky-500',
          className,
        )}
        {...rest}
      />
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

type AlertTone = 'error' | 'success' | 'info';

const ALERT_TONES: Record<AlertTone, string> = {
  error: 'border-red-800 bg-red-950/60 text-red-200',
  success: 'border-emerald-800 bg-emerald-950/60 text-emerald-200',
  info: 'border-neutral-700 bg-neutral-900 text-neutral-300',
};

export function Alert({ tone, children }: { tone: AlertTone; children: ReactNode }) {
  return (
    <div role="alert" className={cx('rounded-md border px-3 py-2 text-sm', ALERT_TONES[tone])}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-neutral-400" role="status">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-sky-400"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

type BadgeTone = 'green' | 'amber' | 'red' | 'neutral' | 'sky';

const BADGE_TONES: Record<BadgeTone, string> = {
  green: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  amber: 'bg-amber-950 text-amber-300 ring-amber-800',
  red: 'bg-red-950 text-red-300 ring-red-800',
  neutral: 'bg-neutral-800 text-neutral-300 ring-neutral-700',
  sky: 'bg-sky-950 text-sky-300 ring-sky-800',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/** A read-only secret (temp password / invite URL) with a copy button. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700">
          {value}
        </code>
        <Button variant="secondary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/** Section wrapper used by every admin page for a consistent header + body. */
export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{title}</h1>
      {description ? <p className="text-sm text-neutral-400">{description}</p> : null}
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-neutral-800 px-6 py-10 text-center text-sm text-neutral-500">
      {children}
    </div>
  );
}
