# BetterTrack redesign demo

A complete, frontend-only product preview for BetterTrack as one connected wealth
workspace. It is intentionally built as a real application shell rather than a landing
page or a collection of disconnected dashboard mockups.

## Run it

From the repository root:

```bash
pnpm install
pnpm --filter @bettertrack/redesign-demo dev
```

Open `http://localhost:5174`.

Production build and checks:

```bash
pnpm --filter @bettertrack/redesign-demo typecheck
pnpm --filter @bettertrack/redesign-demo build
pnpm --filter @bettertrack/redesign-demo test:e2e
```

## Start here

1. Open the avatar at the bottom of the desktop sidebar, or the BetterTrack mark on
   mobile.
2. Use **Design direction** to switch the entire product among Northstar, Ledger,
   Signal, Atelier, Prism, and Origin. Origin is the default sixth direction.
3. Use **Product surfaces** to preview onboarding, authentication, the advisor
   workspace, settings and security, a public portfolio, and the admin console.
4. Return to the personal suite and change the portfolio scope in the top-left.
5. Press `⌘/Ctrl + K`, search for “Developer,” and open the full Developer Platform.
6. Open **Control center → Connections** to inspect the complete source lifecycle.
7. Open **Control center → Backups** for checkpoints, restore previews, portable exports,
   and retention.
8. Open **Personal wealth → Overview → Data quality** to inspect field-level integrity,
   source lineage, evidence requests, correction proposals, and receipts.
9. Choose **Onboarding** to run the full account, data-home, security, first-portfolio,
   first-source, collaboration, and activation journey.

For a complete portfolio-to-platform evaluation route, follow
[`docs/redesign/ORIGIN_DEMO_TOUR.md`](../../docs/redesign/ORIGIN_DEMO_TOUR.md).

The selected direction, theme, density, portfolio scope, created portfolios, trades, cash
flow, imports, review decisions, shares, connection records, developer credentials,
security preferences, dashboard widgets, mobile destination, collaboration state, and
discreet mode persist in local storage. **Reset all demo data** clears only keys owned by
this demo.

## Product coverage

The demo includes:

- a scope-aware Home with performance, attribution, nested portfolios, review queue,
  upcoming activity, allocation, cash flow, and an AI brief;
- a recursive Portfolio directory and a detailed portfolio with Overview, Activity,
  Holdings, Cash flow, Analysis, Tax, Plan, Automate, Files, and People;
- a Workbench scenario studio with editable monthly contributions, projections,
  assumptions, collaborators, reusable Blueprints, backtests, comparisons, calculators,
  saved ideas, and portfolio-aware Alerts;
- connected asset research with watchlists, performance-aware charts, ownership context,
  metrics, news, and events;
- detailed Origin performance views with more than 200 unsmoothed data points, fine
  grid/scale detail, invested-capital history, volume, and activity markers;
- portfolio-native co-ownership, roles, invitations, approvals, and an audit trail;
- scoped Ask BetterTrack conversations, explainable results, editable scenarios, and
  review-before-write automation proposals;
- simulated Google Drive, Parqet, bank, and broker connections;
- a full Connections workspace with permissions, simulated OAuth, account and portfolio
  mapping, import/export/two-way directions, staged reconciliation, health, conflict
  resolution, logs, sync, reauthorization, pause, and safe disconnection;
- universal creation for expenses, income, transfers, nested portfolios, and imports;
- detailed buy/sell flows with value/units entry, market/limit intent, funding, recurring
  proposals, uncovered-lot handling, tax follow-up, review, and a connected receipt;
- a staged import flow with source selection, mapping, duplicate detection, cost-basis
  exceptions, reconciliation, atomic apply, and undo receipt;
- one Review workspace for imports, tax assumptions, AI/automation proposals, OAuth
  consent, collaboration changes, and sync conflicts;
- deep analysis and automation workspaces that create reviewable Workbench proposals
  rather than silent portfolio writes;
- a persistent Goals & Plan workspace with high-resolution projections, editable
  assumptions, linked balances, contributions, allocation drift, creation receipts,
  archive/restore, and Review-gated recurring funding;
- Protection & Continuity inside Portfolio Plan with beneficiaries, coverage versus
  liabilities and goals, estate-evidence readiness, an owner-unavailable Workbench
  scenario, consented emergency handoff rules, redacted package previews, check-ins, and
  auditable receipts;
- portfolio-native Data Health with completeness, freshness, and reconciliation metrics,
  five field-level issue classes, object/source lineage, policy controls, evidence
  requests, reasoned ignore/resolve receipts, and Review-gated truth corrections;
- a portfolio Structure & Ownership graph with single-parent safeguards, recursive
  containment, direct and effective ownership, linked liabilities, lifecycle audit,
  create-under context, and Review-applied reparenting or ownership mutations;
- a portfolio Events inbox for dividends, reinvestments, splits, rights, spin-offs,
  capital returns, and delistings, with source confidence, dates, assumptions, evidence,
  safe batch confirmation, tax and holding diffs, receipts, and Review for ambiguity;
- a constraint-aware Workbench rebalancer with target sleeves, drift bands, cash-only or
  mixed funding, whole/fractional quantities, minimum orders, turnover and cash limits,
  protected holdings, tax-aware sales, exact trade explanations, saved scenarios, and an
  immutable Review proposal;
- portfolio-scoped Settings & Lifecycle for identity, reporting conventions, valuation
  and return policy, connected-data authority, privacy, approval thresholds, duplication,
  splitting, archival, audit history, direct-save receipts, and Review-gated material
  changes;
- Private Markets inside portfolio Cash flow, with commitments, contributed/distributed/
  unfunded capital, capital-call coverage, NAV/IRR/TVPI/DPI, currency translation,
  source evidence, detailed valuation history, persistent records, and Review-gated
  funding or valuation proposals;
- a portfolio Tax workspace with lineage, readiness, monthly signals, FIFO/average/
  specific-lot simulations, missing-basis remediation, Review proposals, accountant
  access, and downloadable fictional JSON/CSV reports;
- a portfolio Documents workspace with uploads, classification, evidence linking,
  checksums, Drive roles, filters, review resolution, annotations, access controls,
  versions, archive/restore, and persistent receipts;
- Data Management in Control Center with data-home ownership, verified checkpoints,
  guarded restore simulations, portable export manifests, Drive destinations, and
  retention policy;
- command search, discreet mode, theme and density controls, dashboard customization,
  and responsive mobile navigation;
- a dedicated Developer Platform with usage overview, scoped API-key creation, public or
  confidential OAuth app registration, webhook signing/test deliveries, permissioned
  MCP configuration, and filterable request logs;
- sign-in, Google chooser, passkey, 2FA, registration, guided onboarding, settings,
  billing, public sharing, advisor, and admin surfaces.

Everything is fictional and runs locally. Buttons that represent a consequential backend
action stop at a clear simulated confirmation or review state.

## Prototype boundaries

The demo deliberately does not fake capabilities whose trust model depends on production
infrastructure or deeper domain validation:

- human risk willingness/capacity/horizon alignment remains a later Portfolio Plan
  workspace; the current Risk view covers portfolio risk and stress only;
- persistent advisor service cycles remain later-phase workflow infrastructure rather
  than another disconnected calendar card;
- proof-of-wealth output is a source-checked preview, not independent attestation,
  signing, or certification.

## Design directions

The six directions are not separate products and do not fork the interaction model.
They demonstrate how one robust product architecture can carry very different brand
expressions:

- **Northstar** — warm graphite, balanced density, familiar left suite navigation.
- **Ledger** — editorial daylight, horizontal suite navigation, paper-like reporting.
- **Signal** — compact dark operating console, narrow rail, square and precise controls.
- **Atelier** — spacious private-wealth office, floating plum navigation, tactile cards.
- **Prism** — bold modular canvas, tiled navigation, indigo analytical surfaces.
- **Origin** — Northstar’s premium graphite foundation combined with the real
  BetterTrack logo/colors, sharper edges, continuous unboxed page composition, denser
  charts, current-product feature depth, and Cloudflare-dashboard-like operational
  clarity: grouped navigation, flat modules, crisp rules, calm spacing, and predictable
  detail workspaces.

Origin keeps the permanent sidebar focused on the five suite destinations. Connections,
imports, settings, backup, and developer access are organized in Control Center and
remain reachable through command search and contextual links.

The rationale and production tradeoffs are documented in
`docs/redesign/DESIGN_DIRECTIONS.md`.

## Keyboard

- `⌘/Ctrl + K` — global command search
- `⌘/Ctrl + J` — Ask BetterTrack
- `Escape` — close the active overlay
