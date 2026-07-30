import { Link, useLocation, useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import { cx } from '../lib/cx';

import { EmptyState } from './EmptyState';

export interface NotFoundStateProps {
  /** Surface-specific start destination, such as `/` or `/admin/users`. */
  homeTo: string;
  className?: string;
}

/**
 * Compact fallback for a route that no longer resolves. The pathname stays as
 * plain text so it is useful in a support request without becoming a link or
 * HTML content.
 */
export function NotFoundState({ homeTo, className }: NotFoundStateProps) {
  const t = useT();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <EmptyState
      compact
      icon="404"
      title={t('notFound.title')}
      description={t('notFound.description')}
      className={cx(
        'mx-auto max-w-md rounded-lg border border-[var(--bt-border-strong)] bg-[var(--bt-surface-strong)] px-6 shadow-sm',
        className,
      )}
      cta={
        <div className="flex flex-col items-center gap-3">
          <p className="bt-muted max-w-full break-all text-xs">
            {t('notFound.requestedPath')}{' '}
            <code className="text-[var(--bt-text-soft)]">{pathname}</code>
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link className="bt-btn bt-btn--primary" to={homeTo}>
              {t('notFound.backToStart')}
            </Link>
            <button className="bt-btn" type="button" onClick={() => navigate(-1)}>
              {t('notFound.backToPrevious')}
            </button>
          </div>
        </div>
      }
    />
  );
}
