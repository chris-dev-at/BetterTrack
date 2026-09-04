/**
 * The admin console's design tokens (#1406 W2, owner mandate 2026-08-29).
 *
 * The owner's brief was "more corners less smooth" — the console trades its
 * soft-rounded V1 look for an **angular, structural** one: zero border radius,
 * hard 1 px rules, visible boxes, uppercase micro-labels on wide tracking, and
 * tabular figures everywhere a number can change. The energy is adapted from the
 * `redesign-demo` walkthrough (dense rows, tight letter-spacing, one saturated
 * accent, structure you can see) — adapted, not copied: that demo is the *user*
 * app's warm gold world, while the console stays sky-accented and dark-only.
 *
 * Why class-string constants rather than CSS custom properties: the console is
 * Tailwind-utility-only and shares one stylesheet with the user app, so a global
 * CSS layer here would leak into Origin. Constants keep the language in one
 * module, let `ui.tsx` compose it, and let a test assert that (say) nothing in
 * the console paints a rounded corner.
 *
 * W3–W7 must build from these. A page that hand-rolls `rounded-lg bg-neutral-900`
 * is a page that will drift.
 */

// ── Surfaces ────────────────────────────────────────────────────────────────
// Three depths, and only three: the canvas the console sits on, the panel a
// section lives in, and the well an input or a code block is sunk into.

/** The console canvas. */
export const SURFACE_CANVAS = 'bg-neutral-950';
/** A panel: the standard bordered container for any section of content. */
export const SURFACE_PANEL = 'bg-neutral-900';
/** A sunk well — inputs, code, the palette trigger. Darker than the canvas. */
export const SURFACE_WELL = 'bg-neutral-950';
/** Row hover / selected-row wash. Never a border change — the grid stays still. */
export const SURFACE_HOVER = 'hover:bg-neutral-900';
/** A header strip inside a panel (table heads, panel titles). */
export const SURFACE_HEADER = 'bg-neutral-900';

// ── Edges ───────────────────────────────────────────────────────────────────
// Every boundary is a visible 1 px line. Nothing is separated by whitespace
// alone, and nothing is rounded.

/** The standard 1 px edge. */
export const EDGE = 'border border-neutral-800';
/** A stronger edge for controls that must read as interactive. */
export const EDGE_STRONG = 'border border-neutral-700';
/** A horizontal rule between stacked rows. */
export const RULE_Y = 'divide-y divide-neutral-800';
/** A vertical rule between side-by-side cells. */
export const RULE_X = 'divide-x divide-neutral-800';
/** A bottom rule, for a header strip sitting above content. */
export const EDGE_BOTTOM = 'border-b border-neutral-800';
/** A top rule, for a footer strip sitting under content. */
export const EDGE_TOP = 'border-t border-neutral-800';
/**
 * The active marker: a 2 px accent bar on the leading edge. This is the
 * console's counterpart to the user app's gold edge line — same idea, sky ink,
 * and (like the user app's rule) it marks the active item and nothing else.
 */
export const EDGE_ACTIVE = 'border-l-2 border-l-sky-500';
/** The inactive counterpart, so an active/inactive swap never shifts layout. */
export const EDGE_ACTIVE_IDLE = 'border-l-2 border-l-transparent';

/** Square corners, stated explicitly so a stray `rounded-*` reads as a bug. */
export const CORNERS = 'rounded-none';

// ── Focus ───────────────────────────────────────────────────────────────────

/**
 * A square focus outline rather than a rounded ring. `outline-offset-0` keeps it
 * flush against the control's own edge, which is what makes the console read as
 * cut rather than floated.
 */
export const FOCUS =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400';
/** Focus for a control whose own edge is the well (inputs, selects). */
export const FOCUS_WITHIN =
  'focus:outline-none focus:border-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400';

// ── Touch ───────────────────────────────────────────────────────────────────

/**
 * The 44 px phone tap-target floor (§13.5 V5-P13b, issue #1756).
 *
 * The console's desktop density is deliberate and stays: 30/34/36/38 px
 * controls are what makes an operator surface dense enough to read. The floor
 * therefore applies below the console's OWN desktop handoff only — declared
 * once in `styles/origin.css`, in an `@media (max-width: 767.98px)` block of
 * its own, keyed on this marker class alone. 768px because that is where the
 * sidebar takes over from the burger and the drawer (`AdminLayout.tsx`), and
 * everything below it navigates by touch-sized drawer rows; the user app's
 * 480px phone block is a different question and this rule does not share it.
 *
 * This is the one exception to "class-string constants, never a CSS layer" at
 * the top of this file, and it is exactly the case that rule was protecting
 * against inverted: nothing outside the console emits `admin-tap-target`, so
 * the rule cannot leak into Origin, and the console still imports none of the
 * `.bt-*` design language. A `max-md:min-h-11` utility pair would work too,
 * but it would depend on Tailwind's utility sort order to beat the density
 * utility on the same element, and it would leave the phone gate no stable
 * selector — the class IS what `e2e/mobile-overflow.spec.ts` measures, so a
 * control that opts in is a control the gate watches.
 */
export const TAP_TARGET = 'admin-tap-target';

// ── Type ────────────────────────────────────────────────────────────────────

/**
 * The micro-label: uppercase, wide tracking, 11 px. Column heads, eyebrows,
 * field labels, badge text. This is the single most load-bearing token in the
 * language — it is what makes a dense screen legible without boxes everywhere.
 */
export const TEXT_MICRO = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500';
/** A micro-label that is being read as content, not chrome. */
export const TEXT_MICRO_STRONG =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-300';
/** Section heading inside a panel. */
export const TEXT_SECTION = 'text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200';
/** The page title. Tight tracking is the demo's confidence tell. */
export const TEXT_TITLE = 'text-[22px] font-semibold tracking-[-0.02em] text-neutral-50';
/** Standard body copy. 13 px — the console is a dense operator surface. */
export const TEXT_BODY = 'text-[13px] text-neutral-300';
/** Secondary / supporting copy. */
export const TEXT_MUTED = 'text-[12px] text-neutral-500';
/** The primary identity in a row (a username, a token label). */
export const TEXT_ROW_PRIMARY = 'text-[13px] font-medium text-neutral-100';
/** Any figure that can change. Tabular so columns never jitter on refresh. */
export const TEXT_NUM = 'tabular-nums';
/** Monospace, for ids, hashes and one-time secrets. */
export const TEXT_MONO = 'font-mono text-[12px] tabular-nums';

// ── Accent ──────────────────────────────────────────────────────────────────

/** An inline link inside console content. Underlined — colour alone is not a cue. */
export const LINK =
  'text-sky-400 underline underline-offset-2 hover:text-sky-300 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400';

// ── Density ─────────────────────────────────────────────────────────────────

/** Padding inside a panel's body. */
export const PAD_PANEL = 'px-4 py-3';
/** Padding for a table cell. */
export const PAD_CELL = 'px-3 py-2';
/** The gap between stacked sections on a page. */
export const STACK = 'flex flex-col gap-4';
/** The gap between controls inside one row. */
export const ROW = 'flex flex-wrap items-center gap-2';

// ── State tones ─────────────────────────────────────────────────────────────

/**
 * The five console tones. `neutral` is the default and carries no meaning;
 * the other four are: good, needs-attention, broken, informational.
 */
export const TONES = ['neutral', 'green', 'amber', 'red', 'sky'] as const;
export type Tone = (typeof TONES)[number];

/** Badge skins — square, 1 px ring, uppercase micro type. */
export const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-neutral-900 text-neutral-300 ring-neutral-700',
  green: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  amber: 'bg-amber-950 text-amber-300 ring-amber-800',
  red: 'bg-red-950 text-red-300 ring-red-800',
  sky: 'bg-sky-950 text-sky-300 ring-sky-800',
};

/** Panel/alert skins — a tinted body behind a hard edge. */
export const TONE_PANEL: Record<Tone, string> = {
  neutral: 'border-neutral-800 bg-neutral-900 text-neutral-300',
  green: 'border-emerald-900 bg-emerald-950/50 text-emerald-200',
  amber: 'border-amber-900 bg-amber-950/50 text-amber-200',
  red: 'border-red-900 bg-red-950/50 text-red-200',
  sky: 'border-sky-900 bg-sky-950/50 text-sky-200',
};

/** The 3 px leading bar an attention row wears. */
export const TONE_BAR: Record<Tone, string> = {
  neutral: 'border-l-neutral-700',
  green: 'border-l-emerald-500',
  amber: 'border-l-amber-500',
  red: 'border-l-red-500',
  sky: 'border-l-sky-500',
};
