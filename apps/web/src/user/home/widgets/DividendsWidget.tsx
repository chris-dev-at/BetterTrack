import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { DividendCalendarEntry } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { upcomingDividendDate } from '../../../lib/dividendDates';
import { displayZoneDay, formatDate } from '../../../lib/format';
import {
  getPortfolioDividendCalendar,
  PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY,
} from '../../../lib/marketIntelApi';
import { MoneyText } from '../../../ui';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * Dividends coming up on the assets the user holds or watches.
 *
 * Reuses the market-intel calendar (`GET /assets/portfolio/dividend-calendar`)
 * under its existing key: that endpoint already aggregates held **and** watchlist
 * assets user-level, which is also why this widget is unscoped — there is no
 * portfolio dimension to scope to, and offering a picker that changed nothing
 * would be a lie.
 *
 * `available: false` is the global market-intel gate being off. As in
 * `NewsWidget`, a widget the user deliberately placed explains itself rather than
 * rendering a blank slot they cannot account for.
 */

/** Events surfaced at most — the calendar page is one click away. */
const MAX_ROWS = 6;

export function DividendsWidget({ size }: WidgetProps) {
  const t = useT();
  const calendarQuery = useQuery({
    queryKey: PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY,
    queryFn: ({ signal }) => getPortfolioDividendCalendar(signal),
    staleTime: 3_600_000,
  });

  if (calendarQuery.isLoading) {
    return (
      <div className="bt-home-divs">
        <SkeletonBlock height={34} />
        <SkeletonBlock height={34} />
      </div>
    );
  }

  if (calendarQuery.isError || !calendarQuery.data?.available) {
    return <Empty title={t('home.widgets.dividends.unavailable')} />;
  }

  // The endpoint already orders the calendar on the date each event is upcoming
  // on, and `upcomingDividendDate` is that same rule — so the widget renders the
  // API's order as it arrived. Re-sorting here on a date chosen by a different
  // rule is exactly what reversed the list and printed a past ex-date (#1758).
  const today = displayZoneDay();
  const rows = calendarQuery.data.entries
    .map((entry) => ({ entry, date: upcomingDividendDate(entry, today) }))
    .filter((row): row is { entry: DividendCalendarEntry; date: { iso: string; isEx: boolean } } =>
      Boolean(row.date),
    )
    .slice(0, size === 's' ? 3 : MAX_ROWS);

  // The server caps the per-request provider fan-out (§5.3), so a book past that
  // budget yields a calendar covering only part of it. Say so — and say it tied
  // to `truncated`, NOT to having rows: the cap runs over the raw book, so a
  // capped read can legitimately surface no upcoming event at all, and "No
  // dividends coming up." over a book only partly read is the loudest
  // claim-of-completeness this widget can make (NewsDigestPage.tsx states the
  // same rule for the digest page).
  const truncated = calendarQuery.data.truncated === true;

  if (rows.length === 0) {
    return (
      <Empty
        title={t(
          truncated ? 'home.widgets.dividends.emptyPartial' : 'home.widgets.dividends.empty',
        )}
      />
    );
  }

  return (
    <>
      {truncated ? <p className="bt-meta">{t('home.widgets.dividends.truncated')}</p> : null}
      <ul className="bt-band">
        {rows.map(({ entry, date }) => (
          <li className="bt-home-row bt-home-row--split" key={`${entry.assetId}-${date.iso}`}>
            <span className="bt-home-row__main">
              <Link className="bt-row-title bt-home-txn__link" to={`/assets/${entry.assetId}`}>
                {entry.symbol}
              </Link>
              <span className="bt-row-sub bt-home-row__sub">
                {[
                  t(date.isEx ? 'home.widgets.dividends.exDate' : 'home.widgets.dividends.payDate'),
                  formatDate(date.iso),
                ].join(' · ')}
              </span>
            </span>
            {/*
            Only shown when the currency came with it: an amount whose
            denomination is unknown would be rendered in the user's base currency
            by default, quietly relabelling a $0.24 dividend as €0.24.
          */}
            {entry.amount !== null && entry.currency !== null ? (
              <span className="bt-num">
                <MoneyText amount={entry.amount} currency={entry.currency} unitPrice />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
