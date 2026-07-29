import type { FeatureFlagKey } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { useFeatureFlags } from '../../lib/featureFlags';
import { ACTIVE_PORTFOLIO_PARAM } from '../portfolio/PortfolioSwitcher';
import type { LocalNavItem } from './LocalNav';

/**
 * Section sub-navigation — ONE definition, two renderers (R2 rail nav).
 *
 * Portfolios · Workbench · Assets · People are expandable groups in the left
 * rail (`OriginShell`) *and* horizontal strips inside the page (`LocalNav`).
 * Both read the tables below, so the rail tree and the in-page tabs can never
 * drift apart.
 *
 * The strip renders the FULL set at every width; the rail tree shows only the
 * children marked `rail` — the vital pages of each section (owner: "the
 * dropdown only contains the most important options, the rest is inside the
 * nav there [the page]").
 */

export const SECTION_KEYS = ['portfolio', 'workbench', 'assets', 'people'] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export interface SectionNavChild {
  /** Target route (absolute). */
  to: string;
  /** i18n key for the label — shared verbatim by the rail and the strip. */
  labelKey: string;
  /** Only match the exact path (a section's overview tab). */
  end?: boolean;
  /** Present in the structure, build lands later (gold "planned" dot). */
  parked?: boolean;
  /** Rendered only while this runtime kill-switch is on (§13.5 V5-P2). */
  flag?: FeatureFlagKey;
  /** Curated into the rail tree (the vital pages). Strip-only when absent. */
  rail?: boolean;
}

export interface SectionNav {
  /** Section root — the rail group row links here. */
  root: string;
  /** i18n key for the strip's `aria-label`. */
  ariaLabelKey: string;
  /**
   * Search params carried across every child of this section — most
   * importantly the portfolio scope `?portfolio=<id>` (#322).
   */
  preserveParams?: readonly string[];
  children: readonly SectionNavChild[];
}

export const SECTION_NAV: Readonly<Record<SectionKey, SectionNav>> = {
  portfolio: {
    root: '/portfolio',
    ariaLabelKey: 'portfolio.section.aria',
    preserveParams: [ACTIVE_PORTFOLIO_PARAM],
    children: [
      { to: '/portfolio', labelKey: 'portfolio.tabs.overview', end: true, rail: true },
      { to: '/portfolio/activity', labelKey: 'portfolio.tabs.activity', rail: true },
      { to: '/portfolio/custom-assets', labelKey: 'portfolio.tabs.customAssets' },
      { to: '/portfolio/cash-flow', labelKey: 'portfolio.tabs.cashFlow', rail: true },
      { to: '/portfolio/analysis', labelKey: 'portfolio.tabs.analysis' },
      { to: '/portfolio/tax', labelKey: 'portfolio.tabs.tax' },
      { to: '/portfolio/import', labelKey: 'portfolio.tabs.import', flag: 'imports' },
      { to: '/portfolio/plan', labelKey: 'portfolio.tabs.plan', parked: true },
      { to: '/portfolio/automate', labelKey: 'portfolio.tabs.automate', parked: true },
      { to: '/portfolio/files', labelKey: 'portfolio.tabs.files', parked: true },
      { to: '/portfolio/people', labelKey: 'portfolio.tabs.people', parked: true },
      { to: '/portfolio/settings', labelKey: 'portfolio.tabs.settings', rail: true },
    ],
  },
  workbench: {
    root: '/workbench',
    ariaLabelKey: 'workbench.aria',
    children: [
      { to: '/workbench', labelKey: 'workbench.tabs.overview', end: true, rail: true },
      { to: '/workbench/studio', labelKey: 'workbench.tabs.studio', parked: true },
      { to: '/workbench/forecasts', labelKey: 'workbench.tabs.forecasts' },
      { to: '/workbench/blueprints', labelKey: 'workbench.tabs.blueprints', rail: true },
      { to: '/workbench/backtests', labelKey: 'workbench.tabs.backtests', rail: true },
      { to: '/workbench/compare', labelKey: 'workbench.tabs.compare' },
      { to: '/workbench/ideas', labelKey: 'workbench.tabs.ideas' },
      { to: '/workbench/calculators', labelKey: 'workbench.tabs.calculators' },
      { to: '/workbench/alerts', labelKey: 'workbench.tabs.alerts', rail: true },
    ],
  },
  assets: {
    root: '/assets',
    ariaLabelKey: 'assets.aria',
    children: [
      { to: '/assets', labelKey: 'assets.tabs.overview', end: true, rail: true },
      { to: '/assets/search', labelKey: 'assets.tabs.search', rail: true },
      { to: '/assets/watchlists', labelKey: 'assets.tabs.watchlists', rail: true },
      { to: '/assets/news', labelKey: 'assets.tabs.news', rail: true },
      { to: '/assets/discover', labelKey: 'assets.tabs.discover', parked: true },
      { to: '/assets/events', labelKey: 'assets.tabs.events', parked: true },
      { to: '/assets/screener', labelKey: 'assets.tabs.screener', parked: true },
    ],
  },
  people: {
    root: '/people',
    ariaLabelKey: 'people.aria',
    children: [
      { to: '/people', labelKey: 'people.tabs.friends', end: true, rail: true },
      { to: '/people/chat', labelKey: 'people.tabs.chat', rail: true },
      { to: '/people/shared', labelKey: 'people.tabs.shared', rail: true },
      { to: '/people/profile', labelKey: 'people.tabs.profile', rail: true },
      { to: '/people/teams', labelKey: 'people.tabs.teams', parked: true },
      { to: '/people/approvals', labelKey: 'people.tabs.approvals', parked: true },
    ],
  },
};

/** The children a section shows right now (kill-switched entries dropped). */
export function useSectionNavChildren(section: SectionKey): readonly SectionNavChild[] {
  const flags = useFeatureFlags();
  return SECTION_NAV[section].children.filter(
    (child) => child.flag === undefined || flags[child.flag],
  );
}

/** The curated subset the rail tree renders — vital pages only. */
export function useRailNavChildren(section: SectionKey): readonly SectionNavChild[] {
  const children = useSectionNavChildren(section);
  return children.filter((child) => child.rail === true);
}

/** The same children as translated {@link LocalNavItem}s for the in-page strip. */
export function useSectionNavItems(section: SectionKey): LocalNavItem[] {
  const t = useT();
  return useSectionNavChildren(section).map((child) => ({
    to: child.to,
    label: t(child.labelKey),
    end: child.end,
    parked: child.parked,
  }));
}

/** Whether `pathname` is this child's route (or, for non-`end` children, below it). */
export function isChildActive(child: SectionNavChild, pathname: string): boolean {
  if (child.end) return pathname === child.to;
  return pathname === child.to || pathname.startsWith(`${child.to}/`);
}
