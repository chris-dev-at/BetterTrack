import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ListPagination, pageRange, type ListPage } from './ListPagination';

/**
 * The footer of every bounded admin list (#1814, repaired by #1848).
 *
 * The defect these tests exist for: `first = offset + 1` / `last = offset +
 * rowCount` with no clamp. Approve the last of 26 pending applications on page
 * 2, the reload answers zero rows at `offset=25`, and the footer read
 * "26–25 of 25" — a range that counts backwards, over an empty page whose only
 * escape was hand-editing the URL.
 */

function renderFooter(page: ListPage | null, rowCount: number, onOffset = vi.fn()) {
  render(
    <I18nProvider initialLocale="en">
      <ListPagination page={page} rowCount={rowCount} onOffset={onOffset} />
    </I18nProvider>,
  );
  return onOffset;
}

test('never states a range that reads backwards, for any window', () => {
  const limits = [1, 5, 25];
  const offsets = [0, 1, 5, 25, 50, 999];
  const totals = [0, 1, 24, 25, 26, 60];
  const rowCounts = [0, 1, 24, 25];

  for (const limit of limits) {
    for (const offset of offsets) {
      for (const total of totals) {
        for (const rowCount of rowCounts) {
          const range = pageRange({ total, limit, offset }, rowCount);
          const where = `limit=${limit} offset=${offset} total=${total} rows=${rowCount}`;
          expect(range.first, where).toBeLessThanOrEqual(range.last);
          expect(range.first, where).toBeGreaterThanOrEqual(0);
          // The total may never be smaller than what is already on screen, even
          // when the server's count is stale.
          expect(range.total, where).toBeGreaterThanOrEqual(range.last);
          // An empty window shows nothing and says so, rather than claiming the
          // row positions it would have held.
          if (rowCount === 0) expect([range.first, range.last], where).toEqual([0, 0]);
          expect(range.prevOffset, where).toBeGreaterThanOrEqual(0);
          expect(range.prevOffset, where).toBeLessThan(Math.max(1, offset + 1));
        }
      }
    }
  }
});

test('reports the window it is actually showing', () => {
  renderFooter({ total: 60, limit: 25, offset: 25 }, 25);
  expect(screen.getByText('26–50 of 60')).toBeInTheDocument();
});

test('a page that emptied under the operator reports 0–0, not an inverted range', () => {
  // 26 applications, the operator is on page 2, and the only row there is gone.
  renderFooter({ total: 25, limit: 25, offset: 25 }, 0);

  expect(screen.getByText('0–0 of 25')).toBeInTheDocument();
  expect(screen.queryByText('26–25 of 25')).not.toBeInTheDocument();
});

test('keeps a usable way back on an empty page past the first', async () => {
  const user = userEvent.setup();
  const onOffset = renderFooter({ total: 25, limit: 25, offset: 25 }, 0);

  const previous = screen.getByRole('button', { name: 'Previous' });
  expect(previous).toBeEnabled();
  // Nothing is shown, so there is nothing after it either.
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

  await user.click(previous);
  expect(onOffset).toHaveBeenCalledWith(0);
});

test('renders no chrome at all when the whole set fits in the first page', () => {
  renderFooter({ total: 4, limit: 25, offset: 0 }, 4);
  expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
});

test('renders nothing before the first page has been read', () => {
  const { container } = render(
    <I18nProvider initialLocale="en">
      <ListPagination page={null} rowCount={0} onOffset={vi.fn()} />
    </I18nProvider>,
  );
  expect(container).toBeEmptyDOMElement();
});
