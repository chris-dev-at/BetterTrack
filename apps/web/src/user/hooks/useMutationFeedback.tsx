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

import { ApiError } from '../../lib/apiClient';
import { Toast } from '../components/ui';

export const MUTATION_FEEDBACK_DURATION_MS = 4_000;

interface MutationFeedback {
  success: (message: string) => void;
  error: (message: string, cause?: unknown) => void;
  /**
   * Entry point for the app-wide 429 policy (§7.4), which owns the specific
   * retry copy. Deliberately outside the `error` suppression below, and sticky
   * like the standalone toast it replaced: it stays until dismissed or until a
   * newer result takes the slot.
   */
  rateLimit: (message: string) => void;
}

interface MutationNotice {
  message: string;
  tone: 'success' | 'error';
  /** Skip the auto-dismiss timeout; the notice waits for ✕ or a replacement. */
  sticky?: boolean;
}

const NO_FEEDBACK: MutationFeedback = {
  success: () => {},
  error: () => {},
  rateLimit: () => {},
};

const MutationFeedbackContext = createContext<MutationFeedback>(NO_FEEDBACK);

/**
 * One app-wide feedback channel, and the user app's ONLY `.bt-toast` renderer.
 * A new result replaces the current notice and resets its timeout, so one
 * action can never grow a toast stack.
 *
 * Single ownership is the point: `.bt-toast` is a single hard-coded fixed slot
 * with no stacking or offset logic, so a second component rendering into it
 * paints over whatever is already there and announces a second `role="alert"`.
 * Everything that wants the slot — including the global rate-limit policy, via
 * `rateLimit` — goes through this channel instead (see `RateLimitToastBridge`).
 *
 * The no-op context default keeps focused component tests lightweight. The
 * live user app always mounts this provider; tests that exercise feedback wrap
 * the representative surface with it as well.
 */
export function MutationFeedbackProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<MutationNotice | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setNotice(null);
  }, [clearTimer]);

  const show = useCallback(
    (nextNotice: MutationNotice) => {
      clearTimer();
      setNotice(nextNotice);
      if (nextNotice.sticky) return;
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setNotice(null);
      }, MUTATION_FEEDBACK_DURATION_MS);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const value = useMemo<MutationFeedback>(
    () => ({
      success: (message) => show({ message, tone: 'success' }),
      error: (message, cause) => {
        // apiRequest hands a 429 to AuthContext's global rate-limit policy
        // *before* rejecting, so that specific notice is already on its way to
        // this same slot. Suppressing the generic follow-up keeps the caller
        // from immediately overwriting "wait 30 seconds" with "try again".
        if (cause instanceof ApiError && cause.status === 429) return;
        show({ message, tone: 'error' });
      },
      rateLimit: (message) => show({ message, tone: 'error', sticky: true }),
    }),
    [show],
  );

  return (
    <MutationFeedbackContext.Provider value={value}>
      {children}
      {notice ? (
        <Toast onDismiss={dismiss} tone={notice.tone}>
          {notice.message}
        </Toast>
      ) : null}
    </MutationFeedbackContext.Provider>
  );
}

/** Consistent success/error feedback for mutations that finish outside their surface. */
export function useMutationFeedback(): MutationFeedback {
  return useContext(MutationFeedbackContext);
}
