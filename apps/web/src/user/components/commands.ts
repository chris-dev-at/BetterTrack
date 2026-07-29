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
}

export const COMMANDS: readonly CommandEntry[] = [
  // ── Suite destinations ──
  { labelKey: 'nav.home', to: '/', group: 'navigate', icon: 'home' },
  { labelKey: 'nav.portfolios', to: '/portfolio', group: 'navigate', icon: 'portfolios' },
  {
    labelKey: 'portfolio.tabs.activity',
    to: '/portfolio/activity',
    group: 'navigate',
    icon: 'clock',
  },
  {
    labelKey: 'portfolio.tabs.cashFlow',
    to: '/portfolio/cash-flow',
    group: 'navigate',
    icon: 'cash',
    extra: ['expenses', 'budget', 'ausgaben'],
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
    to: '/portfolio/custom-assets',
    group: 'navigate',
    icon: 'pen',
  },
  {
    labelKey: 'cashflow.tabs.accounts',
    to: '/portfolio/cash-flow/accounts',
    group: 'navigate',
    icon: 'wallet',
    extra: ['cash sources'],
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
    to: '/portfolio/activity?create=trade',
    group: 'create',
    icon: 'assets',
    extra: ['buy', 'sell', 'kauf', 'verkauf', 'transaction'],
  },
  {
    labelKey: 'create.cashFlow',
    to: '/portfolio/cash-flow?create=transaction',
    group: 'create',
    icon: 'cash',
    extra: ['income', 'expense', 'einnahme', 'ausgabe'],
  },
  {
    labelKey: 'create.transfer',
    to: '/portfolio/cash-flow/accounts?create=transfer',
    group: 'create',
    icon: 'wallet',
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
  { labelKey: 'create.idea', to: '/workbench/ideas?create=1', group: 'create', icon: 'sparkles' },
  { labelKey: 'create.portfolio', to: '/portfolios?create=1', group: 'create', icon: 'portfolios' },

  // ── Control Center / settings ──
  { labelKey: 'nav.controlCenter', to: '/control', group: 'control', icon: 'grid' },
  {
    labelKey: 'control.account',
    to: '/settings/account',
    group: 'control',
    icon: 'user',
    extra: ['email', 'password', 'language', 'sprache', 'passwort'],
  },
  {
    labelKey: 'control.notifications',
    to: '/settings/notifications',
    group: 'control',
    icon: 'bell',
    extra: ['digest', 'quiet hours'],
  },
  {
    labelKey: 'control.security',
    to: '/settings/security',
    group: 'control',
    icon: 'shield',
    extra: ['passkey', '2fa', 'pin', 'sessions', 'two-factor'],
  },
  {
    labelKey: 'control.taxes',
    to: '/settings/taxes',
    group: 'control',
    icon: 'percent',
    extra: ['defaults'],
  },
  {
    labelKey: 'control.connections',
    to: '/settings/connections',
    group: 'control',
    icon: 'link',
    extra: ['google drive', 'parqet'],
  },
  {
    labelKey: 'control.imports',
    to: '/settings/imports',
    group: 'control',
    icon: 'download',
    extra: ['export'],
  },
  { labelKey: 'control.backups', to: '/settings/backups', group: 'control', icon: 'cloud' },
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
    to: '/settings/api',
    group: 'control',
    icon: 'key',
    extra: ['token'],
  },
  { labelKey: 'control.webhooks', to: '/settings/api', group: 'control', icon: 'webhook' },
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
 * Case-insensitive palette filter: matches the translated label or any alias.
 * An empty query surfaces nothing (the palette then shows only asset search),
 * keeping the default state calm.
 */
export function filterCommands(query: string, translate: (key: string) => string): CommandEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  return COMMANDS.filter((command) => {
    if (translate(command.labelKey).toLowerCase().includes(needle)) return true;
    return command.extra?.some((term) => term.includes(needle)) ?? false;
  });
}
