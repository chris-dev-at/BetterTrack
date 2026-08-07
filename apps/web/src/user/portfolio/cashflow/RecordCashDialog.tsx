import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { CashMovement, CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import {
  CASH_TAGS_QUERY_KEY,
  listCashTags,
  previewCashRules,
  setCashMovementTags,
} from '../../../lib/cashApi';
import { cx } from '../../../lib/cx';
import { formatDate } from '../../../lib/format';
import {
  chargeCashFee,
  deleteCashMovement,
  depositCash,
  listCashSources,
  previewCash,
  updateCashMovement,
  withdrawCash,
} from '../../../lib/portfolioApi';
import { Dialog } from '../../components/Dialog';
import { AsyncReadState } from '../../components/AsyncReadState';
import { Alert } from '../../components/ui';
import { useMutationFeedback } from '../../hooks/useMutationFeedback';
import { MoneyText } from '../../../ui';
import { activeSources, sortSourcesMainFirst } from '../cashSourceUtils';
import { TagChip } from './TagChip';

/**
 * RECORD A CASH TRANSACTION (owner, 2026-07-31; reworked after review).
 *
 * Built to the shape of `components/TransactionDialog` — the owner's reference
 * for "thought out" — rather than as a generic form: the same uppercase field
 * labels, the same pos/neg tinted segmented control, the same
 * `surface-strong` bordered blocks, and the same footer that states the total
 * next to the button that commits it.
 *
 * ── ORDER AND COLOUR ──
 *
 * Money IN is first and green, money OUT second and red. In is first because a
 * ledger starts by being funded, and because a left-to-right reader meets the
 * additive case first; the colours mean you can see which one is armed without
 * reading either label.
 *
 * ── "MONEY IN / MONEY OUT", NOT "DEPOSIT / WITHDRAW" ──
 *
 * Considered properly, because the owner asked. This ledger holds two things at
 * once: funding a portfolio, and everyday spending. Bank vocabulary only fits
 * the first — "withdraw €42" is not what anyone calls buying groceries, and
 * "deposit" is not what anyone calls being paid. "Spent / received" has the
 * mirror problem: moving €5 000 into your brokerage is not "receiving" it. The
 * only pair that stays true for BOTH jobs is direction, so direction it is; the
 * ledger keeps `deposit`/`withdrawal` as its own kind names, where they belong.
 *
 * ── NO "MORE" LINK ──
 *
 * The details are a real, permanently visible section header that expands, not
 * a text link floating between fields. Same reason the summary is a bordered
 * block: a form that commits money should look assembled, not stacked.
 */

type Direction = 'in' | 'out';

export interface RecordCashDialogProps {
  portfolioId: string;
  /** Preselects a source — an account card opens this already pointed at itself. */
  sourceId?: string;
  /** Preselects a direction — the account cards' quick actions use this. */
  direction?: Direction;
  /**
   * EDIT MODE (owner, 2026-07-31): the movement being corrected. The same form
   * records and edits deliberately — one dialog means the fields, the vocabulary
   * ("money in / money out") and the tag preview cannot drift between creating a
   * transaction and fixing one, which is exactly what a separate edit form would
   * eventually do.
   */
  movement?: CashMovement;
  onClose: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `2026-07-31T12:00:00Z` → `2026-07-31`, for the date input. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Reconcile the tags of a movement that was just corrected.
 *
 * A naive "send what the user ticked" would strip the system tag the kind
 * earns, and a naive "merge everything" would make un-ticking a tag do nothing.
 * So the write is: the server's post-edit set, MINUS the user tags that were on
 * the row and are no longer ticked, PLUS the ones that now are. System tags and
 * anything the rules just assigned are carried through untouched — they are not
 * the user's to lose by editing an amount.
 *
 * Sends nothing when the result equals what the server already has.
 */
async function syncEditedTags(
  before: CashMovement,
  serverTags: readonly string[],
  ticked: ReadonlySet<string>,
  userTagIds: ReadonlySet<string>,
): Promise<void> {
  const next = new Set(serverTags);
  for (const id of before.tags ?? []) {
    if (userTagIds.has(id) && !ticked.has(id)) next.delete(id);
  }
  for (const id of ticked) next.add(id);
  const unchanged = next.size === serverTags.length && serverTags.every((id) => next.has(id));
  if (unchanged) return;
  await setCashMovementTags(before.id, [...next]);
}

/** A hoverable "i" carrying the long explanation a short label cannot. */
function InfoPoint({ text }: { text: string }) {
  return (
    <span
      aria-label={text}
      className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center"
      style={{
        background: 'var(--bt-surface-strong)',
        borderRadius: '50%',
        color: 'var(--bt-muted)',
        fontSize: 10,
        fontWeight: 640,
      }}
      title={text}
    >
      i
    </span>
  );
}

/** The uppercase caption `TransactionDialog` uses for every field. */
function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label className="text-[0.7rem] font-medium uppercase tracking-wide bt-muted" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

export function RecordCashDialog({
  portfolioId,
  sourceId,
  direction: initialDirection,
  movement,
  onClose,
}: RecordCashDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();
  const amountId = useId();
  const noteId = useId();
  const dateId = useId();
  const accountFieldId = useId();

  const editing = movement ?? null;
  const [direction, setDirection] = useState<Direction>(
    editing ? (editing.amountEur > 0 ? 'in' : 'out') : (initialDirection ?? 'out'),
  );
  const [amount, setAmount] = useState(editing ? String(Math.abs(editing.amountEur)) : '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [date, setDate] = useState(editing ? dayOf(editing.executedAt) : today());
  const [source, setSource] = useState<string | undefined>(editing?.sourceId ?? sourceId);
  const [countsToPerformance, setCountsToPerformance] = useState(editing?.kind === 'fee');
  // In edit mode this starts as the movement's CURRENT set, so the tag
  // toggles show what is on the row rather than an empty slate — and so
  // un-ticking one actually removes it.
  const [manualTagIds, setManualTagIds] = useState<Set<string>>(new Set(editing?.tags ?? []));
  // The details block holds the tags; when a row already has some, hiding them
  // behind a disclosure would mean an edit that silently drops what it cannot see.
  const [showDetails, setShowDetails] = useState((editing?.tags ?? []).length > 0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourcesQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash-sources', false],
    queryFn: ({ signal }) => listCashSources(portfolioId, false, signal),
    staleTime: 30_000,
  });
  const tagsQuery = useQuery({
    queryKey: CASH_TAGS_QUERY_KEY,
    queryFn: ({ signal }) => listCashTags(signal),
    staleTime: 30_000,
  });

  const sources = useMemo(
    () => sortSourcesMainFirst(activeSources(sourcesQuery.data?.sources ?? [])),
    [sourcesQuery.data],
  );
  const target = source
    ? (sources.find((candidate) => candidate.id === source) ?? null)
    : (sources[0] ?? null);
  // A source-card quick action is already scoped before this metadata read
  // starts. Keep that explicit id authoritative while the source list is
  // pending or unavailable; omitting it would make the API silently book the
  // movement against Main instead.
  const targetSourceId = source ?? target?.id;
  const tagsById = useMemo(
    () => new Map<string, CashTag>((tagsQuery.data?.tags ?? []).map((tag) => [tag.id, tag])),
    [tagsQuery.data],
  );
  const userTags = useMemo(
    () => (tagsQuery.data?.tags ?? []).filter((tag) => !tag.system),
    [tagsQuery.data],
  );
  // Which ids the toggles actually govern — an edit may only add or remove
  // these, never a system tag the kind earns.
  const userTagIds = useMemo(() => new Set(userTags.map((tag) => tag.id)), [userTags]);

  const [ruleTagIds, setRuleTagIds] = useState<readonly string[]>([]);
  useEffect(() => {
    const trimmed = note.trim();
    if (trimmed === '') {
      setRuleTagIds([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewCashRules(trimmed, controller.signal)
        .then((result) => setRuleTagIds(result.tagIds))
        // A preview is a courtesy — never surface its failure over the form.
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [note]);

  const parsedAmount = Number(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const kind = direction === 'in' ? 'deposit' : countsToPerformance ? 'fee' : 'withdrawal';
  // The server preview answers "what does ADDING this leave?", which is the
  // wrong question for an edit — the row is already in the balance it would be
  // compared against. In edit mode the receipt does the arithmetic locally
  // (take the old amount out, put the new one in) and the server still has the
  // final word on solvency when Save is pressed.
  const previewQuery = useQuery({
    queryKey: [
      'portfolio',
      portfolioId,
      'cash-preview',
      direction,
      countsToPerformance,
      parsedAmount,
      targetSourceId,
    ],
    queryFn: ({ signal }) =>
      previewCash(
        portfolioId,
        { kind, amountEur: parsedAmount, ...(targetSourceId ? { sourceId: targetSourceId } : {}) },
        signal,
      ),
    enabled: editing === null && amountValid && targetSourceId !== undefined,
    staleTime: 0,
  });

  const submit = useMutation({
    mutationFn: async () => {
      // Cash movements use noon UTC so they replay after same-day trades.
      const executedAt = new Date(`${date}T12:00:00Z`).toISOString();
      if (editing) {
        const result = await updateCashMovement(portfolioId, editing.id, {
          kind,
          amountEur: parsedAmount,
          ...(targetSourceId ? { sourceId: targetSourceId } : {}),
          executedAt,
          // `null` clears the note; omitting it would leave the old one in place.
          note: note.trim() === '' ? null : note.trim(),
        });
        await syncEditedTags(editing, result.movement.tags ?? [], manualTagIds, userTagIds);
        return result;
      }
      const body = {
        amountEur: parsedAmount,
        ...(targetSourceId ? { sourceId: targetSourceId } : {}),
        ...(date === today() ? {} : { executedAt }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      };
      const result =
        direction === 'in'
          ? await depositCash(portfolioId, body)
          : countsToPerformance
            ? await chargeCashFee(portfolioId, body)
            : await withdrawCash(portfolioId, body);

      // Only when the user actually picked tags: `setCashMovementTags` REPLACES
      // the set, so sending it unasked would wipe what the rules just earned.
      if (manualTagIds.size > 0) {
        const merged = new Set([...(result.movement.tags ?? []), ...manualTagIds]);
        await setCashMovementTags(result.movement.id, [...merged]);
      }
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      feedback.success(
        t(
          editing
            ? 'mutationFeedback.cash.transactionUpdated'
            : 'mutationFeedback.cash.transactionCreated',
        ),
      );
      onClose();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError &&
          (err.code === 'INSUFFICIENT_CASH' ||
            err.code === 'CASH_MOVEMENT_NOT_EDITABLE' ||
            // Tax year lock (§16 2026-08-07): the server copy names the
            // locked year and the unlock path.
            err.code === 'TAX_YEAR_LOCKED')
          ? err.message
          : t('portfolio.cash.saveError'),
      );
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteCashMovement(portfolioId, editing!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      feedback.success(t('mutationFeedback.cash.transactionDeleted'));
      onClose();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError &&
          (err.code === 'INSUFFICIENT_CASH' ||
            err.code === 'CASH_MOVEMENT_NOT_EDITABLE' ||
            // Tax year lock (§16 2026-08-07): the server copy names the
            // locked year and the unlock path.
            err.code === 'TAX_YEAR_LOCKED')
          ? err.message
          : t('cashflow.record.deleteError'),
      );
    },
  });

  function toggleTag(tagId: string) {
    setManualTagIds((previous) => {
      const next = new Set(previous);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!amountValid) {
      setError(t('portfolio.cash.amountRequired'));
      return;
    }
    submit.mutate();
  }

  const previewTags = [...new Set([...ruleTagIds, ...manualTagIds])]
    .map((id) => tagsById.get(id))
    .filter((tag): tag is CashTag => tag !== undefined);
  const signed = direction === 'in' ? parsedAmount : -parsedAmount;
  // The balance the receipt counts down from. Adding leaves the source's
  // balance where it is and appends; editing has to take the old row out first,
  // and a row MOVED to another account leaves the old one entirely.
  const balanceBefore =
    editing && target && editing.sourceId === target.id
      ? target.balanceEur - editing.amountEur
      : (target?.balanceEur ?? 0);
  const balanceAfter = editing
    ? balanceBefore + (amountValid ? signed : 0)
    : previewQuery.data
      ? previewQuery.data.afterEur
      : (target?.balanceEur ?? 0);

  return (
    <Dialog
      onClose={onClose}
      phoneSheet
      title={editing ? t('cashflow.record.editTitle') : t('cashflow.record.title')}
      widthClassName="max-w-md"
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {/* Sources and tags fail independently; each keeps (or is denied) its own
            Retry rather than borrowing the other read's classification. */}
        <AsyncReadState
          loading={sourcesQuery.isLoading || tagsQuery.isLoading}
          reads={[
            { error: sourcesQuery.error, refetch: () => sourcesQuery.refetch() },
            { error: tagsQuery.error, refetch: () => tagsQuery.refetch() },
          ]}
          errorLabel={t('common.genericError')}
        />

        {/* Direction — armed state is legible by colour alone. */}
        <div aria-label={t('cashflow.record.directionAria')} className="bt-seg w-full" role="group">
          <button
            aria-pressed={direction === 'in'}
            className={cx('flex-1', direction === 'in' && 'is-active')}
            onClick={() => setDirection('in')}
            style={
              direction === 'in'
                ? { background: 'var(--bt-pos-soft)', color: 'var(--bt-pos)' }
                : undefined
            }
            type="button"
          >
            {t('cashflow.record.moneyIn')}
          </button>
          <button
            aria-pressed={direction === 'out'}
            className={cx('flex-1', direction === 'out' && 'is-active')}
            onClick={() => setDirection('out')}
            style={
              direction === 'out'
                ? { background: 'var(--bt-neg-soft)', color: 'var(--bt-neg)' }
                : undefined
            }
            type="button"
          >
            {t('cashflow.record.moneyOut')}
          </button>
        </div>

        {/* Amount and account on ONE line: they are asked together and neither
            needs a full row to itself. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5" style={{ flexBasis: 140 }}>
            <FieldLabel htmlFor={amountId}>{t('cashflow.record.amountLabel')}</FieldLabel>
            <div className="relative">
              <input
                autoFocus
                className="bt-input"
                id={amountId}
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                style={{ paddingRight: 28 }}
                value={amount}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm bt-muted">
                €
              </span>
            </div>
          </div>
          {sources.length > 1 ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1.5" style={{ flexBasis: 140 }}>
              <FieldLabel htmlFor={accountFieldId}>{t('portfolio.cash.sourceLabel')}</FieldLabel>
              <select
                className="bt-select"
                id={accountFieldId}
                onChange={(event) => setSource(event.target.value)}
                value={target?.id ?? ''}
              >
                {sources.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={noteId}>{t('cashflow.record.noteLabel')}</FieldLabel>
          <input
            className="bt-input"
            id={noteId}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('cashflow.record.notePlaceholder')}
            value={note}
          />
          {previewTags.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5" style={{ fontSize: 12 }}>
              <span className="bt-muted">{t('cashflow.record.willBeTagged')}</span>
              {previewTags.map((tag) => (
                <TagChip color={tag.color} key={tag.id} name={tag.name} />
              ))}
            </p>
          ) : null}
        </div>

        {/* Date is visible by default — it is asked often enough that hiding it
            cost more than it saved. The performance tick rides beside it: two
            words and an info point, not a paragraph. */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5" style={{ minWidth: 150 }}>
            <FieldLabel htmlFor={dateId}>{t('portfolio.cash.dateLabel')}</FieldLabel>
            <input
              className="bt-input"
              id={dateId}
              onChange={(event) => setDate(event.target.value || today())}
              type="date"
              value={date}
            />
          </div>
          {direction === 'out' ? (
            <label
              className="flex items-center gap-2 pb-2"
              style={{ cursor: 'pointer', fontSize: 12 }}
            >
              <input
                checked={countsToPerformance}
                onChange={(event) => setCountsToPerformance(event.target.checked)}
                style={{ accentColor: 'var(--bt-gold)' }}
                type="checkbox"
              />
              <span className="bt-soft">{t('cashflow.record.countsToPerformanceShort')}</span>
              <InfoPoint text={t('cashflow.record.countsToPerformanceHint')} />
            </label>
          ) : null}
        </div>

        {/* A plain disclosure row, not a card and not a link. */}
        <div>
          <button
            aria-expanded={showDetails}
            className="flex w-full items-center gap-1.5 py-1 text-left"
            onClick={() => setShowDetails((open) => !open)}
            type="button"
          >
            <span aria-hidden="true" className="bt-muted" style={{ fontSize: 10 }}>
              {showDetails ? '▾' : '▸'}
            </span>
            <span className="text-sm bt-soft">{t('cashflow.record.details')}</span>
          </button>

          {showDetails ? (
            <div className="flex flex-col gap-3 pt-2">
              {userTags.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>{t('cashflow.record.tagsLabel')}</FieldLabel>
                  <div
                    aria-label={t('cashflow.record.tagsLabel')}
                    className="flex flex-wrap gap-2"
                    role="group"
                  >
                    {userTags.map((tag) => (
                      <button
                        aria-pressed={manualTagIds.has(tag.id)}
                        className="bt-tag-toggle"
                        key={tag.id}
                        onClick={() => toggleTag(tag.id)}
                        type="button"
                      >
                        <TagChip color={tag.color} name={tag.name} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm bt-muted">{t('cashflow.record.receiptLabel')}</span>
                <span
                  className="rounded-md px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide bt-muted"
                  style={{ background: 'var(--bt-surface-soft)' }}
                >
                  {t('cashflow.record.receiptPlanned')}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {/* The whole receipt on ONE line: where it lands, and what it leaves. */}
        {target ? (
          <div
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
            style={{
              background: 'var(--bt-surface-strong)',
              borderColor: 'var(--bt-border-strong)',
            }}
          >
            <span className="bt-muted" style={{ fontSize: 12 }}>
              {target.name} · {formatDate(date)}
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="bt-num bt-muted" style={{ fontSize: 11 }}>
                <MoneyText amount={balanceBefore} currency="EUR" />
              </span>
              <span aria-hidden="true" className="bt-muted" style={{ fontSize: 11 }}>
                →
              </span>
              <span className="bt-num font-bold bt-gold" style={{ fontSize: 15 }}>
                <MoneyText amount={balanceAfter} currency="EUR" />
              </span>
              {amountValid ? (
                <span
                  className={cx('bt-num', direction === 'in' ? 'bt-pos' : 'bt-neg')}
                  style={{ fontSize: 11 }}
                >
                  <MoneyText amount={signed} currency="EUR" signed />
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {/*
          The preview query keys on the parsed amount with no debounce and
          staleTime 0, so every digit typed is a fresh key with no cached data
          and `isLoading` flips true. A visible spinner row here sits directly
          above the insufficient-funds alert and the Record button, so typing
          "125" inserted and removed a ~28px row three times and walked the
          submit target of a money dialog down and back under the pointer.
          Announce the load instead of laying it out; the error branch below
          still renders normally.
        */}
        <AsyncReadState
          loading={previewQuery.isLoading}
          loadingPresentation="sr-only"
          error={previewQuery.error}
          onRetry={() => void previewQuery.refetch()}
        />

        {previewQuery.data && !previewQuery.data.sufficient ? (
          <Alert tone="error">{t('portfolio.cash.blockedError')}</Alert>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}

        <button className="bt-btn bt-btn--primary w-full" disabled={submit.isPending} type="submit">
          {submit.isPending
            ? t('common.saving')
            : editing
              ? t('cashflow.record.saveEdit')
              : t('cashflow.record.submit')}
        </button>

        {/* Delete is available but never the easy press: quiet, below the
            commit button, and it asks once. Two-step in place rather than a
            second dialog — a confirm stacked on a dialog is a trap on mobile. */}
        {editing ? (
          <div className="flex items-center justify-between gap-3">
            {confirmingDelete ? (
              <>
                <span className="bt-meta">{t('cashflow.record.deleteConfirm')}</span>
                <span className="flex items-center gap-2">
                  <button
                    className="bt-btn bt-btn--sm"
                    onClick={() => setConfirmingDelete(false)}
                    type="button"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    className="bt-btn bt-btn--sm bt-btn--danger"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                    type="button"
                  >
                    {remove.isPending ? t('common.saving') : t('cashflow.record.deleteConfirmYes')}
                  </button>
                </span>
              </>
            ) : (
              <button
                className="bt-btn bt-btn--sm bt-btn--quiet"
                onClick={() => setConfirmingDelete(true)}
                type="button"
              >
                {t('cashflow.record.delete')}
              </button>
            )}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
