# BetterTrack core design language

_Archived 2026-09-02 — the Origin redesign record; the shipped design language now lives in `apps/web/src/styles/origin.css`, and the ground-up v6 redesign is tracked in #544._

Design BetterTrack as a premium, calm, modern financial suite. It should feel spacious,
precise, connected, and highly capable without looking like a trading terminal or a
generic SaaS dashboard.

This document defines visual language only. It does not define features, pages,
navigation labels, product structure, permissions, workflows, or data models. Use the
current Origin redesign demo as the visual reference and apply this language to the real
content of each screen.

## Overall character

- Dark-first, premium, restrained, and slightly futuristic.
- Warm and confident rather than cold, neon, or overly technical.
- Information-rich without becoming dense or overstimulating.
- Polished like a mature professional suite, not a collection of website cards.
- Minimal decoration; visual quality comes from proportion, typography, alignment,
  spacing, and excellent data presentation.

## Application frame

- Use a stable left navigation rail on desktop with a slim contextual bar across the
  top.
- Show the full BetterTrack wordmark and small `Web` signature while the rail is
  expanded.
- Show only the BetterTrack app mark while the rail is collapsed.
- Keep navigation visually quiet, predictable, and clearly separate from the working
  canvas.
- Let the main content begin at the left content gutter and expand naturally across the
  available width.
- Never center a narrow application column beside a wide navigation rail.
- Use the full desktop canvas when the content benefits from it, while retaining
  generous outer breathing room.

## Page composition

- Treat every screen as one continuous working canvas.
- Establish one clear visual focus.
- Lead with the actual content or working surface rather than a large introductory
  header.
- Use whitespace, alignment, shared baselines, and thin dividers to create structure.
- Avoid grids of unrelated floating widgets.
- Avoid nested cards and containers inside containers.
- Use cards only when something is genuinely a separate object.
- Remove repeated titles, redundant labels, decorative metrics, and explanatory filler.
- Keep secondary detail available through tabs, disclosures, inspectors, or drawers.

## Spacing

- Desktop content gutters: approximately `38–56px`.
- Major region spacing: approximately `24–40px`.
- Related section spacing: approximately `16–24px`.
- Compact control spacing: approximately `8–12px`.
- Mobile gutters: approximately `16px`.
- Preserve empty space around important information. Do not fill space merely because
  it exists.

## Shape and surfaces

- Use mostly flat graphite surfaces with crisp one-pixel boundaries.
- Use restrained corner radii of approximately `4–8px`.
- Use little or no shadow on normal interface elements.
- Reserve stronger elevation for temporary overlays such as menus, dialogs, and
  drawers.
- Avoid excessive pills, giant rounded rectangles, glassmorphism, glow, and decorative
  gradients.

## Color

Use this dark-theme foundation:

| Role              | Color     |
| ----------------- | --------- |
| Background        | `#090C10` |
| Raised background | `#0C1015` |
| Navigation        | `#07090C` |
| Surface           | `#10151B` |
| Soft surface      | `#121820` |
| Strong surface    | `#171E27` |
| Primary text      | `#F4F6F8` |
| Secondary text    | `#C7CDD5` |
| Muted text        | `#8B949F` |
| BetterTrack gold  | `#F6B82E` |
| Positive          | `#34D399` |
| Negative          | `#FB7185` |
| Analytical blue   | `#38BDF8` |

- Keep **Better** white and **Track** gold.
- Use gold for brand identity, primary interaction, focus, and selective emphasis.
- Do not flood the interface with gold.
- Use green and red only when they carry real positive or negative meaning.
- Use analytical blue as the calm default for neutral data visualization.
- Use subtle neutral borders at roughly 8–15% opacity.

## Typography

Use Inter or a high-quality native system sans-serif with tabular numerals.

- Page title: `27–32px`
- Singular primary value: `36–44px`, used sparingly
- Section heading: `16–18px`
- Row or object title: `13.5–14px`
- Body and controls: `13–14px`
- Metadata and chart labels: at least `12px`
- Body line-height: approximately `1.45–1.55`

Use soft ivory instead of pure white. Keep muted text comfortably readable. Important
values may be prominent, but they should never overpower the entire screen.

## Controls

- Use compact, precise controls with clear labels.
- Standard desktop controls should generally be `34–40px` tall.
- Use small radii, quiet borders, and restrained selected states.
- Make one action visually primary only when the screen needs one.
- Keep hover, active, focus, disabled, loading, and destructive states unambiguous.
- Use a clear gold-accented focus ring.
- Avoid placing many equally loud buttons beside each other.

## Data visualization

- Integrate primary charts directly into the page instead of boxing them inside a
  widget.
- Let important charts be broad, detailed, and visually dominant.
- Preserve real variation and use dense source data; do not heavily smooth the line.
- Use subtle grid lines, readable axes, a crosshair, exact tooltips, and quiet controls.
- Keep chart decoration subordinate to the data.
- Use neutral analytical blue by default, with green or red only when the selected data
  meaningfully calls for it.
- Let charts approach the content edges on small screens.

## Responsive behavior

- Build one responsive visual system rather than shrinking the desktop layout.
- Collapse the navigation rail at intermediate widths.
- Recompose columns and secondary panels when space becomes limited.
- Keep type readable and controls comfortably touchable.
- Use at least `44px` touch targets for important mobile actions.
- Allow long local navigation to scroll horizontally with a visible continuation cue.
- Never allow page-level horizontal overflow.
- On mobile, prioritize the main content and let it use nearly the full screen width.

## Motion

- Keep control and navigation transitions around `140–220ms`.
- Keep panel and layout transitions around `280–420ms`.
- Motion should explain continuity and state change, never decorate the interface.
- Honor reduced-motion preferences.

## Final visual test

The result should feel like one continuous premium application:

- spacious but not empty;
- detailed but not overwhelming;
- strong hierarchy without oversized elements;
- flat and connected rather than boxed and fragmented;
- unmistakably BetterTrack through its mark, gold accent, graphite canvas, and precise
  financial presentation.
