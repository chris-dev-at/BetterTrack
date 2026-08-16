import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { ConglomerateStatus, ConglomerateSummary } from '@bettertrack/contracts';

import { listConglomerates } from '../../lib/conglomerateApi';
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Badge, Page, PageHead } from '../../ui/origin';
import { Alert, Button } from '../components/ui';

function statusLabels(t: TranslateFn): Record<ConglomerateStatus, string> {
  return {
    draft: t('workboard.conglomerates.status.draft'),
    active: t('workboard.conglomerates.status.active'),
  };
}

/**
 * What "Active" means (§6.5, §13.2 V2-P7): shared across Builder, Detail and
 * List so an owner-naive user gets the same explanation everywhere.
 */
function statusExplainers(t: TranslateFn): Record<ConglomerateStatus, string> {
  return {
    draft: t('workboard.conglomerates.statusExplainer.draft'),
    active: t('workboard.conglomerates.statusExplainer.active'),
  };
}

/** Rendered position count, correctly singular/plural in every locale. */
function positionCountLabel(t: TranslateFn, count: number): string {
  return count === 1
    ? t('workboard.conglomerates.positionCountOne', { count })
    : t('workboard.conglomerates.positionCountOther', { count });
}

export function StatusBadge({ status }: { status: ConglomerateStatus }) {
  const t = useT();
  return (
    <Badge title={statusExplainers(t)[status]} tone={status === 'active' ? 'pos' : 'neutral'}>
      {statusLabels(t)[status]}
    </Badge>
  );
}

/**
 * The V5-P6 nesting badge — marks a constituent row that is itself a
 * conglomerate. Shared by the Builder, the detail page and the shared
 * (friend) view.
 */
export function NestedBadge() {
  const t = useT();
  return (
    <Badge className="shrink-0" outline tone="blue">
      {t('workboard.conglomerates.nestedBadge')}
    </Badge>
  );
}

function ConglomerateCard({ conglomerate }: { conglomerate: ConglomerateSummary }) {
  const t = useT();
  return (
    <li>
      <Link
        to={`/workbench/blueprints/${conglomerate.id}`}
        className="bt-data-row bt-blueprint-row"
      >
        <div className="bt-data-row__main">
          <h3 className="bt-row-title truncate">{conglomerate.name}</h3>
          <p className="bt-row-sub">{positionCountLabel(t, conglomerate.positionCount)}</p>
        </div>
        <div className="bt-data-row__meta">
          <StatusBadge status={conglomerate.status} />
        </div>
      </Link>
    </li>
  );
}

function NewConglomerateCard() {
  const t = useT();
  return (
    <li>
      <Link to="/workbench/blueprints/new" className="bt-data-row bt-blueprint-row is-create">
        <span aria-hidden="true" className="bt-blueprint-row__plus">
          +
        </span>
        <span className="bt-row-title">{t('workboard.conglomerates.newCardLabel')}</span>
      </Link>
    </li>
  );
}

/**
 * `/workbench/blueprints` — the caller's Conglomerates as a card grid
 * (PROJECTPLAN.md §6.5, §7.2). The Builder (`/new`, `/:id/edit`) is a separate
 * issue; the "New Conglomerate" card links there ahead of that route landing.
 */
export function ConglomeratesListPage() {
  const t = useT();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
    staleTime: 30_000,
  });

  return (
    <Page className="bt-phone-surface bt-workboard-family bt-blueprints-page" width="narrow">
      <PageHead
        sub={t('workboard.conglomerates.subtitle')}
        title={t('workboard.conglomerates.title')}
      />

      {isLoading ? (
        <div className="bt-blueprints-skeletons">
          <Skeleton height="h-[104px]" />
          <Skeleton height="h-[104px]" />
          <Skeleton height="h-[104px]" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="error">{t('workboard.conglomerates.loadError')}</Alert>
          <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
        </div>
      ) : data!.conglomerates.length === 0 ? (
        <EmptyState
          icon="📊"
          title={t('workboard.conglomerates.emptyTitle')}
          description={t('workboard.conglomerates.emptyDescription')}
          cta={
            <Link to="/workbench/blueprints/new" className="rounded text-sm bt-link">
              {t('workboard.conglomerates.emptyCta')}
            </Link>
          }
        />
      ) : (
        <ul className="bt-surface bt-data-list">
          {data!.conglomerates.map((c) => (
            <ConglomerateCard key={c.id} conglomerate={c} />
          ))}
          <NewConglomerateCard />
        </ul>
      )}
    </Page>
  );
}
