import { WIDGET_SIZE_RULES, WIDGET_TYPES, WIDGET_VARIANT_RULES, type WidgetType } from '../config';
import { AlertsWidget } from './AlertsWidget';
import { AllocationWidget } from './AllocationWidget';
import { AssetSpotlightSettings, AssetSpotlightWidget } from './AssetSpotlightWidget';
import { AttentionWidget } from './AttentionWidget';
import { CashBalancesWidget } from './CashBalancesWidget';
import { QuickCashWidget } from './QuickCashWidget';
import { CASHFLOW_MONTHS, CashflowChartWidget } from './CashflowChartWidget';
import { ConcentrationWidget } from './ConcentrationWidget';
import { DividendsWidget } from './DividendsWidget';
import { LiquidityWidget } from './LiquidityWidget';
import { NetWorthHistoryWidget } from './NetWorthHistoryWidget';
import { NetWorthWidget } from './NetWorthWidget';
import { NewsWidget } from './NewsWidget';
import { PERFORMANCE_RANGES, PerformanceChartWidget } from './PerformanceChartWidget';
import { PortfolioCardsWidget } from './PortfolioCardsWidget';
import { RecentTransactionsSettings, RecentTransactionsWidget } from './RecentTransactionsWidget';
import { ShortcutsWidget } from './ShortcutsWidget';
import { TodayChangeWidget } from './TodayChangeWidget';
import { TopMoversWidget } from './TopMoversWidget';
import { UpcomingWidget } from './UpcomingWidget';
import { WatchlistSettings, WatchlistWidget } from './WatchlistWidget';
import type { WidgetDefinition, WidgetGroup } from './types';

/**
 * A type's display forms, expressed for the picker. `WIDGET_VARIANT_RULES` in
 * `config.ts` is the authority on which values are *valid* (it validates stored
 * payloads without importing React); this turns that same list into labelled
 * options, so the two cannot drift apart.
 */
function variantsOf(type: WidgetType) {
  const rules = WIDGET_VARIANT_RULES[type];
  if (rules === undefined) return undefined;
  return rules.allowed.map((value) => ({
    value,
    labelKey: `home.builder.variant.${type}.${value}`,
  }));
}

/** The range picker offers the same window set as the per-portfolio chart. */
const PERFORMANCE_RANGE_OPTIONS = PERFORMANCE_RANGES.map((range) => ({
  value: range,
  labelKey: `home.widgets.range.${range}`,
}));

/**
 * The Home widget catalog. One entry per {@link WidgetType}; the board, the
 * builder chrome and the "Add widget" drawer all read this and nothing else, so
 * a new widget is one module plus one row here.
 *
 * `satisfies Record<WidgetType, …>` is the guard: adding a type to
 * `WIDGET_TYPES` without registering its module fails the type-check rather
 * than rendering an empty slot at runtime.
 */
export const WIDGET_REGISTRY = {
  'net-worth': {
    type: 'net-worth',
    handlesVaultedPortfolios: true,
    icon: 'wallet',
    labelKey: 'home.widgets.netWorth.title',
    descriptionKey: 'home.widgets.netWorth.description',
    group: 'overview',
    allowedSizes: WIDGET_SIZE_RULES['net-worth'].allowed,
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    Component: NetWorthWidget,
  },
  'today-change': {
    type: 'today-change',
    handlesVaultedPortfolios: true,
    icon: 'pulse',
    labelKey: 'home.widgets.todayChange.title',
    descriptionKey: 'home.widgets.todayChange.description',
    group: 'overview',
    allowedSizes: WIDGET_SIZE_RULES['today-change'].allowed,
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    Component: TodayChangeWidget,
  },
  liquidity: {
    type: 'liquidity',
    handlesVaultedPortfolios: true,
    icon: 'scale',
    labelKey: 'home.widgets.liquidity.title',
    descriptionKey: 'home.widgets.liquidity.description',
    group: 'overview',
    allowedSizes: WIDGET_SIZE_RULES.liquidity.allowed,
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    variants: variantsOf('liquidity'),
    Component: LiquidityWidget,
  },
  concentration: {
    type: 'concentration',
    handlesVaultedPortfolios: true,
    icon: 'target',
    labelKey: 'home.widgets.concentration.title',
    descriptionKey: 'home.widgets.concentration.description',
    group: 'overview',
    allowedSizes: WIDGET_SIZE_RULES.concentration.allowed,
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    Component: ConcentrationWidget,
  },
  'portfolio-cards': {
    type: 'portfolio-cards',
    handlesVaultedPortfolios: true,
    icon: 'portfolios',
    labelKey: 'home.widgets.portfolioCards.title',
    descriptionKey: 'home.widgets.portfolioCards.description',
    group: 'overview',
    allowedSizes: WIDGET_SIZE_RULES['portfolio-cards'].allowed,
    defaultSettings: { scope: 'all' },
    // Scoping this to ONE portfolio would be a worse net-worth widget, but scoping
    // it to a chosen SET is the whole point — "show me only these three".
    supportsScope: true,
    variants: variantsOf('portfolio-cards'),
    Component: PortfolioCardsWidget,
  },
  'performance-chart': {
    type: 'performance-chart',
    handlesVaultedPortfolios: true,
    icon: 'trending-up',
    labelKey: 'home.widgets.performanceChart.title',
    descriptionKey: 'home.widgets.performanceChart.description',
    group: 'charts',
    allowedSizes: WIDGET_SIZE_RULES['performance-chart'].allowed,
    defaultSettings: { scope: 'all', range: '1M' },
    supportsScope: true,
    rangeOptions: PERFORMANCE_RANGE_OPTIONS,
    variants: variantsOf('performance-chart'),
    Component: PerformanceChartWidget,
  },
  'net-worth-history': {
    type: 'net-worth-history',
    handlesVaultedPortfolios: true,
    icon: 'pulse',
    labelKey: 'home.widgets.netWorthHistory.title',
    descriptionKey: 'home.widgets.netWorthHistory.description',
    group: 'charts',
    allowedSizes: WIDGET_SIZE_RULES['net-worth-history'].allowed,
    // 6M by default: long enough that the summed curve has a shape, short enough
    // that a young account is not mostly flat zero at the left edge.
    defaultSettings: { scope: 'all', range: '6M' },
    // Combines whatever it is scoped to: every portfolio by default, or the chosen
    // set — "only show the graph for these portfolios". The aggregation is the same
    // either way (each series forward-fills and contributes 0 before its own first
    // point), so a subset needs no special case.
    supportsScope: true,
    rangeOptions: PERFORMANCE_RANGE_OPTIONS,
    Component: NetWorthHistoryWidget,
  },
  'cashflow-chart': {
    type: 'cashflow-chart',
    handlesVaultedPortfolios: true,
    icon: 'cash',
    labelKey: 'home.widgets.cashflowChart.title',
    descriptionKey: 'home.widgets.cashflowChart.description',
    group: 'charts',
    allowedSizes: WIDGET_SIZE_RULES['cashflow-chart'].allowed,
    defaultSettings: { scope: 'all', range: '6M' },
    // V5 cash fusion: cash now lives IN a portfolio, so this fans out and sums
    // over its scope exactly like net-worth-history / performance-chart.
    supportsScope: true,
    rangeOptions: Object.keys(CASHFLOW_MONTHS).map((range) => ({
      value: range,
      labelKey: `home.widgets.range.${range}`,
    })),
    variants: variantsOf('cashflow-chart'),
    Component: CashflowChartWidget,
  },
  allocation: {
    type: 'allocation',
    handlesVaultedPortfolios: true,
    icon: 'pie',
    labelKey: 'home.widgets.allocation.title',
    descriptionKey: 'home.widgets.allocation.description',
    group: 'charts',
    allowedSizes: WIDGET_SIZE_RULES.allocation.allowed,
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    variants: variantsOf('allocation'),
    Component: AllocationWidget,
  },
  'asset-spotlight': {
    type: 'asset-spotlight',
    icon: 'target',
    labelKey: 'home.widgets.assetSpotlight.title',
    descriptionKey: 'home.widgets.assetSpotlight.description',
    group: 'charts',
    allowedSizes: WIDGET_SIZE_RULES['asset-spotlight'].allowed,
    defaultSettings: { range: '1M' },
    // One asset, picked by hand — portfolios do not enter into it.
    supportsScope: false,
    rangeOptions: ['1W', '1M', '6M', '1Y'].map((range) => ({
      value: range,
      labelKey: `home.widgets.range.${range}`,
    })),
    SettingsExtra: AssetSpotlightSettings,
    Component: AssetSpotlightWidget,
  },
  'top-movers': {
    type: 'top-movers',
    handlesVaultedPortfolios: true,
    icon: 'trending-up',
    labelKey: 'home.widgets.topMovers.title',
    descriptionKey: 'home.widgets.topMovers.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES['top-movers'].allowed,
    defaultSettings: { scope: 'all', metric: 'day' },
    supportsScope: true,
    variants: variantsOf('top-movers'),
    Component: TopMoversWidget,
  },
  news: {
    type: 'news',
    icon: 'inbox',
    labelKey: 'home.widgets.news.title',
    descriptionKey: 'home.widgets.news.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES.news.allowed,
    defaultSettings: {},
    // The digest endpoint spans every held asset, not one portfolio.
    supportsScope: false,
    // Market intelligence unconfigured ⇒ not offered at all (§13.5 V5-P5).
    capability: 'marketIntel',
    Component: NewsWidget,
  },
  attention: {
    type: 'attention',
    icon: 'bell',
    labelKey: 'home.widgets.attention.title',
    descriptionKey: 'home.widgets.attention.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES.attention.allowed,
    defaultSettings: {},
    supportsScope: false,
    Component: AttentionWidget,
  },
  upcoming: {
    type: 'upcoming',
    icon: 'calendar',
    labelKey: 'home.widgets.upcoming.title',
    descriptionKey: 'home.widgets.upcoming.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES.upcoming.allowed,
    defaultSettings: {},
    supportsScope: false,
    Component: UpcomingWidget,
  },
  'recent-transactions': {
    type: 'recent-transactions',
    icon: 'files',
    labelKey: 'home.widgets.recentTransactions.title',
    descriptionKey: 'home.widgets.recentTransactions.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES['recent-transactions'].allowed,
    defaultSettings: { scope: 'all', count: 5 },
    supportsScope: true,
    SettingsExtra: RecentTransactionsSettings,
    Component: RecentTransactionsWidget,
  },
  'cash-balances': {
    type: 'cash-balances',
    handlesVaultedPortfolios: true,
    icon: 'cash',
    labelKey: 'home.widgets.cashBalances.title',
    descriptionKey: 'home.widgets.cashBalances.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES['cash-balances'].allowed,
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    Component: CashBalancesWidget,
  },
  'quick-cash': {
    type: 'quick-cash',
    icon: 'cash',
    labelKey: 'home.widgets.quickCash.title',
    descriptionKey: 'home.widgets.quickCash.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES['quick-cash'].allowed,
    // Scoped by default, unlike every other cash widget: a movement has to land
    // in ONE portfolio, so "all" is not a meaningful setting here.
    defaultSettings: { scope: 'all' },
    supportsScope: true,
    Component: QuickCashWidget,
  },
  watchlist: {
    type: 'watchlist',
    icon: 'star',
    labelKey: 'home.widgets.watchlist.title',
    descriptionKey: 'home.widgets.watchlist.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES.watchlist.allowed,
    defaultSettings: {},
    // A watchlist is user-level; it has no portfolio dimension to scope to.
    supportsScope: false,
    SettingsExtra: WatchlistSettings,
    Component: WatchlistWidget,
  },
  dividends: {
    type: 'dividends',
    icon: 'percent',
    labelKey: 'home.widgets.dividends.title',
    descriptionKey: 'home.widgets.dividends.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES.dividends.allowed,
    defaultSettings: {},
    // The calendar endpoint spans held + watchlist assets user-level.
    supportsScope: false,
    // Market intelligence unconfigured ⇒ not offered at all (§13.5 V5-P5).
    capability: 'marketIntel',
    Component: DividendsWidget,
  },
  alerts: {
    type: 'alerts',
    icon: 'bell',
    labelKey: 'home.widgets.alerts.title',
    descriptionKey: 'home.widgets.alerts.description',
    group: 'lists',
    allowedSizes: WIDGET_SIZE_RULES.alerts.allowed,
    defaultSettings: {},
    // An alert is attached to an asset, not to a portfolio.
    supportsScope: false,
    Component: AlertsWidget,
  },
  shortcuts: {
    type: 'shortcuts',
    icon: 'bolt',
    labelKey: 'home.widgets.shortcuts.title',
    descriptionKey: 'home.widgets.shortcuts.description',
    group: 'overview',
    allowedSizes: WIDGET_SIZE_RULES.shortcuts.allowed,
    defaultSettings: {},
    supportsScope: false,
    Component: ShortcutsWidget,
  },
} satisfies Record<WidgetType, WidgetDefinition>;

export function widgetDefinition(type: WidgetType): WidgetDefinition {
  return WIDGET_REGISTRY[type];
}

/** The catalog in a stable order, for the "Add widget" drawer. */
export const WIDGET_CATALOG: readonly WidgetDefinition[] = WIDGET_TYPES.map(widgetDefinition);

/** The catalog entries of one group, in catalog order. */
export function widgetsInGroup(group: WidgetGroup): WidgetDefinition[] {
  return WIDGET_CATALOG.filter((definition) => definition.group === group);
}

export type { WidgetDefinition, WidgetGroup, WidgetProps, WidgetSettingsExtraProps } from './types';
export { WIDGET_GROUPS } from './types';
