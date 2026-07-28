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
import { cx } from '../../lib/cx';
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
import { Alert } from '../components/ui';
import { Badge, Button, Panel, type BadgeTone } from '../../ui/origin';

/**
 * Bank-statement CSV import (PROJECTPLAN.md §13.5 V5-P9, issue 2/3). Upload a bank
 * export → the server autodetects the bank (overridable) and returns a staged
 * preview with a rule-suggested category per row → tweak the categories → apply.
 *
 * Stateless: nothing is persisted at preview, so apply re-uploads the same file.
 * A re-import of an already-applied file writes nothing (content-hash dedupe).
 * Compact per the anti-bloat rule — the whole flow is two cards.
 */

/** Compact inline select sizing shared by the bank picker and per-row category picker. */
const compactSelectStyle = { minHeight: 28, padding: '2px 26px 2px 8px', width: 'auto', fontSize: 12 } as const;

const FLAG_TONE: Record<ExpenseImportRowFlag, BadgeTone> = {
  new: 'pos',
  duplicate: 'gold',
  error: 'neg',
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
      <p className="bt-meta">{t('expenses.import.subtitle')}</p>

      {/* ── Step 1: pick a file (+ optional manual bank) ── */}
      <Panel className="flex flex-col gap-3">
        <h2 className="bt-h2">{t('expenses.import.uploadTitle')}</h2>
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
            className="bt-meta file:mr-3 file:rounded-md file:border-0 file:bg-[var(--bt-surface-strong)] file:px-3 file:py-1.5 file:text-[13px] file:text-[var(--bt-text)] hover:file:bg-[var(--bt-surface-hover)]"
          />
          <label className="bt-meta flex items-center gap-2">
            {t('expenses.import.bank')}
            <select
              className="bt-select"
              style={compactSelectStyle}
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
        <p className="bt-meta">{t('expenses.import.uploadHint')}</p>
      </Panel>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {/* ── Result summary (after apply) ── */}
      {result ? (
        <Panel className="flex flex-col gap-3">
          <Alert tone="success">
            {t('expenses.import.applied', {
              applied: result.applied,
              duplicate: result.duplicate,
              error: result.error,
            })}
          </Alert>
          <div>
            <Button onClick={reset}>{t('expenses.import.importAnother')}</Button>
          </div>
        </Panel>
      ) : null}

      {/* ── Step 2: staged preview + apply ── */}
      {preview ? (
        <Panel className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="bt-h2">{t('expenses.import.previewTitle', { bank: preview.bankLabel })}</h2>
            <p className="bt-meta">
              {t('expenses.import.counts', {
                new: preview.counts.new,
                duplicate: preview.counts.duplicate,
                error: preview.counts.error,
              })}
            </p>
          </div>

          <div className="bt-table-wrap">
            <table className="bt-table min-w-[36rem]">
              <thead>
                <tr>
                  <th scope="col">{t('expenses.import.colDate')}</th>
                  <th scope="col">{t('expenses.import.colDescription')}</th>
                  <th className="is-num" scope="col">
                    {t('expenses.import.colAmount')}
                  </th>
                  <th scope="col">{t('expenses.import.colCategory')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowIndex} className={row.flag === 'error' ? 'bt-muted' : undefined}>
                    <td className="whitespace-nowrap bt-muted">
                      {row.bookedOn ? formatDate(row.bookedOn) : '—'}
                    </td>
                    <td className="max-w-[16rem] truncate" title={row.raw}>
                      <Badge className="mr-2" tone={FLAG_TONE[row.flag]}>
                        {t(`expenses.import.flag.${row.flag}`)}
                      </Badge>
                      {row.description ?? row.message ?? row.raw}
                    </td>
                    <td className={cx('is-num whitespace-nowrap', row.direction === 'income' && 'bt-pos')}>
                      {row.amount !== null && row.direction
                        ? `${row.direction === 'income' ? '+' : '−'}${formatMoney(row.amount, row.currency ?? 'EUR')}`
                        : '—'}
                    </td>
                    <td>
                      {row.flag === 'new' ? (
                        <select
                          className="bt-select"
                          style={compactSelectStyle}
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
                        <span className="bt-meta">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={reset} disabled={applyMutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => applyMutation.mutate()}
              disabled={applyMutation.isPending || newCount === 0}
            >
              {applyMutation.isPending
                ? t('expenses.import.applying')
                : t('expenses.import.apply', { count: newCount })}
            </Button>
          </div>
        </Panel>
      ) : null}
    </section>
  );
}
