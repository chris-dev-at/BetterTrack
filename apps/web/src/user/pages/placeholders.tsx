/**
 * Placeholder bodies for the `user` routes (PROJECTPLAN.md §7.2). Real pages
 * replace these as each feature issue lands. Current placeholders:
 * Dashboard, Conglomerates, Settings.
 * Search was replaced in issue #36; Asset detail in issue #37; Workboard in #38;
 * Portfolio in issue #41.
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

export function ConglomeratesPage() {
  return <Placeholder title="Conglomerates" blurb="Your conglomerates and the Builder." />;
}

export function SettingsPage() {
  return <Placeholder title="Settings" blurb="Password and notification channels." />;
}
