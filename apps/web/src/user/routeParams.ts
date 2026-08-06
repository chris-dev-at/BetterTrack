/**
 * The URL params the shell writes and pages read.
 *
 * A leaf module on purpose: the command registry (`components/commands.ts`) is
 * a pure table with a plain `.ts` test, and reading these names off the
 * components that happen to own the flows dragged `PortfolioWizard` /
 * `MirrorchainPanel` into its module graph (cf. the code-splitting work, #1089).
 * Nothing here imports anything.
 */

/** The `?portfolio=<id>` search-param key that names the active portfolio. */
export const ACTIVE_PORTFOLIO_PARAM = 'portfolio';

/** The `?create=<intent>` search-param key that starts a create flow on arrival. */
export const CREATE_INTENT_PARAM = 'create';

/**
 * The whole `?create=` value namespace, in ONE table — because the values are
 * global while the consumers are not: several of them live on the same URL.
 *
 * `PortfolioSwitcher` sits in the topbar of **every** `/portfolio*` surface and
 * claims the bare `'1'` for its new-portfolio wizard. A page under that prefix
 * therefore MUST take its own value; reusing `'1'` there fires two consumers off
 * one link and stacks the wizard on top of the flow the user actually asked for.
 * Outside that prefix `'1'` is free, and a surface with exactly one create flow
 * uses it.
 *
 * Add a value here before wiring it, and keep the comment saying who reads it.
 */
export const CREATE_INTENT = {
  /** New-portfolio wizard — `PortfolioSwitcher`, mounted on every `/portfolio*`. */
  portfolio: '1',
  /** Buy/sell dialog — `PortfolioPage` (`/portfolio`). */
  trade: 'trade',
  /** Record income or expense — `CashMovementsPage` (`/portfolio/cash/movements`). */
  movement: 'movement',
  /** Cash transfer dialog — `CashSourcesPage` (`/portfolio/cash/accounts`). */
  transfer: 'transfer',
  /** New watchlist — `WatchlistsPage` (`/assets/watchlists`, no switcher there). */
  watchlist: '1',
  /** New alert — `AlertsPage` (`/workbench/alerts`, no switcher there). */
  alert: '1',
  /** Save an ad-hoc basket as an idea — `ConglomerateBuilderPage` (`/workbench/blueprints/new`). */
  idea: 'idea',
} as const;

export type CreateIntent = (typeof CREATE_INTENT)[keyof typeof CREATE_INTENT];

const CREATE_INTENT_VALUES = new Set<string>(Object.values(CREATE_INTENT));

/** Whether a raw query value belongs to the global create-intent namespace. */
export function isCreateIntent(value: string): value is CreateIntent {
  return CREATE_INTENT_VALUES.has(value);
}
