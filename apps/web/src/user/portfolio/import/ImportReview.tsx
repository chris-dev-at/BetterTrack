import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ImportRow, ImportRowCandidate, SearchResultItem } from '@bettertrack/contracts';

import type { TranslateFn } from '../../../i18n';
import { EM_DASH, formatDate } from '../../../lib/format';
import { searchAssets } from '../../../lib/searchApi';
import { Badge, Button, Empty, Field, Input } from '../../../ui/origin';

/**
 * The review step: the rows the pipeline could not finish, and the controls to
 * finish them (§16 2026-07-31 points 3 and 4 — *ask only about what it could
 * not*, and *unresolved assets are resolvable IN the wizard … never a dead end
 * and never a silent mis-map*).
 *
 * Two populations, deliberately kept apart because only one is actionable here:
 *
 *  - `unmapped` rows PARSED fine but their instrument did not resolve. These are
 *    the actionable ones: the row shows the identity the file gave, the
 *    near-matches the catalog search already returned, and a search box for
 *    anything else. Picking calls `PATCH /imports/:batchId/rows/:rowId`.
 *  - `error` rows could not be read at all (an unreadable date, a non-EUR cash
 *    amount, a kind the classifier will not guess). Nothing here can repair
 *    those, so they are LISTED WITH THEIR REASON rather than hidden — the rule
 *    is that a row is never silently dropped, not that every row is fixable.
 *
 * ── WHY A CANDIDATE IS NEVER PRE-SELECTED ────────────────────────────────────
 *
 * Candidates arrive ranked by the search's own order with NO score attached,
 * because nothing was measured — the server is explicit about that. So the UI
 * must not imply one is "the" answer: there is no default selection, no
 * highlighted first row, and no confidence number invented to fill the column.
 * What is shown instead is provenance a human can judge — symbol, name,
 * exchange, currency, type — and the identity the file actually carried, so the
 * comparison is theirs to make.
 */

const MIN_SEARCH_CHARS = 2;

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
  const trimmed = term.trim();

  // Only searches once the user has typed something worth a query — the catalog
  // read is cheap but a one-character term returns noise, not help.
  const searchQuery = useQuery({
    queryKey: ['search', trimmed],
    queryFn: ({ signal }) => searchAssets(trimmed, signal),
    enabled: trimmed.length >= MIN_SEARCH_CHARS,
    staleTime: 30_000,
  });

  const candidates = row.candidates ?? [];
  const results = searchQuery.data?.results ?? [];

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

      {trimmed.length >= MIN_SEARCH_CHARS ? (
        <ul className="flex flex-col">
          {searchQuery.isLoading ? (
            <li className="bt-meta py-2">{t('common.loading')}</li>
          ) : searchQuery.error ? (
            // The search is an aid, not the only way through — a failed lookup
            // says so and offers a retry, and the candidates above still stand.
            <li className="flex items-center gap-2 py-2">
              <span className="bt-meta" role="alert">
                {t('portfolio.import.review.searchFailed')}
              </span>
              <Button onClick={() => void searchQuery.refetch()} size="sm" variant="quiet">
                {t('common.retry')}
              </Button>
            </li>
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

export function ImportReviewPanel({
  rows,
  busy,
  onResolve,
  t,
}: {
  rows: ImportRow[];
  busy: boolean;
  onResolve: (rowId: string, assetId: string) => void;
  t: TranslateFn;
}) {
  const unresolved = rows.filter((r) => r.flag === 'unmapped');
  const errored = rows.filter((r) => r.flag === 'error');

  if (unresolved.length === 0 && errored.length === 0) {
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
            {t('portfolio.import.review.unresolvedTitle', { count: unresolved.length })}
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

      {errored.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="bt-h3">
            {t('portfolio.import.review.skippedTitle', { count: errored.length })}
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
