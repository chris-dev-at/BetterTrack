import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import type {
  ExpenseImportApplyResponse,
  ExpenseImportOverride,
  ExpenseImportPreviewResponse,
  ExpenseImportRowFlag,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  EXPENSE_CATEGORIES_QUERY_KEY,
  EXPENSE_IMPORT_BANKS_QUERY_KEY,
  EXPENSE_TRANSACTIONS_QUERY_KEY,
  applyExpenseImport,
  listExpenseCategories,
  listExpenseImportBanks,
  previewExpenseImport,
} from '../../lib/expensesApi';
import { formatDate, formatMoney } from '../../lib/format';
import { Alert, Button, cx } from '../components/ui';

/**
 * Bank-statement CSV import (PROJECTPLAN.md §13.5 V5-P9, issue 2/3). Upload a bank
 * export → the server autodetects the bank (overridable) and returns a staged
 * preview with a rule-suggested category per row → tweak the categories → apply.
 *
 * Stateless: nothing is persisted at preview, so apply re-uploads the same file.
 * A re-import of an already-applied file writes nothing (content-hash dedupe).
 * Compact per the anti-bloat rule — the whole flow is two cards.
 */

const selectClass = cx(
  'rounded-md bg-neutral-950 px-2 py-1 text-xs text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500',
);

const FLAG_TONE: Record<ExpenseImportRowFlag, string> = {
  new: 'bg-emerald-950/60 text-emerald-300 ring-emerald-800',
  duplicate: 'bg-amber-950/60 text-amber-300 ring-amber-800',
  error: 'bg-red-950/60 text-red-300 ring-red-800',
};

export function ImportPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [bankId, setBankId] = useState('');
  const [preview, setPreview] = useState<ExpenseImportPreviewResponse | null>(null);
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [result, setResult] = useState<ExpenseImportApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const banksQuery = useQuery({
    queryKey: EXPENSE_IMPORT_BANKS_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseImportBanks(signal),
    staleTime: Infinity,
  });
  const categoriesQuery = useQuery({
    queryKey: EXPENSE_CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseCategories(signal),
    staleTime: 30_000,
  });
  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data]);

  const previewMutation = useMutation({
    mutationFn: () => previewExpenseImport({ file: file!, bankId: bankId || undefined }),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      const next: Record<number, string> = {};
      for (const row of data.rows)
        if (row.flag === 'new') next[row.rowIndex] = row.categoryId ?? '';
      setSelections(next);
    },
    onError: (err) => {
      setPreview(null);
      setError(err instanceof ApiError ? err.message : t('expenses.import.previewError'));
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      // The preview is WYSIWYG: send every importable row's shown category as an
      // override so apply books exactly what the user sees (rules re-run server-side).
      const overrides: ExpenseImportOverride[] = (preview?.rows ?? [])
        .filter((row) => row.flag === 'new')
        .map((row) => ({ rowIndex: row.rowIndex, categoryId: selections[row.rowIndex] || null }));
      return applyExpenseImport({ file: file!, bankId: preview?.bankId, overrides });
    },
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: EXPENSE_TRANSACTIONS_QUERY_KEY });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('expenses.import.applyError'));
    },
  });

  function reset() {
    setFile(null);
    setBankId('');
    setPreview(null);
    setResult(null);
    setSelections({});
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const banks = banksQuery.data?.banks ?? [];
  const newCount = preview?.counts.new ?? 0;

  return (
    <section className="flex flex-col gap-6">
      <p className="text-sm text-neutral-500">{t('expenses.import.subtitle')}</p>

      {/* ── Step 1: pick a file (+ optional manual bank) ── */}
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-4">
        <h2 className="text-sm font-semibold text-neutral-200">
          {t('expenses.import.uploadTitle')}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            aria-label={t('expenses.import.chooseFile')}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setError(null);
            }}
            className="text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-sm file:text-neutral-100 hover:file:bg-neutral-700"
          />
          <label className="flex items-center gap-2 text-sm text-neutral-400">
            {t('expenses.import.bank')}
            <select
              className={cx(selectClass, 'py-1.5')}
              value={bankId}
              onChange={(e) => setBankId(e.target.value)}
            >
              <option value="">{t('expenses.import.bankAuto')}</option>
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            onClick={() => {
              setError(null);
              previewMutation.mutate();
            }}
            disabled={!file || previewMutation.isPending}
          >
            {previewMutation.isPending
              ? t('expenses.import.previewing')
              : t('expenses.import.preview')}
          </Button>
        </div>
        <p className="text-xs text-neutral-600">{t('expenses.import.uploadHint')}</p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {/* ── Result summary (after apply) ── */}
      {result ? (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-4">
          <Alert tone="success">
            {t('expenses.import.applied', {
              applied: result.applied,
              duplicate: result.duplicate,
              error: result.error,
            })}
          </Alert>
          <div>
            <Button variant="secondary" onClick={reset}>
              {t('expenses.import.importAnother')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── Step 2: staged preview + apply ── */}
      {preview ? (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-200">
              {t('expenses.import.previewTitle', { bank: preview.bankLabel })}
            </h2>
            <p className="text-xs text-neutral-500">
              {t('expenses.import.counts', {
                new: preview.counts.new,
                duplicate: preview.counts.duplicate,
                error: preview.counts.error,
              })}
            </p>
          </div>

          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-xs text-neutral-500">
                  <th className="px-4 py-2 font-medium sm:px-2">{t('expenses.import.colDate')}</th>
                  <th className="px-4 py-2 font-medium sm:px-2">
                    {t('expenses.import.colDescription')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium sm:px-2">
                    {t('expenses.import.colAmount')}
                  </th>
                  <th className="px-4 py-2 font-medium sm:px-2">
                    {t('expenses.import.colCategory')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {preview.rows.map((row) => (
                  <tr key={row.rowIndex} className={row.flag === 'error' ? 'text-neutral-600' : ''}>
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-400 sm:px-2">
                      {row.bookedOn ? formatDate(row.bookedOn) : '—'}
                    </td>
                    <td
                      className="max-w-[16rem] truncate px-4 py-2 text-neutral-200 sm:px-2"
                      title={row.raw}
                    >
                      <span
                        className={cx(
                          'mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ring-1 ring-inset',
                          FLAG_TONE[row.flag],
                        )}
                      >
                        {t(`expenses.import.flag.${row.flag}`)}
                      </span>
                      {row.description ?? row.message ?? row.raw}
                    </td>
                    <td
                      className={cx(
                        'whitespace-nowrap px-4 py-2 text-right tabular-nums sm:px-2',
                        row.direction === 'income' ? 'text-emerald-400' : 'text-neutral-200',
                      )}
                    >
                      {row.amount !== null && row.direction
                        ? `${row.direction === 'income' ? '+' : '−'}${formatMoney(row.amount, row.currency ?? 'EUR')}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2 sm:px-2">
                      {row.flag === 'new' ? (
                        <select
                          className={selectClass}
                          aria-label={t('expenses.import.colCategory')}
                          value={selections[row.rowIndex] ?? ''}
                          onChange={(e) =>
                            setSelections((prev) => ({ ...prev, [row.rowIndex]: e.target.value }))
                          }
                        >
                          <option value="">{t('expenses.import.uncategorized')}</option>
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-neutral-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={reset} disabled={applyMutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => applyMutation.mutate()}
              disabled={applyMutation.isPending || newCount === 0}
            >
              {applyMutation.isPending
                ? t('expenses.import.applying')
                : t('expenses.import.apply', { count: newCount })}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
