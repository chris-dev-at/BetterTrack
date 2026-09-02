# BetterTrack Design Lab

_Archived 2026-09-02 — the Origin redesign record; the shipped design language now lives in `apps/web/src/styles/origin.css`, and the ground-up v6 redesign is tracked in #544._

Status: six production-grade visual directions applied to the complete demo  
Shared product model: portfolio-scoped wealth workspace  
Recommended starting point: **Origin**, with **Northstar** as the calmer card-based
alternative and **Ledger** as the strongest daylight alternative

## Why the directions share one application

The problem to solve is product coherence, so the variants deliberately do not invent
six different information architectures. Portfolio scope, navigation names, review
logic, Workbench behavior, permissions, and mobile tasks remain stable. A person can
evaluate the real effect of typography, geometry, density, and brand character without
mistaking a rearranged feature list for better UX.

Every direction therefore changes:

- suite-navigation geometry;
- information density and page rhythm;
- typography and metric character;
- card edges, elevation, and grouping;
- primary and semantic color behavior;
- desktop composition;
- mobile surface and navigation treatment.

It does not change:

- the recursive Portfolio model;
- the four core jobs;
- the persistent scope;
- the review-before-write AI contract;
- terminology or task order;
- accessible labels and interaction behavior.

## 1. Northstar

**Position:** a premium personal wealth operating system.

- Warm graphite foundation with muted brass, ivory, jade, and coral.
- Stable left suite navigation with balanced information density.
- Softly layered cards and restrained radii.
- Feels capable without looking like trading software.
- Dark-first, but has a complete warm daylight mode.

Best for:

- the broadest audience;
- launching one identity across personal, shared, advisor, and admin contexts;
- retaining some visual continuity with the current BetterTrack brand.

Risk:

- it is the safest direction, so distinctive copy, illustration, and motion will matter
  during brand production.

Recommendation:

- use this as the default product direction and borrow Ledger’s report styling for
  printable/exported views.

## 2. Ledger

**Position:** a modern financial book that happens to be interactive.

- Daylight paper canvas with forest ink and restrained ruled texture.
- Horizontal desktop suite navigation, freeing the full page width.
- Editorial serif display type paired with highly practical interface type.
- Flatter surfaces and quieter borders make reports feel trustworthy.
- Mobile keeps the same task-first bottom navigation.

Best for:

- people who dislike “finance dashboard” aesthetics;
- longer research, reporting, tax, and advisor sessions;
- public share pages and client-facing output.

Risk:

- the top navigation has less room for future first-class destinations. Secondary
  utilities must stay in command search or settings instead of growing endlessly.

## 3. Signal

**Position:** a precise operating console for serious self-directed investors.

- Near-black structured canvas with a calm turquoise signal color.
- Narrow icon-and-label rail maximizes working area.
- Square components, tighter gaps, and monospace metadata increase scan speed.
- Grid texture and explicit borders replace decorative depth.
- Semantic gain/loss colors remain separate from the interface accent.

Best for:

- dense holdings, activity, Workbench, and multi-portfolio workflows;
- power users and frequent desktop use;
- an optional “pro” workspace preference.

Risk:

- it can feel technical during onboarding. The product should not make this the default
  for a first-time investor.

## 4. Atelier

**Position:** a calm private-wealth office for a person, family, or small advisory firm.

- Warm parchment canvas with a floating plum navigation volume.
- Large radii, generous spacing, and serif display type.
- Copper actions feel intentional rather than urgent.
- The sidebar reads like a private room while content stays light and legible.
- Mobile becomes a soft, tactile card stack.

Best for:

- households, private clients, properties, entities, and long-horizon planning;
- advisor and public-share contexts;
- a premium brand that avoids cold fintech conventions.

Risk:

- generous spacing reduces information-per-screen. Dense ledger views should retain a
  compact preference inside this direction.

## 5. Prism

**Position:** a bold modular analytical canvas.

- Deep navy foundation with periwinkle structure and mint semantics.
- Two-column tiled navigation makes the suite itself feel composable.
- Stronger card boundaries make nested data and bento layouts easy to parse.
- Heavier headings and brighter actions create more product energy.
- The Workbench and portfolio-map concepts feel especially native here.

Best for:

- emphasizing BetterTrack’s composability and technical capability;
- users who want a modern product without the visual noise of a trading terminal;
- marketing moments where Northstar may feel too quiet.

Risk:

- the blue family is common in software. Brand assets and copy must prevent it from
  becoming generic SaaS.

## 6. Origin

**Position:** the production-oriented synthesis of Northstar and the current
BetterTrack product.

- Retains the original BetterTrack app icon and wordmark relationship: white
  “Better” with the original gold `#F6B82E` “Track.”
- Uses the same warm graphite foundation and premium calm that made Northstar the
  strongest first demo, but with sharper 6–8px geometry and less decorative elevation.
- Treats the page as one continuous working surface. Borders, ruled bands, shared
  baselines, and vertical separators establish hierarchy; cards are reserved for
  discrete objects such as a portfolio, credential, or review item.
- Gives the primary performance graph the page, instead of placing a small graph inside
  a dashboard tile. The simulated series contains more than 200 visible, unsmoothed
  points plus invested-capital, volume, event, crosshair, and value-scale detail.
- Keeps attribution beside the graph as a ranked explanatory rail. It tells the user
  where to focus without repeating a loose stack of “what moved” cards below it.
- Carries real BetterTrack depth into the shared suite: value and performance analysis,
  holdings and transactions, cash sources, broker imports, tax lots, watchlists, alerts,
  Blueprints/backtests, asset research, sharing, and portfolio collaboration.
- Keeps the permanent sidebar focused on Home, Portfolios, Workbench, Assets, and
  People. Ask and Review remain utilities; Connections, imports, settings, and the
  Developer Platform live in a Control Center instead of overcrowding navigation.
- Adds a full Developer Platform with Overview, API keys, OAuth apps, Webhooks, MCP, and
  Logs. It uses the same portfolio boundaries, permissions, and audit language as the
  rest of BetterTrack rather than behaving like a separate admin product.

Best for:

- the next production design pass;
- serious self-directed investors who want analytical resolution without a day-trading
  terminal;
- households, advisors, and builders who need one model to support both simple and
  advanced workflows;
- wide desktop workspaces, while retaining a task-first mobile composition.

Risk:

- continuous surfaces depend on disciplined spacing and dividers. If every subsection
  later receives its own background, Origin will regress into the disconnected card
  grid it is intended to fix.

Recommendation:

- use Origin as the baseline for implementation and usability testing. Keep Northstar
  available in the Design Lab as a reference for moments that benefit from softer
  grouping.

## Evaluation criteria

When choosing the production direction, test each system with the same tasks:

1. Find the source of a monthly value change.
2. Resolve two items in Review.
3. Enter an expense inside the correct portfolio.
4. Create and compare a ten-year contribution scenario.
5. Invite a co-owner with limited permissions.
6. Explain a number’s source and calculation.
7. Create a portfolio-scoped API key and trace one request.
8. Complete the investor tasks on a phone without learning different terminology.

Score comprehension, time, error rate, trust, perceived capability, and visual
preference separately. A beautiful direction should not win if people complete fewer
tasks or understand portfolio scope less clearly.

## Suggested synthesis

If user testing does not produce a decisive winner:

- keep **Origin** for the core application shell and continuous analytical pages;
- reuse **Northstar’s softer grouping** for onboarding and low-density empty states;
- use **Ledger** for reports, exports, and public sharing;
- offer **Signal density** as an advanced preference;
- borrow **Atelier’s spacing and tone** for onboarding and family/advisor moments;
- use **Prism’s modular treatment** selectively in Workbench and portfolio composition.

That synthesis preserves one brand and one UX while taking the strongest behavior from
each exploration.
