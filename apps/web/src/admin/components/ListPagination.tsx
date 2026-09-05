import { useT } from '../../i18n';
import { Button, cx } from './ui';
import { EDGE_TOP, TEXT_MICRO, TEXT_NUM } from './tokens';

/** The window a bounded admin list reports back with its rows. */
export interface ListPage {
  total: number;
  limit: number;
  offset: number;
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
 * invites should not be shown paging chrome.
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
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = page.offset + rowCount;
  const hasPrev = page.offset > 0;
  const hasNext = last < page.total;
  if (!hasPrev && !hasNext) return null;

  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 px-4 py-2.5', EDGE_TOP)}>
      <span className={cx(TEXT_MICRO, TEXT_NUM)}>
        {t('admin.pagination.range', { first, last, total: page.total })}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
        >
          {t('admin.pagination.previous')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext}
          onClick={() => onOffset(page.offset + page.limit)}
        >
          {t('admin.pagination.next')}
        </Button>
      </div>
    </div>
  );
}
