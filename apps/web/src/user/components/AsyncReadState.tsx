import { useT } from '../../i18n';
import { classifyApiError } from '../../lib/apiClient';
import { Alert, Button, Spinner } from './ui';

interface AsyncReadStateProps {
  loading: boolean;
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
  loadingLabel?: string;
  unavailableLabel?: string;
  errorLabel?: string;
}

/**
 * Compact state for an auxiliary async read that must not erase usable sibling
 * content. Only a confirmed transport/server outage offers retry; authorization,
 * absence, and unknown failures deliberately share one terminal presentation.
 */
export function AsyncReadState({
  loading,
  error,
  onRetry,
  compact = false,
  loadingLabel,
  unavailableLabel,
  errorLabel,
}: AsyncReadStateProps) {
  const t = useT();

  if (loading) return <Spinner label={loadingLabel} />;
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
