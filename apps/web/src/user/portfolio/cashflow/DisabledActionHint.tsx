import { useId, useState, type ReactNode } from 'react';

interface DisabledActionHintProps {
  disabled: boolean;
  hint: string;
  children: ReactNode;
}

/**
 * Makes the reason for a disabled action available on hover and keyboard
 * focus. Native disabled buttons cannot receive focus, so their wrapper owns
 * the description and exposes the visible helper when focused.
 */
export function DisabledActionHint({ children, disabled, hint }: DisabledActionHintProps) {
  const descriptionId = useId();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (!disabled) return children;

  const open = focused || hovered;

  return (
    <span
      aria-describedby={descriptionId}
      className="relative inline-flex"
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="group"
      tabIndex={0}
    >
      {children}
      {open ? (
        <span
          className="bt-meta absolute top-full right-0 z-10 mt-1 max-w-64 text-right"
          id={descriptionId}
          role="tooltip"
        >
          {hint}
        </span>
      ) : (
        <span className="sr-only" id={descriptionId}>
          {hint}
        </span>
      )}
    </span>
  );
}
