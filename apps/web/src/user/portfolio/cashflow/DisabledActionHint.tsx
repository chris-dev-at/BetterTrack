import { useId, useState, type ReactNode } from 'react';

interface DisabledActionHintProps {
  disabled: boolean;
  hint: string;
  label: string;
  children: ReactNode;
}

/**
 * Makes the reason for a disabled action available on hover and keyboard
 * focus. Native disabled buttons cannot receive focus, so their wrapper owns
 * the description and exposes the visible helper when focused.
 */
export function DisabledActionHint({ children, disabled, hint, label }: DisabledActionHintProps) {
  const descriptionId = useId();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (!disabled) return children;

  const open = focused || hovered;

  return (
    <span
      aria-describedby={descriptionId}
      aria-label={label}
      className="inline-flex flex-col items-end gap-1"
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="group"
      tabIndex={0}
    >
      {children}
      <span className="sr-only" id={descriptionId}>
        {hint}
      </span>
      {open ? (
        <span className="bt-meta max-w-64 text-right" role="tooltip">
          {hint}
        </span>
      ) : null}
    </span>
  );
}
