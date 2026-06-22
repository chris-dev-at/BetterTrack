import { Component, type ErrorInfo, type ReactNode } from 'react';

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

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally silent — a future monitoring integration can hook in here.
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-4 rounded-lg border border-red-900 bg-red-950/40 px-6 py-8 text-center"
      >
        <p className="text-sm font-medium text-red-300">Something went wrong.</p>
        {this.state.error?.message ? (
          <p className="text-xs text-neutral-500">{this.state.error.message}</p>
        ) : null}
        <button
          type="button"
          onClick={this.reset}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Try again
        </button>
      </div>
    );
  }
}
