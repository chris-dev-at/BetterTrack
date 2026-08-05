import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Toast } from '../components/ui';

export const MUTATION_FEEDBACK_DURATION_MS = 4_000;

interface MutationFeedback {
  success: (message: string) => void;
  error: (message: string) => void;
}

const NO_FEEDBACK: MutationFeedback = {
  success: () => {},
  error: () => {},
};

const MutationFeedbackContext = createContext<MutationFeedback>(NO_FEEDBACK);

/**
 * One app-wide mutation feedback channel. A new result replaces the current
 * notice and resets its timeout, so one action can never grow a toast stack.
 *
 * The no-op context default keeps focused component tests lightweight. The
 * live user app always mounts this provider; tests that exercise feedback wrap
 * the representative surface with it as well.
 */
export function MutationFeedbackProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setMessage(null);
  }, [clearTimer]);

  const show = useCallback(
    (nextMessage: string) => {
      clearTimer();
      setMessage(nextMessage);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setMessage(null);
      }, MUTATION_FEEDBACK_DURATION_MS);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const value = useMemo<MutationFeedback>(() => ({ success: show, error: show }), [show]);

  return (
    <MutationFeedbackContext.Provider value={value}>
      {children}
      {message ? <Toast onDismiss={dismiss}>{message}</Toast> : null}
    </MutationFeedbackContext.Provider>
  );
}

/** Consistent success/error feedback for mutations that finish outside their surface. */
export function useMutationFeedback(): MutationFeedback {
  return useContext(MutationFeedbackContext);
}
