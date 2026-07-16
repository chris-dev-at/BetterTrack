import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useT } from '../i18n';
import { reportError } from '../lib/sentry';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback UI. When omitted, a default panel with a "Try again" retry
   * button is shown.
   */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React error boundary with a retry affordance (PROJECTPLAN.md §7.1). Catches
 * render-time errors in its subtree, shows a recoverable fallback, and lets the
 * user retry by clearing the error and re-rendering children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Report render-time errors to error tracking (§13.4 V4-P5a). A no-op when
    // Sentry is disabled (no DSN), so behavior is unchanged without a DSN.
    reportError(error, { componentStack: info.componentStack });
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return <DefaultErrorFallback errorMessage={this.state.error?.message} onRetry={this.reset} />;
  }
}

/** Hook-friendly default fallback — class components can't call `useT` themselves. */
function DefaultErrorFallback({
  errorMessage,
  onRetry,
}: {
  errorMessage: string | undefined;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 rounded-lg border border-red-900 bg-red-950/40 px-6 py-8 text-center"
    >
      <p className="text-sm font-medium text-red-300">{t('common.errorTitle')}</p>
      {errorMessage ? <p className="text-xs text-neutral-500">{errorMessage}</p> : null}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {t('common.retry')}
      </button>
    </div>
  );
}
