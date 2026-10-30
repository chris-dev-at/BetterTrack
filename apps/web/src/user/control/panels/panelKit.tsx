import type { ReactNode } from 'react';

import { cx } from '../../../lib/cx';

/**
 * The Control Center's panel grammar (R2). Every panel is built for the 960×660
 * popup, not for a page canvas: ONE compact head, then labelled groups of ruled
 * rows — label · optional one-line hint · control. There are no cards, no nested
 * panels and no paragraph under each control; prose only survives where it
 * states a real constraint ({@link PanelNote}).
 *
 * Section labels are real headings styled small, so the document outline (and
 * every `getByRole('heading')` assertion) survives the visual compaction.
 */

/** The panel's single head: its name, plus at most one action. */
export function PanelHead({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="bt-cc-panel__head">
      <h2 className="bt-cc-panel__title">{title}</h2>
      {actions ? <div className="bt-cc-row__control">{actions}</div> : null}
    </div>
  );
}

/** A labelled group of rows. `label` omitted → an unlabelled ruled run. */
export function PanelGroup({
  label,
  children,
  className,
}: {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('bt-cc-group', className)}>
      {label ? <h3 className="bt-cc-group__label">{label}</h3> : null}
      <div className="bt-cc-rows">{children}</div>
    </section>
  );
}

/**
 * One setting: label (+ one-line hint) left, control right. `stack` puts the
 * control under the label instead — for forms and lists that need the width.
 */
export function Row({
  label,
  hint,
  htmlFor,
  stack = false,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  /** Renders the label as a real `<label for>` when the control has an id. */
  htmlFor?: string;
  stack?: boolean;
  children?: ReactNode;
}) {
  const text =
    label || hint ? (
      <div className="bt-cc-row__text">
        {label ? (
          htmlFor ? (
            <label className="bt-cc-row__label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <span className="bt-cc-row__label">{label}</span>
          )
        ) : null}
        {hint ? <span className="bt-cc-row__hint">{hint}</span> : null}
      </div>
    ) : null;

  return (
    <div className={cx('bt-cc-row', stack && 'bt-cc-row--stack')}>
      {text}
      {children ? stack ? children : <div className="bt-cc-row__control">{children}</div> : null}
    </div>
  );
}

/** A one-line constraint worth the pixels. Never a narration of the control. */
export function PanelNote({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <p className={cx('bt-cc-note', warn && 'bt-cc-note--warn')}>{children}</p>;
}

/** A narrow inline form column (≤420px) — the popup's only form width. */
export function PanelForm({
  children,
  onSubmit,
  className,
  formRef,
}: {
  children: ReactNode;
  onSubmit?: (event: React.FormEvent) => void;
  className?: string;
  /** The rendered `<form>`, for callers that scope a DOM query to it (`useFieldErrors`). */
  formRef?: React.Ref<HTMLFormElement>;
}) {
  if (onSubmit) {
    return (
      <form className={cx('bt-cc-form', className)} onSubmit={onSubmit} ref={formRef}>
        {children}
      </form>
    );
  }
  return <div className={cx('bt-cc-form', className)}>{children}</div>;
}

/** A dense list of objects (sessions, keys, apps, webhooks…). */
export function PanelList({
  children,
  ...rest
}: { children: ReactNode } & { 'aria-label'?: string }) {
  return (
    <ul className="bt-cc-list" {...rest}>
      {children}
    </ul>
  );
}

/** One object row: title + metadata left, inline actions right. */
export function PanelListItem({
  main,
  actions,
  children,
}: {
  main: ReactNode;
  actions?: ReactNode;
  /** Extra content below the row (an expanded deliveries list, a form…). */
  children?: ReactNode;
}) {
  return (
    <li className="bt-cc-list__item" style={children ? { flexDirection: 'column' } : undefined}>
      <div
        className="bt-cc-list__item"
        style={{ border: 0, padding: 0, width: '100%', alignItems: 'flex-start' }}
      >
        <div className="bt-cc-list__main">{main}</div>
        {actions ? <div className="bt-cc-list__actions">{actions}</div> : null}
      </div>
      {children}
    </li>
  );
}

/** A collapsed block — the popup's way to fold a long, optional surface away. */
export function PanelFold({
  summary,
  children,
  open,
  onToggle,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className="bt-cc-fold"
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
      open={open}
    >
      <summary>{summary}</summary>
      <div className="bt-cc-fold__body">{children}</div>
    </details>
  );
}
