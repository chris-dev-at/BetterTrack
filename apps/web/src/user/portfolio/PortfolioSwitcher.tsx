/**
 * Portfolio switcher (PROJECTPLAN.md §6.8, §7.4) — **placeholder only**.
 *
 * V1 auto-creates a single default portfolio and every endpoint is already
 * `portfolio_id`-scoped, so multi-portfolio is purely additive. Until that UI
 * lands, the switcher shows the current portfolio name plus a disabled
 * "New portfolio — Coming soon" affordance, exactly as §6.8 specifies.
 */
export function PortfolioSwitcher({ portfolioName = 'My Portfolio' }: { portfolioName?: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 ring-1 ring-inset ring-neutral-800">
      <span className="text-sm font-medium text-neutral-200">{portfolioName}</span>
      <span
        className="rounded bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500"
        title="Additional portfolios — coming soon"
      >
        Default
      </span>
      <button
        type="button"
        disabled
        title="New portfolio — coming soon"
        className="ml-1 rounded border border-dashed border-neutral-700 px-2 py-0.5 text-xs text-neutral-500 disabled:cursor-not-allowed"
      >
        + New portfolio
      </button>
    </div>
  );
}
