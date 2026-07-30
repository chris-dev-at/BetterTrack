import { Component, type ReactNode } from 'react';

import { useT } from '../i18n';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback UI. When omitted, a default panel with a "Try again" retry
   * button is shown.
   */
  fallback?: ReactNode;
  /**
   * When this value changes while the boundary is showing an error, the error
   * clears and children re-render. Unlike keying the boundary itself (the old
   * shell pattern), a reset key never unmounts healthy children — route
   * transitions keep long-lived subtrees (overlays, docks) mounted.
   */
  resetKey?: unknown;
}

type ErrorBoundaryState =
  | { hasError: false; correlationId: null }
  | { hasError: true; correlationId: string };

const correlationIds = new WeakMap<object, string>();

function createCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const random = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `bt-${Date.now().toString(36)}-${random}`;
}

function correlationIdFor(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return createCorrelationId();
  }

  const existing = correlationIds.get(error);
  if (existing) return existing;

  const correlationId = createCorrelationId();
  correlationIds.set(error, correlationId);
  return correlationId;
}

/**
 * React error boundary with a retry affordance (PROJECTPLAN.md §7.1). Catches
 * render-time errors in its subtree, shows a recoverable fallback, and lets the
 * user retry by clearing the error and re-rendering children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, correlationId: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, correlationId: correlationIdFor(error) };
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ hasError: false, correlationId: null });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return <DefaultErrorFallback correlationId={this.state.correlationId} onRetry={this.reset} />;
  }
}

/** Hook-friendly default fallback — class components can't call `useT` themselves. */
function DefaultErrorFallback({
  correlationId,
  onRetry,
}: {
  correlationId: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 rounded-lg border px-6 py-8 text-center"
      // Same negative-tone recipe the shared Alert uses: a 10%-alpha wash with a
      // low-alpha border of the same hue, both derived from the semantic token.
      style={{
        background: 'var(--bt-neg-soft)',
        borderColor: 'color-mix(in srgb, var(--bt-neg) 26%, transparent)',
      }}
    >
      <p className="bt-neg text-sm font-medium">{t('common.errorTitle')}</p>
      <p className="bt-muted text-sm">{t('common.errorFallbackMessage')}</p>
      <p className="bt-muted font-mono text-xs">
        {t('common.errorCorrelationId', { id: correlationId })}
      </p>
      <button type="button" onClick={onRetry} className="bt-btn bt-btn--sm">
        {t('common.retry')}
      </button>
    </div>
  );
}
