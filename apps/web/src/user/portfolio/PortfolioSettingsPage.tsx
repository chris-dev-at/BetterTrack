import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { Skeleton } from '../../ui';
import { Button, Field, Input, PageHead, SectionHead } from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { AsyncReadState } from '../components/AsyncReadState';
import { Alert, cx } from '../components/ui';
import { ConvertChainDialog, MemberSheet, MirrorInviteStepDialog } from './MirrorchainPanel';
import { PortfolioIconChip } from './PortfolioIconChip';
import { PortfolioTaxSection } from './PortfolioTaxSection';
import {
  ACTIVE_PORTFOLIO_PARAM,
  promotedDefaultName,
  rememberActivePortfolio,
  resolveActivePortfolio,
} from './PortfolioSwitcher';
import { PORTFOLIO_KINDS, PORTFOLIO_KIND_ICONS, usePortfolioKind } from './portfolioKinds';
import { usePortfolioStore } from './PortfolioStoreProvider';
import { isVaultedPortfolio } from './lockedPortfolio';
import { NormalModeOnly } from '../vault/ui/ParanoidSurfaceGate';
import { PortfolioVaultSection } from '../vault/ui/PortfolioVaultSection';

/**
 * Portfolio settings — the Settings tab of the portfolio workspace
 * (PROJECTPLAN.md §6.8; PRODUCT_BLUEPRINT.md §4). Everything that *changes* a
 * portfolio rather than *views* it lives here, absorbed out of the switcher
 * dropdown and out of the overview header:
 *
 *   • General — rename, and the Icon (internally the *kind*) that colours and
 *     marks this portfolio everywhere it appears.
 *   • Tax — this portfolio's tax mode: inherited from the account default or
 *     overridden here (issue #636). The Tax tab reports; this decides.
 *   • Group portfolio — the MIRRORCHAIN convert entry point (V5-P7 M5, design
 *     §11) that used to sit as a standing CTA on the overview header, or the
 *     member sheet once the portfolio already is a synced copy.
 *   • Archived — restore a soft-archived portfolio.
 *   • Danger zone — archive (soft, restorable) and delete (permanent,
 *     type-to-confirm, the #362 account-deletion pattern).
 *
 * It resolves the active portfolio exactly like every other tab: the
 * `?portfolio=` routing param through {@link resolveActivePortfolio}.
 */

export function PortfolioSettingsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const store = usePortfolioStore();
  const [searchParams, setSearchParams] = useSearchParams();

  const [name, setName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<PortfolioSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PortfolioSummary | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [memberSheetOpen, setMemberSheetOpen] = useState(false);
  // After Convert succeeds, jump straight to the friend-picker invite step
  // (§4/§11 zero-config AC) — NOT the full member sheet.
  const [inviteChainId, setInviteChainId] = useState<string | null>(null);

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = useMemo(() => portfoliosQuery.data?.portfolios ?? [], [portfoliosQuery.data]);

  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const portfolio = useMemo(() => resolveActivePortfolio(portfolios, param), [portfolios, param]);
  const portfolioId = portfolio?.id ?? null;
  const [kind, setKind] = usePortfolioKind(portfolio);

  // The archived list only matters here, so it is fetched with the page.
  const archivedQuery = useQuery({
    queryKey: ['portfolios', 'archived'],
    queryFn: ({ signal }) => store.listPortfolios(signal, true),
    staleTime: 60_000,
  });
  const archived = (archivedQuery.data?.portfolios ?? []).filter(
    (portfolio) => portfolio.archivedAt !== null && !isVaultedPortfolio(portfolio),
  );

  // Seed the rename field from the resolved portfolio, and re-seed whenever the
  // active portfolio changes — but never clobber an edit in progress.
  useEffect(() => {
    if (!nameDirty) setName(portfolio?.name ?? '');
  }, [portfolio?.id, portfolio?.name, nameDirty]);

  const refetchLists = () => {
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  /**
   * The archived/deleted portfolio is no longer selectable: drop the routing
   * param AND the session-sticky memory of it, so the view falls through to the
   * (auto-promoted) default instead of pointing at something gone.
   */
  function forgetActive() {
    rememberActivePortfolio(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(ACTIVE_PORTFOLIO_PARAM);
        return next;
      },
      { replace: true },
    );
  }

  const renameMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) =>
      store.updatePortfolio(id, { name: next }),
    onSuccess: () => {
      setActionError(null);
      setNameDirty(false);
      setSaved(true);
      refetchLists();
    },
    onError: (err) => {
      setSaved(false);
      setActionError(
        err instanceof ApiError && err.code === 'PORTFOLIO_NAME_TAKEN'
          ? t('portfolio.switcher.nameTakenError')
          : t('portfolio.switcher.renameError'),
      );
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => store.archivePortfolio(id),
    onSuccess: (_res, id) => {
      setActionError(null);
      setConfirmArchive(null);
      if (portfolioId === id) forgetActive();
      refetchLists();
      void queryClient.invalidateQueries({ queryKey: ['portfolios', 'archived'] });
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'LAST_ACTIVE_PORTFOLIO'
          ? err.message
          : t('portfolio.switcher.archiveError'),
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => store.deletePortfolio(id),
    onSuccess: (_res, id) => {
      setActionError(null);
      setConfirmDelete(null);
      if (portfolioId === id) forgetActive();
      refetchLists();
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'LAST_ACTIVE_PORTFOLIO'
          ? err.message
          : t('portfolio.switcher.deleteError'),
      ),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => store.restorePortfolio(id),
    onSuccess: () => {
      setActionError(null);
      refetchLists();
      void queryClient.invalidateQueries({ queryKey: ['portfolios', 'archived'] });
    },
    onError: () => setActionError(t('portfolio.switcher.restoreError')),
  });

  if (portfoliosQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (portfoliosQuery.isError || portfolio === null) {
    return <Alert tone="error">{t('portfolio.settings.loadError')}</Alert>;
  }

  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && trimmed.length <= 120;
  const nameChanged = trimmed !== portfolio.name;
  const onlyOneActive = portfolios.length <= 1;

  return (
    <div className="bt-money-surface flex flex-col">
      <PageHead title={t('portfolio.settings.title')} />

      {/* ── General ─────────────────────────────────────────────────────── */}
      <section aria-label={t('portfolio.settings.generalHeading')} className="bt-section">
        <SectionHead title={t('portfolio.settings.generalHeading')} />
        <form
          className="bt-settings-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (nameValid && nameChanged && !renameMutation.isPending) {
              renameMutation.mutate({ id: portfolio.id, next: trimmed });
            }
          }}
        >
          <Field
            className="bt-settings-row__field"
            htmlFor="bt-portfolio-name"
            label={t('portfolio.switcher.nameLabel')}
          >
            <Input
              id="bt-portfolio-name"
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setNameDirty(true);
                setSaved(false);
                setActionError(null);
              }}
              value={name}
            />
          </Field>
          <Button
            disabled={!nameValid || !nameChanged || renameMutation.isPending}
            type="submit"
            variant="primary"
          >
            {renameMutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </form>
        {saved ? <p className="bt-meta">{t('portfolio.settings.nameSaved')}</p> : null}

        <div className="bt-settings-block">
          <p className="bt-label">{t('portfolio.settings.iconLabel')}</p>
          <div
            aria-label={t('portfolio.settings.iconPickerAriaLabel')}
            className="bt-kind-picker"
            role="radiogroup"
          >
            {PORTFOLIO_KINDS.map((option) => (
              <button
                aria-checked={option === kind}
                className={cx('bt-kind-option', option === kind && 'is-active')}
                key={option}
                onClick={() => setKind(option)}
                role="radio"
                type="button"
              >
                <PortfolioIconChip icon={PORTFOLIO_KIND_ICONS[option]} tint={option} />
                <span>{t(`portfolio.kinds.${option}`)}</span>
              </button>
            ))}
          </div>
          <p className="bt-meta">{t('portfolio.settings.iconHint')}</p>
        </div>
      </section>

      {/* ── Tax (issue #636) ────────────────────────────────────────────── */}
      <section aria-label={t('portfolio.settings.taxHeading')} className="bt-section">
        <SectionHead title={t('portfolio.settings.taxHeading')} />
        <PortfolioTaxSection portfolioId={portfolio.id} />
      </section>

      {/* ── Group portfolio (MIRRORCHAIN) ───────────────────────────────── */}
      <NormalModeOnly>
        <section aria-label={t('portfolio.settings.groupHeading')} className="bt-section">
          <SectionHead title={t('portfolio.settings.groupHeading')} />
          {portfolio.mirror ? (
            <div className="bt-settings-row">
              <p className="bt-row-title">
                {t('portfolio.settings.groupActive', {
                  name: portfolio.mirror.chainName,
                  count: portfolio.mirror.memberCount,
                })}
              </p>
              <Button onClick={() => setMemberSheetOpen(true)}>
                {t('portfolio.settings.manageGroup')}
              </Button>
            </div>
          ) : (
            <div className="bt-settings-row">
              <p className="bt-meta">{t('portfolio.settings.groupHint')}</p>
              <Button onClick={() => setConvertOpen(true)}>
                {t('mirrorchain.actions.makeGroup')}
              </Button>
            </div>
          )}
        </section>
      </NormalModeOnly>

      {/* ── Private vault (§9 move-in) ──────────────────────────────────── */}
      <PortfolioVaultSection onMoved={refetchLists} portfolio={portfolio} />

      {/* ── Archived ────────────────────────────────────────────────────── */}
      <section aria-label={t('portfolio.switcher.archivedDialogTitle')} className="bt-section">
        <SectionHead title={t('portfolio.switcher.archivedDialogTitle')} />
        {archivedQuery.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton height="h-10" />
            <Skeleton height="h-10" />
          </div>
        ) : archivedQuery.isError ? (
          <AsyncReadState
            loading={archivedQuery.isLoading}
            error={archivedQuery.error}
            onRetry={() => void archivedQuery.refetch()}
          />
        ) : archived.length === 0 ? (
          <p className="bt-meta">{t('portfolio.switcher.noArchived')}</p>
        ) : (
          <ul className="bt-panel bt-band">
            {archived.map((p) => (
              <li className="bt-band__row bt-settings-row" key={p.id}>
                <span className="bt-row-title truncate">{p.name}</span>
                <Button
                  disabled={restoreMutation.isPending}
                  onClick={() => restoreMutation.mutate(p.id)}
                  size="sm"
                >
                  {t('portfolio.switcher.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Danger zone ─────────────────────────────────────────────────── */}
      <section aria-label={t('portfolio.settings.dangerHeading')} className="bt-section">
        <SectionHead title={t('portfolio.settings.dangerHeading')} />
        <div className="bt-panel bt-band bt-danger-zone">
          <div className="bt-band__row bt-settings-row">
            <div>
              <p className="bt-row-title">{t('portfolio.settings.archiveAction')}</p>
              <p className="bt-row-sub">{t('portfolio.settings.archiveHint')}</p>
            </div>
            <Button
              disabled={onlyOneActive}
              onClick={() => {
                setActionError(null);
                setConfirmArchive(portfolio);
              }}
              title={onlyOneActive ? t('portfolio.switcher.archiveDisabledHint') : undefined}
            >
              {t('portfolio.settings.archiveAction')}
            </Button>
          </div>
          <div className="bt-band__row bt-settings-row">
            <div>
              <p className="bt-row-title">{t('portfolio.settings.deleteAction')}</p>
              <p className="bt-row-sub">{t('portfolio.settings.deleteHint')}</p>
            </div>
            <Button
              disabled={onlyOneActive}
              onClick={() => {
                setActionError(null);
                setConfirmDelete(portfolio);
              }}
              title={onlyOneActive ? t('portfolio.switcher.deleteDisabledHint') : undefined}
              variant="danger"
            >
              {t('portfolio.settings.deleteAction')}
            </Button>
          </div>
        </div>
      </section>

      {actionError && !confirmArchive && !confirmDelete ? (
        <div style={{ marginTop: 16 }}>
          <Alert tone="error">{actionError}</Alert>
        </div>
      ) : null}

      {confirmArchive ? (
        <Dialog
          description={t('portfolio.switcher.archiveDialogDescription', {
            name: confirmArchive.name,
          })}
          onClose={() => {
            setConfirmArchive(null);
            setActionError(null);
          }}
          phoneSheet
          title={t('portfolio.switcher.archiveDialogTitle')}
          widthClassName="max-w-md"
        >
          <div className="flex flex-col gap-4">
            {actionError ? <Alert tone="error">{actionError}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button
                disabled={archiveMutation.isPending}
                onClick={() => {
                  setConfirmArchive(null);
                  setActionError(null);
                }}
                variant="quiet"
              >
                {t('common.cancel')}
              </Button>
              <Button
                disabled={archiveMutation.isPending}
                onClick={() => archiveMutation.mutate(confirmArchive.id)}
                variant="primary"
              >
                {archiveMutation.isPending
                  ? t('portfolio.switcher.archiving')
                  : t('portfolio.switcher.archive')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {confirmDelete ? (
        <DeletePortfolioDialog
          error={actionError}
          onClose={() => {
            setConfirmDelete(null);
            setActionError(null);
          }}
          onConfirm={() => deleteMutation.mutate(confirmDelete.id)}
          portfolio={confirmDelete}
          promotedDefault={promotedDefaultName(
            portfolios,
            confirmDelete,
            t('vault.lockedStub.fallbackAlias'),
          )}
          submitting={deleteMutation.isPending}
        />
      ) : null}

      <NormalModeOnly>
        {convertOpen && !portfolio.mirror ? (
          <ConvertChainDialog
            onClose={() => setConvertOpen(false)}
            onConverted={(chainId) => {
              setConvertOpen(false);
              refetchLists();
              setInviteChainId(chainId);
            }}
            portfolioId={portfolio.id}
            portfolioName={portfolio.name}
          />
        ) : null}

        {memberSheetOpen && portfolio.mirror ? (
          <MemberSheet
            chainId={portfolio.mirror.chainId}
            onClose={() => setMemberSheetOpen(false)}
          />
        ) : null}

        {inviteChainId ? (
          <MirrorInviteStepDialog
            chainId={inviteChainId}
            onClose={() => setInviteChainId(null)}
            onDone={() => {
              setInviteChainId(null);
              refetchLists();
            }}
          />
        ) : null}
      </NormalModeOnly>
    </div>
  );
}

/**
 * Permanent-delete confirmation (moved here from the switcher) (the #362 account-deletion safety pattern): an
 * explicit consequence list plus a field where the exact portfolio name must be
 * typed before the destructive button enables. When the deleted portfolio is the
 * current default, it also names the portfolio that auto-promotes to default.
 */
function DeletePortfolioDialog({
  portfolio,
  promotedDefault,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  portfolio: PortfolioSummary;
  promotedDefault: string | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState('');
  // Exact, case-sensitive match on the trimmed input — the destructive button
  // stays disabled until the name is typed verbatim.
  const confirmed = typed.trim() === portfolio.name;

  return (
    <Dialog
      description={t('portfolio.switcher.deleteDialogDescription', { name: portfolio.name })}
      onClose={onClose}
      phoneSheet
      title={t('portfolio.switcher.deleteDialogTitle')}
      widthClassName="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed && !submitting) onConfirm();
        }}
      >
        <Alert tone="error">
          <span className="font-semibold">{t('portfolio.switcher.deleteWarningHeadline')}</span>
          <ul className="mt-2 list-disc pl-5 text-sm">
            <li>{t('portfolio.switcher.deleteWarningTransactions')}</li>
            <li>{t('portfolio.switcher.deleteWarningCash')}</li>
            <li>{t('portfolio.switcher.deleteWarningShares')}</li>
            <li>{t('portfolio.switcher.deleteWarningTax')}</li>
          </ul>
        </Alert>

        {promotedDefault ? (
          <p className="bt-meta">
            {t('portfolio.switcher.deletePromotesDefault', { name: promotedDefault })}
          </p>
        ) : null}

        <Field label={t('portfolio.switcher.deleteConfirmLabel', { name: portfolio.name })}>
          <Input
            aria-label={t('portfolio.switcher.deleteConfirmAriaLabel')}
            autoComplete="off"
            autoFocus
            onChange={(e) => setTyped(e.target.value)}
            value={typed}
          />
        </Field>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button disabled={submitting} onClick={onClose} variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button disabled={!confirmed || submitting} type="submit" variant="danger">
            {submitting ? t('portfolio.switcher.deleting') : t('portfolio.switcher.delete')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
