/**
 * Notification bell (PROJECTPLAN.md §6.10, §7.4) — **placeholder only**.
 *
 * V1's in-app bell (unread badge, dropdown list, mark-read) is wired to the
 * notifications API in P6; this shell renders the header slot as an inert,
 * clearly-disabled control so the layout is final now and only the data-wiring
 * lands later.
 */
export function NotificationBell() {
  return (
    <button
      type="button"
      disabled
      aria-label="Notifications (coming soon)"
      title="Notifications — coming soon"
      className="grid h-9 w-9 place-items-center rounded-md text-neutral-500 ring-1 ring-inset ring-neutral-800 disabled:cursor-not-allowed"
    >
      <span aria-hidden="true" className="text-base">
        🔔
      </span>
    </button>
  );
}
