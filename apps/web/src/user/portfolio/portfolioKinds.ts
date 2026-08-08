import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  DEFAULT_PORTFOLIO_KIND,
  PORTFOLIO_KINDS,
  type PortfolioKind,
  type PortfolioSummary,
} from '@bettertrack/contracts';

import type { IconName } from '../../ui/origin';

import { usePortfolioStore } from './PortfolioStoreProvider';

/**
 * Portfolio kind — the purpose category a portfolio is filed under (private,
 * family, business, savings, property). It drives the icon shown in the
 * switcher trigger, the switcher list and the portfolio settings page, so a
 * long portfolio list stays scannable at a glance.
 *
 * ⚠️ NAMING: `kind` is the internal name only. To the user this is the
 * portfolio's **Icon** (settings section, aria labels, helper copy) — a colour
 * plus a glyph, not a taxonomy they have to reason about. Rename the copy, never
 * the type.
 *
 * GRADUATED (board #69). The kind now lives on the portfolio row: it is read off
 * `PortfolioSummary.kind` and written with `PATCH /portfolios/:id`, so it
 * follows the account to every device instead of living in one browser. The
 * public surface below is otherwise unchanged from the localStorage era —
 * {@link PortfolioKind}, {@link PORTFOLIO_KINDS}, {@link PORTFOLIO_KIND_ICONS},
 * {@link portfolioIconName}, {@link usePortfolioKind} — because it was
 * API-shaped from the start.
 *
 * The enum itself moved to `@bettertrack/contracts` (it is the wire contract
 * now, shared with the mobile app, which ported these hues) and is re-exported
 * here so imports of this module keep working. Reads take the portfolio rows the
 * caller already loaded rather than firing a second query behind its back: the
 * surface's own async state stays the one story about the portfolio list.
 *
 * LEGACY FALLBACK: the stopgap's `localStorage` map is still READ — never
 * written — for portfolios the server has no kind for yet (`kind === null`).
 * That is what keeps a browser that classified its portfolios before this
 * shipped looking exactly the same, right up until the first server write for
 * that portfolio takes over. The stopgap documented no data migration, so
 * nothing is silently PATCHed upward on the user's behalf; a kind becomes
 * account-wide the moment they next pick one.
 */

export { DEFAULT_PORTFOLIO_KIND, PORTFOLIO_KINDS, type PortfolioKind };

/** The Origin stroke glyph each kind renders with (`ui/origin/icons.tsx`). */
export const PORTFOLIO_KIND_ICONS: Record<PortfolioKind, IconName> = {
  private: 'user-lock',
  family: 'family',
  business: 'briefcase',
  savings: 'piggy-bank',
  property: 'building',
};

/**
 * The glyph a group (MIRRORCHAIN) portfolio renders with instead of its kind
 * icon. A synced copy is structurally different from every purpose category, so
 * it gets its own trio glyph rather than a decorated kind icon (V5-P7 M5).
 */
export const PORTFOLIO_GROUP_ICON: IconName = 'users';

/**
 * Which hue an icon chip is tinted with: one per kind, plus `group` for the
 * synced-copy glyph. The hues themselves live in CSS
 * (`.bt-pf-chip--<tint>` in the R2 switcher section of `styles/origin.css`),
 * taken off the validated categorical palette — see that section for why the
 * green/teal/red/gold slots are excluded.
 */
export type PortfolioIconTint = PortfolioKind | 'group';

/**
 * The tint one portfolio row renders with: its kind's hue, resolved exactly like
 * {@link portfolioIconName} so colour never claims something the glyph
 * contradicts. The `group` hue is reserved for the shared-book marker.
 */
export function portfolioIconTint(
  _portfolio: Pick<PortfolioSummary, 'mirror'>,
  kind: PortfolioKind,
): PortfolioIconTint {
  return kind;
}

/** localStorage key the pre-#69 stopgap wrote the portfolioId → kind map under. */
const STORAGE_KEY = 'bt.portfolio.kinds';

type KindMap = Readonly<Record<string, PortfolioKind>>;

const EMPTY: KindMap = Object.freeze({});

function isKind(value: unknown): value is PortfolioKind {
  return typeof value === 'string' && (PORTFOLIO_KINDS as readonly string[]).includes(value);
}

/**
 * Cached parse of the legacy map. Read once per session and never written: the
 * server owns kinds now, so there is nothing to invalidate.
 */
let legacySnapshot: KindMap | null = null;

function readLegacy(): KindMap {
  if (legacySnapshot !== null) return legacySnapshot;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      legacySnapshot = EMPTY;
      return legacySnapshot;
    }
    const clean: Record<string, PortfolioKind> = {};
    for (const [id, kind] of Object.entries(parsed as Record<string, unknown>)) {
      if (isKind(kind)) clean[id] = kind;
    }
    legacySnapshot = Object.freeze(clean);
  } catch {
    // Private-mode / disabled storage / corrupt JSON: the fallback is a nicety
    // on top of the server value, so degrade to "no fallback" rather than
    // breaking the switcher.
    legacySnapshot = EMPTY;
  }
  return legacySnapshot;
}

/** Test/teardown helper: drop the cached legacy map so storage is re-read. */
export function resetPortfolioKindCache(): void {
  legacySnapshot = null;
}

/**
 * The kind map for a list of portfolios: the server's value where it has one,
 * the legacy per-browser value where it does not. Ids with neither are absent —
 * callers fall back to {@link DEFAULT_PORTFOLIO_KIND}, exactly as before.
 */
export function portfolioKindsFor(
  portfolios: readonly Pick<PortfolioSummary, 'id' | 'kind'>[],
): KindMap {
  const legacy = readLegacy();
  const map: Record<string, PortfolioKind> = {};
  for (const portfolio of portfolios) {
    const resolved = portfolio.kind ?? legacy[portfolio.id];
    if (resolved !== undefined) map[portfolio.id] = resolved;
  }
  return Object.freeze(map);
}

/** One portfolio's kind, resolved the same way, defaulting when neither has one. */
export function portfolioKindOf(
  portfolio: Pick<PortfolioSummary, 'id' | 'kind'> | null | undefined,
): PortfolioKind {
  if (!portfolio) return DEFAULT_PORTFOLIO_KIND;
  return portfolio.kind ?? readLegacy()[portfolio.id] ?? DEFAULT_PORTFOLIO_KIND;
}

/**
 * One portfolio's kind plus a setter bound to it.
 *
 * The kind is READ off the portfolio the caller already has — this module fires
 * no query of its own, so the surface's own loading/error state stays the one
 * story about the portfolio list (the V5 async-read gate would otherwise count
 * a second, invisible read here with no states of its own). The setter is the
 * `PATCH /portfolios/:id` mutation, fire-and-forget from the caller's side just
 * as the localStorage write it replaces was, invalidating the portfolio lists so
 * the switcher and the picker never disagree.
 */
export function usePortfolioKind(
  portfolio: Pick<PortfolioSummary, 'id' | 'kind'> | null | undefined,
): [PortfolioKind, (kind: PortfolioKind) => void] {
  const store = usePortfolioStore();
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: PortfolioKind }) =>
      store.updatePortfolio(id, { kind }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
  const portfolioId = portfolio?.id ?? null;
  const set = useCallback(
    (kind: PortfolioKind) => {
      if (portfolioId !== null) mutate({ id: portfolioId, kind });
    },
    [mutate, portfolioId],
  );
  return [portfolioKindOf(portfolio), set];
}

/**
 * The glyph one portfolio row renders with: always its chosen kind icon.
 *
 * A group portfolio used to be forced onto the group glyph, which quietly made
 * the Icon setting a no-op for exactly the portfolios people most want to tell
 * apart (owner). Being shared is now carried by a small marker on the chip
 * ({@link isGroupPortfolio} → `PortfolioIconChip group`) instead, so the two
 * facts — what this book is for, and that others are in it — no longer compete
 * for one glyph.
 */
export function portfolioIconName(
  _portfolio: Pick<PortfolioSummary, 'mirror'>,
  kind: PortfolioKind,
): IconName {
  return PORTFOLIO_KIND_ICONS[kind];
}

/** Whether this row is a synced copy of an active chain — the group signal. */
export function isGroupPortfolio(portfolio: Pick<PortfolioSummary, 'mirror'>): boolean {
  return Boolean(portfolio.mirror);
}
