import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';

import type {
  ApplyImportResponse,
  ImportPreviewResponse,
  ImportRowKind,
  ImportRowResult,
} from '@bettertrack/contracts';
import { IMPORT_MAX_DISTINCT_INSTRUMENTS } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { useAiCapability } from '../../lib/aiApi';
import { ApiError } from '../../lib/apiClient';
import { CASH_TAGS_QUERY_KEY, listCashTags } from '../../lib/cashApi';
import {
  applyImportBatch,
  discardImportBatch,
  IMPORT_BROKERS_QUERY_KEY,
  listImportBrokers,
  resolveImportRow,
  uploadImportBatch,
} from '../../lib/importsApi';
import { listCashSources, listPortfolios } from '../../lib/portfolioApi';
import { EmptyState } from '../../ui';
import { Badge, Button, Field, PageHead, Select, type BadgeTone } from '../../ui/origin';
import { Alert } from '../components/ui';
import { AsyncReadState, type AsyncRead } from '../components/AsyncReadState';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';
import { vaultedPortfolioErrorMessage } from './vaultedPortfolioError';
import { ImportPreviewTable } from './import/ImportPreviewTable';
import { ImportReviewPanel } from './import/ImportReview';
import { ImportUnderstandingPanel } from './import/ImportUnderstanding';

/**
 * THE IMPORT WIZARD (#964, PROJECTPLAN §16 2026-07-31: "IMPORT IS A WIZARD THAT
 * UNDERSTANDS A WHOLE FILE, not a CSV parser for one shape").
 *
 * Four steps, and the shape of them is dictated by what the server actually
 * does rather than by a generic import metaphor:
 *
 *  1. FILE — pick the portfolio's file and, optionally, override the broker.
 *     There is exactly one source, because file-based import is the product and
 *     live broker sync is an explicit §13.4 non-goal. The picker's last entry
 *     is the generic "work it out from the file" path.
 *  2. UNDERSTOOD — what the server made of the file: its delimiter, encoding
 *     and locales, one labelled row per column with the evidence behind it, and
 *     any AI proposals shown as suggestions that were NOT used. Skipped
 *     entirely for a file a broker mapper claimed, which labels no columns.
 *  3. REVIEW — only the rows that need a person: unresolved instruments (with
 *     candidates and a search box that pin through the API), rows whose KIND
 *     nobody has decided (a statement with no booking-type column: one control
 *     per row, plus a bulk sweep per kind), and rows that could not be read at
 *     all, listed with their reason. Skipped when there are none, so a clean
 *     file never asks a question it does not have.
 *  4. CONFIRM — the full staged table, the cash source, and the one button that
 *     writes. The result report replaces this step in place.
 *
 * ── WHY NOT THE DEMO'S EIGHT ─────────────────────────────────────────────────
 *
 * `apps/redesign-demo/src/OriginImportFlow.tsx` sketches Source → Connect →
 * Coverage → Map → Assets → Review → Dry run → Receipt. Four of those describe
 * a server that does not exist here: Connect/Source assume Drive and API
 * origins (the §13.4 non-goal), Coverage is a page for a number that belongs in
 * a badge, and Receipt promises an undo that has no endpoint. Map and Assets
 * are real needs and survive as steps 2 and 3; Dry run and Receipt are step 4
 * and its result state. The demo is the look; the server is the shape.
 *
 * ── WHAT THIS SURFACE MUST NEVER DO ──────────────────────────────────────────
 *
 * Recompute. Every count, flag, tag and resolved asset is read from the preview
 * payload, and BOTH row mutations — pinning an instrument, confirming a kind —
 * REPLACE the whole preview with the server's response rather than patching a
 * row locally, because apply replays what staging persisted and a client that
 * derived its own view of any of it could show one thing and book another.
 *
 * The kind confirmation makes that sharper rather than softer: the request
 * carries one enum member and no data at all, and the amount, direction, asset,
 * duplicate verdict and tags that come back were all derived by the server from
 * what it parsed. This page decides WHICH question to answer, never the answer.
 */

const AUTO_BROKER = 'auto';

type Step = 'file' | 'understood' | 'review' | 'confirm';

/**
 * Canonical order. `steps` below is a SUBSET of this — a broker-mapper batch
 * has no `understood`, a clean file has no `review` — and the subset is
 * recomputed on every preview change, including the one that lands when the
 * user pins the LAST unresolved row. Without a canonical order there is nothing
 * to reconcile the current step against when it vanishes mid-flow.
 */
const ALL_STEPS: readonly Step[] = ['file', 'understood', 'review', 'confirm'];

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
  const vaulted = vaultedPortfolioErrorMessage(err, t);
  if (vaulted) return vaulted;
  if (err.code === 'IMPORT_TOO_MANY_INSTRUMENTS') {
    return t('portfolio.import.tooManyInstruments', { max: IMPORT_MAX_DISTINCT_INSTRUMENTS });
  }
  return err.message;
}

/** The dot stepper, following the portfolio wizard's own chrome vocabulary. */
function Stepper({ steps, current, t }: { steps: Step[]; current: Step; t: TranslateFn }) {
  const index = steps.indexOf(current);
  return (
    <div className="bt-pfw__stepper">
      <div aria-hidden="true" className="bt-pfw__dots">
        {steps.map((step, position) => (
          <span
            className="bt-pfw__dot"
            data-state={position === index ? 'current' : position < index ? 'done' : 'upcoming'}
            key={step}
          />
        ))}
      </div>
      <p className="bt-pfw__stepnow">
        {t('portfolio.wizard.stepOf', { current: index + 1, total: steps.length })}
        {' · '}
        {t(`portfolio.import.step.${current}`)}
      </p>
    </div>
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
  const [step, setStep] = useState<Step>('file');
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

  // The caller's own tags, to name the ids a staged cash row was pre-tagged
  // with. Read once and only while a preview exists.
  const cashTagsQuery = useQuery({
    queryKey: CASH_TAGS_QUERY_KEY,
    queryFn: ({ signal }) => listCashTags(signal),
    enabled: preview !== null,
    staleTime: 60_000,
  });
  const tagsById = useMemo(
    () => new Map((cashTagsQuery.data?.tags ?? []).map((tag) => [tag.id, tag])),
    [cashTagsQuery.data],
  );

  // The shared AI capability read every AI surface keys visibility off. It is
  // NOT part of `referenceLoading`: the wizard works identically with or without
  // an assistant, so a slow or failed capability read must never gate the upload
  // step — it only decides whether the budget line below is shown.
  const aiCapability = useAiCapability();

  const referenceLoading =
    portfoliosQuery.isLoading ||
    brokersQuery.isLoading ||
    cashSourcesQuery.isLoading ||
    cashTagsQuery.isLoading;
  // Handed over as a group so each reference read is classified on its own: a
  // recoverable 5xx keeps its Retry even behind a confirmed rejection, and that
  // Retry re-runs only the reads that can actually recover. The preview-scoped
  // reads join the group only once a preview exists.
  const referenceReads: AsyncRead[] = [
    { error: portfoliosQuery.error, refetch: () => portfoliosQuery.refetch() },
    { error: brokersQuery.error, refetch: () => brokersQuery.refetch() },
    ...(preview !== null
      ? [
          { error: cashSourcesQuery.error, refetch: () => cashSourcesQuery.refetch() },
          { error: cashTagsQuery.error, refetch: () => cashTagsQuery.refetch() },
        ]
      : []),
  ];

  /**
   * True from the moment Discard is fired until the page resets (review B3).
   *
   * Discard deletes the batch server-side, but a pin started just before it can
   * still be in flight — and its `onSuccess` would `setPreview` a batch that no
   * longer exists, resurrecting a dead preview whose Apply can only ever 404.
   * A ref rather than state because the check happens inside a mutation
   * callback, which must read the value at settle time, not at render time.
   *
   * DEFENSE IN DEPTH, deliberately kept with no UI path today: gating the
   * footer on `resolveMutation.isPending` means the user cannot leave Review
   * while a pin is settling, and Discard lives on Confirm — so the two cannot
   * currently overlap. That is a property of the STEP FLOW, which is exactly
   * the kind of thing a later step gets added to; this guard is what stops that
   * change from silently re-opening the window.
   */
  const discardedRef = useRef(false);

  const reset = () => {
    discardedRef.current = false;
    setPreview(null);
    setResult(null);
    setStep('file');
    setCashSourceId('');
    setLinkCash(false);
    setError(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * Which steps exist for THIS batch. A broker-mapper file understood no
   * columns, and a clean file has nothing to review — so neither step is
   * rendered as an empty formality the user has to click past.
   */
  const steps = useMemo<Step[]>(() => {
    const list: Step[] = ['file'];
    if (preview?.understanding) list.push('understood');
    if (preview && preview.rows.some((r) => r.flag === 'unmapped' || r.flag === 'error')) {
      list.push('review');
    }
    if (preview) list.push('confirm');
    return list;
  }, [preview]);

  const goAfter = (from: Step, next: ImportPreviewResponse) => {
    const list: Step[] = ['file'];
    if (next.understanding) list.push('understood');
    if (next.rows.some((r) => r.flag === 'unmapped' || r.flag === 'error')) list.push('review');
    list.push('confirm');
    const index = list.indexOf(from);
    setStep(list[index + 1] ?? 'confirm');
  };

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File; portfolioId: string; brokerId?: string }) =>
      uploadImportBatch(input),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      goAfter('file', data);
    },
    onError: (err) => {
      setError(uploadErrorMessage(err, t));
    },
  });

  // Pinning replaces the WHOLE preview with the server's response — see the
  // "must never recompute" note at the top of this file.
  const resolveMutation = useMutation({
    mutationFn: (input: { rowId: string; assetId: string }) =>
      resolveImportRow(preview!.batch.id, input.rowId, { assetId: input.assetId }),
    // Clearing on START, not on success (review B2): a mutation may only clear
    // the error IT is replacing. Clearing on success lets a pin that resolves
    // later wipe a failure written by something else in the meantime, leaving
    // the user with a silent problem and no message.
    onMutate: () => setError(null),
    onSuccess: (data) => {
      // The batch may have been discarded while this was in flight (B3).
      if (discardedRef.current) return;
      setPreview(data);
    },
    onError: (err) => {
      setError(
        vaultedPortfolioErrorMessage(err, t) ??
          (err instanceof ApiError ? err.message : t('portfolio.import.resolveFailed')),
      );
    },
  });

  /**
   * Confirming what a row IS (§16 2026-08-29 gap (b)) — one row, or a whole
   * sweep of them, through the SAME endpoint the pin uses.
   *
   * SEQUENTIAL, DELIBERATELY. Every PATCH returns the whole refreshed preview,
   * so two in flight at once would race to be the last writer and the loser's
   * view — one row out of date — would be the one left on screen. Running them
   * in order also means the counts the user ends up looking at are the counts
   * after every confirmation, which is the invariant this page is built on: the
   * client renders what the server says and never recomputes it.
   *
   * A refusal STOPS the sweep rather than pressing on. The wizard only ever
   * offers kinds the server already said each row accepts, so a rejection here
   * means the world changed under it — the batch was applied, the session went
   * — and every remaining row would fail the same way. The preview from the
   * last row that DID land is kept, so the user sees exactly how far it got
   * beside the reason it stopped.
   */
  const confirmMutation = useMutation({
    mutationFn: async (input: { rowIds: string[]; kind: ImportRowKind }) => {
      let latest: ImportPreviewResponse | null = null;
      for (const rowId of input.rowIds) {
        try {
          latest = await resolveImportRow(preview!.batch.id, rowId, { kind: input.kind });
        } catch (err) {
          // Nothing landed at all: let the mutation fail, so the page keeps the
          // preview it already had rather than replacing it with itself.
          if (latest === null) throw err;
          return { preview: latest, failure: err };
        }
      }
      return { preview: latest!, failure: null as unknown };
    },
    onMutate: () => setError(null),
    onSuccess: (data) => {
      // The batch may have been discarded while this was in flight (B3).
      if (discardedRef.current) return;
      setPreview(data.preview);
      if (data.failure) {
        setError(
          vaultedPortfolioErrorMessage(data.failure, t) ??
            (data.failure instanceof ApiError
              ? data.failure.message
              : t('portfolio.import.confirmFailed')),
        );
      }
    },
    onError: (err) => {
      setError(
        vaultedPortfolioErrorMessage(err, t) ??
          (err instanceof ApiError ? err.message : t('portfolio.import.confirmFailed')),
      );
    },
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      applyImportBatch(preview!.batch.id, {
        ...(cashSourceId ? { cashSourceId } : {}),
        linkCashOnTrades: linkCash,
      }),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      setResult(data);
    },
    onError: (err) => {
      setError(
        vaultedPortfolioErrorMessage(err, t) ??
          (err instanceof ApiError ? err.message : t('portfolio.import.applyFailed')),
      );
    },
  });

  const discardMutation = useMutation({
    mutationFn: () => discardImportBatch(preview!.batch.id),
    // Raised BEFORE the request leaves, so a pin already in flight is ignored
    // when it lands rather than restoring the batch this is deleting (B3).
    onMutate: () => {
      discardedRef.current = true;
    },
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

  /**
   * The step actually being shown (review B1).
   *
   * Pinning the last unresolved row removes `review` from `steps` while `step`
   * still names it. Left alone that is `indexOf` === -1, which renders "Step 0
   * of 2" and turns Continue into a jump BACK to the file picker — the user
   * finishes the work the wizard asked for and is thrown to the start.
   *
   * Derived rather than corrected in an effect: this reconciles during the same
   * render that drops the step, so the broken intermediate state never paints.
   * A vanished step advances FORWARD to the next surviving one, which is where
   * finishing that step would have gone anyway.
   */
  const activeStep = useMemo<Step>(() => {
    if (steps.includes(step)) return step;
    const from = ALL_STEPS.indexOf(step);
    return (
      steps.find((candidate) => ALL_STEPS.indexOf(candidate) >= from) ??
      steps[steps.length - 1] ??
      'file'
    );
  }, [steps, step]);

  const counts = preview?.batch.counts;
  /**
   * A per-row write is settling. BOTH row writes gate the same things, because
   * both change which rows are importable AND whether the review step still
   * exists: nothing may step forward onto a preview that is about to change,
   * step back out of it, start a second write, or reach the button that books
   * money, until the server has answered.
   */
  const rowWriteInFlight = resolveMutation.isPending || confirmMutation.isPending;
  const stepIndex = steps.indexOf(activeStep);
  const canGoBack = stepIndex > 0 && result === null;

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
        reads={referenceReads}
        errorLabel={t('portfolio.import.referenceDataLoadError')}
      />

      {preview && result === null ? <Stepper current={activeStep} steps={steps} t={t} /> : null}

      {/* ── Step 1 — the file ── */}
      {activeStep === 'file' ? (
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
                variant="primary"
              >
                {uploadMutation.isPending
                  ? t('portfolio.import.uploading')
                  : t('portfolio.import.uploadCta')}
              </Button>
            </div>
            {/*
              The generic staging path may spend the caller's SHARED per-user
              daily AI budget — the same one insights and the NL builder draw on
              (§6.18, one cap per user, not per feature). Disclosed here, BEFORE
              the upload that would spend it, as one compact line rather than a
              panel; when no assistant is configured (or the `ai` flag is off)
              `available` is false and nothing about AI renders at all (#1857).
            */}
            {aiCapability.data?.available ? (
              <p className="bt-meta" style={{ maxWidth: 640 }}>
                {t('portfolio.import.aiBudgetNote', {
                  remaining: aiCapability.data.remaining,
                  cap: aiCapability.data.dailyCap,
                })}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Step 2 — what the file turned out to be ── */}
      {activeStep === 'understood' && preview?.understanding ? (
        <section className="bt-section flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="bt-h3">
              {t('portfolio.import.understanding.title', { filename: preview.batch.filename })}
            </h2>
            <span className="bt-meta">
              {t('portfolio.import.detectedBroker', { broker: preview.batch.brokerLabel })}
            </span>
          </div>
          <ImportUnderstandingPanel t={t} understanding={preview.understanding} />
        </section>
      ) : null}

      {/* ── Step 3 — only what needs a person ── */}
      {activeStep === 'review' && preview ? (
        <section className="bt-section flex flex-col gap-3">
          <h2 className="bt-h3">{t('portfolio.import.review.title')}</h2>
          <ImportReviewPanel
            busy={rowWriteInFlight}
            onConfirmKind={(rowIds, kind) => confirmMutation.mutate({ rowIds, kind })}
            onResolve={(rowId, assetId) => resolveMutation.mutate({ rowId, assetId })}
            rows={preview.rows}
            t={t}
          />
        </section>
      ) : null}

      {/* ── Step 4 — the staged truth, then the one button that writes ── */}
      {activeStep === 'confirm' && preview && counts ? (
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
              <ImportPreviewTable rows={preview.rows} t={t} tagsById={tagsById} />
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
                      style={{ accentColor: 'var(--bt-gold-graphic)' }}
                      type="checkbox"
                    />
                    <span className="bt-meta">{t('portfolio.import.linkCashLabel')}</span>
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={
                      discardMutation.isPending || applyMutation.isPending || rowWriteInFlight
                    }
                    onClick={() => discardMutation.mutate()}
                  >
                    {t('portfolio.import.discardCta')}
                  </Button>
                  <Button
                    disabled={applyMutation.isPending || rowWriteInFlight || counts.mapped === 0}
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

      {/* ── The result report replaces the confirm step in place ── */}
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

      {/* ── Wizard footer: Back, and Continue where a step is informational ── */}
      {preview && result === null ? (
        <div className="bt-pfw__foot">
          {canGoBack ? (
            <Button
              disabled={rowWriteInFlight}
              onClick={() => setStep(steps[stepIndex - 1]!)}
              variant="quiet"
            >
              {t('common.back')}
            </Button>
          ) : (
            <span />
          )}
          {activeStep !== 'confirm' ? (
            <Button
              disabled={rowWriteInFlight}
              onClick={() => setStep(steps[stepIndex + 1] ?? 'confirm')}
              variant="primary"
            >
              {t('common.continue')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
