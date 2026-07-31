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
import { IMPORT_MAX_DISTINCT_INSTRUMENTS } from '@bettertrack/contracts';

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
import { Badge, Button, Field, PageHead, Select, type BadgeTone } from '../../ui/origin';
import { Alert } from '../components/ui';
import { AsyncReadState } from '../components/AsyncReadState';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';

/**
 * Broker CSV import (PROJECTPLAN.md §13.4 V4-P8): upload a broker export →
 * autodetected broker (overridable) → staged preview table with per-row
 * `mapped`/`unmapped`/`duplicate`/`error` flags → choose a cash source →
 * confirm → per-row result report. Nothing touches the portfolio until the
 * explicit confirm; imports are always file-based (no broker API sync, §13.4).
 */

const AUTO_BROKER = 'auto';

const FLAG_TONES: Record<ImportRowFlag, BadgeTone> = {
  mapped: 'pos',
  duplicate: 'gold',
  unmapped: 'blue',
  error: 'neg',
};

const RESULT_TONES: Record<ImportRowResult, BadgeTone> = {
  applied: 'pos',
  skipped_duplicate: 'gold',
  skipped_unmapped: 'blue',
  skipped_error: 'neutral',
  failed: 'neg',
};

/**
 * Upload rejections. §8 error messages are server-authored English, so the codes
 * this surface owns a translated string for are mapped here and the rest still
 * render verbatim — the systemic error-code → i18n sweep is #739.
 */
function uploadErrorMessage(err: unknown, t: TranslateFn): string {
  if (!(err instanceof ApiError)) return t('portfolio.import.uploadFailed');
  if (err.code === 'IMPORT_TOO_MANY_INSTRUMENTS') {
    return t('portfolio.import.tooManyInstruments', { max: IMPORT_MAX_DISTINCT_INSTRUMENTS });
  }
  return err.message;
}

function FlagBadge({ flag, t }: { flag: ImportRowFlag; t: TranslateFn }) {
  return <Badge tone={FLAG_TONES[flag]}>{t(`portfolio.import.flag.${flag}`)}</Badge>;
}

/** The instrument cell: resolved catalog asset, or the file's own identity. */
function InstrumentCell({ row }: { row: ImportRow }) {
  if (row.asset) {
    return (
      <span className="flex items-baseline gap-2">
        <span className="bt-row-title">{row.asset.symbol}</span>
        <span className="bt-row-sub truncate">{row.asset.name}</span>
      </span>
    );
  }
  const identity = row.name ?? row.symbol ?? row.isin;
  return identity ? (
    <span className="bt-muted truncate">{identity}</span>
  ) : (
    <span className="bt-muted">{EM_DASH}</span>
  );
}

function PreviewRow({ row, t }: { row: ImportRow; t: TranslateFn }) {
  return (
    <tr>
      <td className="bt-muted">{row.rowIndex}</td>
      <td className="bt-muted">{row.executedAt ? formatDate(row.executedAt) : EM_DASH}</td>
      <td className="bt-soft">{row.kind ? t(`portfolio.import.kind.${row.kind}`) : EM_DASH}</td>
      <td className="max-w-56">
        <InstrumentCell row={row} />
      </td>
      <td className="is-num bt-soft">
        {row.quantity === null ? EM_DASH : formatQuantity(row.quantity)}
      </td>
      <td className="is-num bt-soft">
        {row.price === null || !row.currency ? (
          EM_DASH
        ) : (
          <MoneyText amount={row.price} currency={row.currency} />
        )}
      </td>
      <td className="is-num bt-soft">
        {row.amountEur === null ? EM_DASH : <MoneyText amount={row.amountEur} currency="EUR" />}
      </td>
      <td>
        <FlagBadge flag={row.flag} t={t} />
        {row.message ? <div className="bt-meta mt-1 max-w-64">{row.message}</div> : null}
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

  const referenceLoading =
    portfoliosQuery.isLoading || brokersQuery.isLoading || cashSourcesQuery.isLoading;
  const referenceError = portfoliosQuery.error ?? brokersQuery.error ?? cashSourcesQuery.error;

  function retryReferenceData() {
    const retries: Promise<unknown>[] = [portfoliosQuery.refetch(), brokersQuery.refetch()];
    if (preview !== null) retries.push(cashSourcesQuery.refetch());
    void Promise.all(retries);
  }

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
      setError(uploadErrorMessage(err, t));
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
    <div>
      <PageHead title={t('portfolio.import.title')}>
        <p className="bt-page-sub" style={{ maxWidth: 720 }}>
          {t('portfolio.import.intro')}
        </p>
      </PageHead>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <AsyncReadState
        loading={referenceLoading}
        error={referenceError}
        errorLabel={t('portfolio.import.referenceDataLoadError')}
        onRetry={retryReferenceData}
      />

      {/* ── Step 1: file + broker ── */}
      <section className="bt-section">
        <div
          className="bt-panel bt-panel--soft bt-panel--pad flex flex-col gap-3"
          style={{ borderColor: 'var(--bt-border-strong)', borderStyle: 'dashed' }}
        >
          <h2 className="bt-h3">{t('portfolio.import.uploadTitle')}</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field htmlFor="import-file" label={t('portfolio.import.fileLabel')}>
              <input
                accept=".csv,text/csv"
                className="bt-input cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-[var(--bt-surface-strong)] file:px-2 file:py-1 file:text-xs file:font-medium file:text-[var(--bt-text)]"
                id="import-file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                ref={fileInputRef}
                type="file"
              />
            </Field>
            <Field htmlFor="import-broker" label={t('portfolio.import.brokerLabel')}>
              <Select
                id="import-broker"
                onChange={(e) => setBrokerChoice(e.target.value)}
                value={brokerChoice}
              >
                <option value={AUTO_BROKER}>{t('portfolio.import.brokerAuto')}</option>
                {(brokersQuery.data?.brokers ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              disabled={!file || !activePortfolio}
              loading={uploadMutation.isPending}
              onClick={upload}
            >
              {uploadMutation.isPending
                ? t('portfolio.import.uploading')
                : t('portfolio.import.uploadCta')}
            </Button>
          </div>
        </div>
      </section>

      {/* ── Step 2: staged preview + confirm ── */}
      {preview && counts ? (
        <section className="bt-section">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="bt-h3">
                {t('portfolio.import.previewTitle', { filename: preview.batch.filename })}
              </h2>
              <span className="bt-meta">
                {t('portfolio.import.detectedBroker', { broker: preview.batch.brokerLabel })}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge>{t('portfolio.import.counts.total', { count: counts.total })}</Badge>
              <Badge tone="pos">
                {t('portfolio.import.counts.mapped', { count: counts.mapped })}
              </Badge>
              <Badge tone="gold">
                {t('portfolio.import.counts.duplicate', { count: counts.duplicate })}
              </Badge>
              <Badge tone="blue">
                {t('portfolio.import.counts.unmapped', { count: counts.unmapped })}
              </Badge>
              <Badge tone="neg">
                {t('portfolio.import.counts.error', { count: counts.error })}
              </Badge>
            </div>

            {preview.rows.length === 0 ? (
              <EmptyState
                description={t('portfolio.import.previewEmptyBody')}
                icon="📄"
                title={t('portfolio.import.previewEmptyTitle')}
              />
            ) : (
              <div className="bt-table-wrap bt-table-wrap--panel">
                <table className="bt-table" style={{ minWidth: '44rem' }}>
                  <thead>
                    <tr>
                      <th scope="col">{t('portfolio.import.table.row')}</th>
                      <th scope="col">{t('portfolio.import.table.date')}</th>
                      <th scope="col">{t('portfolio.import.table.type')}</th>
                      <th scope="col">{t('portfolio.import.table.instrument')}</th>
                      <th className="is-num" scope="col">
                        {t('portfolio.import.table.quantity')}
                      </th>
                      <th className="is-num" scope="col">
                        {t('portfolio.import.table.price')}
                      </th>
                      <th className="is-num" scope="col">
                        {t('portfolio.import.table.amount')}
                      </th>
                      <th scope="col">{t('portfolio.import.table.status')}</th>
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
              <div
                className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
                style={{ borderTop: '1px solid var(--bt-border)', paddingTop: 12 }}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <Field htmlFor="import-cash-source" label={t('portfolio.import.cashSourceLabel')}>
                    <Select
                      id="import-cash-source"
                      onChange={(e) => setCashSourceId(e.target.value)}
                      value={cashSourceId}
                    >
                      <option value="">{t('portfolio.import.cashSourceMain')}</option>
                      {(cashSourcesQuery.data?.sources ?? [])
                        .filter((s) => !s.isMain)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 pb-2">
                    <input
                      checked={linkCash}
                      className="h-4 w-4"
                      onChange={(e) => setLinkCash(e.target.checked)}
                      style={{ accentColor: 'var(--bt-gold)' }}
                      type="checkbox"
                    />
                    <span className="bt-meta">{t('portfolio.import.linkCashLabel')}</span>
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={discardMutation.isPending || applyMutation.isPending}
                    onClick={() => discardMutation.mutate()}
                  >
                    {t('portfolio.import.discardCta')}
                  </Button>
                  <Button
                    disabled={applyMutation.isPending || counts.mapped === 0}
                    loading={applyMutation.isPending}
                    onClick={() => applyMutation.mutate()}
                    variant="primary"
                  >
                    {applyMutation.isPending
                      ? t('portfolio.import.applying')
                      : t('portfolio.import.applyCta', { count: counts.mapped })}
                  </Button>
                </div>
              </div>
            ) : null}
            {result === null && counts.mapped === 0 ? (
              <p className="bt-meta">{t('portfolio.import.nothingToApply')}</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Step 3: per-row result report ── */}
      {result ? (
        <section className="bt-section">
          <div className="flex flex-col gap-3">
            <h2 className="bt-h3">{t('portfolio.import.resultTitle')}</h2>
            <p className="bt-soft">
              {t('portfolio.import.resultSummary', {
                applied: result.applied,
                skipped: result.skipped,
                failed: result.failed,
              })}
            </p>
            <ul className="bt-band flex flex-col">
              {result.rows.map((row) => (
                <li className="flex flex-wrap items-baseline gap-2 py-2" key={row.id}>
                  <span className="bt-meta">
                    {t('portfolio.import.table.row')} {row.rowIndex}
                  </span>
                  <Badge tone={RESULT_TONES[row.result]}>
                    {t(`portfolio.import.result.${row.result}`)}
                  </Badge>
                  {row.message ? <span className="bt-meta">{row.message}</span> : null}
                </li>
              ))}
            </ul>
            <div>
              <Button onClick={reset}>{t('portfolio.import.startOver')}</Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
