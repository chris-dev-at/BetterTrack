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
  'performance-chart',
  'cashflow-chart',
  'allocation',
  'top-movers',
  'portfolio-cards',
  'news',
  'attention',
  'upcoming',
  'shortcuts',
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Column spans on the 12-column desktop grid: s = 4, m = 6, l = 12. */
export const WIDGET_SIZES = ['s', 'm', 'l'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** `'all'` (every active portfolio, rolled up) or one portfolio's id. */
export type WidgetScope = 'all' | string;

/** Ranking metric for the top-movers widget — today's move or lifetime P/L. */
export type MoverMetric = 'day' | 'total';

export interface WidgetSettings {
  /** Which portfolios feed the widget. Ignored by unscoped widget types. */
  scope?: WidgetScope;
  /** Time window token. Each type declares its own vocabulary (see the registry). */
  range?: string;
  /** Top-movers ranking metric. */
  metric?: MoverMetric;
}

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
  'cashflow-chart': { allowed: ['m', 'l'], default: 'm' },
  allocation: { allowed: ['s', 'm', 'l'], default: 'm' },
  'top-movers': { allowed: ['s', 'm', 'l'], default: 'm' },
  'portfolio-cards': { allowed: ['m', 'l'], default: 'l' },
  news: { allowed: ['s', 'm', 'l'], default: 'm' },
  attention: { allowed: ['s', 'm', 'l'], default: 'm' },
  upcoming: { allowed: ['s', 'm', 'l'], default: 'm' },
  shortcuts: { allowed: ['m', 'l'], default: 'l' },
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
 * Keep only the settings keys this build understands, each type-checked. Unknown
 * keys are dropped rather than carried through, so a newer build's settings can
 * never reach a widget that would misread them.
 */
function parseSettings(raw: unknown): WidgetSettings {
  if (!isRecord(raw)) return {};
  const settings: WidgetSettings = {};
  if (typeof raw.scope === 'string' && raw.scope.length > 0) settings.scope = raw.scope;
  if (typeof raw.range === 'string' && raw.range.length > 0) settings.range = raw.range;
  if (raw.metric === 'day' || raw.metric === 'total') settings.metric = raw.metric;
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
    settings: parseSettings(raw.settings),
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

/** Append a widget of `type` with its default size and settings. */
export function addWidget(
  config: HomeConfig,
  type: WidgetType,
  defaultSettings: WidgetSettings,
): HomeConfig {
  return {
    ...config,
    widgets: [
      ...config.widgets,
      {
        id: newWidgetId(type),
        type,
        size: WIDGET_SIZE_RULES[type].default,
        settings: { ...defaultSettings },
      },
    ],
  };
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
