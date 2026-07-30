import { useCallback, useSyncExternalStore } from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import type { IconName } from '../../ui/origin';

/**
 * Portfolio kind — the purpose category a portfolio is filed under (private,
 * family, business, savings, property). It drives the icon shown in the
 * switcher trigger, the switcher list and the portfolio settings page, so a
 * long portfolio list stays scannable at a glance.
 *
 * ⚠️ NAMING: `kind` is the internal name only. To the user this is the
 * portfolio's **Icon** (settings section, aria labels, helper copy) — a colour
 * plus a glyph, not a taxonomy they have to reason about. Rename the copy, never
 * the type or {@link STORAGE_KEY} (no migration).
 *
 * ⚠️ CLIENT-ONLY, FOR NOW. There is no `kind` field on `PortfolioSummary` and no
 * `PATCH /portfolios/:id` body field for it (see `packages/contracts/src/
 * portfolio.ts` — the patch accepts `name`, `visibility`, `defaultPayFromCash`
 * only). Until the API grows one, the mapping lives in `localStorage` under
 * {@link STORAGE_KEY}: per-browser, not synced, lost when site data is cleared.
 *
 * GRADUATION PATH: when the API gains `kind` on the portfolio row, delete the
 * storage layer below and keep the public surface — {@link PortfolioKind},
 * {@link PORTFOLIO_KINDS}, {@link PORTFOLIO_KIND_ICONS} and
 * {@link portfolioIconName} are all API-shaped already. `usePortfolioKinds`
 * becomes a read off the portfolio query and `setPortfolioKind` becomes the
 * PATCH mutation; no call site changes shape.
 */

/** Every selectable kind, in picker order. */
export const PORTFOLIO_KINDS = ['private', 'family', 'business', 'savings', 'property'] as const;

export type PortfolioKind = (typeof PORTFOLIO_KINDS)[number];

/** The kind an unclassified portfolio falls back to. */
export const DEFAULT_PORTFOLIO_KIND: PortfolioKind = 'private';

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

/** localStorage key for the portfolioId → kind map. */
const STORAGE_KEY = 'bt.portfolio.kinds';

type KindMap = Readonly<Record<string, PortfolioKind>>;

const EMPTY: KindMap = Object.freeze({});

function isKind(value: unknown): value is PortfolioKind {
  return typeof value === 'string' && (PORTFOLIO_KINDS as readonly string[]).includes(value);
}

/**
 * Cached snapshot. `useSyncExternalStore` requires a stable object identity
 * between notifications (a fresh parse each read would loop forever), so the
 * parsed map is memoised and only replaced when something actually writes.
 */
let snapshot: KindMap | null = null;
const listeners = new Set<() => void>();

function read(): KindMap {
  if (snapshot !== null) return snapshot;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      snapshot = EMPTY;
      return snapshot;
    }
    const clean: Record<string, PortfolioKind> = {};
    for (const [id, kind] of Object.entries(parsed as Record<string, unknown>)) {
      if (isKind(kind)) clean[id] = kind;
    }
    snapshot = Object.freeze(clean);
  } catch {
    // Private-mode / disabled storage / corrupt JSON: kinds are pure garnish,
    // so degrade to "everything is private" rather than breaking the switcher.
    snapshot = EMPTY;
  }
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every stored kind, keyed by portfolio id. Ids with no entry are absent. */
export function getPortfolioKinds(): KindMap {
  return read();
}

/** One portfolio's kind, defaulting to {@link DEFAULT_PORTFOLIO_KIND}. */
export function getPortfolioKind(portfolioId: string): PortfolioKind {
  return read()[portfolioId] ?? DEFAULT_PORTFOLIO_KIND;
}

/** Persist one portfolio's kind and notify every mounted hook. */
export function setPortfolioKind(portfolioId: string, kind: PortfolioKind): void {
  const next = { ...read(), [portfolioId]: kind };
  snapshot = Object.freeze(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Write failed (quota/private mode) — the in-memory snapshot still updates,
    // so the current session stays consistent; it just won't survive a reload.
  }
  for (const listener of listeners) listener();
}

/** Test/teardown helper: drop the in-memory snapshot so storage is re-read. */
export function resetPortfolioKindCache(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/**
 * Subscribe to the whole kind map. Re-renders on every
 * {@link setPortfolioKind} anywhere in the tree, so the switcher trigger, the
 * switcher list and the settings picker never disagree.
 */
export function usePortfolioKinds(): KindMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** One portfolio's kind plus a setter bound to it. */
export function usePortfolioKind(
  portfolioId: string | null,
): [PortfolioKind, (kind: PortfolioKind) => void] {
  const kinds = usePortfolioKinds();
  const set = useCallback(
    (kind: PortfolioKind) => {
      if (portfolioId !== null) setPortfolioKind(portfolioId, kind);
    },
    [portfolioId],
  );
  return [(portfolioId !== null ? kinds[portfolioId] : undefined) ?? DEFAULT_PORTFOLIO_KIND, set];
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
