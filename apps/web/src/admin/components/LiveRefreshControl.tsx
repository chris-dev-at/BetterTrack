import { useT } from '../../i18n';
import { LIVE_REFRESH_SECONDS, type LiveRefresh, type LiveRefreshSeconds } from '../useLiveRefresh';

import { TEXT_MICRO, TEXT_NUM } from './tokens';
import { Button, SegmentedControl, cx } from './ui';

/**
 * The cockpit's refresh control (#1406 W4).
 *
 * Two things live together on purpose: the manual Refresh button W1 established
 * everywhere, and the cadence picker that makes the automatic refresh a stated,
 * operator-owned fact rather than a hidden timer. The line underneath is the
 * "visible cadence" — it says when the numbers on screen were read and, when
 * polling is suspended because the tab is in the background, that it is
 * suspended. A dashboard that silently stops updating is worse than one that
 * never updated.
 */
export function LiveRefreshControl({ live, busy }: { live: LiveRefresh; busy: boolean }) {
  const t = useT();

  const options = LIVE_REFRESH_SECONDS.map((seconds) => ({
    value: String(seconds) as `${LiveRefreshSeconds}`,
    label: seconds === 0 ? t('admin.ops.live.off') : t('admin.ops.live.seconds', { seconds }),
  }));

  const status =
    live.seconds === 0
      ? t('admin.ops.live.manualOnly')
      : live.paused
        ? t('admin.ops.live.pausedHidden')
        : t('admin.ops.live.every', { seconds: live.seconds });

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label={t('admin.ops.live.label')}
          onChange={(value) => live.setSeconds(Number(value) as LiveRefreshSeconds)}
          options={options}
          value={String(live.seconds) as `${LiveRefreshSeconds}`}
        />
        <Button disabled={busy} onClick={live.refreshNow} size="sm" variant="secondary">
          {t('admin.ops.refresh')}
        </Button>
      </div>
      {/* `role="status"` so a screen reader hears the cadence change, but polite:
          an operator reading a table must not be interrupted every 30 seconds. */}
      <p className={cx(TEXT_MICRO, TEXT_NUM, 'normal-case tracking-normal')} role="status">
        {status}
        {live.lastRefreshedAt
          ? ` · ${t('admin.ops.live.updatedAt', {
              time: live.lastRefreshedAt.toLocaleTimeString(),
            })}`
          : null}
      </p>
    </div>
  );
}
