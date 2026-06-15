import { useParams } from 'react-router-dom';

/**
 * Placeholder bodies for the `user` routes (PROJECTPLAN.md §7.2). This issue
 * builds the auth shell and guarded routing only; the real Dashboard, Search,
 * Asset detail, Workboard, Conglomerates, Portfolio and Settings pages arrive
 * in later phases. Each renders behind `RequireUser` + `AppLayout`.
 */
function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{title}</h1>
      <p className="text-sm text-neutral-400">{blurb}</p>
      <p className="mt-4 text-xs uppercase tracking-wide text-neutral-600">
        Coming in a later phase
      </p>
    </section>
  );
}

export function DashboardPage() {
  return <Placeholder title="Dashboard" blurb="Your calm overview lands here." />;
}

export function SearchPage() {
  return <Placeholder title="Search" blurb="Find stocks, ETFs and your custom assets." />;
}

export function AssetDetailPage() {
  const { id } = useParams();
  return <Placeholder title="Asset detail" blurb={`Details for asset ${id ?? ''}.`} />;
}

export function WorkboardPage() {
  return <Placeholder title="Workboard" blurb="Watchlist, alerts and your conglomerates." />;
}

export function ConglomeratesPage() {
  return <Placeholder title="Conglomerates" blurb="Your conglomerates and the Builder." />;
}

export function PortfolioPage() {
  return <Placeholder title="Portfolio" blurb="Holdings, transactions and custom investments." />;
}

export function SettingsPage() {
  return <Placeholder title="Settings" blurb="Password and notification channels." />;
}
