import { useState } from 'react';

import type {
  ImportRow,
  ImportRowCandidate,
  ImportRowKind,
  SearchResultItem,
} from '@bettertrack/contracts';
import { IMPORT_ROW_KINDS } from '@bettertrack/contracts';

import type { TranslateFn } from '../../../i18n';
import { EM_DASH, formatDate } from '../../../lib/format';
import { useAssetSearch } from '../../components/useAssetSearch';
import { MoneyText } from '../../../ui';
import { Badge, Button, Empty, Field, Input, Select } from '../../../ui/origin';

/**
 * The review step: the rows the pipeline could not finish, and the controls to
 * finish them (§16 2026-07-31 points 3 and 4 — *ask only about what it could
 * not*, and *unresolved assets are resolvable IN the wizard … never a dead end
 * and never a silent mis-map*).
 *
 * THREE populations, deliberately kept apart because they ask different things:
 *
 *  - `unmapped` rows PARSED fine but their instrument did not resolve. The row
 *    shows the identity the file gave, the near-matches the catalog search
 *    already returned, and a search box for anything else. Picking calls
 *    `PATCH /imports/:batchId/rows/:rowId` with an `assetId`.
 *  - UNDECIDED rows (§16 2026-08-29 gap (b)) parsed fine too — the file simply
 *    never says what they ARE. A bank statement with no booking-type column is
 *    the reference case: memo plus a signed amount, which cannot separate
 *    "money out" from "bought something", so the classifier refuses to guess.
 *    These carry `confirmableKinds`, and the same PATCH takes a `kind`.
 *  - `error` rows could not be read at all (an unreadable date, a non-EUR cash
 *    amount). Nothing here can repair those, so they are LISTED WITH THEIR
 *    REASON rather than hidden — the rule is that a row is never silently
 *    dropped, not that every row is fixable.
 *
 * The last two are both `flag: 'error'` on the wire, because that vocabulary is
 * frozen and neither will be booked as things stand. `confirmableKinds` is what
 * separates them, so this file splits on exactly that and never on the flag
 * alone — a row with something to decide must not be filed under "we can't".
 *
 * ── WHY NOTHING IS EVER PRE-SELECTED ─────────────────────────────────────────
 *
 * Candidates arrive ranked by the search's own order with NO score attached,
 * because nothing was measured — the server is explicit about that. So the UI
 * must not imply one is "the" answer: there is no default selection, no
 * highlighted first row, and no confidence number invented to fill the column.
 * What is shown instead is provenance a human can judge — symbol, name,
 * exchange, currency, type — and the identity the file actually carried, so the
 * comparison is theirs to make.
 *
 * The kind picker follows the same rule for a sharper reason, which the API's
 * own classifier states: "a reviewer working through hundreds of flagged rows
 * approves the pre-filled default in bulk, so a WRONG default is how a flagged
 * row still becomes a wrong booking". There is therefore no pre-selected kind.
 * The BULK control is the deliberate exception and it is safe by construction:
 * it offers one kind at a time, it names how many rows will take it, and it can
 * only reach rows the SERVER already said accept that kind — on a statement
 * that signs its amounts, a salary line is simply not eligible for "confirm the
 * rest as withdrawals", and stays behind to be decided on its own.
 */

/** A row whose kind is the only thing missing — the server says so, not us. */
function isUndecided(row: ImportRow): boolean {
  return (row.confirmableKinds?.length ?? 0) > 0;
}

function Identity({ row, t }: { row: ImportRow; t: TranslateFn }) {
  const parts = [row.symbol, row.isin, row.name].filter((p): p is string => Boolean(p));
  return (
    <div className="flex flex-col">
      <span className="bt-row-title">{parts[0] ?? t('portfolio.import.review.noIdentity')}</span>
      {parts.length > 1 ? <span className="bt-row-sub">{parts.slice(1).join(' · ')}</span> : null}
    </div>
  );
}

function CandidateButton({
  candidate,
  disabled,
  onPick,
  t,
}: {
  candidate: ImportRowCandidate | SearchResultItem;
  disabled: boolean;
  onPick: () => void;
  t: TranslateFn;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="flex min-w-0 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="bt-row-title">{candidate.symbol}</span>
          <span className="bt-row-sub truncate">{candidate.name}</span>
        </span>
        <span className="bt-meta">
          {[candidate.exchange, candidate.currency, candidate.type].filter(Boolean).join(' · ')}
        </span>
      </span>
      <Button disabled={disabled} onClick={onPick} size="sm">
        {t('portfolio.import.review.pick')}
      </Button>
    </li>
  );
}

function UnresolvedRow({
  row,
  busy,
  onResolve,
  t,
}: {
  row: ImportRow;
  busy: boolean;
  onResolve: (assetId: string) => void;
  t: TranslateFn;
}) {
  const [term, setTerm] = useState('');

  // The ONE catalog search every surface uses (§6.2): debounced, cached,
  // enrichment-aware, and honouring the owner's single-character directive
  // (#248 §3). Re-implementing it here with a private threshold would have made
  // this the only search box in the app that behaves differently.
  const search = useAssetSearch(term);

  const candidates = row.candidates ?? [];
  const results = search.results;

  return (
    <li className="bt-band flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="bt-meta">
            {t('portfolio.import.table.row')} {row.rowIndex}
          </span>
          <span className="bt-soft">
            {row.kind ? t(`portfolio.import.kind.${row.kind}`) : EM_DASH}
          </span>
          <span className="bt-muted">{row.executedAt ? formatDate(row.executedAt) : EM_DASH}</span>
        </span>
        <Badge tone="blue">{t('portfolio.import.flag.unmapped')}</Badge>
      </div>

      <Identity row={row} t={t} />

      {candidates.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="bt-meta">{t('portfolio.import.review.candidatesTitle')}</p>
          <ul className="flex flex-col">
            {candidates.map((candidate) => (
              <CandidateButton
                candidate={candidate}
                disabled={busy}
                key={candidate.id}
                onPick={() => onResolve(candidate.id)}
                t={t}
              />
            ))}
          </ul>
        </div>
      ) : (
        <p className="bt-meta">{t('portfolio.import.review.noCandidates')}</p>
      )}

      <Field
        htmlFor={`import-search-${row.id}`}
        hint={t('portfolio.import.review.searchHint')}
        label={t('portfolio.import.review.searchLabel')}
      >
        <Input
          id={`import-search-${row.id}`}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('portfolio.import.review.searchPlaceholder')}
          value={term}
        />
      </Field>

      {search.enabled ? (
        <ul className="flex flex-col">
          {search.isError && !search.isFetching ? (
            // The search is an aid, not the only way through: it says so, and
            // the candidates above still stand. Typing re-runs the query, so
            // there is nothing for a retry button to do that the input cannot.
            <li className="bt-meta py-2" role="alert">
              {t('portfolio.import.review.searchFailed')}
            </li>
          ) : search.isFetching && !search.hasLoaded ? (
            // Same gate `AssetSearchBox` uses: the first fetch shows progress, a
            // background refetch keeps the results that are already on screen.
            <li className="bt-meta py-2">{t('common.loading')}</li>
          ) : results.length === 0 ? (
            <li className="bt-meta py-2">{t('portfolio.import.review.searchEmpty')}</li>
          ) : (
            results
              .slice(0, 6)
              .map((result) => (
                <CandidateButton
                  candidate={result}
                  disabled={busy}
                  key={result.id}
                  onPick={() => onResolve(result.id)}
                  t={t}
                />
              ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * One row waiting on a person to say what it is.
 *
 * It shows what the file actually carried — the date, the memo, and the amount
 * with the file's own sign — because that is what the decision is made from,
 * and the server's reason underneath it. The choices are the row's own
 * `confirmableKinds`: the server computed them by dry-running the very
 * derivation a confirmation runs, so every option here is one it will accept,
 * and a direction the file contradicts is simply not offered.
 */
function UndecidedRow({
  row,
  busy,
  onConfirm,
  t,
}: {
  row: ImportRow;
  busy: boolean;
  onConfirm: (kind: ImportRowKind) => void;
  t: TranslateFn;
}) {
  const [kind, setKind] = useState<ImportRowKind | ''>('');
  const kinds = row.confirmableKinds ?? [];
  const identity = row.note ?? row.name ?? row.symbol ?? row.isin;

  return (
    <li className="bt-band flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="bt-meta">
            {t('portfolio.import.table.row')} {row.rowIndex}
          </span>
          <span className="bt-muted">{row.executedAt ? formatDate(row.executedAt) : EM_DASH}</span>
          {row.amountEur === null ? null : (
            <span className="bt-row-title">
              <MoneyText amount={row.amountEur} currency="EUR" />
            </span>
          )}
        </span>
        <Badge tone="gold">{t('portfolio.import.review.undecidedBadge')}</Badge>
      </div>

      {identity ? <span className="bt-row-sub">{identity}</span> : null}
      {row.message ? <p className="bt-meta">{row.message}</p> : null}

      <div className="flex flex-wrap items-end gap-2">
        <Field htmlFor={`import-kind-${row.id}`} label={t('portfolio.import.review.kindLabel')}>
          <Select
            id={`import-kind-${row.id}`}
            onChange={(e) => setKind(e.target.value as ImportRowKind | '')}
            value={kind}
          >
            {/* No pre-selection: see WHY NOTHING IS EVER PRE-SELECTED above. */}
            <option value="">{t('portfolio.import.review.kindPlaceholder')}</option>
            {kinds.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`portfolio.import.kind.${candidate}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          disabled={busy || kind === ''}
          onClick={() => {
            if (kind !== '') onConfirm(kind);
          }}
          size="sm"
        >
          {t('portfolio.import.review.confirmCta')}
        </Button>
      </div>
    </li>
  );
}

/**
 * "All the same kind?" — one button per kind ANY undecided row accepts, each
 * naming how many rows it would actually reach.
 *
 * The count is the honest part. A statement of nothing but deposits gives one
 * button covering every row, which is the case this exists for; a statement
 * that signs its amounts gives one button per direction, each covering only the
 * rows whose own sign agrees. Either way the label says what will happen, and
 * the parent confirms exactly those rows, one request each.
 */
function BulkKinds({
  rows,
  busy,
  onConfirmAll,
  t,
}: {
  rows: ImportRow[];
  busy: boolean;
  onConfirmAll: (rowIds: string[], kind: ImportRowKind) => void;
  t: TranslateFn;
}) {
  // Contract order, not first-seen order: the buttons must not move around
  // between renders as rows leave the list.
  const eligible = IMPORT_ROW_KINDS.map((kind) => ({
    kind,
    ids: rows.filter((row) => (row.confirmableKinds ?? []).includes(kind)).map((row) => row.id),
  })).filter((entry) => entry.ids.length > 0);

  if (eligible.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="bt-meta">{t('portfolio.import.review.bulkTitle')}</span>
      {eligible.map(({ kind, ids }) => (
        <Button
          disabled={busy}
          key={kind}
          onClick={() => onConfirmAll(ids, kind)}
          size="sm"
          variant="quiet"
        >
          {t(
            ids.length === 1
              ? 'portfolio.import.review.bulkCtaOne'
              : 'portfolio.import.review.bulkCtaOther',
            { count: ids.length, kind: t(`portfolio.import.kind.${kind}`) },
          )}
        </Button>
      ))}
    </div>
  );
}

export function ImportReviewPanel({
  rows,
  busy,
  onResolve,
  onConfirmKind,
  t,
}: {
  rows: ImportRow[];
  busy: boolean;
  onResolve: (rowId: string, assetId: string) => void;
  onConfirmKind: (rowIds: string[], kind: ImportRowKind) => void;
  t: TranslateFn;
}) {
  const unresolved = rows.filter((r) => r.flag === 'unmapped');
  const undecided = rows.filter((r) => r.flag === 'error' && isUndecided(r));
  // Split on what is ACTIONABLE, not on the flag: an undecided row shares the
  // `error` flag with an unreadable one and must not be filed under "we can't".
  const errored = rows.filter((r) => r.flag === 'error' && !isUndecided(r));

  if (unresolved.length === 0 && undecided.length === 0 && errored.length === 0) {
    return (
      <Empty icon="check" title={t('portfolio.import.review.emptyTitle')}>
        {t('portfolio.import.review.emptyBody')}
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {unresolved.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="bt-h3">
            {t(
              unresolved.length === 1
                ? 'portfolio.import.review.unresolvedTitleOne'
                : 'portfolio.import.review.unresolvedTitleOther',
              { count: unresolved.length },
            )}
          </h3>
          <p className="bt-meta" style={{ maxWidth: 640 }}>
            {t('portfolio.import.review.unresolvedBody')}
          </p>
          <ul className="flex flex-col">
            {unresolved.map((row) => (
              <UnresolvedRow
                busy={busy}
                key={row.id}
                onResolve={(assetId) => onResolve(row.id, assetId)}
                row={row}
                t={t}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {undecided.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="bt-h3">
            {t(
              undecided.length === 1
                ? 'portfolio.import.review.undecidedTitleOne'
                : 'portfolio.import.review.undecidedTitleOther',
              { count: undecided.length },
            )}
          </h3>
          <p className="bt-meta" style={{ maxWidth: 640 }}>
            {t('portfolio.import.review.undecidedBody')}
          </p>
          {/* One row is not a batch — the bulk control would just be a second
              way to do the same click. */}
          {undecided.length > 1 ? (
            <BulkKinds busy={busy} onConfirmAll={onConfirmKind} rows={undecided} t={t} />
          ) : null}
          <ul className="flex flex-col">
            {undecided.map((row) => (
              <UndecidedRow
                busy={busy}
                key={row.id}
                onConfirm={(kind) => onConfirmKind([row.id], kind)}
                row={row}
                t={t}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {errored.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="bt-h3">
            {t(
              errored.length === 1
                ? 'portfolio.import.review.skippedTitleOne'
                : 'portfolio.import.review.skippedTitleOther',
              { count: errored.length },
            )}
          </h3>
          <p className="bt-meta" style={{ maxWidth: 640 }}>
            {t('portfolio.import.review.skippedBody')}
          </p>
          <ul className="bt-band flex flex-col">
            {errored.map((row) => (
              <li className="flex flex-wrap items-baseline gap-2 py-2" key={row.id}>
                <span className="bt-meta">
                  {t('portfolio.import.table.row')} {row.rowIndex}
                </span>
                <span className="bt-soft">{row.message ?? EM_DASH}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
