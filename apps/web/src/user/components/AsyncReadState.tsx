import { useT } from '../../i18n';
import { classifyApiError } from '../../lib/apiClient';
import { Alert, Button, Spinner } from './ui';

/**
 * One async read a surface depends on, paired with the retry that re-runs
 * exactly that read. Only reads that currently apply belong in a group — a
 * disabled query has no state to present and must never be re-run on another
 * read's behalf.
 */
export interface AsyncRead {
  error: unknown;
  /** Re-runs ONLY this read. Omit when the read has no retry of its own. */
  refetch?: () => unknown;
}

interface ResolvedAsyncReads {
  /** The failure the surface may present, or `null` when every read is fine. */
  error: unknown;
  /** Refetches the outage reads only — never a confirmed 401/403/404 read. */
  onRetry?: () => void;
}

/**
 * Collapses several concurrent reads into the single state a surface can show,
 * by failure CLASS rather than by arrival order.
 *
 * Chaining `??` over several `error`s let declaration order pick the
 * classification and forced one Retry to refetch the whole group: a 5xx sitting
 * behind a confirmed 403 lost its recovery affordance, and a confirmed 403
 * sitting behind a 5xx gained one it must never have. Here a recoverable outage
 * always wins the presentation, so recovery stays reachable, and Retry re-runs
 * only the reads currently in the outage class. Confirmed outcomes keep the
 * indistinguishable unavailable state with no retry.
 */
export function resolveAsyncReads(reads: readonly AsyncRead[]): ResolvedAsyncReads {
  const failed = reads.filter((read) => read.error != null);
  const outages = failed.filter((read) => classifyApiError(read.error) === 'outage');
  const firstOutage = outages[0];
  if (firstOutage === undefined) return { error: failed[0]?.error ?? null };

  const retryable = outages.filter((read) => read.refetch !== undefined);
  return {
    error: firstOutage.error,
    onRetry:
      retryable.length === 0
        ? undefined
        : () => {
            for (const read of retryable) void read.refetch?.();
          },
  };
}

interface AsyncReadStatePresentation {
  loading: boolean;
  compact?: boolean;
  loadingLabel?: string;
  loadingPresentation?: 'spinner' | 'sr-only';
  unavailableLabel?: string;
  errorLabel?: string;
}

/**
 * A surface states either one read (`error`) or the group it depends on
 * (`reads`) — never a hand-collapsed error alongside a group, which is how the
 * order-dependent classification crept in.
 */
type AsyncReadStateProps = AsyncReadStatePresentation &
  (
    | { error: unknown; onRetry?: () => void; reads?: never }
    | { reads: readonly AsyncRead[]; error?: never; onRetry?: never }
  );

/**
 * Compact state for an auxiliary async read that must not erase usable sibling
 * content. Only a confirmed transport/server outage offers retry; authorization,
 * absence, and unknown failures deliberately share one terminal presentation.
 */
export function AsyncReadState(props: AsyncReadStateProps) {
  const {
    loading,
    compact = false,
    loadingLabel,
    loadingPresentation = 'spinner',
    unavailableLabel,
    errorLabel,
  } = props;
  const t = useT();

  const { error, onRetry } = props.reads
    ? resolveAsyncReads(props.reads)
    : { error: props.error, onRetry: props.onRetry };

  if (loading) {
    if (loadingPresentation === 'sr-only') {
      return (
        <span className="sr-only" role="status">
          {loadingLabel ?? t('common.loading')}
        </span>
      );
    }
    // `compact` exists so an auxiliary read cannot erase or displace usable
    // sibling content, and the error branch below honours it. Loading used to
    // fall straight through to the full Spinner, so a compact read still
    // inserted and removed a spinner row on every visit — growing and shrinking
    // the layout it was supposed to leave alone. Mirror the error branch's
    // inline shape instead of introducing a second one.
    if (compact) {
      return (
        <span className="inline-flex items-center gap-1 text-xs bt-muted" role="status">
          {loadingLabel ?? t('common.loading')}
        </span>
      );
    }
    return <Spinner label={loadingLabel} />;
  }
  if (error == null) return null;

  const outage = classifyApiError(error) === 'outage';

  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-xs bt-muted" role="alert">
        <span>
          {outage
            ? (errorLabel ?? t('common.genericError'))
            : (unavailableLabel ?? t('common.unavailable'))}
        </span>
        {outage && onRetry ? (
          <Button className="min-h-0 px-1 py-0 text-xs" variant="ghost" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </span>
    );
  }

  if (!outage) {
    return <Alert tone="info">{unavailableLabel ?? t('common.unavailable')}</Alert>;
  }

  return (
    <Alert tone="error">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{errorLabel ?? t('common.genericError')}</span>
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}
