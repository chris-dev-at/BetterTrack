import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';

import { useT } from '../../i18n';
import { Wordmark, type WordmarkEdition } from '../../components/Wordmark';
import { TAGLINE } from '../../ui/Disclaimer';
import { Spinner } from '../../ui/Spinner';
import { AuthFigures } from './AuthFigures';

export { Spinner };

/*
 * Legacy shared primitives, reskinned onto the Origin design system
 * (docs/redesign/REAL_APP_REDESIGN_PROMPT.md, styles/origin.css). The exported
 * API and prop semantics are unchanged on purpose: dozens of not-yet-rebuilt
 * dialogs render through these, so mapping the internals onto `bt-*` reskins
 * all of them at once. Visual rules live in origin.css — anything without a
 * `bt-*` class reaches for a token rather than a Tailwind palette color.
 */

/** Tiny class-name joiner — avoids a dependency for one helper (mirrors admin/ui). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

/** Legacy variant → Origin control class (`primary` is the single gold action). */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bt-btn bt-btn--primary',
  secondary: 'bt-btn',
  ghost: 'bt-btn bt-btn--quiet',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type, ...rest }: ButtonProps) {
  return (
    <button type={type ?? 'button'} className={cx(BUTTON_VARIANTS[variant], className)} {...rest} />
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

/**
 * Label + control + hint, as one `bt-field` column.
 *
 * `className` lands on the field wrapper rather than the `<input>`: `bt-input`
 * owns the control's own box (it is a full-width 34px control), and origin.css
 * is unlayered, so a caller's Tailwind utility would lose the cascade against
 * it. Sizing the field is what every caller actually wants — `sm:w-40` on the
 * wrapper produces exactly the width the input then fills.
 */
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
    <div className={cx('bt-field', className)}>
      <span className="bt-field__label">
        <label htmlFor={inputId}>{label}</label>
        {rest.required ? (
          <span aria-hidden="true" className="bt-field__required-marker">
            {'*'}
          </span>
        ) : null}
      </span>
      <input
        id={inputId}
        className="bt-input"
        {...rest}
        aria-describedby={describedBy || undefined}
        aria-invalid={hasError || undefined}
      />
      {hint ? (
        <p id={hintId} className="bt-field__hint">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="bt-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Native checkbox styling. `accent-color` paints the box and its tick in the
 * brand gold with a browser-correct contrasting check — no custom control, so
 * the native keyboard/AT semantics are untouched.
 */
export const CHECKBOX_STYLE: CSSProperties = { accentColor: 'var(--bt-gold-graphic)' };

/** A hairline rule broken by a small uppercase label — "… or …". */
export function OrDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1" style={{ background: 'var(--bt-border)' }} />
      <span className="bt-label">{label}</span>
      <span className="h-px flex-1" style={{ background: 'var(--bt-border)' }} />
    </div>
  );
}

type AlertTone = 'error' | 'success' | 'info';

/**
 * Tone surfaces built straight from the semantic tokens: a 10%-alpha wash, the
 * full-strength hue for the text, and a 1px border of the same hue at low alpha.
 * Token-driven so the light theme flips with the rest of the system.
 */
const ALERT_TONES: Record<AlertTone, CSSProperties> = {
  error: {
    background: 'var(--bt-neg-soft)',
    borderColor: 'color-mix(in srgb, var(--bt-neg) 26%, transparent)',
    color: 'var(--bt-neg)',
  },
  success: {
    background: 'var(--bt-pos-soft)',
    borderColor: 'color-mix(in srgb, var(--bt-pos) 26%, transparent)',
    color: 'var(--bt-pos)',
  },
  info: {
    background: 'var(--bt-blue-soft)',
    borderColor: 'color-mix(in srgb, var(--bt-blue) 26%, transparent)',
    color: 'var(--bt-blue)',
  },
};

export function Alert({ tone, children }: { tone: AlertTone; children: ReactNode }) {
  return (
    <div
      role={tone === 'success' ? 'status' : 'alert'}
      className="rounded-md border px-3 py-2 text-sm"
      style={ALERT_TONES[tone]}
    >
      {children}
    </div>
  );
}

/**
 * Full-screen branded splash, shown while the session bootstraps — and, on the
 * admin origin, while the admin chunk that IS its first paint arrives, which is
 * the only reason the edition is a prop.
 */
export function Splash({ edition = 'Web', label }: { edition?: WordmarkEdition; label?: string }) {
  return (
    <div className="bt-app grid place-items-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <Wordmark edition={edition} className="text-2xl" />
        <Spinner label={label} />
      </div>
    </div>
  );
}

/**
 * Non-blocking overlay toast. Rendered at a fixed position so it never
 * shifts layout. Its semantic tone controls both the accent rail and whether
 * assistive technology announces the notice politely or assertively.
 */
export function Toast({
  children,
  onDismiss,
  tone = 'info',
}: {
  children: ReactNode;
  onDismiss: () => void;
  tone?: AlertTone;
}) {
  const t = useT();
  const rail =
    tone === 'error'
      ? 'var(--bt-neg)'
      : tone === 'success'
        ? 'var(--bt-pos)'
        : 'var(--bt-gold-graphic)';
  return (
    <div
      role="alert"
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      data-tone={tone}
      className="bt-toast"
      style={{ boxShadow: `inset 2px 0 0 ${rail}, var(--bt-shadow-menu)` }}
    >
      <span className="flex-1">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('common.dismiss')}
        className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon shrink-0"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Card scaffold shared by the public auth screens. Horizontally centered and
 * anchored a little above vertical center — top-middle-ish, not bottom-anchored
 * and not flush to the top (PROJECTPLAN.md §6.1, issue #89). The top offset is
 * viewport-height-relative so it scales down on short viewports instead of
 * pushing the card off-screen.
 *
 * Composed as the Origin gate (`bt-gate` / `bt-gate__card`): ONE card holds the
 * wordmark, the subtitle and the screen's content — no card inside a card. It
 * carries `bt-app` itself because auth screens render outside the app shell.
 *
 * **Split gate (R2).** From 900px up the same markup becomes two columns: a
 * graphite brand panel holding the wordmark and the single {@link TAGLINE} line
 * over a slow ambient tint, and a working column carrying this card's content
 * straight on the canvas (the card chrome drops away — see origin.css). Every
 * child screen keeps its markup, so field labels, names and roles are untouched.
 * Below 900px the brand panel is `display: none` and the card renders exactly
 * the centered single-column gate it always did — which is also what jsdom sees,
 * so unit tests keep asserting against one wordmark and one subtitle.
 */
export function AuthCard({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="bt-app bt-gate bt-gate--split">
      {/* Brand panel — decorative twin of the card's own wordmark, so it is
          hidden from assistive tech: the card below always announces the mark. */}
      <aside className="bt-gate__brandpanel" aria-hidden="true">
        <AuthFigures />
        <Wordmark edition="Web" className="bt-gate__mark" />
        <p className="bt-gate__tagline">{TAGLINE}</p>
      </aside>
      <main className="bt-gate__column">
        <div className="bt-gate__card">
          <div className="bt-gate__brand text-center">
            <span className="bt-gate__brand-mark">
              <Wordmark edition="Web" />
            </span>
            <h1 className="bt-meta mt-1 font-normal">{subtitle}</h1>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
