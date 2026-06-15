/** Shared display formatting for the admin area (de-AT locale, PROJECTPLAN.md §7.1). */

const dateTimeFmt = new Intl.DateTimeFormat('de-AT', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const dateFmt = new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium' });

/** ISO timestamp → localized date+time, or an em dash when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d);
}

/** ISO timestamp → localized date only, or an em dash when absent. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}
