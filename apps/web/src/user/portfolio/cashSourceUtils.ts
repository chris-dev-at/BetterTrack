import type { CashSource } from '@bettertrack/contracts';

/**
 * Shared helpers for the cash-sources surface (V3-P3, §13.3). Kept framework-free
 * so the page, the dialogs and their unit tests all agree on ordering and the
 * default-source rule without duplicating it.
 */

/** Main first (the sticky default target of every flow), then oldest-created. */
export function sortSourcesMainFirst(sources: CashSource[]): CashSource[] {
  return [...sources].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Only the active (non-archived) sources, Main first. */
export function activeSources(sources: CashSource[]): CashSource[] {
  return sortSourcesMainFirst(sources.filter((s) => s.archivedAt === null));
}

/**
 * The source a flow should default to (V3-P3): a still-active `preferredId` when
 * given, otherwise Main, otherwise the first active source. Returns `null` when
 * there is nothing selectable.
 */
export function pickDefaultSourceId(
  sources: CashSource[],
  preferredId?: string | null,
): string | null {
  const active = activeSources(sources);
  if (preferredId && active.some((s) => s.id === preferredId)) return preferredId;
  const main = active.find((s) => s.isMain);
  return main?.id ?? active[0]?.id ?? null;
}
