import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { EDITABLE_CASH_MOVEMENT_KINDS } from '@bettertrack/contracts';
import type { CashMovement, CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { CASH_TAGS_QUERY_KEY, listCashTags } from '../../../lib/cashApi';
import { EM_DASH, formatDate } from '../../../lib/format';
import { getCashMovements } from '../../../lib/portfolioApi';
import { Alert } from '../../components/ui';
import { AsyncReadState } from '../../components/AsyncReadState';
import { EmptyState, MoneyText, Skeleton } from '../../../ui';
import { Button, PageHead } from '../../../ui/origin';
import { SourceBadge } from '../SourceBadge';
import { usePreservedSearch } from '../../components/LocalNav';
import { ACTIVE_PORTFOLIO_PARAM } from '../PortfolioSwitcher';
import { usePhoneShell } from '../../hooks/useCompactShell';
import { CashMovementTagsDialog } from './CashMovementTagsDialog';
import { RecordCashDialog } from './RecordCashDialog';
import { TagChip } from './TagChip';
import { useActivePortfolio } from './useActivePortfolio';

const UNTAGGED_FILTER = 'untagged';
const ALL_FILTER = 'all';

function kindLabel(t: TranslateFn, kind: CashMovement['kind']): string {
  return t(`portfolio.cashSources.kind.${kind}`);
}

/**
 * Can this row be corrected here? Only the three kinds a person TYPED. The
 * predicate mirrors the server's `EDITABLE_CASH_MOVEMENT_KINDS` — the server is
 * the authority and 409s a derived row regardless, so this is about not
 * offering a button that cannot work, not about enforcement.
 */
function isEditable(kind: CashMovement['kind']): boolean {
  return (EDITABLE_CASH_MOVEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The tagged cash ledger (V5 cash fusion): every movement in this portfolio,
 * newest first, with its tags as chips and inline tag editing. Reads through
 * the existing `GET /portfolios/:id/cash` (no new ledger endpoint — only
 * `movements[].tags` is new) and joins to `GET /cash/tags` client-side.
 */
export function CashMovementsPage() {
  const t = useT();
  const phone = usePhoneShell();
  const queryClient = useQueryClient();
  const { portfoliosQuery, portfolioId } = useActivePortfolio();
  const [tagFilter, setTagFilter] = useState<string>(ALL_FILTER);
  const [editing, setEditing] = useState<CashMovement | null>(null);
  const [tagging, setTagging] = useState<CashMovement | null>(null);
  const [recording, setRecording] = useState(false);
  const search = usePreservedSearch([ACTIVE_PORTFOLIO_PARAM]);
  const labelsTo = search
    ? { pathname: '/portfolio/cash/labels', search }
    : '/portfolio/cash/labels';

  const movementsQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash'],
    queryFn: ({ signal }) => getCashMovements(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });
  const tagsQuery = useQuery({
    queryKey: CASH_TAGS_QUERY_KEY,
    queryFn: ({ signal }) => listCashTags(signal),
    staleTime: 30_000,
  });

  const tags = useMemo(() => tagsQuery.data?.tags ?? [], [tagsQuery.data]);
  const tagsById = useMemo(
    () => new Map<string, CashTag>(tags.map((tag) => [tag.id, tag])),
    [tags],
  );

  const movements = movementsQuery.data?.movements ?? [];
  const ordered = useMemo(
    () =>
      [...movements]
        .filter((m) => {
          if (tagFilter === ALL_FILTER) return true;
          const movementTags = m.tags ?? [];
          if (tagFilter === UNTAGGED_FILTER) return movementTags.length === 0;
          return movementTags.includes(tagFilter);
        })
        .sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime()),
    [movements, tagFilter],
  );

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ['portfolio', portfolioId, 'cash'] });
  }

  if (portfoliosQuery.isLoading || (portfolioId !== null && movementsQuery.isLoading)) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (
    portfoliosQuery.isError ||
    portfolioId === null ||
    movementsQuery.isError ||
    !movementsQuery.data
  ) {
    return <Alert tone="error">{t('cashflow.movements.loadError')}</Alert>;
  }

  return (
    <div className="bt-money-surface flex flex-col gap-6">
      {/* Labels live one click from here on purpose: this is where you are
          standing when you notice a movement is tagged wrong, or not at all. */}
      <PageHead
        actions={
          <>
            <Link className="bt-btn" to={labelsTo}>
              {t('cashflow.movements.manageLabels')}
            </Link>
            <Button onClick={() => setRecording(true)} variant="primary">
              {t('cashflow.record.action')}
            </Button>
          </>
        }
        title={t('cashflow.tabs.movements')}
      />

      <AsyncReadState
        loading={tagsQuery.isLoading}
        error={tagsQuery.error}
        errorLabel={t('cashflow.movements.loadError')}
        onRetry={() => void tagsQuery.refetch()}
      />

      {tags.length > 1 ? (
        <label className="bt-meta flex items-center gap-1.5">
          {t('cashflow.movements.filterLabel')}
          <select
            className="bt-select"
            onChange={(e) => setTagFilter(e.target.value)}
            style={{ minHeight: 28, padding: '2px 26px 2px 8px', width: 'auto', fontSize: 12 }}
            value={tagFilter}
          >
            <option value={ALL_FILTER}>{t('cashflow.movements.filterAll')}</option>
            <option value={UNTAGGED_FILTER}>{t('cashflow.untagged')}</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {ordered.length === 0 ? (
        <EmptyState
          description={t('cashflow.movements.emptyDescription')}
          icon="💶"
          title={t('cashflow.movements.emptyTitle')}
        />
      ) : phone ? (
        <ul aria-label={t('cashflow.movements.listAriaLabel')} className="bt-phone-card-list">
          {ordered.map((movement) => {
            const movementTags = (movement.tags ?? [])
              .map((id) => tagsById.get(id))
              .filter((tag): tag is CashTag => tag !== undefined);
            return (
              <li className="bt-phone-card" key={movement.id}>
                <div className="bt-phone-card__head">
                  <div className="min-w-0">
                    <p className="bt-row-title break-words">{movement.note ?? EM_DASH}</p>
                    <p className="bt-row-sub flex flex-wrap items-center gap-1.5">
                      <span>{kindLabel(t, movement.kind)}</span>
                      <SourceBadge source={movement.source} />
                    </p>
                  </div>
                  <span className="shrink-0 bt-num">
                    <MoneyText amount={movement.amountEur} currency="EUR" signed />
                  </span>
                </div>
                <dl className="bt-phone-card__facts">
                  <div>
                    <dt>{t('cashflow.movements.dateColumn')}</dt>
                    <dd>{formatDate(movement.executedAt)}</dd>
                  </div>
                  <div>
                    <dt>{t('cashflow.movements.tagsColumn')}</dt>
                    <dd className="flex flex-wrap items-center gap-1">
                      {movementTags.length === 0 ? (
                        <span className="bt-muted">{t('cashflow.untagged')}</span>
                      ) : (
                        movementTags.map((tag) => (
                          <TagChip color={tag.color} key={tag.id} name={tag.name} />
                        ))
                      )}
                    </dd>
                  </div>
                  {movement.originalCurrency ? (
                    <div>
                      <dt>{t('cashflow.movements.amountColumn')}</dt>
                      <dd>
                        {t('cashflow.movements.originalCurrency', {
                          currency: movement.originalCurrency,
                        })}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <div className="bt-phone-card__actions">
                  {isEditable(movement.kind) ? (
                    <Button onClick={() => setEditing(movement)} variant="quiet">
                      {t('common.edit')}
                    </Button>
                  ) : (
                    <Button onClick={() => setTagging(movement)} variant="quiet">
                      {t('cashflow.movements.editTagsAction')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="bt-table-wrap">
          <table aria-label={t('cashflow.movements.listAriaLabel')} className="bt-table">
            <thead>
              <tr>
                <th scope="col">{t('cashflow.movements.dateColumn')}</th>
                <th scope="col">{t('cashflow.movements.kindColumn')}</th>
                <th className="is-num" scope="col">
                  {t('cashflow.movements.amountColumn')}
                </th>
                <th scope="col">{t('cashflow.movements.tagsColumn')}</th>
                <th scope="col">{t('cashflow.movements.noteColumn')}</th>
                <th
                  aria-label={t('portfolio.cashSources.actionsColumn')}
                  className="is-num"
                  scope="col"
                />
              </tr>
            </thead>
            <tbody>
              {ordered.map((m) => {
                const movementTags = (m.tags ?? [])
                  .map((id) => tagsById.get(id))
                  .filter((tag): tag is CashTag => tag !== undefined);
                return (
                  <tr key={m.id}>
                    <td className="bt-muted whitespace-nowrap">{formatDate(m.executedAt)}</td>
                    <td className="bt-muted">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span>{kindLabel(t, m.kind)}</span>
                        <SourceBadge source={m.source} />
                      </span>
                    </td>
                    <td className="is-num">
                      <MoneyText amount={m.amountEur} currency="EUR" signed />
                      {m.originalCurrency ? (
                        <span className="bt-meta ml-1">
                          {t('cashflow.movements.originalCurrency', {
                            currency: m.originalCurrency,
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {movementTags.length === 0 ? (
                        <span className="bt-muted">{t('cashflow.untagged')}</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1">
                          {movementTags.map((tag) => (
                            <TagChip color={tag.color} key={tag.id} name={tag.name} />
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="bt-muted max-w-[12rem] truncate" title={m.note ?? undefined}>
                      {m.note ?? EM_DASH}
                    </td>
                    {/* A hand-entered row opens the full editor — amount, date,
                        account, direction, note and tags. A DERIVED row (a
                        trade's cash leg, a dividend, a tax settlement, a
                        transfer) has no financial edit: it follows its parent,
                        so only its labels are the user's to change here. */}
                    <td className="is-num">
                      {isEditable(m.kind) ? (
                        <Button onClick={() => setEditing(m)} size="sm" variant="quiet">
                          {t('common.edit')}
                        </Button>
                      ) : (
                        <Button onClick={() => setTagging(m)} size="sm" variant="quiet">
                          {t('cashflow.movements.editTagsAction')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {recording ? (
        <RecordCashDialog onClose={() => setRecording(false)} portfolioId={portfolioId} />
      ) : null}

      {editing ? (
        <RecordCashDialog
          movement={editing}
          onClose={() => setEditing(null)}
          portfolioId={portfolioId}
        />
      ) : null}

      {tagging ? (
        <CashMovementTagsDialog
          movementId={tagging.id}
          onClose={() => setTagging(null)}
          onSaved={refetchAll}
          selectedTagIds={tagging.tags ?? []}
          tags={tags}
        />
      ) : null}
    </div>
  );
}
