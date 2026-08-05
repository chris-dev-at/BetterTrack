import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { CashMovement, CashSource } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { EM_DASH, formatDate, formatPercent } from '../../lib/format';
import { Alert } from '../components/ui';
import { AsyncReadState } from '../components/AsyncReadState';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Badge, Button, PageHead } from '../../ui/origin';
import { resolveActivePortfolio } from './PortfolioSwitcher';
import { useCreateIntent } from '../components/useCreateIntent';
import { ACTIVE_PORTFOLIO_PARAM, CREATE_INTENT } from '../routeParams';
import { activeSources, sortSourcesMainFirst } from './cashSourceUtils';
import { CashDialog } from './CashDialog';
import { CashSourceDialog } from './CashSourceDialog';
import { MirrorAttributionChip } from './MirrorchainPanel';
import { SetBalanceDialog } from './SetBalanceDialog';
import { SourceBadge, sourceTagLabel } from './SourceBadge';
import { TransferDialog } from './TransferDialog';
import { usePortfolioStore } from './PortfolioStoreProvider';
import { usePhoneShell } from '../hooks/useCompactShell';

/** Human label for a source's descriptive type (V3-P3). */
function typeLabel(t: TranslateFn, source: CashSource): string {
  return t(`portfolio.cashSources.type.${source.type}`);
}

/** Human label for a movement kind (V3-P3). */
function kindLabel(t: TranslateFn, kind: CashMovement['kind']): string {
  return t(`portfolio.cashSources.kind.${kind}`);
}

// ── Action iconography (inline SVG, dependency-free — matches the app house style) ─
//
// V4-P0: deposit/withdraw/transfer/set-balance carry a small icon plus the
// label ("icon+label — whichever reads better"). Icons are decorative and
// `aria-hidden`: the visible + button-labelled text stays the accessible name.

const ACTION_ICON_PROPS = {
  className: 'h-3.5 w-3.5',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function DepositIcon() {
  return (
    <svg {...ACTION_ICON_PROPS}>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function WithdrawIcon() {
  return (
    <svg {...ACTION_ICON_PROPS}>
      <path d="M12 20V9" />
      <path d="M7 14l5-5 5 5" />
      <path d="M5 4h14" />
    </svg>
  );
}

function TransferIcon() {
  return (
    <svg {...ACTION_ICON_PROPS}>
      <path d="M6 8h12" />
      <path d="M15 5l3 3-3 3" />
      <path d="M18 16H6" />
      <path d="M9 13l-3 3 3 3" />
    </svg>
  );
}

function SetBalanceIcon() {
  return (
    <svg {...ACTION_ICON_PROPS}>
      <path d="M4 12h6" />
      <path d="M14 12h6" />
      <path d="M12 5v14" />
    </svg>
  );
}

// ─── Dialog state ─────────────────────────────────────────────────────────────

type DialogState =
  | { kind: 'create' }
  | { kind: 'rename'; source: CashSource }
  | { kind: 'setBalance'; source: CashSource }
  | { kind: 'transfer' }
  | { kind: 'deposit'; sourceId: string }
  | { kind: 'withdraw'; sourceId: string };

// ─── Sources table ──────────────────────────────────────────────────────────

function SourceRow({
  source,
  totalActive,
  onSetBalance,
  onRename,
  onDeposit,
  onWithdraw,
  onArchive,
  onRestore,
  busy,
  phone,
}: {
  source: CashSource;
  totalActive: number;
  onSetBalance: () => void;
  onRename: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onArchive: () => void;
  onRestore: () => void;
  busy: boolean;
  phone: boolean;
}) {
  const t = useT();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = source.archivedAt !== null;
  const share = totalActive > 0 && !archived ? (source.balanceEur / totalActive) * 100 : null;
  const canArchive = !source.isMain && !archived && Math.abs(source.balanceEur) < 0.005;

  const actions = archived ? (
    <Button disabled={busy} onClick={onRestore} size="sm" variant="quiet">
      {t('portfolio.cashSources.restoreAction')}
    </Button>
  ) : (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button onClick={onDeposit} size="sm" variant="quiet">
        <DepositIcon />
        {t('portfolio.cashSources.depositButton')}
      </Button>
      <Button onClick={onWithdraw} size="sm" variant="quiet">
        <WithdrawIcon />
        {t('portfolio.cashSources.withdrawButton')}
      </Button>
      <Button onClick={onSetBalance} size="sm" variant="quiet">
        <SetBalanceIcon />
        {t('portfolio.cashSources.setBalanceAction')}
      </Button>
      {!source.isMain ? (
        <Button onClick={onRename} size="sm" variant="quiet">
          {t('portfolio.cashSources.renameAction')}
        </Button>
      ) : null}
      {canArchive ? (
        confirmArchive ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-1">
            <span className="bt-muted">{t('portfolio.cashSources.archiveConfirm')}</span>
            <Button disabled={busy} onClick={onArchive} size="sm" variant="danger">
              {t('common.yes')}
            </Button>
            <Button onClick={() => setConfirmArchive(false)} size="sm" variant="quiet">
              {t('common.no')}
            </Button>
          </span>
        ) : (
          <Button onClick={() => setConfirmArchive(true)} size="sm" variant="quiet">
            {t('portfolio.cashSources.archiveAction')}
          </Button>
        )
      ) : null}
    </div>
  );

  if (phone) {
    return (
      <li className={cx('bt-phone-card', archived && 'opacity-60')}>
        <div className="bt-phone-card__head">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="bt-row-title break-words">{source.name}</span>
            {source.isMain ? <Badge>{t('portfolio.cashSources.mainBadge')}</Badge> : null}
            {archived ? <Badge>{t('portfolio.cashSources.archivedBadge')}</Badge> : null}
            {source.mirror ? <MirrorAttributionChip attribution={source.mirror.addedBy} /> : null}
          </div>
          <span className="shrink-0 bt-num">
            <MoneyText amount={source.balanceEur} currency="EUR" />
          </span>
        </div>
        <dl className="bt-phone-card__facts">
          <div>
            <dt>{t('portfolio.cashSources.typeColumn')}</dt>
            <dd>{typeLabel(t, source)}</dd>
          </div>
          <div>
            <dt>{t('portfolio.cashSources.shareLabel')}</dt>
            <dd>{share !== null ? formatPercent(share) : EM_DASH}</dd>
          </div>
        </dl>
        <div className="bt-phone-card__actions">{actions}</div>
      </li>
    );
  }

  return (
    <tr className={archived ? 'opacity-60' : undefined}>
      <td>
        <div className="flex items-center gap-2">
          <span className="bt-row-title">{source.name}</span>
          {source.isMain ? <Badge>{t('portfolio.cashSources.mainBadge')}</Badge> : null}
          {archived ? <Badge>{t('portfolio.cashSources.archivedBadge')}</Badge> : null}
          {source.mirror ? <MirrorAttributionChip attribution={source.mirror.addedBy} /> : null}
        </div>
      </td>
      <td className="bt-muted">{typeLabel(t, source)}</td>
      <td className="is-num">
        <MoneyText amount={source.balanceEur} currency="EUR" />
      </td>
      <td className="is-num bt-muted">{share !== null ? formatPercent(share) : EM_DASH}</td>
      <td className="is-num">{actions}</td>
    </tr>
  );
}

// ─── Movement history ─────────────────────────────────────────────────────────

function HistorySection({
  movements,
  sourceNames,
}: {
  movements: CashMovement[];
  sourceNames: Map<string, string>;
}) {
  const t = useT();
  const phone = usePhoneShell();
  // Source-tag filter (V5-P0c): folded into the history header, and only shown
  // when the ledger actually mixes sources (anti-bloat — a pure `manual` ledger
  // never sees it). Filtering is client-side over the already-loaded movements.
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const sourceTags = useMemo(() => {
    const tags = new Set<string>();
    for (const m of movements) tags.add(m.source);
    return [...tags].sort();
  }, [movements]);
  const ordered = useMemo(
    () =>
      [...movements]
        .filter((m) => sourceFilter === 'all' || m.source === sourceFilter)
        .sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime()),
    [movements, sourceFilter],
  );
  const showFilter = sourceTags.length > 1;

  return (
    <section aria-label={t('portfolio.cashSources.history.heading')} className="bt-section">
      <div className="bt-section__head">
        <h2 className="bt-h2">{t('portfolio.cashSources.history.heading')}</h2>
        {showFilter ? (
          <label className="bt-meta flex items-center gap-1.5">
            {t('portfolio.sourceTag.filterLabel')}
            <select
              className="bt-select"
              onChange={(e) => setSourceFilter(e.target.value)}
              style={{ minHeight: 28, padding: '2px 26px 2px 8px', width: 'auto', fontSize: 12 }}
              value={sourceFilter}
            >
              <option value="all">{t('portfolio.sourceTag.filterAll')}</option>
              {sourceTags.map((tag) => (
                <option key={tag} value={tag}>
                  {sourceTagLabel(t, tag) ?? t('portfolio.sourceTag.manual')}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {ordered.length === 0 ? (
        <p className="bt-meta" style={{ padding: '10px 0' }}>
          {t('portfolio.cashSources.history.empty')}
        </p>
      ) : phone ? (
        <ul className="bt-phone-card-list">
          {ordered.map((movement) => (
            <li className="bt-phone-card" key={movement.id}>
              <div className="bt-phone-card__head">
                <div className="min-w-0">
                  <p className="bt-row-title break-words">
                    {sourceNames.get(movement.sourceId) ?? EM_DASH}
                  </p>
                  <p className="bt-row-sub flex flex-wrap items-center gap-1.5">
                    <span>{kindLabel(t, movement.kind)}</span>
                    <SourceBadge source={movement.source} />
                    {movement.mirror ? (
                      <MirrorAttributionChip attribution={movement.mirror.addedBy} />
                    ) : null}
                  </p>
                </div>
                <span className="shrink-0 bt-num">
                  <MoneyText amount={movement.amountEur} currency="EUR" signed />
                </span>
              </div>
              <dl className="bt-phone-card__facts">
                <div>
                  <dt>{t('portfolio.cashSources.history.dateColumn')}</dt>
                  <dd>{formatDate(movement.executedAt)}</dd>
                </div>
                <div>
                  <dt>{t('portfolio.cashSources.history.noteColumn')}</dt>
                  <dd>{movement.note ?? EM_DASH}</dd>
                </div>
                {movement.counterpartSourceId ? (
                  <div>
                    <dt>{t('portfolio.cashSources.history.kindColumn')}</dt>
                    <dd>
                      {t('portfolio.cashSources.history.counterpart', {
                        name: sourceNames.get(movement.counterpartSourceId) ?? EM_DASH,
                      })}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <div className="bt-table-wrap">
          <table className="bt-table">
            <thead>
              <tr>
                <th scope="col">{t('portfolio.cashSources.history.sourceColumn')}</th>
                <th scope="col">{t('portfolio.cashSources.history.kindColumn')}</th>
                <th className="is-num" scope="col">
                  {t('portfolio.cashSources.history.amountColumn')}
                </th>
                <th scope="col">{t('portfolio.cashSources.history.dateColumn')}</th>
                <th scope="col">{t('portfolio.cashSources.history.noteColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((m) => (
                <tr key={m.id}>
                  <td className="bt-soft">{sourceNames.get(m.sourceId) ?? EM_DASH}</td>
                  <td className="bt-muted">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span>{kindLabel(t, m.kind)}</span>
                      <SourceBadge source={m.source} />
                      {m.mirror ? <MirrorAttributionChip attribution={m.mirror.addedBy} /> : null}
                    </span>
                    {m.counterpartSourceId ? (
                      <span className="bt-muted ml-1">
                        {t('portfolio.cashSources.history.counterpart', {
                          name: sourceNames.get(m.counterpartSourceId) ?? EM_DASH,
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className="is-num">
                    <MoneyText amount={m.amountEur} currency="EUR" signed />
                  </td>
                  <td className="bt-muted">{formatDate(m.executedAt)}</td>
                  <td className="bt-muted max-w-[12rem] truncate" title={m.note ?? undefined}>
                    {m.note ?? EM_DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Cash-sources management surface (PROJECTPLAN.md §13.3 V3-P3). Lists every cash
 * source with its balance, type and liquidity share; hosts create / rename /
 * archive, per-source deposit/withdraw and set-balance, transfers between two
 * sources, and the combined movement history where a transfer's paired legs both
 * appear. The Net-Worth roll-up on the overview already sums all sources; this
 * page is where the split lives.
 */
export function CashSourcesPage() {
  const t = useT();
  const phone = usePhoneShell();
  const store = usePortfolioStore();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The shell and command palette both advertise this destination as a create
  // action; this opens the real transfer flow when they do.
  useCreateIntent(CREATE_INTENT.transfer, () => setDialog({ kind: 'transfer' }));

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });

  const activeParam = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const portfolio = useMemo(
    () => resolveActivePortfolio(portfoliosQuery.data?.portfolios ?? [], activeParam),
    [portfoliosQuery.data, activeParam],
  );
  const portfolioId = portfolio?.id ?? null;

  const sourcesQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash-sources', showArchived],
    queryFn: ({ signal }) => store.listCashSources(portfolioId!, showArchived, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });

  const cashQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash'],
    queryFn: ({ signal }) => store.getCashMovements(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });

  function refetchAll() {
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  }

  async function runAction(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      refetchAll();
    } catch (err) {
      // MIRRORCHAIN §3 stale-edit surface (V5-P7 M5): archive/restore on a chain
      // source send `baseSeq` and the server refuses with `409 MIRROR_CONFLICT`
      // (or `MIRROR_ROW_DELETED`) if another member changed the source first —
      // tell the user to refresh instead of a generic "please try again".
      if (
        err instanceof ApiError &&
        (err.code === 'MIRROR_CONFLICT' || err.code === 'MIRROR_ROW_DELETED')
      ) {
        setActionError(
          err.code === 'MIRROR_ROW_DELETED'
            ? t('portfolio.cashSources.mirrorRowDeleted')
            : t('portfolio.cashSources.mirrorConflict'),
        );
      } else {
        setActionError(t('portfolio.cashSources.actionError'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (portfoliosQuery.isLoading || (portfolioId !== null && sourcesQuery.isLoading)) {
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
    sourcesQuery.isError ||
    !sourcesQuery.data
  ) {
    return <Alert tone="error">{t('portfolio.cashSources.loadError')}</Alert>;
  }

  const sources = sortSourcesMainFirst(sourcesQuery.data.sources);
  const active = activeSources(sources);
  const totalActive = active.reduce((sum, s) => sum + s.balanceEur, 0);
  const movements = cashQuery.data?.movements ?? [];
  // Names come from the movements payload's source list (archived included) so a
  // historical leg always resolves, even for a source hidden from the active list.
  const sourceNames = new Map<string, string>(
    (cashQuery.data?.sources ?? sources).map((s) => [s.id, s.name]),
  );
  const hasArchived = sources.some((s) => s.archivedAt !== null);

  function renderSource(source: CashSource, phoneLayout: boolean) {
    return (
      <SourceRow
        key={source.id}
        source={source}
        totalActive={totalActive}
        busy={busy}
        phone={phoneLayout}
        onSetBalance={() => setDialog({ kind: 'setBalance', source })}
        onRename={() => setDialog({ kind: 'rename', source })}
        onDeposit={() => setDialog({ kind: 'deposit', sourceId: source.id })}
        onWithdraw={() => setDialog({ kind: 'withdraw', sourceId: source.id })}
        onArchive={() =>
          void runAction(() =>
            store.archiveCashSource(portfolioId!, source.id, {
              baseSeq: source.mirror?.version,
            }),
          )
        }
        onRestore={() =>
          void runAction(() =>
            store.restoreCashSource(portfolioId!, source.id, {
              baseSeq: source.mirror?.version,
            }),
          )
        }
      />
    );
  }

  return (
    <div className="bt-money-surface flex flex-col">
      <PageHead
        actions={
          <>
            {active.length > 1 ? (
              <Button onClick={() => setDialog({ kind: 'transfer' })}>
                <TransferIcon />
                {t('portfolio.cashSources.transferButton')}
              </Button>
            ) : null}
            <Button onClick={() => setDialog({ kind: 'create' })} variant="primary">
              {t('portfolio.cashSources.addButton')}
            </Button>
          </>
        }
        title={t('portfolio.cashSources.title')}
      />

      <div>
        <p className="bt-label">{t('portfolio.cashSources.totalLabel')}</p>
        <p className="bt-num" style={{ marginTop: 4, fontSize: 24, fontWeight: 630 }}>
          <MoneyText amount={totalActive} currency="EUR" />
        </p>
      </div>

      <section className="bt-section flex flex-col gap-3">
        {actionError ? <Alert tone="error">{actionError}</Alert> : null}
        {sources.length === 0 ? (
          <EmptyState icon="🏦" title={t('portfolio.cashSources.empty')} />
        ) : phone ? (
          <ul aria-label={t('portfolio.cashSources.listAriaLabel')} className="bt-phone-card-list">
            {sources.map((source) => renderSource(source, true))}
          </ul>
        ) : (
          <div className="bt-table-wrap">
            <table aria-label={t('portfolio.cashSources.listAriaLabel')} className="bt-table">
              <thead>
                <tr>
                  <th scope="col">{t('portfolio.cashSources.nameColumn')}</th>
                  <th scope="col">{t('portfolio.cashSources.typeColumn')}</th>
                  <th className="is-num" scope="col">
                    {t('portfolio.cashSources.balanceColumn')}
                  </th>
                  <th className="is-num" scope="col">
                    {t('portfolio.cashSources.shareLabel')}
                  </th>
                  <th
                    aria-label={t('portfolio.cashSources.actionsColumn')}
                    className="is-num"
                    scope="col"
                  />
                </tr>
              </thead>
              <tbody>{sources.map((source) => renderSource(source, false))}</tbody>
            </table>
          </div>
        )}

        {hasArchived || showArchived ? (
          <button
            className="bt-link self-start"
            onClick={() => setShowArchived((v) => !v)}
            style={{ fontSize: 12.5, background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
            type="button"
          >
            {showArchived
              ? t('portfolio.cashSources.hideArchived')
              : t('portfolio.cashSources.showArchived')}
          </button>
        ) : null}
      </section>

      <AsyncReadState
        loading={cashQuery.isLoading}
        error={cashQuery.error}
        errorLabel={t('portfolio.cashSources.loadError')}
        onRetry={() => void cashQuery.refetch()}
      />
      {!cashQuery.isLoading && !cashQuery.error ? (
        <HistorySection movements={movements} sourceNames={sourceNames} />
      ) : null}

      {dialog?.kind === 'create' ? (
        <CashSourceDialog
          portfolioId={portfolioId}
          onClose={() => setDialog(null)}
          onSaved={refetchAll}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <CashSourceDialog
          portfolioId={portfolioId}
          source={dialog.source}
          onClose={() => setDialog(null)}
          onSaved={refetchAll}
        />
      ) : null}
      {dialog?.kind === 'setBalance' ? (
        <SetBalanceDialog
          portfolioId={portfolioId}
          source={dialog.source}
          onClose={() => setDialog(null)}
          onSubmitted={refetchAll}
        />
      ) : null}
      {dialog?.kind === 'transfer' ? (
        <TransferDialog
          portfolioId={portfolioId}
          sources={sources}
          onClose={() => setDialog(null)}
          onSubmitted={refetchAll}
        />
      ) : null}
      {dialog?.kind === 'deposit' || dialog?.kind === 'withdraw' ? (
        <CashDialog
          portfolioId={portfolioId}
          initialKind={dialog.kind === 'deposit' ? 'deposit' : 'withdrawal'}
          sources={sources}
          initialSourceId={dialog.sourceId}
          onClose={() => setDialog(null)}
          onSubmitted={refetchAll}
        />
      ) : null}
    </div>
  );
}
