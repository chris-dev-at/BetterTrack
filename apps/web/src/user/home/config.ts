/**
 * Home dashboard configuration (R2 home-widgets workstream).
 *
 * The Home screen is a user-composed widget board: which widgets appear, in
 * which order, how wide, and what each one is scoped to. The whole layout lives
 * client-side under one `localStorage` key — there is no server model for it —
 * so this module is the single source of truth for the shape, its defaults and
 * its **forward-safe** parsing.
 *
 * Forward-safety matters because the key survives deploys and rollbacks: a
 * payload written by a newer build (unknown widget types, unknown settings) must
 * never crash an older one, and a payload from an unknown *version* must never
 * be interpreted under this version's rules. The rules, in order:
 *
 *  - unreadable payload (absent, bad JSON, not an object, `widgets` not an
 *    array) or a `version` this build does not own ⇒ {@link DEFAULT_LAYOUT};
 *  - a readable payload keeps the widgets it understands and silently drops the
 *    ones it does not (unknown `type`, malformed entry, duplicate id);
 *  - a deliberately empty board stays empty — the page renders its designed
 *    empty state instead of resurrecting the defaults the user just cleared.
 *
 * Parsing NEVER writes. A rollback that drops unknown widget types on read
 * leaves the stored payload intact, so rolling forward again restores them.
 *
 * Kept free of React and of the widget components on purpose: the registry
 * (`widgets/index.ts`) imports these types, not the other way round, and this
 * module stays unit-testable in isolation.
 */

/** The `localStorage` key holding the whole board. Versioned in the key itself. */
export const HOME_CONFIG_STORAGE_KEY = 'bt.home.v1';

/** The schema version this build reads and writes. */
export const HOME_CONFIG_VERSION = 1;

/**
 * Every widget type this build can render. The registry is keyed by exactly
 * this list (`satisfies Record<WidgetType, …>`), so adding a type here without
 * adding its module is a compile error rather than a runtime blank.
 */
export const WIDGET_TYPES = [
  'net-worth',
  'today-change',
  'liquidity',
  'concentration',
  'performance-chart',
  'net-worth-history',
  'cashflow-chart',
  'allocation',
  'asset-spotlight',
  'top-movers',
  'portfolio-cards',
  'news',
  'attention',
  'upcoming',
  'recent-transactions',
  'cash-balances',
  'watchlist',
  'dividends',
  'alerts',
  'shortcuts',
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Column spans on the 12-column desktop grid: s = 4, m = 6, l = 12. */
export const WIDGET_SIZES = ['s', 'm', 'l'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Every active portfolio, rolled up — and the default for every scoped type. */
export const SCOPE_ALL = 'all';

/**
 * A hand-picked set of portfolios, listed in {@link WidgetSettings.scopeIds}.
 *
 * A sentinel rather than "scope holds an array" so the setting stays one
 * discriminant plus one payload: `scope` alone always says which *mode* the widget
 * is in, and there is no way to express a contradiction (an id *and* a list). It
 * also means a payload written by the build before this one — where `scope` was
 * only ever `'all'` or a single id — parses unchanged and keeps its meaning.
 */
export const SCOPE_SELECTED = 'selected';

/**
 * `'all'`, `'selected'` (see {@link WidgetSettings.scopeIds}), or one portfolio's
 * id. An id is compared against the live portfolio list at render time, never
 * trusted on its own.
 */
export type WidgetScope = typeof SCOPE_ALL | typeof SCOPE_SELECTED | string;

/**
 * Portfolio ids one widget may pin itself to. Well past any plausible number of
 * portfolios, because this bound exists to keep a hand-edited or corrupted payload
 * from becoming an unbounded fan-out — not to tell the user how to work. The
 * per-widget request caps (12 series on the value charts, say) still apply on top.
 */
export const SCOPE_IDS_MAX = 24;

/** Ranking metric for the top-movers widget — today's move or lifetime P/L. */
export type MoverMetric = 'day' | 'total';

export interface WidgetSettings {
  /** Which portfolios feed the widget. Ignored by unscoped widget types. */
  scope?: WidgetScope;
  /**
   * The chosen portfolios, read **only** when {@link scope} is
   * {@link SCOPE_SELECTED}. Ids that no longer name a live portfolio are dropped at
   * render time and the rest are kept; if none survive the widget falls back to all,
   * exactly as a dead single scope already does. Never rewritten on read, so
   * restoring an archived portfolio restores its place in the set.
   */
  scopeIds?: string[];
  /** Time window token. Each type declares its own vocabulary (see the registry). */
  range?: string;
  /** Top-movers ranking metric. */
  metric?: MoverMetric;
  /** How many rows a list widget shows (recent transactions). See {@link COUNT_LIMITS}. */
  count?: number;
  /** Which named watchlist the watchlist widget reads. Absent ⇒ the first list. */
  watchlistId?: string;
  /** The asset the spotlight widget follows. Absent ⇒ the "pick an asset" state. */
  assetId?: string;
  /**
   * The symbol captured when {@link assetId} was picked, so the header and the
   * empty chrome can name the asset without waiting on (or requiring) a fetch.
   * Purely a display cache — never trusted as identity.
   */
  assetLabel?: string;
  /**
   * Which display form the widget uses — the same question answered a different
   * way (a donut vs. a ranked bar list, a net area vs. in/out columns). The
   * vocabulary is per type; see {@link WIDGET_VARIANT_RULES}, which is also what
   * validates a stored value.
   */
  variant?: string;
}

/**
 * Bounds on {@link WidgetSettings.count}. Deliberately wider than any picker
 * offers: the stored value only has to be *sane*, and a future build offering
 * "25 rows" must not have its setting rejected by this one.
 */
export const COUNT_LIMITS = { min: 1, max: 50 } as const;

export interface WidgetConfig {
  /** Stable per-instance id — the React key, the drag/reorder handle identity. */
  id: string;
  type: WidgetType;
  size: WidgetSize;
  settings: WidgetSettings;
}

export interface HomeConfig {
  version: typeof HOME_CONFIG_VERSION;
  widgets: WidgetConfig[];
}

/**
 * Which sizes each type may take and which it starts at. Lives here rather than
 * in the registry so {@link parseHomeConfig} can clamp a stored size without
 * importing React components (and so the rules stay unit-testable).
 */
export const WIDGET_SIZE_RULES: Record<
  WidgetType,
  { allowed: readonly WidgetSize[]; default: WidgetSize }
> = {
  // The single focal point of the page — never allowed to shrink to a column.
  'net-worth': { allowed: ['m', 'l'], default: 'l' },
  'today-change': { allowed: ['s', 'm'], default: 's' },
  'performance-chart': { allowed: ['m', 'l'], default: 'l' },
  // The all-portfolios curve is the widest thing on the board after the hero —
  // a 4-column version would be a sparkline pretending to be a chart.
  'net-worth-history': { allowed: ['m', 'l'], default: 'l' },
  'cashflow-chart': { allowed: ['m', 'l'], default: 'm' },
  allocation: { allowed: ['s', 'm', 'l'], default: 'm' },
  'asset-spotlight': { allowed: ['s', 'm', 'l'], default: 'm' },
  'top-movers': { allowed: ['s', 'm', 'l'], default: 'm' },
  'portfolio-cards': { allowed: ['m', 'l'], default: 'l' },
  news: { allowed: ['s', 'm', 'l'], default: 'm' },
  attention: { allowed: ['s', 'm', 'l'], default: 'm' },
  upcoming: { allowed: ['s', 'm', 'l'], default: 'm' },
  'recent-transactions': { allowed: ['s', 'm', 'l'], default: 'm' },
  'cash-balances': { allowed: ['s', 'm', 'l'], default: 'm' },
  watchlist: { allowed: ['s', 'm', 'l'], default: 'm' },
  dividends: { allowed: ['s', 'm', 'l'], default: 'm' },
  // A count plus a couple of rows — it reads fine in one column and has nothing
  // to fill a full-width band with.
  alerts: { allowed: ['s', 'm'], default: 's' },
  shortcuts: { allowed: ['m', 'l'], default: 'l' },
  // Single-ratio indicators: a gauge and two numbers. They exist to sit in a
  // column beside something bigger, so they never span the full width.
  liquidity: { allowed: ['s', 'm'], default: 's' },
  concentration: { allowed: ['s', 'm'], default: 's' },
};

/**
 * The display forms each type offers, and which it starts in.
 *
 * A **variant** answers the same question a different way — the cash-flow chart
 * as a net area or as per-month in/out columns, allocation as a donut or as a
 * ranked bar list. It is deliberately not a place for skins: a type only appears
 * here when a second form genuinely reads better for some boards.
 *
 * Lives beside {@link WIDGET_SIZE_RULES} and for the same reason — it is what
 * validates a *stored* variant, so it must be reachable without importing any
 * React component. A type absent from this table has no variants, and a `variant`
 * setting stored against it is dropped on read.
 */
export const WIDGET_VARIANT_RULES: Partial<
  Record<WidgetType, { allowed: readonly string[]; default: string }>
> = {
  // "Did I save or burn money" (net polarity) vs. "what came in and what went
  // out each month" (the two gross figures side by side).
  'cashflow-chart': { allowed: ['net', 'columns'], default: 'net' },
  // Euro value over time vs. the time-weighted return on that value, in percent.
  //
  // The `return` form is **single-portfolio only** and the widget degrades it to
  // `value` whenever its scope resolves wider: `/history` returns a per-portfolio
  // TWR, percentages are not additive, and an honest combined return would need
  // the combined external flows — which that endpoint does not return. The
  // degrade lives in the widget rather than here because it depends on the *live*
  // portfolio list, which this module (a pure parser) cannot see.
  'performance-chart': { allowed: ['value', 'return'], default: 'value' },
  // Shape of the whole vs. a ranked list you can read exact shares off.
  allocation: { allowed: ['donut', 'bars'], default: 'donut' },
  // Two labelled columns vs. a dense strip of chips that fits a small tile.
  'top-movers': { allowed: ['list', 'chips'], default: 'list' },
  // One card per portfolio vs. a table that compares them line by line.
  'portfolio-cards': { allowed: ['cards', 'table'], default: 'cards' },
  // The same ratio as an arc or as a single bar — the bar survives size `s`
  // beside a long number better than a ring does.
  liquidity: { allowed: ['ring', 'bar'], default: 'ring' },
};

const WIDGET_TYPE_SET: ReadonlySet<string> = new Set<string>(WIDGET_TYPES);
const WIDGET_SIZE_SET: ReadonlySet<string> = new Set<string>(WIDGET_SIZES);

/**
 * The zero-setup board: what Home looked like before it became configurable —
 * the net-worth hero, the roll-up across portfolios, what needs attention, what
 * is scheduled, and where to go next. A brand-new user gets this without ever
 * opening the builder.
 */
export const DEFAULT_LAYOUT: HomeConfig = {
  version: HOME_CONFIG_VERSION,
  widgets: [
    { id: 'default-net-worth', type: 'net-worth', size: 'l', settings: { scope: 'all' } },
    { id: 'default-portfolios', type: 'portfolio-cards', size: 'l', settings: {} },
    { id: 'default-attention', type: 'attention', size: 'm', settings: {} },
    { id: 'default-upcoming', type: 'upcoming', size: 'm', settings: {} },
    { id: 'default-shortcuts', type: 'shortcuts', size: 'l', settings: {} },
  ],
};

/** A fresh deep copy of {@link DEFAULT_LAYOUT} — callers mutate their own board. */
export function defaultLayout(): HomeConfig {
  return cloneConfig(DEFAULT_LAYOUT);
}

function cloneConfig(config: HomeConfig): HomeConfig {
  return {
    version: config.version,
    widgets: config.widgets.map((widget) => ({ ...widget, settings: { ...widget.settings } })),
  };
}

let idCounter = 0;

/**
 * A collision-free instance id. Deliberately not `crypto.randomUUID` — this runs
 * in jsdom and in browsers without a secure context, and the id is a local React
 * key, not a security token.
 */
export function newWidgetId(type: WidgetType): string {
  idCounter += 1;
  return `${type}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clamp a stored size onto what the type actually supports. A size dropped by a
 * later build (or a hand-edited payload) degrades to the type's default instead
 * of rendering an impossible span.
 */
export function clampSize(type: WidgetType, size: unknown): WidgetSize {
  const rules = WIDGET_SIZE_RULES[type];
  return typeof size === 'string' &&
    WIDGET_SIZE_SET.has(size) &&
    rules.allowed.includes(size as WidgetSize)
    ? (size as WidgetSize)
    : rules.default;
}

/**
 * The variant a type should actually render, given whatever was stored.
 *
 * Unlike {@link clampSize} this can answer "none": a type with no variants has no
 * default to fall back to, and a `variant` stored against it is meaningless. A
 * *known* type with an *unknown* variant degrades to that type's default — the
 * rollback case, where a form this build has never heard of must still render as
 * something rather than blank.
 */
export function clampVariant(type: WidgetType, variant: unknown): string | undefined {
  const rules = WIDGET_VARIANT_RULES[type];
  if (rules === undefined) return undefined;
  return typeof variant === 'string' && rules.allowed.includes(variant) ? variant : rules.default;
}

/**
 * A stored `scopeIds` list, cleaned: strings only, no blanks, de-duplicated, and
 * capped at {@link SCOPE_IDS_MAX}. Returns undefined when there is nothing usable,
 * so the key is dropped rather than stored as `[]` — an empty list and an absent
 * one would resolve identically, and one of them is a lie about what the user did.
 *
 * Order is preserved here but is *not* meaningful: widgets render the chosen
 * portfolios in the app's own portfolio order, so a set stays a set.
 */
function parseScopeIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (ids.includes(entry)) continue;
    ids.push(entry);
    if (ids.length === SCOPE_IDS_MAX) break;
  }
  return ids.length > 0 ? ids : undefined;
}

/** The variant a widget instance renders in — its stored one, or its type's default. */
export function widgetVariant(type: WidgetType, settings: WidgetSettings): string | undefined {
  return settings.variant ?? WIDGET_VARIANT_RULES[type]?.default;
}

/**
 * Keep only the settings keys this build understands, each type-checked. Unknown
 * keys are dropped rather than carried through, so a newer build's settings can
 * never reach a widget that would misread them.
 *
 * An out-of-range or wrong-typed *known* key is dropped too, never coerced: the
 * widget then falls back to its own documented default, which is a state it is
 * built to render. Silently clamping 9 000 rows to 50 would instead hand the
 * widget a number the user never chose. `variant` is the exception and clamps
 * rather than drops — see {@link clampVariant}.
 */
function parseSettings(raw: unknown, type: WidgetType): WidgetSettings {
  if (!isRecord(raw)) return {};
  const settings: WidgetSettings = {};
  if (typeof raw.scope === 'string' && raw.scope.length > 0) settings.scope = raw.scope;
  const scopeIds = parseScopeIds(raw.scopeIds);
  if (scopeIds !== undefined) settings.scopeIds = scopeIds;
  if (typeof raw.range === 'string' && raw.range.length > 0) settings.range = raw.range;
  if (raw.metric === 'day' || raw.metric === 'total') settings.metric = raw.metric;
  if (
    typeof raw.count === 'number' &&
    Number.isInteger(raw.count) &&
    raw.count >= COUNT_LIMITS.min &&
    raw.count <= COUNT_LIMITS.max
  ) {
    settings.count = raw.count;
  }
  if (typeof raw.watchlistId === 'string' && raw.watchlistId.length > 0) {
    settings.watchlistId = raw.watchlistId;
  }
  if (typeof raw.assetId === 'string' && raw.assetId.length > 0) settings.assetId = raw.assetId;
  if (typeof raw.assetLabel === 'string' && raw.assetLabel.length > 0) {
    settings.assetLabel = raw.assetLabel;
  }
  if (raw.variant !== undefined) {
    const variant = clampVariant(type, raw.variant);
    if (variant !== undefined) settings.variant = variant;
  }
  return settings;
}

/** One stored widget → a usable {@link WidgetConfig}, or null when unusable. */
function parseWidget(raw: unknown, index: number): WidgetConfig | null {
  if (!isRecord(raw)) return null;
  const { type } = raw;
  // An unknown type is the expected rollback case: drop this widget, keep the board.
  if (typeof type !== 'string' || !WIDGET_TYPE_SET.has(type)) return null;
  const widgetType = type as WidgetType;
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `${widgetType}-${index}`;
  return {
    id,
    type: widgetType,
    size: clampSize(widgetType, raw.size),
    settings: parseSettings(raw.settings, widgetType),
  };
}

/**
 * Parse a stored payload (the raw `localStorage` string, or `null`) into a board.
 * Never throws and never writes — see the module docblock for the exact rules.
 */
export function parseHomeConfig(raw: string | null | undefined): HomeConfig {
  if (typeof raw !== 'string' || raw.trim() === '') return defaultLayout();

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return defaultLayout();
  }

  if (!isRecord(decoded)) return defaultLayout();
  // A version this build does not own may mean anything at all — do not guess.
  if (decoded.version !== HOME_CONFIG_VERSION) return defaultLayout();
  if (!Array.isArray(decoded.widgets)) return defaultLayout();

  const seen = new Set<string>();
  const widgets: WidgetConfig[] = [];
  for (const [index, entry] of decoded.widgets.entries()) {
    const widget = parseWidget(entry, index);
    if (widget === null) continue;
    // Duplicate ids would collide as React keys and make reorder ambiguous.
    if (seen.has(widget.id)) continue;
    seen.add(widget.id);
    widgets.push(widget);
  }

  // An empty board is a legitimate user choice (they removed everything); the
  // page shows its designed empty state with "Add widget" / "Reset to default".
  return { version: HOME_CONFIG_VERSION, widgets };
}

/** Read + parse the persisted board. Falls back to the defaults on any failure. */
export function readHomeConfig(): HomeConfig {
  try {
    return parseHomeConfig(localStorage.getItem(HOME_CONFIG_STORAGE_KEY));
  } catch {
    // No storage available (private mode, disabled cookies) — still render.
    return defaultLayout();
  }
}

/** Persist the board. A storage failure is non-fatal: the session keeps its layout. */
export function writeHomeConfig(config: HomeConfig): void {
  try {
    localStorage.setItem(HOME_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignored on purpose — persistence is a convenience, not a correctness need.
  }
}

/** Forget the stored board so the next read returns {@link DEFAULT_LAYOUT}. */
export function clearHomeConfig(): void {
  try {
    localStorage.removeItem(HOME_CONFIG_STORAGE_KEY);
  } catch {
    // Ignored — see writeHomeConfig.
  }
}

// ─── Board edits (pure — the page owns the state, these own the rules) ───────

/**
 * Add a widget of `type` with its default size and settings.
 *
 * `at` is an insertion slot in the same numbering the placement lines use (slot
 * `i` = "before the widget currently at `i`", `widgets.length` = at the end), so
 * the ⊕ on a line can hand straight through what the user pointed at. Omitted or
 * out of range ⇒ appended, which is what the header's "Add widget" wants: the new
 * widget lands at the bottom of the page the user just scrolled through rather
 * than silently in the middle.
 */
export function addWidget(
  config: HomeConfig,
  type: WidgetType,
  defaultSettings: WidgetSettings,
  at?: number,
): HomeConfig {
  const entry: WidgetConfig = {
    id: newWidgetId(type),
    type,
    size: WIDGET_SIZE_RULES[type].default,
    settings: { ...defaultSettings },
  };
  const slot =
    at !== undefined && Number.isInteger(at) && at >= 0 && at <= config.widgets.length
      ? at
      : config.widgets.length;
  const widgets = [...config.widgets];
  widgets.splice(slot, 0, entry);
  return { ...config, widgets };
}

export function removeWidget(config: HomeConfig, id: string): HomeConfig {
  return { ...config, widgets: config.widgets.filter((widget) => widget.id !== id) };
}

/** Move the widget at `from` to index `to`. Out-of-range moves are no-ops. */
export function moveWidget(config: HomeConfig, from: number, to: number): HomeConfig {
  const { widgets } = config;
  if (from === to || from < 0 || to < 0 || from >= widgets.length || to >= widgets.length) {
    return config;
  }
  const next = [...widgets];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return config;
  next.splice(to, 0, moved);
  return { ...config, widgets: next };
}

/**
 * The insertion slots a placement UI should offer for the widget at `from`.
 *
 * A board of N widgets has N+1 gaps to drop into, indexed by the widget they sit
 * *before* (`N` meaning "at the end"). Two of them — the gap immediately before
 * the widget and the one immediately after it — describe where it already is, so
 * they are omitted rather than offered as buttons that do nothing. Hence exactly
 * N−1 slots for any board of N ≥ 1.
 *
 * Slots are numbered against the board **as it looks now**, which is what the
 * targets are labelled with; {@link moveWidgetToSlot} does the off-by-one that
 * removing the widget first introduces.
 */
export function placementSlots(count: number, from: number): number[] {
  if (count <= 1 || from < 0 || from >= count) return [];
  const slots: number[] = [];
  for (let slot = 0; slot <= count; slot += 1) {
    if (slot === from || slot === from + 1) continue;
    slots.push(slot);
  }
  return slots;
}

/**
 * Move the widget with `id` into insertion slot `slot` (see
 * {@link placementSlots}). A no-op slot, an unknown id or an out-of-range slot
 * returns the board unchanged.
 */
export function moveWidgetToSlot(config: HomeConfig, id: string, slot: number): HomeConfig {
  const from = config.widgets.findIndex((widget) => widget.id === id);
  if (from < 0 || slot < 0 || slot > config.widgets.length) return config;
  if (slot === from || slot === from + 1) return config;
  // `moveWidget` splices the widget out first, so every slot past its old
  // position shifts down by one.
  return moveWidget(config, from, slot < from ? slot : slot - 1);
}

export function setWidgetSize(config: HomeConfig, id: string, size: WidgetSize): HomeConfig {
  return {
    ...config,
    widgets: config.widgets.map((widget) =>
      widget.id === id ? { ...widget, size: clampSize(widget.type, size) } : widget,
    ),
  };
}

/** Merge `patch` into one widget's settings; `undefined` values clear their key. */
export function setWidgetSettings(
  config: HomeConfig,
  id: string,
  patch: WidgetSettings,
): HomeConfig {
  return {
    ...config,
    widgets: config.widgets.map((widget) => {
      if (widget.id !== id) return widget;
      const settings: WidgetSettings = { ...widget.settings, ...patch };
      for (const key of Object.keys(patch) as (keyof WidgetSettings)[]) {
        if (patch[key] === undefined) delete settings[key];
      }
      return { ...widget, settings };
    }),
  };
}
