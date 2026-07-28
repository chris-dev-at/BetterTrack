# BetterTrack — Ground-up product blueprint

Status: Origin synthesis implemented as the sixth redesign direction  
Primary platform: desktop web, adapting deliberately to mobile web/PWA  
Product line: **Your wealth, working together.**

## 1. Product definition

BetterTrack is a **wealth workspace** for people who want to understand, shape, and
collaborate on their financial lives without stitching together a tracker, a budget app,
a forecasting tool, a spreadsheet, and a social network.

The atomic object is a **Portfolio**. A portfolio is not merely a list of securities. It
is a permissioned, composable financial workspace containing:

- assets, liabilities, cash accounts, holdings, and ownership stakes;
- transactions, income, expenses, dividends, fees, and transfers;
- goals, forecasts, scenarios, automations, and target allocations;
- data connections, imported files, documents, and calculation provenance;
- collaborators, roles, comments, approvals, and an audit trail;
- child portfolios, allowing a portfolio to represent a person, household, company,
  client, mandate, strategy, or total-wealth roll-up.

This recursive model is the core advantage. Someone can start with one simple portfolio,
then split it, nest it, share it, connect it, or roll it up without changing products.

## 2. The four connected jobs

The existing four-part mental model is retained, but each part operates on the same
portfolio-scoped data instead of behaving like a separate application.

1. **Portfolio — hold and understand the truth**
   - Overview, activity, holdings, cash flow, analysis, plans, files, collaborators,
     automations, integrations, settings.
   - Expenses are cash-flow activity inside a portfolio, never a top-level product.
   - Nested portfolios and ownership percentages support households, businesses,
     advisors, group investing, and total-wealth views.

2. **Workbench — test and manipulate possibilities**
   - Scenarios, forecasts, backtests, comparisons, rebalancing, strategy baskets,
     calculators, saved ideas, and AI-assisted planning.
   - Workbench sessions are non-destructive drafts until the user explicitly applies
     them to a portfolio.

3. **Assets — research the ingredients**
   - Search, security detail, live charts, fundamentals, estimates, news, events,
     watchlists, screeners, alerts, and ETF/fund look-through.
   - Any researched asset can be sent into a Workbench scenario or added to a portfolio.

4. **People — control who works with the data**
   - Co-owned portfolios, teams, clients, invitations, approvals, activity, and
     lightweight discussion.
   - Collaboration is portfolio-first. A generic social feed and chat are secondary.

## 3. The connective tissue

### Portfolio scope

Every primary screen has one persistent scope control:

- All wealth;
- one portfolio;
- several selected portfolios;
- a saved scope such as “Family excluding business”;
- a client or organization context.

Changing scope updates totals, analytics, Workbench inputs, asset ownership markers,
AI context, upcoming events, permissions, and search results. The user never has to
rebuild the same selection in six modules.

### Universal activity model

Trades, transfers, expenses, income, dividends, value changes, file imports, bank syncs,
automation runs, comments, approvals, and collaborator changes share one typed timeline.
Users can switch between a human-friendly feed, a dense ledger, a cash-flow view, and
saved filtered views without leaving the portfolio.

### Universal create action

One create menu routes intent into the correct workflow:

- buy or sell;
- income or expense;
- transfer;
- asset or liability;
- portfolio or child portfolio;
- scenario;
- automation;
- collaborator;
- import or connection.

The current scope is preselected. When the scope contains multiple portfolios, the
composer asks for a target before saving.

### Review inbox

The home screen and every portfolio expose a single “Needs review” queue for:

- uncategorized or duplicate activity;
- stale connections and failed imports;
- pending invitations or approvals;
- target-allocation drift;
- missing cost basis or price data;
- automation proposals;
- unusual cash flow or document requests.

This turns fragmented status warnings into a manageable workflow.

### Data provenance

Every consequential number can expose:

- source account, import, or manual entry;
- calculation method and covered date range;
- last sync and price timestamp;
- currency and FX source;
- whether the value is actual, estimated, or simulated;
- who changed it and when.

## 4. Information architecture

### Persistent suite navigation

- **Home** — scoped command center and customizable dashboard
- **Portfolios** — portfolio tree, list, templates, archived portfolios
- **Workbench** — scenarios, forecasts, strategy Blueprints, backtests, compare
- **Assets** — search, watchlists, discover, news, events
- **People** — co-owned work, teams, clients, shared items

Persistent utilities:

- Ask BetterTrack
- Review inbox
- Global search / command menu
- Create
- Notifications
- Account / organization switcher

Connections, imports/exports, backup, settings, and developer tools live in a compact
**Control Center**. This keeps the sidebar from becoming a second feature directory while
making advanced capability reachable through Control Center, command search, and
contextual links.

The mobile bottom bar defaults to Home, Portfolios, Workbench, Assets, and Create. Each
user can replace Assets with People or Developer; later candidates include News, Review,
or Ask.

### Portfolio-local navigation

- **Overview** — current state, change, composition, attention, upcoming
- **Activity** — trades, transfers, income, expenses, dividends, fees, audit
- **Holdings** — securities, cash, property, alternatives, liabilities, child portfolios
- **Cash flow** — income, spending, recurring items, budgets, runway
- **Analysis** — performance, allocation, risk, exposure, dividends, benchmarks
- **Tax** — yearly position, realized lots, dividends, withholding, missing basis,
  document readiness
- **Plan** — goals, forecast, target allocation, rebalancing, scenario links
- **Automate** — standing orders, rules, sync schedules, approved AI actions
- **Files** — statements, contracts, receipts, valuation evidence
- **People** — roles, access, approvals, ownership
- **Settings** — currency, tax model, privacy, integrations, archive/split/merge

The local navigation is progressive. Simple portfolios can show only Overview, Activity,
Holdings, and More; advanced users can pin any destination.

### Workbench navigation

- **Studio** — visual scenario builder
- **Forecasts** — cash and portfolio projections
- **Blueprints** — reusable investment baskets and allocation rules
- **Backtests** — historical simulations and custom benchmarks
- **Compare** — actual portfolios, scenarios, assets, and benchmarks
- **Ideas** — saved hypotheses and research notes
- **Calculators** — focused tools, opened in context rather than a separate product
- **Alerts** — portfolio, allocation, price, cash-runway, connection, and valuation
  conditions with explicit delivery channels

“Blueprint” replaces “Conglomerate.” It describes a reusable plan that can contain nested
assets, portfolios, weights, rebalance logic, and contribution rules without implying
that the user already owns it.

## 5. Core screen contract

Every major destination answers the same five questions in the same order:

1. **Where am I?** Current portfolio scope, date range, and mode.
2. **What is true?** Primary value and a small number of decisive metrics.
3. **What changed?** Explainable changes connected to underlying activity.
4. **What needs attention?** A prioritized, actionable review queue.
5. **What can I do next?** Contextual actions, not a wall of generic buttons.

The home screen follows the requested hierarchy:

1. total value / net worth;
2. what changed and why;
3. what needs attention;
4. what is upcoming;
5. recommended or frequent actions.

## 6. Portfolio types without separate products

Portfolio capabilities are composed with settings and roles rather than creating
different applications:

- **Personal** — one owner, optional trusted viewer;
- **Shared** — several owners or editors;
- **Household** — children may be people or separate portfolios;
- **Entity** — company, trust, club, or partnership with ownership stakes;
- **Client** — advisor-managed with review and approval rules;
- **Aggregate** — nested view across selected portfolios;
- **Model** — a non-funded target used as a benchmark or reusable Blueprint.

A user can convert or extend a portfolio as their needs grow. The setup wizard asks what
the portfolio represents, then configures sensible defaults while keeping the underlying
model consistent.

## 7. AI contract

AI is a deliberate destination, not a floating mascot.

### Ask BetterTrack

- User explicitly selects one or more portfolio scopes.
- The context panel shows exactly which data is readable and writable.
- Answers link every figure back to portfolio records and assumptions.
- Scenario answers can open a Workbench draft with editable parameters.
- Proposed changes appear as a reviewable action plan.
- No write, trade, automation, deletion, or sharing change executes without explicit
  confirmation.
- Role permissions, audit logs, and paranoid-mode restrictions always apply.

Example:

> “What happens if I invest €200 into the S&P 500 each month for ten years?”

The answer contains an assumption card, projected range, portfolio comparison, and an
optional draft automation. The automation remains a proposal until reviewed.

### Contextual intelligence

Small AI elements are allowed only where they reduce real work:

- explain a portfolio change;
- categorize imported activity;
- summarize relevant news for owned assets;
- identify missing or contradictory data;
- draft scenario assumptions;
- summarize collaborator changes;
- turn a request into a filtered view.

No unsolicited chat bubbles, decorative sparkle buttons, or opaque “AI scores.”

## 8. Visual system

### Character

Premium, calm, warm, and precise. Slightly futuristic through layering, motion, and
excellent information behavior—not neon gradients or science-fiction ornament.

### Foundation

- Dark-first for the demo, with system theme used on first production visit.
- Warm graphite surfaces instead of blue-black.
- Soft ivory type instead of pure white.
- The existing BetterTrack mark is retained. “Better” remains white and “Track” uses the
  original gold `#F6B82E`; the app icon remains the original white B / gold T on near
  black.
- The original gold is the brand/action accent, used deliberately rather than flooding
  analytical data.
- Jade and coral reserved for semantic gain/loss and health states.
- Portfolio performance uses a neutral sky-blue by default so gold remains a brand and
  action signal.
- Individual assets can use jade when positive and coral when negative over the selected
  interval.

### Density

Balanced by default. Each analytical page supports:

- comfortable or compact density;
- overview and deep-analysis modes;
- saved column and widget layouts;
- keyboard navigation and command search;
- a focused full-screen mode for charting and complex Workbench tasks.
- high-resolution charts with more than 200 unsmoothed points in the default analytical
  range, rather than a decorative ten-point sparkline.

### Shape and elevation

- Origin uses mostly 6–8px radii for controls and discrete objects. Softer directions may
  retain 10–16px radii.
- Fine warm borders, ruled bands, shared baselines, and restrained elevation.
- Large ambient gradients only in spacious overview regions.
- Dense tables use flat surfaces, aligned numerals, sticky headers, and row drill-down.

### Continuous page grammar

Origin is composed as a working canvas, not a grid of unrelated cards:

- a primary graph can run across the main content column and share a baseline with a
  narrow explanation rail;
- metric strips, tables, allocation, review, and upcoming activity use separators inside
  one page region instead of each receiving a rounded container;
- borders communicate a real boundary between tasks or objects, not a default decoration;
- cards are reserved for independent objects that can be selected, moved, or acted on;
- progressive disclosure moves secondary controls into tabs, detail panels, and
  expandable rows instead of hiding useful data entirely.

The detailed chart remains visually calm while exposing hundreds of real-looking,
unsmoothed observations, a right-side scale, fine grid, invested-capital line, activity
volume, contribution/dividend/valuation markers, and point-specific tooltips. Asset
charts use positive or negative semantic color for the selected interval; portfolio
charts remain neutral.

### Motion

- 140–220ms for controls and navigation.
- 280–420ms for panels, scope changes, and chart transitions.
- Motion communicates continuity: filters morph results, cards expand into details,
  created items appear in the relevant timeline.
- Reduced-motion preferences are honored.

## 9. Personalization

- Rearrange, resize, hide, or add Home and portfolio widgets.
- Save layouts per portfolio type and screen size.
- Pin local navigation destinations.
- Configure mobile bottom navigation.
- Select compact/comfortable density.
- Choose chart palette, baseline, benchmark, and visible events.
- Create saved scopes and saved filtered activity views.
- Set discreet mode to blur or replace sensitive values.
- Paranoid mode can require re-authentication, block AI/network context, and conceal data.

Personalization never changes the location of destructive actions or security controls.

## 10. Feature inventory for the complete demo

### Current BetterTrack capability carried forward

Origin is a redesign of the product that exists, not a replacement mockup with shallower
content. Its structure explicitly accommodates the current application’s working
capabilities:

- dense value and performance history with M1, M3, M6, Y1, YTD, maximum, and custom
  ranges; inflation-adjusted values; portfolio/asset/index comparisons; overlays,
  markers, CAGR, drawdown, best/worst day, and contribution analysis;
- net worth, cash, liquidity, invested capital, unrealized P&L, day movement, allocation,
  holdings, transactions, winners/losers, and custom investments;
- cash sources plus deposit, withdrawal, transfer, and balance correction;
- annual tax reporting with realized P&L, dividends, withholding, refunds, net position,
  and lot-level drill-down;
- broker import review for Trade Republic, Flatex, Interactive Brokers, and George;
- watchlist creation/reordering, price and portfolio alerts, existing
  conglomerate/Blueprint builders and backtests, and saved ideas;
- dense asset history, live quote frames, watchlist/transaction/alert actions, and
  “appears in” links back to portfolios and plans;
- portfolio sharing, collaborators, permissions, and activity attached to the financial
  object instead of isolated social mechanics;
- the existing API-key and OAuth foundation, expanded into a coherent Developer
  Platform.

The demo can use fictional records, but page allocation and navigation are sized for
these real features so production work does not have to reintroduce them after the
visual design is approved.

### Authentication and trust

- Sign in, register, invite acceptance, Google sign-in simulation
- account chooser, passkey, PIN unlock, two-factor setup and challenge
- trusted devices, sessions, recovery, forced password change
- role/demo persona switcher and OAuth consent

### Portfolio data

- nested portfolios and ownership percentages
- securities, cash, property, vehicles, crypto, collectibles, private assets
- debts, mortgages, loans, credit, capital commitments
- buys/sells, transfers, dividends, income, expenses, fees, taxes
- custom assets and custom price histories
- files, receipts, notes, valuations, statements
- split/merge portfolio, archive, duplicate, templates

### Analytics

- value and net worth, absolute and percentage performance
- TTWROR, IRR, realized/unrealized gains, drawdown, volatility, Sharpe
- allocation, concentration, asset class, region, sector, currency
- ETF/fund and nested-portfolio look-through
- income/dividend analysis and forecasts
- benchmark comparison, contribution analysis, moving averages
- tax estimates for Austria, Germany, and custom rules
- inflation-adjusted values and explainable calculation details

### Workbench

- visual what-if Studio
- recurring contribution and withdrawal forecasts
- Blueprints with nested components and target weights
- historical backtests, late listings, custom benchmarks, rebalance rules
- scenario comparison and apply-to-portfolio review
- calculators and saved ideas
- natural-language scenario creation

### Cash flow and planning

- portfolio-scoped categories, tags, rules, budgets, and recurring items
- upcoming calendar, runway, expected versus actual
- goals, target dates, required contributions
- debt payoff planning and capital calls
- standing orders and approved automations

### Research

- global asset search and command search
- asset profile, charts, fundamentals, estimates, filings, peers
- news, earnings, dividends, splits, macro and economic calendar
- watchlists, alerts, screener, heatmaps, compare
- owned-in and used-in markers linking back to portfolios and Workbench

### Collaboration and sharing

- co-owned portfolios, role-based access, invitations, ownership stakes
- task/review requests, comments, approvals, activity/audit
- groups and advisor/client workspaces
- shareable report and public-link preview
- profiles, follows, reactions, and messages as secondary surfaces

### Connections and platform

- Google identity and Drive import/export
- bank/cash sync and Parqet two-way sync
- CSV/PDF/manual import review
- API keys, OAuth apps, webhooks, MCP context
- source health, sync logs, conflict resolution
- proof-of-wealth report, emergency/trusted access, data export

### Developer Platform

Developer functionality is a dedicated suite page, not another group of permanent
sidebar items. It is reachable through command search, Control Center, Connections, and
relevant portfolio integration links.

- **Overview** — request volume, plan use, latency, platform health, active integrations,
  first-request example, and routes into each integration type.
- **API keys** — create a personal token, select one portfolio or all wealth, grant
  explicit read/write scopes, show the token once, inspect use, and revoke it. A write
  scope includes its matching read scope.
- **OAuth apps** — register public PKCE or confidential clients, manage redirect URIs and
  scopes, reveal credentials once, preview the authorization model, inspect authorized
  apps, and revoke grants.
- **Webhooks** — register HTTPS endpoints, choose event types, reveal a signing secret
  once, pause/resume endpoints, send test events, redeliver, and inspect signed delivery
  attempts and responses.
- **MCP** — configure a Streamable HTTP client, choose a portfolio boundary and tools,
  rotate access, inspect connected clients, and require finance writes to arrive as
  reviewable proposals.
- **Logs** — filter requests by period, path, actor, result, and source; inspect status,
  latency, authentication, portfolio scope, region, response preview, and request ID; and
  export a CSV.

Connections and Developer are deliberately separate. Connections answer “where does my
financial data come from or go?” Developer answers “what can software I build access?”
Administrative provider configuration remains in the admin surface.

### Administration

- users, invitations, roles, plans, quotas, feature flags
- registration, defaults, AI policy, OAuth/API apps
- announcements, health, incidents, usage, audit, email
- connection providers, sync jobs, problem queue, governance

## 11. Demo behavior standard

The redesign demo does not need a production backend, but its primary journeys should
behave like a real app. This prototype implements the connected happy paths; the full
production state matrix remains an implementation requirement.

- State is stored locally and can be reset from the demo menu.
- Drive, Parqet, bank, and broker connections keep local simulated connection state;
  Drive also changes the portfolio Files experience.
- Creation flows add portfolio activity; imports demonstrate staging and review intent.
- Scenario changes update charts and comparisons.
- Applying a scenario produces an explicit review step.
- Inviting a collaborator changes the People workspace and persists the pending access.
- API keys, OAuth clients, and webhook endpoints can be created with scoped fictional
  credentials that are shown once; webhook tests add a delivery result.
- MCP access, approval policy, connected clients, token rotation, request filtering, and
  log detail behave locally without implying a live external service.
- Theme, density, privacy, layout, scope, and mobile-nav settings persist.
- A role switcher demonstrates personal, advisor, collaborator, and admin views.
- Primary task controls have simulated outcomes. Secondary drill-down controls may remain
  preview affordances when their behavior would only repeat an already demonstrated
  pattern.

Production must additionally cover loading, empty, success, error, stale, offline, and
permission-denied states, and recalculate affected totals across views after every write.

### Origin deep-demo acceptance contract

The sixth direction is considered a product simulation rather than a collection of
screens. Its representative path is:

1. create or authenticate an identity;
2. select hosted, Google Drive, or local/self-hosted data ownership;
3. configure security, regional tax defaults, portfolio structure, first source,
   collaboration, and notification policy;
4. activate a portfolio and arrive on a useful Overview;
5. search an asset, inspect it, build a buy or sell, review the order, and receive a
   persistent portfolio receipt;
6. create income, expense, transfer, or recurring cash flow inside that portfolio;
7. import data through source selection, mapping, staging, reconciliation, and review;
8. approve or reject uncertain writes in one Review workspace;
9. build forecasts, stress tests, rebalancing plans, and automations as non-destructive
   proposals;
10. invite a person, assign a role, collaborate on a proposal, group portfolios, or
    create a controlled mirror/fork;
11. connect brokers, banks, Parqet, or Drive through explicit permissions and inspect
    health, conflicts, mappings, and logs;
12. configure API keys, OAuth apps, webhooks, and MCP with portfolio scopes and
    one-time-secret handling;
13. configure passkeys/TOTP, sessions, privacy, AI provider boundaries, data home,
    export, and account lifecycle;
14. create and edit goals, inspect a high-resolution projection, record contributions,
    and submit recurring funding as a Review-gated proposal;
15. inspect tax-year readiness, compare cost-basis methods, resolve missing basis from
    evidence, create a report, and hand a scoped workspace to an accountant;
16. upload, classify, link, annotate, version, review, archive, and restore portfolio
    evidence without leaving Files;
17. create a verified checkpoint, preview a restore, build a portable export manifest,
    and configure retention in Data Management;
18. configure beneficiaries, coverage, estate readiness, and a consented continuity
    handoff inside Portfolio Plan;
19. open portfolio Data Health, inspect a field and its source lineage, record evidence or
    a reasoned exception, and stage any truth-changing correction in Review;
20. inspect the portfolio containment and ownership graph, propose a valid reparenting or
    ownership change, approve it in Review, and see the graph update without double counting;
21. reconcile a safe corporate action directly, send an evidence-heavy event to Review,
    and inspect its persistent source, tax, position, and receipt trail;
22. calculate a constraint-aware rebalance in Workbench, inspect exact quantities, costs,
    tax estimates, policy decisions, and submit the frozen plan checksum to Review;
23. configure portfolio identity, calculation, data-authority, access, and lifecycle
    policy, with harmless display changes saved directly and material changes entering
    Review with their exact diff;
24. create and inspect a private-market commitment, plan a capital call against portfolio
    liquidity, trace valuation evidence, and stage funding or NAV changes in Review;
25. reload and find the consequential demo state intact.

The visual proof and state receipt are part of every consequential action. A button that
claims to write data must either update the connected portfolio model, create a Review
proposal, or say clearly that it is a preview.

### Origin visual system

Origin combines the user's preferred Northstar direction with current BetterTrack
detail and a Cloudflare-dashboard-like operational hierarchy:

- a small stable suite navigation grouped by job;
- a continuous page canvas with deliberate whitespace rather than nested card stacks;
- flat modules and tables separated by crisp one-pixel rules;
- compact controls, restrained four-to-five-pixel corners, and minimal shadow;
- large, high-resolution, lightly smoothed charts with inspectable events and periods;
- gold reserved for BetterTrack identity, current action, and important attention;
- green/red reserved for financial meaning, not generic decoration;
- overview pages that identify the next decision and deeper workspaces that expose full
  provenance;
- adaptive mobile composition with the same capabilities, not a simplified second
  product.

## 12. Product decisions

1. Keep the BetterTrack name. Its weakness is not that it is bad; it is that “track”
   understates the product. The descriptor and experience will establish the broader
   category.
2. Use **wealth workspace** as the category phrase and “Your wealth, working together”
   as the initial brand line.
3. Keep Portfolio, Workbench, Assets, and People as the stable mental model.
4. Replace the top-level Forecast and Expenses apps with contextual Portfolio and
   Workbench capabilities.
5. Rename Conglomerates to **Blueprints**.
6. Make collaboration portfolio-first; place generic chat/social mechanics behind it.
7. Make AI a scoped, permissioned workspace with reviewable actions.
8. Use one responsive product with adaptive composition. Create native shells later only
   where platform conventions materially improve the experience.
9. Use **Origin**—Northstar’s premium calm plus current BetterTrack’s detail, logo, and
   feature depth—as the implementation baseline.
10. Keep the permanent suite navigation small. Advanced access and integration
    management belong in Control Center and the Developer Platform.

## 13. Open validation questions after the first prototype

These should be answered by using the prototype, not by another long questionnaire:

- Does “Blueprint” feel clearer than “Conglomerate”?
- Is “People” the right label, or does “Collaboration” feel more accurate?
- Should Home default to all wealth or reopen the most recent portfolio?
- Is the portfolio tree visible enough without dominating the workspace?
- Does the restored original gold and app mark feel recognizably BetterTrack inside the
  sharper Origin system?
- Does the continuous canvas make related data feel connected without weakening the
  boundaries between actions?
- Is the graph detailed enough for experienced investors while still legible at the
  default density?
- Which Home widgets deserve permanent default placement?
- On mobile, is Workbench important enough for the default bottom bar?
- How much information should discreet mode leave visible?
