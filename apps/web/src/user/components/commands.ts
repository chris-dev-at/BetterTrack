import type { IconName } from '../../ui/origin';

/**
 * The universal ⌘K command registry (PRODUCT_BLUEPRINT.md §4 "Global search /
 * command menu"): every suite destination, portfolio tab, creation intent and
 * Control Center entry — parked surfaces included, so the palette can reach the
 * complete product structure. Labels resolve through i18n at render time;
 * `extra` carries untranslated alias terms so e.g. "paranoid" finds Privacy
 * modes and "2fa" finds Security in both languages.
 */
export type CommandGroup = 'navigate' | 'create' | 'control';

export interface CommandEntry {
  /** i18n key of the visible label. */
  labelKey: string;
  to: string;
  group: CommandGroup;
  icon: IconName;
  /** Lower-case alias terms matched in addition to the translated label. */
  extra?: readonly string[];
  /** Present in the structure, build lands later — rendered with the gold dot. */
  parked?: boolean;
  /**
   * Rank (1 = first) in the palette's curated **Suggested** default state — the
   * handful of high-value entries an empty ⌘K offers before anything is typed.
   * Deliberately a rank rather than a flag: registry order groups by product
   * structure, which is the wrong order for a "start here" list.
   */
  suggested?: number;
}

export const COMMANDS: readonly CommandEntry[] = [
  // ── Suite destinations ──
  { labelKey: 'nav.home', to: '/', group: 'navigate', icon: 'home', suggested: 4 },
  {
    labelKey: 'nav.portfolios',
    to: '/portfolio',
    group: 'navigate',
    icon: 'portfolios',
    suggested: 3,
  },
  {
    labelKey: 'portfolio.tabs.activity',
    to: '/portfolio/activity',
    group: 'navigate',
    icon: 'clock',
  },
  {
    labelKey: 'portfolio.tabs.cashFlow',
    to: '/portfolio/cash',
    group: 'navigate',
    icon: 'cash',
    extra: ['expenses', 'budget', 'ausgaben'],
    suggested: 2,
  },
  {
    labelKey: 'portfolio.tabs.analysis',
    to: '/portfolio/analysis',
    group: 'navigate',
    icon: 'pulse',
    extra: ['analytics'],
  },
  {
    labelKey: 'portfolio.tabs.tax',
    to: '/portfolio/tax',
    group: 'navigate',
    icon: 'percent',
    extra: ['steuern', 'report'],
  },
  {
    labelKey: 'portfolio.tabs.customAssets',
    to: '/assets/custom-assets',
    group: 'navigate',
    icon: 'pen',
  },
  {
    labelKey: 'cashflow.tabs.accounts',
    to: '/portfolio/cash/accounts',
    group: 'navigate',
    icon: 'wallet',
    extra: ['cash sources'],
  },
  {
    labelKey: 'cashflow.tabs.budgets',
    to: '/portfolio/cash/budgets',
    group: 'navigate',
    icon: 'target',
    extra: ['cash budgets'],
  },
  {
    labelKey: 'cashflow.tabs.tags',
    to: '/portfolio/cash/labels',
    group: 'navigate',
    icon: 'pen',
    extra: ['cash tags', 'categories'],
  },
  {
    labelKey: 'portfolio.tabs.import',
    to: '/portfolio/import',
    group: 'navigate',
    icon: 'upload',
    extra: ['csv', 'broker'],
  },
  {
    labelKey: 'portfolio.tabs.plan',
    to: '/portfolio/plan',
    group: 'navigate',
    icon: 'target',
    parked: true,
    extra: ['goals', 'ziele'],
  },
  {
    labelKey: 'portfolio.tabs.automate',
    to: '/portfolio/automate',
    group: 'navigate',
    icon: 'bolt',
    parked: true,
    extra: ['rules', 'standing orders', 'sparplan'],
  },
  {
    labelKey: 'portfolio.tabs.files',
    to: '/portfolio/files',
    group: 'navigate',
    icon: 'files',
    parked: true,
    extra: ['documents', 'dokumente'],
  },
  { labelKey: 'nav.workbench', to: '/workbench', group: 'navigate', icon: 'workbench' },
  {
    labelKey: 'workbench.tabs.studio',
    to: '/workbench/studio',
    group: 'navigate',
    icon: 'sliders',
    parked: true,
    extra: ['scenario', 'szenario'],
  },
  {
    labelKey: 'workbench.tabs.forecasts',
    to: '/workbench/forecasts',
    group: 'navigate',
    icon: 'trending-up',
    extra: ['projection', 'prognose'],
  },
  {
    labelKey: 'workbench.tabs.blueprints',
    to: '/workbench/blueprints',
    group: 'navigate',
    icon: 'layers',
    extra: ['conglomerate'],
  },
  {
    labelKey: 'workbench.tabs.backtests',
    to: '/workbench/backtests',
    group: 'navigate',
    icon: 'refresh',
  },
  {
    labelKey: 'workbench.tabs.compare',
    to: '/workbench/compare',
    group: 'navigate',
    icon: 'scale',
    extra: ['comparison', 'vergleich'],
  },
  {
    labelKey: 'workbench.tabs.ideas',
    to: '/workbench/ideas',
    group: 'navigate',
    icon: 'sparkles',
    extra: ['ideen'],
  },
  {
    labelKey: 'workbench.tabs.calculators',
    to: '/workbench/calculators',
    group: 'navigate',
    icon: 'percent',
    extra: ['rechner', 'budget'],
  },
  {
    labelKey: 'workbench.tabs.alerts',
    to: '/workbench/alerts',
    group: 'navigate',
    icon: 'bell',
    extra: ['alarm'],
  },
  { labelKey: 'nav.assets', to: '/assets', group: 'navigate', icon: 'assets' },
  { labelKey: 'assets.tabs.watchlists', to: '/assets/watchlists', group: 'navigate', icon: 'star' },
  {
    labelKey: 'assets.tabs.news',
    to: '/assets/news',
    group: 'navigate',
    icon: 'book',
    extra: ['digest'],
  },
  {
    labelKey: 'assets.tabs.events',
    to: '/assets/events',
    group: 'navigate',
    icon: 'calendar',
    parked: true,
    extra: ['earnings', 'dividends', 'termine'],
  },
  {
    labelKey: 'assets.tabs.screener',
    to: '/assets/screener',
    group: 'navigate',
    icon: 'filter',
    parked: true,
  },
  {
    labelKey: 'assets.tabs.discover',
    to: '/assets/discover',
    group: 'navigate',
    icon: 'globe',
    parked: true,
    extra: ['stocks', 'etf', 'crypto'],
  },
  {
    labelKey: 'nav.people',
    to: '/people',
    group: 'navigate',
    icon: 'people',
    extra: ['friends', 'freunde', 'social'],
  },
  { labelKey: 'people.tabs.chat', to: '/people/chat', group: 'navigate', icon: 'message' },
  {
    labelKey: 'people.tabs.shared',
    to: '/people/shared',
    group: 'navigate',
    icon: 'share',
    extra: ['sharing'],
  },
  {
    labelKey: 'people.tabs.profile',
    to: '/people/profile',
    group: 'navigate',
    icon: 'user',
    extra: ['public profile'],
  },
  {
    labelKey: 'nav.ask',
    to: '/ask',
    group: 'navigate',
    icon: 'sparkles',
    parked: true,
    extra: ['ai', 'ki', 'assistant'],
    suggested: 6,
  },
  { labelKey: 'nav.review', to: '/review', group: 'navigate', icon: 'inbox', parked: true },
  {
    labelKey: 'firstrun.command.runAgain',
    to: '/welcome',
    group: 'navigate',
    icon: 'target',
    extra: ['setup', 'onboarding', 'wizard', 'welcome', 'einrichtung', 'assistent'],
  },

  // ── Create intents ──
  {
    labelKey: 'create.trade',
    to: '/portfolio?create=trade',
    group: 'create',
    icon: 'assets',
    extra: ['buy', 'sell', 'kauf', 'verkauf', 'transaction'],
    suggested: 1,
  },
  {
    labelKey: 'create.transfer',
    to: '/portfolio/cash/accounts?create=transfer',
    group: 'create',
    icon: 'wallet',
    extra: ['cash transfer', 'umbuchung', 'überweisung'],
  },
  {
    labelKey: 'create.blueprint',
    to: '/workbench/blueprints/new',
    group: 'create',
    icon: 'layers',
  },
  {
    labelKey: 'create.watchlist',
    to: '/assets/watchlists?create=1',
    group: 'create',
    icon: 'star',
  },
  { labelKey: 'create.alert', to: '/workbench/alerts?create=1', group: 'create', icon: 'bell' },
  {
    labelKey: 'create.idea',
    to: '/workbench/blueprints/new',
    group: 'create',
    icon: 'sparkles',
  },
  { labelKey: 'create.portfolio', to: '/portfolios?create=1', group: 'create', icon: 'portfolios' },

  // ── Control Center / settings ──
  // Every settings surface is a Control Center panel (R2): `/control/<panel>`
  // opens the overlay straight on it. Only genuine pages stay page targets.
  { labelKey: 'nav.controlCenter', to: '/control', group: 'control', icon: 'grid', suggested: 5 },
  {
    labelKey: 'control.account',
    to: '/control/account',
    group: 'control',
    icon: 'user',
    extra: ['email', 'password', 'language', 'sprache', 'passwort', 'settings'],
  },
  {
    labelKey: 'control.notifications',
    to: '/control/notifications',
    group: 'control',
    icon: 'bell',
    extra: ['digest', 'quiet hours'],
  },
  {
    labelKey: 'control.security',
    to: '/control/security',
    group: 'control',
    icon: 'shield',
    extra: ['passkey', '2fa', 'pin', 'sessions', 'two-factor'],
  },
  {
    labelKey: 'control.portfolioDefaults',
    to: '/control/portfolio-defaults',
    group: 'control',
    icon: 'percent',
    extra: ['defaults', 'tax', 'steuer'],
  },
  {
    labelKey: 'control.connections',
    to: '/control/connections',
    group: 'control',
    icon: 'link',
    extra: ['google drive', 'parqet'],
  },
  {
    labelKey: 'control.deleteAccount',
    to: '/control/delete-account',
    group: 'control',
    icon: 'trash',
    extra: ['close account', 'konto löschen'],
  },
  {
    labelKey: 'control.imports',
    to: '/control/data',
    group: 'control',
    icon: 'download',
    parked: true,
    extra: ['export'],
  },
  {
    labelKey: 'control.backups',
    to: '/control/data',
    group: 'control',
    icon: 'cloud',
    parked: true,
  },
  {
    labelKey: 'control.privacy',
    to: '/control/privacy',
    group: 'control',
    icon: 'lock',
    extra: ['discreet', 'paranoid', 'diskret', 'vault'],
  },
  {
    labelKey: 'control.dataManagement',
    to: '/control/data',
    group: 'control',
    icon: 'database',
    parked: true,
    extra: ['checkpoint', 'retention'],
  },
  {
    labelKey: 'control.developer',
    to: '/developer',
    group: 'control',
    icon: 'code',
    extra: ['api'],
  },
  {
    labelKey: 'control.apiKeys',
    to: '/control/api',
    group: 'control',
    icon: 'key',
    extra: ['token'],
  },
  { labelKey: 'control.webhooks', to: '/control/webhooks', group: 'control', icon: 'webhook' },
  {
    labelKey: 'control.mcp',
    to: '/developer/mcp',
    group: 'control',
    icon: 'terminal',
    parked: true,
    extra: ['model context protocol'],
  },
  {
    labelKey: 'control.logs',
    to: '/developer/logs',
    group: 'control',
    icon: 'document',
    parked: true,
    extra: ['requests'],
  },
] as const;

/**
 * The curated default state of an empty ⌘K: the {@link CommandEntry.suggested}
 * entries in rank order. An empty palette showing nothing was the old behaviour
 * and read as a broken void — a universal search must offer a starting point.
 */
export const SUGGESTED_COMMANDS: readonly CommandEntry[] = COMMANDS.filter(
  (command) => command.suggested !== undefined,
).sort((a, b) => a.suggested! - b.suggested!);

/**
 * Where a nested destination lives, as quiet row meta ("Cash flow — Portfolio").
 * Derived from the route so the registry carries no duplicated copy; top-level
 * destinations get no meta because their label already says it.
 */
const SECTION_LABEL_KEY: readonly (readonly [prefix: string, labelKey: string])[] = [
  ['/portfolio/', 'nav.portfolios'],
  ['/portfolios', 'nav.portfolios'],
  ['/workbench/', 'nav.workbench'],
  ['/assets/', 'nav.assets'],
  ['/people/', 'nav.people'],
  ['/control/', 'nav.controlCenter'],
  ['/developer/', 'control.developer'],
];

/** i18n key of the parent section for `to`, or `undefined` for a top-level route. */
export function sectionLabelKeyFor(to: string): string | undefined {
  return SECTION_LABEL_KEY.find(([prefix]) => to.startsWith(prefix))?.[1];
}

/**
 * Match strength, highest first. Ranking (not raw registry order) is what makes
 * a short query useful: typing "cas" must offer *Cash flow* before *Backtests*,
 * which merely contains the letters.
 */
const SCORE_LABEL_PREFIX = 4;
const SCORE_LABEL_WORD = 3;
const SCORE_ALIAS_PREFIX = 2;
const SCORE_CONTAINS = 1;
/** A single character only ever matches the start of a word — never mid-word noise. */
const MIN_SCORE_SINGLE_CHAR = SCORE_ALIAS_PREFIX;

function scoreCommand(
  command: CommandEntry,
  needle: string,
  translate: (key: string) => string,
): number {
  const label = translate(command.labelKey).toLowerCase();
  if (label.startsWith(needle)) return SCORE_LABEL_PREFIX;
  const aliases = command.extra ?? [];
  if (label.split(/[\s/·—–-]+/).some((word) => word.startsWith(needle))) return SCORE_LABEL_WORD;
  if (aliases.some((term) => term.split(/[\s-]+/).some((word) => word.startsWith(needle)))) {
    return SCORE_ALIAS_PREFIX;
  }
  if (label.includes(needle) || aliases.some((term) => term.includes(needle))) {
    return SCORE_CONTAINS;
  }
  return 0;
}

/**
 * Case-insensitive, ranked palette filter over the translated labels and the
 * alias terms. Returns best matches first, stable within a score (registry
 * order), and nothing at all for an empty query — the palette shows
 * {@link SUGGESTED_COMMANDS} there instead.
 */
export function filterCommands(query: string, translate: (key: string) => string): CommandEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const floor = needle.length === 1 ? MIN_SCORE_SINGLE_CHAR : SCORE_CONTAINS;
  return COMMANDS.map((command, index) => ({
    command,
    index,
    score: scoreCommand(command, needle, translate),
  }))
    .filter((hit) => hit.score >= floor)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((hit) => hit.command);
}
