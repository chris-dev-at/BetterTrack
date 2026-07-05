import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import {
  archivePortfolio,
  createPortfolio,
  listPortfolios,
  restorePortfolio,
  updatePortfolio,
} from '../../lib/portfolioApi';
import { Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

/**
 * Portfolio switcher (PROJECTPLAN.md §6.8, §13.2 V2-P8). Replaces the V1
 * "Coming soon" placeholder with real multi-portfolio management: it lists the
 * user's **active** portfolios, switches the active one via the `?portfolio=`
 * routing param (so every scoped view below the layout follows), and offers
 * New / Rename / Archive plus an Archived list to restore from.
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

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

type NameDialogState = { mode: 'create' } | { mode: 'rename'; portfolio: PortfolioSummary };

export function PortfolioSwitcher() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<PortfolioSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
          ? 'You already have a portfolio with that name.'
          : 'Could not create the portfolio. Please try again.',
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
          ? 'You already have a portfolio with that name.'
          : 'Could not rename the portfolio. Please try again.',
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
          : 'Could not archive the portfolio. Please try again.',
      ),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restorePortfolio(id),
    onSuccess: () => {
      setActionError(null);
      refetchLists();
      void queryClient.invalidateQueries({ queryKey: ['portfolios', 'archived'] });
    },
    onError: () => setActionError('Could not restore the portfolio. Please try again.'),
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
        aria-label="Switch portfolio"
        className="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-200 ring-1 ring-inset ring-neutral-800 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span className="max-w-[12rem] truncate">{active?.name ?? 'Portfolio'}</span>
        {active?.isDefault ? (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500">
            Default
          </span>
        ) : null}
        <span aria-hidden="true" className="text-neutral-500">
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Portfolios"
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
                    Default
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
              + New portfolio
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
              Rename current
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!active || onlyOneActive}
              title={onlyOneActive ? 'You cannot archive your only portfolio' : undefined}
              onClick={() => {
                if (!active) return;
                setActionError(null);
                setConfirmArchive(active);
                setOpen(false);
              }}
              className={cx(itemClass, 'disabled:cursor-not-allowed disabled:text-neutral-600')}
            >
              Archive current
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
              Archived…
            </button>
          </div>
        </div>
      ) : null}

      {actionError && !nameDialog && !confirmArchive && !archivedOpen ? (
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
          title="Archive portfolio"
          description={`Hide "${confirmArchive.name}" from your portfolio list. Its history is kept and you can restore it any time.`}
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
                Cancel
              </Button>
              <Button
                onClick={() => archiveMutation.mutate(confirmArchive.id)}
                disabled={archiveMutation.isPending}
              >
                {archiveMutation.isPending ? 'Archiving…' : 'Archive'}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {archivedOpen ? (
        <Dialog
          title="Archived portfolios"
          description="Restore a portfolio to bring it back into your list."
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
              <p className="text-sm text-neutral-500">No archived portfolios.</p>
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
                      Restore
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
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 120;

  return (
    <Dialog
      title={mode === 'create' ? 'New portfolio' : 'Rename portfolio'}
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
          <span className="text-sm font-medium text-neutral-300">Name</span>
          <input
            type="text"
            value={name}
            maxLength={120}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            aria-label="Portfolio name"
            placeholder="e.g. Retirement"
            className={inputClass}
          />
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || submitting}>
            {submitting ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
