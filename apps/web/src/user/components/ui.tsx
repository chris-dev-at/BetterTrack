import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** Tiny class-name joiner — avoids a dependency for one helper (mirrors admin/ui). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-500 disabled:bg-sky-900 disabled:text-sky-300',
  secondary:
    'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700',
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
          'disabled:cursor-not-allowed disabled:text-neutral-400',
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

/** Full-screen branded splash, shown while the session bootstraps. */
export function Splash({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="text-2xl font-semibold tracking-tight text-neutral-100">BetterTrack</span>
        <Spinner label={label} />
      </div>
    </div>
  );
}

/**
 * Non-blocking overlay toast. Rendered at a fixed position so it never
 * shifts layout. Provide an `onDismiss` handler to let the user close it.
 */
export function Toast({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed right-4 top-4 z-50 flex max-w-sm items-start gap-3 rounded-md border border-amber-700 bg-amber-950/95 px-4 py-3 text-sm text-amber-200 shadow-lg"
    >
      <span className="flex-1">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-amber-400 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
      >
        ✕
      </button>
    </div>
  );
}

/** Centered card scaffold shared by the public auth screens. */
export function AuthCard({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#0b0e14] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">BetterTrack</h1>
          <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
