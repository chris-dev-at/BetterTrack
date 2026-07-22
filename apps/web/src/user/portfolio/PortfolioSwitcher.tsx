import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  archivePortfolio,
  createPortfolio,
  deletePortfolio,
  listPortfolios,
  restorePortfolio,
  updatePortfolio,
} from '../../lib/portfolioApi';
import { Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { CreateChainDialog, MirrorInviteStepDialog } from './MirrorchainPanel';

/**
 * Portfolio switcher (PROJECTPLAN.md §6.8, §13.2 V2-P8). Replaces the V1
 * "Coming soon" placeholder with real multi-portfolio management: it lists the
 * user's **active** portfolios, switches the active one via the `?portfolio=`
 * routing param (so every scoped view below the layout follows), and offers
 * New / Rename / Archive / Delete plus an Archived list to restore from.
 * Archive is the soft, restorable option; Delete is the hard, permanent one —
 * a type-to-confirm dialog (the #362 account-deletion pattern) gates it.
 *
 * The active portfolio lives in the URL, not in component state, so it survives
 * navigation across the section subnav and is shared with {@link PortfolioPage}
 * through {@link resolveActivePortfolio} reading the same param.
 */

/** The `?portfolio=<id>` search-param key that names the active portfolio. */
export const ACTIVE_PORTFOLIO_PARAM = 'portfolio';

/**
 * Resolve which portfolio is active from the routing param and the active list:
 * the param'd portfolio when it is still active, else the default, else the
 * first, else null. Kept here so the switcher and the page agree exactly.
 */
export function resolveActivePortfolio(
  portfolios: readonly PortfolioSummary[],
  param: string | null,
): PortfolioSummary | null {
  return (
    (param ? portfolios.find((p) => p.id === param) : undefined) ??
    portfolios.find((p) => p.isDefault) ??
    portfolios[0] ??
    null
  );
}

/**
 * When the portfolio about to be deleted is the current default, the name of the
 * active portfolio that will auto-promote to default in its place: the oldest
 * remaining active row (lowest `sortOrder`, then oldest id), mirroring the API's
 * derived-default rule (§6.8) so the dialog can name it. Null when the target is
 * not the default (nothing promotes) or nothing remains.
 */
export function promotedDefaultName(
  portfolios: readonly PortfolioSummary[],
  deleting: PortfolioSummary,
): string | null {
  if (!deleting.isDefault) return null;
  const remaining = portfolios
    .filter((p) => p.id !== deleting.id && p.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return remaining[0]?.name ?? null;
}

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

type NameDialogState = { mode: 'create' } | { mode: 'rename'; portfolio: PortfolioSummary };

export function PortfolioSwitcher() {
  const t = useT();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<PortfolioSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PortfolioSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Create-group-portfolio flow (V5-P7 §11): the "New group portfolio" menu
  // item opens CreateChainDialog; on success we chain straight into the
  // friend-picker invite step (§4/§11 zero-config AC).
  const [createChainOpen, setCreateChainOpen] = useState(false);
  const [inviteChainId, setInviteChainId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const activeQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = activeQuery.data?.portfolios ?? [];
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);

  // The archived list is only fetched when its dialog opens.
  const archivedQuery = useQuery({
    queryKey: ['portfolios', 'archived'],
    queryFn: ({ signal }) => listPortfolios(signal, true),
    enabled: archivedOpen,
    staleTime: 60_000,
  });
  const archived = (archivedQuery.data?.portfolios ?? []).filter((p) => p.archivedAt !== null);

  function setActive(id: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(ACTIVE_PORTFOLIO_PARAM, id);
        return next;
      },
      { replace: true },
    );
  }

  function clearActive() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(ACTIVE_PORTFOLIO_PARAM);
        return next;
      },
      { replace: true },
    );
  }

  const refetchLists = () => {
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => createPortfolio(name),
    onSuccess: (created) => {
      setActionError(null);
      setNameDialog(null);
      refetchLists();
      setActive(created.id); // jump straight to the new portfolio
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'PORTFOLIO_NAME_TAKEN'
          ? t('portfolio.switcher.nameTakenError')
          : t('portfolio.switcher.createError'),
      ),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updatePortfolio(id, { name }),
    onSuccess: () => {
      setActionError(null);
      setNameDialog(null);
      refetchLists();
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'PORTFOLIO_NAME_TAKEN'
          ? t('portfolio.switcher.nameTakenError')
          : t('portfolio.switcher.renameError'),
      ),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archivePortfolio(id),
    onSuccess: (_res, id) => {
      setActionError(null);
      setConfirmArchive(null);
      // If the archived one was active, drop the param so the view falls back
      // to the default (the switcher re-resolves it below).
      if (param === id) clearActive();
      refetchLists();
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'LAST_ACTIVE_PORTFOLIO'
          ? err.message
          : t('portfolio.switcher.archiveError'),
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePortfolio(id),
    onSuccess: (_res, id) => {
      setActionError(null);
      setConfirmDelete(null);
      // The portfolio is gone: if it was the active one, drop the param so the
      // view navigates away to the (auto-promoted) default — the switcher
      // re-resolves it below.
      if (param === id) clearActive();
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
    mutationFn: (id: string) => restorePortfolio(id),
    onSuccess: () => {
      setActionError(null);
      refetchLists();
      void queryClient.invalidateQueries({ queryKey: ['portfolios', 'archived'] });
    },
    onError: () => setActionError(t('portfolio.switcher.restoreError')),
  });

  const itemClass =
    'flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 focus:bg-neutral-800 focus:outline-none';
  const onlyOneActive = portfolios.length <= 1;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('portfolio.switcher.triggerAriaLabel')}
        className="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-200 ring-1 ring-inset ring-neutral-800 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span className="max-w-[12rem] truncate">
          {active?.name ?? t('portfolio.switcher.fallbackName')}
        </span>
        {active?.isDefault ? (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500">
            {t('portfolio.switcher.defaultBadge')}
          </span>
        ) : null}
        <span aria-hidden="true" className="text-neutral-500">
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t('portfolio.switcher.menuAriaLabel')}
          className="absolute left-0 z-40 mt-2 w-64 rounded-lg border border-neutral-800 bg-neutral-900 p-1 shadow-xl"
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {portfolios.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === active?.id}
                onClick={() => {
                  setActive(p.id);
                  setOpen(false);
                }}
                className={itemClass}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="w-3 shrink-0 text-sky-400">
                    {p.id === active?.id ? '✓' : ''}
                  </span>
                  <span className="truncate">{p.name}</span>
                </span>
                {p.isDefault ? (
                  <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500">
                    {t('portfolio.switcher.defaultBadge')}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="border-t border-neutral-800 py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionError(null);
                setNameDialog({ mode: 'create' });
                setOpen(false);
              }}
              className={itemClass}
            >
              {t('portfolio.switcher.newPortfolio')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionError(null);
                setCreateChainOpen(true);
                setOpen(false);
              }}
              className={itemClass}
            >
              {t('portfolio.switcher.newGroupPortfolio')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!active}
              onClick={() => {
                if (!active) return;
                setActionError(null);
                setNameDialog({ mode: 'rename', portfolio: active });
                setOpen(false);
              }}
              className={cx(itemClass, 'disabled:cursor-not-allowed disabled:text-neutral-600')}
            >
              {t('portfolio.switcher.renameCurrent')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!active || onlyOneActive}
              title={onlyOneActive ? t('portfolio.switcher.archiveDisabledHint') : undefined}
              onClick={() => {
                if (!active) return;
                setActionError(null);
                setConfirmArchive(active);
                setOpen(false);
              }}
              className={cx(itemClass, 'disabled:cursor-not-allowed disabled:text-neutral-600')}
            >
              {t('portfolio.switcher.archiveCurrent')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!active || onlyOneActive}
              title={onlyOneActive ? t('portfolio.switcher.deleteDisabledHint') : undefined}
              onClick={() => {
                if (!active) return;
                setActionError(null);
                setConfirmDelete(active);
                setOpen(false);
              }}
              className={cx(
                itemClass,
                'text-red-300 hover:bg-red-950/60 focus:bg-red-950/60',
                'disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent',
              )}
            >
              {t('portfolio.switcher.deleteCurrent')}
            </button>
          </div>

          <div className="border-t border-neutral-800 py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionError(null);
                setArchivedOpen(true);
                setOpen(false);
              }}
              className={itemClass}
            >
              {t('portfolio.switcher.archivedMenuItem')}
            </button>
          </div>
        </div>
      ) : null}

      {actionError && !nameDialog && !confirmArchive && !confirmDelete && !archivedOpen ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-64">
          <Alert tone="error">{actionError}</Alert>
        </div>
      ) : null}

      {nameDialog ? (
        <NameDialog
          mode={nameDialog.mode}
          initialName={nameDialog.mode === 'rename' ? nameDialog.portfolio.name : ''}
          submitting={createMutation.isPending || renameMutation.isPending}
          error={actionError}
          onClose={() => {
            setNameDialog(null);
            setActionError(null);
          }}
          onSubmit={(name) => {
            if (nameDialog.mode === 'create') createMutation.mutate(name);
            else renameMutation.mutate({ id: nameDialog.portfolio.id, name });
          }}
        />
      ) : null}

      {confirmArchive ? (
        <Dialog
          title={t('portfolio.switcher.archiveDialogTitle')}
          description={t('portfolio.switcher.archiveDialogDescription', {
            name: confirmArchive.name,
          })}
          onClose={() => {
            setConfirmArchive(null);
            setActionError(null);
          }}
          widthClassName="max-w-md"
        >
          <div className="flex flex-col gap-4">
            {actionError ? <Alert tone="error">{actionError}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmArchive(null);
                  setActionError(null);
                }}
                disabled={archiveMutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => archiveMutation.mutate(confirmArchive.id)}
                disabled={archiveMutation.isPending}
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
          portfolio={confirmDelete}
          promotedDefault={promotedDefaultName(portfolios, confirmDelete)}
          submitting={deleteMutation.isPending}
          error={actionError}
          onClose={() => {
            setConfirmDelete(null);
            setActionError(null);
          }}
          onConfirm={() => deleteMutation.mutate(confirmDelete.id)}
        />
      ) : null}

      {createChainOpen ? (
        <CreateChainDialog
          onClose={() => setCreateChainOpen(false)}
          onCreated={(chainId) => {
            setCreateChainOpen(false);
            refetchLists();
            setInviteChainId(chainId);
          }}
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

      {archivedOpen ? (
        <Dialog
          title={t('portfolio.switcher.archivedDialogTitle')}
          description={t('portfolio.switcher.archivedDialogDescription')}
          onClose={() => {
            setArchivedOpen(false);
            setActionError(null);
          }}
          widthClassName="max-w-md"
        >
          <div className="flex flex-col gap-3">
            {actionError ? <Alert tone="error">{actionError}</Alert> : null}
            {archivedQuery.isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton height="h-10" />
                <Skeleton height="h-10" />
              </div>
            ) : archived.length === 0 ? (
              <p className="text-sm text-neutral-500">{t('portfolio.switcher.noArchived')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {archived.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-neutral-200">{p.name}</span>
                    <Button
                      variant="secondary"
                      onClick={() => restoreMutation.mutate(p.id)}
                      disabled={restoreMutation.isPending}
                    >
                      {t('portfolio.switcher.restore')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/** New / Rename portfolio dialog — a single trimmed-name text field. */
function NameDialog({
  mode,
  initialName,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'rename';
  initialName: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 120;

  return (
    <Dialog
      title={
        mode === 'create'
          ? t('portfolio.switcher.createTitle')
          : t('portfolio.switcher.renameTitle')
      }
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(trimmed);
        }}
        className="flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.switcher.nameLabel')}
          </span>
          <input
            type="text"
            value={name}
            maxLength={120}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            aria-label={t('portfolio.switcher.nameAriaLabel')}
            placeholder={t('portfolio.switcher.namePlaceholder')}
            className={inputClass}
          />
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!valid || submitting}>
            {submitting
              ? t('common.saving')
              : mode === 'create'
                ? t('portfolio.switcher.create')
                : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Permanent-delete confirmation (the #362 account-deletion safety pattern): an
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
      title={t('portfolio.switcher.deleteDialogTitle')}
      description={t('portfolio.switcher.deleteDialogDescription', { name: portfolio.name })}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed && !submitting) onConfirm();
        }}
        className="flex flex-col gap-4"
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
          <p className="text-sm text-neutral-400">
            {t('portfolio.switcher.deletePromotesDefault', { name: promotedDefault })}
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.switcher.deleteConfirmLabel', { name: portfolio.name })}
          </span>
          <input
            type="text"
            value={typed}
            autoFocus
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
            aria-label={t('portfolio.switcher.deleteConfirmAriaLabel')}
            className={inputClass}
          />
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="secondary"
            className="text-red-300 ring-red-900 hover:bg-red-950"
            disabled={!confirmed || submitting}
          >
            {submitting ? t('portfolio.switcher.deleting') : t('portfolio.switcher.delete')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
