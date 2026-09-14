import { useEffect, useRef } from 'react';

import { useT } from '../../i18n';
import { Button, cx } from './ui';
import { EDGE_TOP, TEXT_MICRO, TEXT_NUM } from './tokens';

/** The window a bounded admin list reports back with its rows. */
export interface ListPage {
  total: number;
  limit: number;
  offset: number;
}

/** What the footer of a bounded list may state about the window it is showing. */
export interface PageRange {
  /** 1-based index of the first row shown, or `0` when nothing is shown. */
  first: number;
  /** 1-based index of the last row shown, never less than {@link first}. */
  last: number;
  /** The set size, never smaller than what is already on screen. */
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** Where "Previous" goes. */
  prevOffset: number;
  /** Where "Next" goes. */
  nextOffset: number;
}

/**
 * The range a bounded list may honestly claim (#1848).
 *
 * The arithmetic used to be `first = offset + 1`, `last = offset + rowCount`
 * with no clamp, and it inverted the moment a window answered no rows: approve
 * the last of 26 applications on page 2 and the footer read **"26–25 of 25"**.
 * A window that answered nothing shows nothing, so it reports `0–0`; and the
 * total can never be smaller than the rows already on screen, so no combination
 * of `(offset, rowCount, total)` — a stale total included — produces a range
 * that reads backwards.
 */
export function pageRange(page: ListPage, rowCount: number): PageRange {
  const offset = Math.max(0, page.offset);
  const limit = page.limit > 0 ? page.limit : 1;
  const rows = Math.max(0, rowCount);
  const first = rows === 0 ? 0 : offset + 1;
  const last = rows === 0 ? 0 : offset + rows;
  const total = Math.max(0, page.total, last);
  return {
    first,
    last,
    total,
    hasPrev: offset > 0,
    // An empty window past the end offers no "Next": the way back is backwards.
    hasNext: rows > 0 && last < total,
    prevOffset: Math.max(0, offset - limit),
    nextOffset: offset + limit,
  };
}

/**
 * Snap a bounded list back when its window has fallen off the end of the set
 * (#1848).
 *
 * A page is a position in a set that mutates under the operator: approve the
 * only application on page 2, or bulk-disable the one user left on it, and the
 * reload behind the action re-reads the SAME offset — which now answers zero
 * rows. Without this the surface renders "No pending applications" over a queue
 * of 25 and the only escape is hand-editing `?offset=` in the URL.
 *
 * It lands on the last page that can still hold rows rather than merely one
 * page back, because a filter change or a bulk action can retire several pages
 * at once, and it re-asks only when the offset it is answering for changes — so
 * a snap that is still in flight is never issued twice.
 */
export function useOffsetSnapBack(
  page: ListPage | null,
  rowCount: number,
  onOffset: (offset: number) => void,
): void {
  // Call sites pass an inline arrow; a ref keeps the effect off its identity.
  const onOffsetRef = useRef(onOffset);
  useEffect(() => {
    onOffsetRef.current = onOffset;
  });
  const snappedFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!page) return;
    if (rowCount > 0 || page.offset <= 0) {
      snappedFrom.current = null;
      return;
    }
    if (snappedFrom.current === page.offset) return;
    snappedFrom.current = page.offset;
    const { prevOffset, total } = pageRange(page, rowCount);
    const limit = page.limit > 0 ? page.limit : 1;
    const lastPageOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
    onOffsetRef.current(Math.min(prevOffset, lastPageOffset));
  }, [page, rowCount]);
}

/**
 * The page footer for a bounded admin list (§6.12, V5-P2 — #1814).
 *
 * The users list has had one since #1406; API keys, invites and registration
 * shipped without a bound at all, so every row that had ever been written
 * arrived in one response and rendered one row each. They now read a page and
 * this offers the rest of it — same shape, same copy, one component so the
 * three surfaces cannot drift apart.
 *
 * Renders nothing when everything fits in the first page: an operator with four
 * invites should not be shown paging chrome. It does render on an EMPTY page
 * past the first one, which is the one case the chrome is load-bearing: the way
 * back has to stay on screen (#1848).
 */
export function ListPagination({
  page,
  rowCount,
  onOffset,
}: {
  page: ListPage | null;
  rowCount: number;
  onOffset: (offset: number) => void;
}) {
  const t = useT();
  if (!page) return null;
  const { first, last, total, hasPrev, hasNext, prevOffset, nextOffset } = pageRange(
    page,
    rowCount,
  );
  if (!hasPrev && !hasNext) return null;

  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 px-4 py-2.5', EDGE_TOP)}>
      <span className={cx(TEXT_MICRO, TEXT_NUM)}>
        {t('admin.pagination.range', { first, last, total })}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onOffset(prevOffset)}
        >
          {t('admin.pagination.previous')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext}
          onClick={() => onOffset(nextOffset)}
        >
          {t('admin.pagination.next')}
        </Button>
      </div>
    </div>
  );
}
