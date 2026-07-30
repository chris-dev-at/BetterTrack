import type { ComponentType } from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import type { IconName } from '../../../ui/origin';
import type { WidgetSettings, WidgetSize, WidgetType } from '../config';

/**
 * The contract every Home widget module implements. A widget is a plain
 * presentational component plus the metadata the builder needs to list it,
 * size it and configure it — the board itself knows nothing about any
 * individual widget beyond this shape.
 */

/** Catalog grouping in the "Add widget" drawer. */
export type WidgetGroup = 'overview' | 'charts' | 'lists';

export const WIDGET_GROUPS: readonly WidgetGroup[] = ['overview', 'charts', 'lists'];

export interface WidgetProps {
  /** This instance's persisted settings. */
  settings: WidgetSettings;
  /**
   * Persist a settings change made *inside* the widget — a chart range toggle, a
   * movers metric. Lets direct manipulation stick without entering edit mode;
   * the settings popover writes through the same path.
   */
  onSettingsChange: (patch: WidgetSettings) => void;
  /** Every active portfolio (already fetched once by the page). */
  portfolios: readonly PortfolioSummary[];
  /** The portfolios this instance reads, after {@link resolveScope}. */
  scopedPortfolios: readonly PortfolioSummary[];
  /** The single scoped portfolio, or null when the widget spans all of them. */
  scopedPortfolio: PortfolioSummary | null;
  /** True while the portfolio list itself is still loading. */
  portfoliosLoading: boolean;
  /** The instance's current size — a few widgets adapt their density to it. */
  size: WidgetSize;
}

/** One selectable range token plus the i18n key for its label. */
export interface RangeOption {
  value: string;
  labelKey: string;
}

/**
 * One display form the widget offers, plus the i18n key naming it.
 *
 * The values must match the type's entry in `WIDGET_VARIANT_RULES` — that table
 * is what validates a *stored* variant, and it lives in `config.ts` because
 * parsing may not import React. This list is the same vocabulary expressed for
 * the picker; the registry keeps the two in step.
 */
export interface VariantOption {
  value: string;
  labelKey: string;
}

/**
 * Props for a widget's own settings fields ({@link WidgetDefinition.SettingsExtra}).
 *
 * Deliberately narrower than {@link WidgetProps}: a settings field edits the
 * instance's settings and nothing else. It gets no portfolios and no resolved
 * scope, so it cannot quietly grow into a second copy of the widget — anything
 * it needs to list (the user's watchlists, an asset search) it fetches itself
 * under the same query key its owning surface uses.
 */
export interface WidgetSettingsExtraProps {
  settings: WidgetSettings;
  /** Merge a patch into this instance's settings; `undefined` clears a key. */
  onSettingsChange: (patch: WidgetSettings) => void;
}

export interface WidgetDefinition {
  type: WidgetType;
  icon: IconName;
  /** i18n key for the widget's title (used in the header row and the catalog). */
  labelKey: string;
  /** i18n key for the one-line catalog description. */
  descriptionKey: string;
  group: WidgetGroup;
  allowedSizes: readonly WidgetSize[];
  defaultSettings: WidgetSettings;
  /** Whether the settings popover offers the portfolio scope picker. */
  supportsScope: boolean;
  /**
   * Whether "All portfolios" is one of the scope options. False for widgets
   * backed by a per-portfolio endpoint that cannot be honestly aggregated (the
   * value-over-time chart): those always resolve to exactly one portfolio.
   */
  scopeAllowsAll?: boolean;
  /** Present ⇒ the settings popover offers a range picker over these tokens. */
  rangeOptions?: readonly RangeOption[];
  /**
   * Present ⇒ the settings popover offers a display-form picker. Two or three
   * forms at most: past that it stops being "the same question, differently" and
   * becomes a menu of unrelated widgets wearing one name.
   */
  variants?: readonly VariantOption[];
  /**
   * Extra settings fields for types whose configuration is not scope-or-range —
   * a row count, a watchlist, an asset. Rendered by the frame's settings popover
   * *below* the generic fields, and its presence alone makes an otherwise
   * unconfigurable widget offer the settings button.
   *
   * Colocated with the widget it configures rather than living in the frame: the
   * frame stays ignorant of what any individual widget needs, which is the same
   * bargain the rest of this contract makes.
   */
  SettingsExtra?: ComponentType<WidgetSettingsExtraProps>;
  Component: ComponentType<WidgetProps>;
}
