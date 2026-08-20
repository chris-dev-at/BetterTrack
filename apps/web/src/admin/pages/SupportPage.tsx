import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { EmptyState, PageHeader } from '../components/ui';

/**
 * Support workspace landing (#1406 W1).
 *
 * The helpdesk console — threads, internal notes, tags, saved views, aging
 * indicators — is W3. Until it lands this page is honest about that and forwards
 * to the feedback inbox that already exists (#1316), so the workspace is a real
 * destination rather than a dead nav entry.
 */
export function SupportPage() {
  const t = useT();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.support.title')} description={t('admin.support.subtitle')} />

      <EmptyState>
        <p>{t('admin.support.comingSoon')}</p>
        <p className="mt-3">
          <Link
            className="text-sky-400 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            to="/admin/feedback"
          >
            {t('admin.support.openInbox')}
          </Link>
        </p>
      </EmptyState>
    </div>
  );
}
