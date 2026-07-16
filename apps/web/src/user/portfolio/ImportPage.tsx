import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';

import type {
  ApplyImportResponse,
  ImportPreviewResponse,
  ImportRow,
  ImportRowFlag,
  ImportRowResult,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { EM_DASH, formatDate, formatQuantity } from '../../lib/format';
import {
  applyImportBatch,
  discardImportBatch,
  IMPORT_BROKERS_QUERY_KEY,
  listImportBrokers,
  uploadImportBatch,
} from '../../lib/importsApi';
import { listCashSources, listPortfolios } from '../../lib/portfolioApi';
import { EmptyState, MoneyText } from '../../ui';
import { Alert, Button, cx } from '../components/ui';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';

/**
 * Broker CSV import (PROJECTPLAN.md §13.4 V4-P8): upload a broker export →
 * autodetected broker (overridable) → staged preview table with per-row
 * `mapped`/`unmapped`/`duplicate`/`error` flags → choose a cash source →
 * confirm → per-row result report. Nothing touches the portfolio until the
 * explicit confirm; imports are always file-based (no broker API sync, §13.4).
 */

const AUTO_BROKER = 'auto';

const FLAG_CLASSES: Record<ImportRowFlag, string> = {
  mapped: 'bg-emerald-500/15 text-emerald-300',
  duplicate: 'bg-amber-500/15 text-amber-300',
  unmapped: 'bg-sky-500/15 text-sky-300',
  error: 'bg-red-500/15 text-red-300',
};

const RESULT_CLASSES: Record<ImportRowResult, string> = {
  applied: 'bg-emerald-500/15 text-emerald-300',
  skipped_duplicate: 'bg-amber-500/15 text-amber-300',
  skipped_unmapped: 'bg-sky-500/15 text-sky-300',
  skipped_error: 'bg-neutral-500/15 text-neutral-300',
  failed: 'bg-red-500/15 text-red-300',
};

function FlagBadge({ flag, t }: { flag: ImportRowFlag; t: TranslateFn }) {
  return (
    <span
      className={cx(
        'inline-block rounded px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide',
        FLAG_CLASSES[flag],
      )}
    >
      {t(`portfolio.import.flag.${flag}`)}
    </span>
  );
}

/** The instrument cell: resolved catalog asset, or the file's own identity. */
function InstrumentCell({ row }: { row: ImportRow }) {
  if (row.asset) {
    return (
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-semibold text-neutral-100">{row.asset.symbol}</span>
        <span className="truncate text-xs text-neutral-500">{row.asset.name}</span>
      </span>
    );
  }
  const identity = row.name ?? row.symbol ?? row.isin;
  return identity ? (
    <span className="truncate text-xs text-neutral-400">{identity}</span>
  ) : (
    <span className="text-neutral-600">{EM_DASH}</span>
  );
}

function PreviewRow({ row, t }: { row: ImportRow; t: TranslateFn }) {
  return (
    <tr className="border-t border-neutral-800/60 text-xs">
      <td className="px-3 py-2 text-neutral-500">{row.rowIndex}</td>
      <td className="px-3 py-2 text-neutral-400">
        {row.executedAt ? formatDate(row.executedAt) : EM_DASH}
      </td>
      <td className="px-3 py-2 text-neutral-300">
        {row.kind ? t(`portfolio.import.kind.${row.kind}`) : EM_DASH}
      </td>
      <td className="max-w-56 px-3 py-2">
        <InstrumentCell row={row} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        {row.quantity === null ? EM_DASH : formatQuantity(row.quantity)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        {row.price === null || !row.currency ? (
          EM_DASH
        ) : (
          <MoneyText amount={row.price} currency={row.currency} />
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        {row.amountEur === null ? EM_DASH : <MoneyText amount={row.amountEur} currency="EUR" />}
      </td>
      <td className="px-3 py-2">
        <FlagBadge flag={row.flag} t={t} />
        {row.message ? <div className="mt-1 max-w-64 text-neutral-500">{row.message}</div> : null}
      </td>
    </tr>
  );
}

export function ImportPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [brokerChoice, setBrokerChoice] = useState<string>(AUTO_BROKER);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [result, setResult] = useState<ApplyImportResponse | null>(null);
  const [cashSourceId, setCashSourceId] = useState<string>('');
  const [linkCash, setLinkCash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
  });
  const activePortfolio = resolveActivePortfolio(
    portfoliosQuery.data?.portfolios ?? [],
    searchParams.get(ACTIVE_PORTFOLIO_PARAM),
  );

  const brokersQuery = useQuery({
    queryKey: IMPORT_BROKERS_QUERY_KEY,
    queryFn: ({ signal }) => listImportBrokers(signal),
    staleTime: Infinity,
  });

  const cashSourcesQuery = useQuery({
    queryKey: ['portfolio', preview?.batch.portfolioId, 'cash-sources'],
    queryFn: ({ signal }) => listCashSources(preview!.batch.portfolioId, false, signal),
    enabled: preview !== null,
  });

  const reset = () => {
    setPreview(null);
    setResult(null);
    setCashSourceId('');
    setLinkCash(false);
    setError(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File; portfolioId: string; brokerId?: string }) =>
      uploadImportBatch(input),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('portfolio.import.uploadFailed'));
    },
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      applyImportBatch(preview!.batch.id, {
        ...(cashSourceId ? { cashSourceId } : {}),
        linkCashOnTrades: linkCash,
      }),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('portfolio.import.applyFailed'));
    },
  });

  const discardMutation = useMutation({
    mutationFn: () => discardImportBatch(preview!.batch.id),
    onSettled: reset,
  });

  const upload = () => {
    if (!file || !activePortfolio) return;
    uploadMutation.mutate({
      file,
      portfolioId: activePortfolio.id,
      ...(brokerChoice !== AUTO_BROKER ? { brokerId: brokerChoice } : {}),
    });
  };

  const counts = preview?.batch.counts;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-neutral-100">{t('portfolio.import.title')}</h1>
        <p className="max-w-3xl text-sm text-neutral-400">{t('portfolio.import.intro')}</p>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {/* ── Step 1: file + broker ── */}
      <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950/40 p-4">
        <h2 className="text-sm font-semibold text-neutral-200">
          {t('portfolio.import.uploadTitle')}
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            {t('portfolio.import.fileLabel')}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 file:mr-3 file:rounded file:border-0 file:bg-neutral-700 file:px-2 file:py-1 file:text-xs file:text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            {t('portfolio.import.brokerLabel')}
            <select
              value={brokerChoice}
              onChange={(e) => setBrokerChoice(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            >
              <option value={AUTO_BROKER}>{t('portfolio.import.brokerAuto')}</option>
              {(brokersQuery.data?.brokers ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            onClick={upload}
            disabled={!file || !activePortfolio || uploadMutation.isPending}
          >
            {uploadMutation.isPending
              ? t('portfolio.import.uploading')
              : t('portfolio.import.uploadCta')}
          </Button>
        </div>
      </section>

      {/* ── Step 2: staged preview + confirm ── */}
      {preview && counts ? (
        <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-200">
              {t('portfolio.import.previewTitle', { filename: preview.batch.filename })}
            </h2>
            <span className="text-xs text-neutral-500">
              {t('portfolio.import.detectedBroker', { broker: preview.batch.brokerLabel })}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="text-neutral-400">
              {t('portfolio.import.counts.total', { count: counts.total })}
            </span>
            <span className="text-emerald-300">
              {t('portfolio.import.counts.mapped', { count: counts.mapped })}
            </span>
            <span className="text-amber-300">
              {t('portfolio.import.counts.duplicate', { count: counts.duplicate })}
            </span>
            <span className="text-sky-300">
              {t('portfolio.import.counts.unmapped', { count: counts.unmapped })}
            </span>
            <span className="text-red-300">
              {t('portfolio.import.counts.error', { count: counts.error })}
            </span>
          </div>

          {preview.rows.length === 0 ? (
            <EmptyState
              icon="📄"
              title={t('portfolio.import.previewEmptyTitle')}
              description={t('portfolio.import.previewEmptyBody')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem]">
                <thead>
                  <tr className="text-[0.65rem] uppercase tracking-wide text-neutral-600">
                    <th scope="col" className="px-3 py-1 text-left font-medium">
                      {t('portfolio.import.table.row')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-medium">
                      {t('portfolio.import.table.date')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-medium">
                      {t('portfolio.import.table.type')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-medium">
                      {t('portfolio.import.table.instrument')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-right font-medium">
                      {t('portfolio.import.table.quantity')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-right font-medium">
                      {t('portfolio.import.table.price')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-right font-medium">
                      {t('portfolio.import.table.amount')}
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-medium">
                      {t('portfolio.import.table.status')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <PreviewRow key={row.id} row={row} t={t} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result === null ? (
            <div className="flex flex-col gap-3 border-t border-neutral-800/60 pt-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex flex-col gap-1 text-xs text-neutral-400">
                  {t('portfolio.import.cashSourceLabel')}
                  <select
                    value={cashSourceId}
                    onChange={(e) => setCashSourceId(e.target.value)}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
                  >
                    <option value="">{t('portfolio.import.cashSourceMain')}</option>
                    {(cashSourcesQuery.data?.sources ?? [])
                      .filter((s) => !s.isMain)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 pb-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={linkCash}
                    onChange={(e) => setLinkCash(e.target.checked)}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-900"
                  />
                  {t('portfolio.import.linkCashLabel')}
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => discardMutation.mutate()}
                  disabled={discardMutation.isPending || applyMutation.isPending}
                >
                  {t('portfolio.import.discardCta')}
                </Button>
                <Button
                  type="button"
                  onClick={() => applyMutation.mutate()}
                  disabled={applyMutation.isPending || counts.mapped === 0}
                >
                  {applyMutation.isPending
                    ? t('portfolio.import.applying')
                    : t('portfolio.import.applyCta', { count: counts.mapped })}
                </Button>
              </div>
            </div>
          ) : null}
          {result === null && counts.mapped === 0 ? (
            <p className="text-xs text-neutral-500">{t('portfolio.import.nothingToApply')}</p>
          ) : null}
        </section>
      ) : null}

      {/* ── Step 3: per-row result report ── */}
      {result ? (
        <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950/40 p-4">
          <h2 className="text-sm font-semibold text-neutral-200">
            {t('portfolio.import.resultTitle')}
          </h2>
          <p className="text-sm text-neutral-300">
            {t('portfolio.import.resultSummary', {
              applied: result.applied,
              skipped: result.skipped,
              failed: result.failed,
            })}
          </p>
          <ul className="flex flex-col gap-1">
            {result.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="text-neutral-500">
                  {t('portfolio.import.table.row')} {row.rowIndex}
                </span>
                <span
                  className={cx(
                    'inline-block rounded px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide',
                    RESULT_CLASSES[row.result],
                  )}
                >
                  {t(`portfolio.import.result.${row.result}`)}
                </span>
                {row.message ? <span className="text-neutral-500">{row.message}</span> : null}
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" variant="secondary" onClick={reset}>
              {t('portfolio.import.startOver')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
