import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { CashMovement, CashSource } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EM_DASH, formatDate, formatPercent } from '../../lib/format';
import {
  archiveCashSource,
  getCashMovements,
  listCashSources,
  listPortfolios,
  restoreCashSource,
} from '../../lib/portfolioApi';
import { Alert, Button, cx } from '../components/ui';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';
import { activeSources, sortSourcesMainFirst } from './cashSourceUtils';
import { CashDialog } from './CashDialog';
import { CashSourceDialog } from './CashSourceDialog';
import { SetBalanceDialog } from './SetBalanceDialog';
import { TransferDialog } from './TransferDialog';

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
}) {
  const t = useT();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = source.archivedAt !== null;
  const share = totalActive > 0 && !archived ? (source.balanceEur / totalActive) * 100 : null;
  const canArchive = !source.isMain && !archived && Math.abs(source.balanceEur) < 0.005;

  return (
    <tr className={cx('border-b border-neutral-800 last:border-b-0', archived && 'opacity-60')}>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-neutral-100">{source.name}</span>
          {source.isMain ? (
            <span className="rounded bg-sky-900/50 px-1.5 py-0.5 text-xs font-medium text-sky-300">
              {t('portfolio.cashSources.mainBadge')}
            </span>
          ) : null}
          {archived ? (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs font-medium text-neutral-400">
              {t('portfolio.cashSources.archivedBadge')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-3 text-neutral-400">{typeLabel(t, source)}</td>
      <td className="px-3 py-3 text-right">
        <MoneyText amount={source.balanceEur} currency="EUR" />
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-neutral-400">
        {share !== null ? formatPercent(share) : EM_DASH}
      </td>
      <td className="px-3 py-3 text-right">
        {archived ? (
          <button
            type="button"
            onClick={onRestore}
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-sky-400 hover:bg-neutral-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {t('portfolio.cashSources.restoreAction')}
          </button>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
            <button
              type="button"
              onClick={onDeposit}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sky-400 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <DepositIcon />
              {t('portfolio.cashSources.depositButton')}
            </button>
            <button
              type="button"
              onClick={onWithdraw}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sky-400 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <WithdrawIcon />
              {t('portfolio.cashSources.withdrawButton')}
            </button>
            <button
              type="button"
              onClick={onSetBalance}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <SetBalanceIcon />
              {t('portfolio.cashSources.setBalanceAction')}
            </button>
            {!source.isMain ? (
              <button
                type="button"
                onClick={onRename}
                className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                {t('portfolio.cashSources.renameAction')}
              </button>
            ) : null}
            {canArchive ? (
              confirmArchive ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-neutral-400">
                    {t('portfolio.cashSources.archiveConfirm')}
                  </span>
                  <button
                    type="button"
                    onClick={onArchive}
                    disabled={busy}
                    className="rounded px-1.5 py-0.5 text-red-400 hover:bg-neutral-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    {t('common.yes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmArchive(false)}
                    className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    {t('common.no')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmArchive(true)}
                  className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  {t('portfolio.cashSources.archiveAction')}
                </button>
              )
            ) : null}
          </div>
        )}
      </td>
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
  const ordered = useMemo(
    () =>
      [...movements].sort(
        (a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime(),
      ),
    [movements],
  );

  return (
    <section
      aria-label={t('portfolio.cashSources.history.heading')}
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold text-neutral-200">
        {t('portfolio.cashSources.history.heading')}
      </h2>
      {ordered.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('portfolio.cashSources.history.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
                <th scope="col" className="px-3 py-2">
                  {t('portfolio.cashSources.history.sourceColumn')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('portfolio.cashSources.history.kindColumn')}
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  {t('portfolio.cashSources.history.amountColumn')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('portfolio.cashSources.history.dateColumn')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('portfolio.cashSources.history.noteColumn')}
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((m) => (
                <tr key={m.id} className="border-b border-neutral-800 last:border-b-0">
                  <td className="px-3 py-2 text-neutral-200">
                    {sourceNames.get(m.sourceId) ?? EM_DASH}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {kindLabel(t, m.kind)}
                    {m.counterpartSourceId ? (
                      <span className="ml-1 text-neutral-500">
                        {t('portfolio.cashSources.history.counterpart', {
                          name: sourceNames.get(m.counterpartSourceId) ?? EM_DASH,
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MoneyText amount={m.amountEur} currency="EUR" signed />
                  </td>
                  <td className="px-3 py-2 text-neutral-400">{formatDate(m.executedAt)}</td>
                  <td
                    className="max-w-[12rem] truncate px-3 py-2 text-neutral-500"
                    title={m.note ?? undefined}
                  >
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
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
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
    queryFn: ({ signal }) => listCashSources(portfolioId!, showArchived, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });

  const cashQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash'],
    queryFn: ({ signal }) => getCashMovements(portfolioId!, signal),
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
    } catch {
      setActionError(t('portfolio.cashSources.actionError'));
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

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {t('portfolio.cashSources.title')}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-neutral-400">
            {t('portfolio.cashSources.subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          {active.length > 1 ? (
            <Button variant="secondary" onClick={() => setDialog({ kind: 'transfer' })}>
              <TransferIcon />
              {t('portfolio.cashSources.transferButton')}
            </Button>
          ) : null}
          <Button onClick={() => setDialog({ kind: 'create' })}>
            {t('portfolio.cashSources.addButton')}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {t('portfolio.cashSources.totalLabel')}
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-neutral-100">
          <MoneyText amount={totalActive} currency="EUR" />
        </p>
      </div>

      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      <section className="flex flex-col gap-3">
        {sources.length === 0 ? (
          <EmptyState icon="🏦" title={t('portfolio.cashSources.empty')} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table
              className="w-full text-left text-sm"
              aria-label={t('portfolio.cashSources.listAriaLabel')}
            >
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
                  <th scope="col" className="px-3 py-2">
                    {t('portfolio.cashSources.nameColumn')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('portfolio.cashSources.typeColumn')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('portfolio.cashSources.balanceColumn')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('portfolio.cashSources.shareLabel')}
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-right"
                    aria-label={t('portfolio.cashSources.actionsColumn')}
                  />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <SourceRow
                    key={s.id}
                    source={s}
                    totalActive={totalActive}
                    busy={busy}
                    onSetBalance={() => setDialog({ kind: 'setBalance', source: s })}
                    onRename={() => setDialog({ kind: 'rename', source: s })}
                    onDeposit={() => setDialog({ kind: 'deposit', sourceId: s.id })}
                    onWithdraw={() => setDialog({ kind: 'withdraw', sourceId: s.id })}
                    onArchive={() => void runAction(() => archiveCashSource(portfolioId, s.id))}
                    onRestore={() => void runAction(() => restoreCashSource(portfolioId, s.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasArchived || showArchived ? (
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="self-start text-xs text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {showArchived
              ? t('portfolio.cashSources.hideArchived')
              : t('portfolio.cashSources.showArchived')}
          </button>
        ) : null}
      </section>

      <HistorySection movements={movements} sourceNames={sourceNames} />

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
