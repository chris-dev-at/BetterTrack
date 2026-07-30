import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { DividendCalendarEntry } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDate } from '../../../lib/format';
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

/**
 * The event's own date: whichever of ex-date / pay-date comes first, since either
 * may be missing. `null` when the provider gave neither, in which case the row is
 * dropped — an undated "upcoming" event is not information.
 */
function eventDate(entry: DividendCalendarEntry): { iso: string; isEx: boolean } | null {
  const { exDate, payDate } = entry;
  if (exDate !== null && payDate !== null) {
    return exDate <= payDate ? { iso: exDate, isEx: true } : { iso: payDate, isEx: false };
  }
  if (exDate !== null) return { iso: exDate, isEx: true };
  if (payDate !== null) return { iso: payDate, isEx: false };
  return null;
}

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

  const rows = calendarQuery.data.entries
    .map((entry) => ({ entry, date: eventDate(entry) }))
    .filter((row): row is { entry: DividendCalendarEntry; date: { iso: string; isEx: boolean } } =>
      Boolean(row.date),
    )
    // The endpoint already sorts ascending by the earliest of the two dates; sort
    // again anyway so the widget's own choice of date drives its own order.
    .sort((a, b) => a.date.iso.localeCompare(b.date.iso))
    .slice(0, size === 's' ? 3 : MAX_ROWS);

  if (rows.length === 0) return <Empty title={t('home.widgets.dividends.empty')} />;

  return (
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
  );
}
