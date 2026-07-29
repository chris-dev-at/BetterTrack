# BetterTrack redesign — competitor and interaction research

Research date: 2026-07-27  
Method: public product pages, pricing pages, help centers, and official documentation.

This document records reusable product patterns, not a visual mood board to copy.

## Direct portfolio and wealth products

### Parqet

Sources:

- https://parqet.com/en/pricing
- https://parqet.com/en/terminal
- https://parqet.com/en/blog/portfolio-overview
- https://parqet.com/en/blog/performance-tree-map
- https://developer.parqet.com/docs/give-ai-portfolio-context-with-the-parqet-mcp
- https://developer.parqet.com/docs/build-your-first-parqet-integration
- https://developer.parqet.com/changelog

Relevant strengths:

- Strong German-market portfolio tracking and import ecosystem.
- Combined multi-portfolio overview, same-asset grouping, performance comparison.
- Premium analytical depth: what-if returns, ETF breakdown, drawdown, capital flow,
  moving averages, custom periods, and benchmarking.
- Terminal adds research, fundamentals, estimates, peers, filings, screeners, and news.
- Connect API has read/write OAuth scopes; current remote MCP is read-only.
- Recent platform expansion includes subaccounts, cash, insurance, commodities,
  real estate, multi-currency, and custom quotes.

Opportunity for BetterTrack:

- Make aggregation and sub-portfolios part of the core mental model rather than an
  overview feature.
- Let permissioned AI create reviewable Workbench and automation proposals while keeping
  writes explicit and auditable.
- Use one connected visual language across tracking, research, and planning.

### Portfolio Performance

Sources:

- https://www.portfolio-performance.info/en/
- https://help.portfolio-performance.info/en/about/
- https://help.portfolio-performance.info/en/reference/view/reports/performance/

Relevant strengths:

- Deep, transparent performance accounting with transaction history, TTWROR and IRR.
- Flexible price sources, classifications/taxonomies, rebalancing, FX accounts, and local
  storage.
- Highly configurable analytical dashboards and many specialized metrics.

Opportunity for BetterTrack:

- Match calculation depth and provenance while using progressive disclosure so a new
  investor does not encounter a desktop-terminal learning curve.

### Sharesight

Sources:

- https://www.sharesight.com/pricing/
- https://help.sharesight.com/what-can-i-track-in-sharesight/
- https://www.sharesight.com/blog/sharesight-portfolio-sharing-now-on-all-plans-even-free/

Relevant strengths:

- Broad reports for performance, tax, income, contribution, drawdown, diversity,
  multi-currency, future income, and cost basis.
- Automatic dividends and corporate actions, broker/email imports, unlisted assets.
- Mature guest, family, accountant, and advisor sharing.

Opportunity for BetterTrack:

- Bring equivalent reporting and advisor collaboration into a cohesive portfolio
  workspace instead of making the report list the primary navigation model.

### getquin

Sources:

- https://www.getquin.com/
- https://www.getquin.com/de/portfolio-tracker/
- https://www.getquin.com/getquin-ai/

Relevant strengths:

- Broad all-wealth proposition covering investments, income, spending, goals, scenarios,
  community, and AI.
- Customizable home, dividend forecast, benchmarking, risk and allocation analysis.

Opportunity for BetterTrack:

- Preserve the unified scope while making collaboration data-first and AI intentional,
  explainable, and permissioned rather than feed- or assistant-first.

### Finanzfluss Copilot

Sources:

- https://www.finanzfluss.de/copilot/
- https://www.finanzfluss.de/copilot/preise/
- https://www.finanzfluss.de/copilot/hilfe/dashboard/
- https://www.finanzfluss.de/copilot/hilfe/portfolios-und-konten/
- https://www.finanzfluss.de/copilot/hilfe/investment-seite/
- https://www.finanzfluss.de/copilot/hilfe/breakdown/

Relevant strengths:

- Connected net-worth dashboard across portfolios and accounts.
- Investment analysis plus income, expenses, budgets, dividend calendar, watchlists,
  benchmarks, and many account connections.
- ETF look-through and custom grouping.

Opportunity for BetterTrack:

- Keep the connected total-wealth view but locate cash-flow tools within the selected
  portfolio rather than exposing a separate household-book application.

### Kubera

Source:

- https://www.kubera.com/

Relevant strengths:

- Closest public comparison to the portfolio-as-universal-container vision.
- Unified balance sheet across listed assets, crypto, private investments, property,
  vehicles, collectibles, and liabilities.
- Nested portfolios for entities and ownership, granular multiplayer access, forecasting,
  cash management, external AI-advisor access, and trusted/emergency access.

Opportunity for BetterTrack:

- Combine this composability with stronger market research, transactional depth,
  Workbench simulations, portfolio-native collaboration, and a more active review queue.

### Snowball Analytics

Sources:

- https://snowball-analytics.com/
- https://snowball-analytics.com/pricing

Relevant strengths:

- Dividend forecasts and calendars, rebalancing, diversification, cash, broker links,
  risk-adjusted returns, event calendar, public/model portfolios, and long-range backtests.

Opportunity for BetterTrack:

- Include this depth as portfolio views and optional widgets without turning the entire
  experience into a dividend-focused tracker.

### Delta

Source:

- https://delta.app/en

Relevant strengths:

- Strong mobile-first interaction, cross-asset connections, alerts, discovery, and
  cross-device continuity.

Opportunity for BetterTrack:

- Adopt mobile polish and continuity without removing the controls and analytical depth
  that serious users need.

## Adjacent money products

### Monarch Money

Sources:

- https://www.monarchmoney.com/partner?c=SPI&s=spi
- https://www.monarchmoney.com/features/collaboration

Reusable pattern:

- Accounts, transactions, investments, goals, budgeting, and collaboration share one
  household context.
- Collaboration is attached to transactions, goals, and review tasks.

BetterTrack application:

- Portfolio collaborators should review concrete data and decisions. Generic chat is
  secondary.

### Copilot Money

Sources:

- https://www.copilot.money/
- https://help.copilot.money/en/articles/6045480-dashboard-tab-overview

Reusable pattern:

- A dashboard should not only report; it should surface a focused “to review” queue and
  upcoming recurring activity.

BetterTrack application:

- Home prioritizes what changed, what needs attention, and what is upcoming before
  exposing a library of reports.

### YNAB

Sources:

- https://www.ynab.com/features
- https://www.ynab.com/features/goal-tracking
- https://support.ynab.com/en_us/plan-and-adjust-with-edit-plan-and-cost-to-be-me-ByR7vpqPyx

Reusable pattern:

- Targets, expected income, recurring costs, and debt payoff make planning tangible.

BetterTrack application:

- Goals, debt, and recurring activity are native portfolio objects that participate in
  Workbench forecasts.

## Research and analytical workspaces

### TradingView

Source:

- https://www.tradingview.com/features/

Reusable pattern:

- Command search, advanced charts, indicators, conditional alerts, screeners, calendars,
  heatmaps, and saved layouts serve expert work.

BetterTrack application:

- Put analytical density into an intentional full-screen focus mode. Keep the default
  portfolio overview calmer.

### Koyfin

Sources:

- https://www.koyfin.com/
- https://www.koyfin.com/pricing/

Reusable pattern:

- Custom dashboards, graphing, screeners, financial/macro data, saved templates, and
  advisor model/client portfolios support advanced desktop workflows.

BetterTrack application:

- Give power users configurable workspaces and reusable Blueprint layouts without making
  the first-use dashboard resemble a market terminal.

### Simply Wall St

Source:

- https://simplywall.st/

Reusable pattern:

- A high-level portfolio-health visualization can make complex fundamentals approachable
  and provide a path into deeper risk, dividend, valuation, and financial-health views.

BetterTrack application:

- Use explainable summaries and progressive drill-down, but never collapse financial
  complexity into a mysterious score.

## Suite and interaction references

### Stripe Dashboard

Sources:

- https://docs.stripe.com/dashboard/basics
- https://stripe.com/apps

Reusable patterns:

- Stable suite sidebar plus contextual resources.
- Customizable Home, unresolved-item workflows, global search, shortcuts, and connected
  account scope.
- Extensions appear in the context where their data is useful.

BetterTrack application:

- Use a stable five-destination shell, one portfolio scope, and integrations that surface
  inside portfolios rather than a disconnected app marketplace.

### Mercury

Sources:

- https://mercury.com/insights
- https://mercury.com/blog/introducing-mercury-command
- https://mercury.com/blog/updated-transactions-page

Reusable patterns:

- Interactive charts and transaction tables cross-filter each other.
- A dedicated finance AI can prepare actions for review, respect permissions, and keep
  an audit trail.
- Spreadsheet-like saved transaction views coexist with a visual cash-flow layer.

BetterTrack application:

- This is the strongest interaction precedent for Ask BetterTrack: scoped questions,
  grounded answers, and explicit review before actions.
- Portfolio charts, cash flow, and activity should be linked views of one dataset.

### Linear

Sources:

- https://linear.app/docs/project-overview
- https://linear.app/docs/board-layout

Reusable patterns:

- Multiple views of the same data, command-driven navigation, predictable details panels,
  and linked resources create speed without visual noise.

BetterTrack application:

- Activity can switch between feed, table, cash-flow, and calendar views without becoming
  four products.

## Advisor and complex-wealth products

### Addepar

Source:

- https://addepar.com/family-offices

Relevant strengths:

- Unified source of truth for complex entities, ownership look-through, alternative
  assets, permissioned client portals, aggregation, filters, and APIs.

### Vyzer

Source:

- https://vyzer.co/

Relevant strengths:

- Entities, co-investments, ownership stakes, role-based access, document extraction,
  and expected-versus-actual cash flows.

BetterTrack opportunity:

- A serious advisor mode needs organizations, people, entities, ownership percentages,
  permission layers, review tasks, and client-ready reporting—not only a share button.

## Product gaps worth designing in now

The following additions should be represented in the redesign data model even if some
are later-phase engineering:

1. Liabilities and debt payoff as first-class portfolio holdings.
2. Ownership percentages and look-through across nested portfolios/entities.
3. Portfolio review inbox with reconciliation and approval tasks.
4. Goals linked directly to expected cash flow and Workbench scenarios.
5. Document vault, receipts, valuation evidence, and capital-call tracking.
6. Target allocations, drift, and reviewable rebalancing plans.
7. Advisor/client and household/entity context switching.
8. Saved scopes, saved filtered views, and pinned/recent navigation.
9. Source lineage and an explanation drawer for every important calculation.
10. Proof-of-wealth reporting and trusted/emergency access.
11. Read/write integration permissions with explicit confirmation and audit.
12. ETF, fund, and nested-portfolio exposure look-through.

## Interfaces to inspect for visual feedback

These are useful for discussing taste, not templates to copy:

- **Stripe Dashboard** — suite structure, scope, search, and review workflows.
- **Mercury** — premium finance surfaces, linked charts/tables, deliberate AI.
- **Koyfin** — configurable expert workspace and desktop density.
- **Delta** — mobile interaction and cross-device simplicity.
- **Kubera** — nested wealth/entity concepts and premium calm.
- **TradingView** — optional focus mode and expert charting depth.
- **Linear** — command navigation, transitions, and details panels.
- **Trade Republic Web Terminal** — useful as a visual reference from the user's own
  logged-in experience, but not the target for information density.

The target is a composition of principles: Stripe's coherence, Mercury's financial
interaction quality, Kubera's composability, Koyfin's optional depth, and Delta's mobile
polish—expressed as BetterTrack rather than visually copied.

## 2026 depth pass — features users already pay for

This pass focuses on capabilities competitors put behind subscriptions or use as a
reason to choose a locally hosted product. The useful lesson is the product job, not the
competitor's packaging.

### Sharesight reporting and professional hand-off

Additional sources:

- https://www.sharesight.com/pricing/
- https://help.sharesight.com/reports/

Paid value is concentrated in unlimited holdings, more portfolios and grouping,
benchmarking, automatic corporate actions, price/portfolio alerts, attachments,
multi-currency valuation, contribution analysis, drawdown, future-income calendars, and
tax/compliance reports. BetterTrack should treat these as connected views of portfolio
truth. Reports should retain the active scope and calculation lineage; an accountant or
advisor can receive a time-bounded role instead of an emailed data copy.

### Finary optimization and ownership models

Additional sources:

- https://finary.com/en/finary-plus
- https://finary.com/en/finary-pro

Finary Plus sells fee detection, lower-cost alternatives, geographic/sector analysis,
dividend tracking, simulations, and reporting. Pro adds professional accounts, business
entities, relationships, split ownership, and attributed loans. BetterTrack already has
the right primitive: recursive portfolios with ownership and liabilities. The
high-value addition is a fee scanner whose replacement action opens a Workbench scenario,
not a product advertisement or silent rebalance.

### Wealthfolio local-first and agent access

Additional sources:

- https://wealthfolio.app/docs/introduction/
- https://wealth-folio.com/changelog/

Wealthfolio's differentiators are a local SQLite source of truth, desktop/self-hosted
operation, explicit data ownership, portfolio health, inline import review, attachments,
MCP-compatible AI access, account-scoped activity, allocation tools, planning, and
mobile support. BetterTrack should preserve storage choice during first run and expose
the selected boundary everywhere permissions matter. AI may read or prepare a proposal;
portfolio writes still go through Review.

### Ghostfolio portability

Additional source:

- https://github.com/ghostfolio/ghostfolio

Ghostfolio validates demand for self-hosting, import/export, multi-account tracking,
privacy, PWA/mobile use, risk analysis, and a minimal mode. BetterTrack should support a
portable local/Drive data home and a deliberately reduced focus view without making the
normal suite simplistic.

### Portfolio Performance calculation depth

Additional sources:

- https://help.portfolio-performance.info/en/reference/view/reports/performance/
- https://help.portfolio-performance.info/en/reference/view/reports/performance/dashboard/
- https://help.portfolio-performance.info/en/reference/view/reports/performance/performance-chart/

The analytical baseline is not a smoothed marketing graph. It includes daily-resolution
series, custom periods, TTWROR, IRR, absolute change, benchmarks, drawdown and duration,
volatility, semivariance, Sharpe ratio, contribution, fee/tax rates, heatmaps, configurable
series, and inspectable calculation periods. Origin therefore uses detailed charts by
default and places advanced calculation controls in Analysis rather than permanently
crowding Overview.

### Parqet paid analysis and separate Terminal

Additional sources:

- https://parqet.com/en/pricing
- https://parqet.com/en/terminal
- https://parqet.com/en/blog/performance-tree-map

Parqet's paid tracker bundles X-Ray look-through, dividends, benchmark and what-if
comparison, tax, capital-flow and transaction analysis, drawdown, ETF fees, moving
averages, flexible periods, multiple portfolios, integrations, and autosync. Its new
Terminal is intentionally a separate research product with financials, estimates,
earnings, dividends, insider activity, peers, screeners, alerts, and long history.
BetterTrack should match the depth but reject the split: Assets holds research,
Portfolios show ownership context, and Workbench receives any candidate comparison.
Advanced research may be a paid capability without becoming a disconnected application.

### Kubera complex-wealth premium

Additional source:

- https://www.kubera.com/wealth-tracker

Kubera's high-complexity tier charges for nested portfolios, entity/family ownership,
granular access, onboarding, and support. This reinforces BetterTrack's central product
bet: nesting and permission boundaries are core data primitives. The demo exposes them
from the first portfolio onward instead of bolting them onto a separate “family office”
mode.

### Monarch goals and household operations

Additional sources:

- https://help.monarch.com/hc/en-us/articles/15000751305108-Using-Goals
- https://www.monarchmoney.com/features/recurring
- https://www.monarch.com/pricing

Monarch links goals to accounts and transactions, supports recurring rules, household
collaboration, professional read-only access, review assignment, reminders, searchable
activity, customizable reports, and cash-flow calendars. BetterTrack applies the useful
mechanics within Portfolio: a goal reads selected portfolio balances, contributions are
typed activity, and any recurring rule is an automation with a preview and audit trail.
It rejects a separate household budget product.

## Cloudflare dashboard interaction reference

Sources:

- https://blog.cloudflare.com/redesigning-cloudflare/
- https://blog.cloudflare.com/zero-trust-navigation/
- https://blog.cloudflare.com/new-application-security-experience/
- https://blog.cloudflare.com/security-overview-dashboard/
- https://blog.cloudflare.com/project-a11y/

Cloudflare is the strongest reference for the revised Origin desktop language:

- grouped navigation scales a large suite without presenting every capability at once;
- overview pages aggregate status and lead to the next decision rather than merely
  displaying cards;
- flat modules, crisp rules, consistent rows, and restrained corners make dense data
  feel calm;
- context, scope, health, filters, and actions remain in predictable positions;
- accessible time-series charts and responsive behavior are system requirements;
- contextual guidance appears beside the affected setting rather than in a detached
  help product.

BetterTrack should not copy Cloudflare's infrastructure aesthetic literally. It combines
that operational clarity with the original BetterTrack gold, richer financial charts,
warmer portfolio language, and a more editorial sense of hierarchy.

## Fit decisions from this pass

| Competitor capability                  | BetterTrack placement                       | Decision                                     |
| -------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Fee scanner and cheaper alternatives   | Portfolio Analysis → Workbench scenario     | Build into demo                              |
| Daily-resolution performance and risk  | Portfolio Analysis and expanded chart       | Build into demo                              |
| Future income and calendar reports     | Portfolio Cash flow / Upcoming              | Build into demo                              |
| Tax and accountant reporting           | Portfolio Tax / Collaboration               | Build into demo                              |
| Entity ownership and attributed loans  | Nested portfolio structure                  | Build into model and demo                    |
| Local/self-hosted storage              | First run and Security → Data home          | Build into demo                              |
| MCP/agent access                       | Developer Platform with Review-gated writes | Build into demo                              |
| Standalone budgets/spending app        | —                                           | Reject; cash flow stays in Portfolio         |
| Broker execution and banking           | —                                           | Reject; BetterTrack records and simulates    |
| Floating global AI assistant           | —                                           | Reject; use scoped Ask BetterTrack workspace |
| Social engagement feed as default Home | —                                           | Reject; collaboration is portfolio-first     |

## 2026 depth pass two — continuity, advisor operations, and field-level integrity

This pass looked specifically for premium domains that were still absent after Origin's
connections, import, documents, collaboration, security, goals, tax, analytics, reports,
and developer workspaces were in place.

### RightCapital: persistent data checks and repeatable client work

Sources:

- https://help.rightcapital.com/module-overview/client-portal/iris
- https://help.rightcapital.com/module-overview/advisor-portal/rightflows
- https://help.rightcapital.com/getting-started/client-plan-overview

RightCapital's useful lesson is that data checks should persist after import. Missing cost
basis, inconsistent dates, incomplete records, concentration, and missing insurance can
remain in one field-level queue that opens the affected portfolio object. Its recurring
advisor workflows also show the value of repeatable annual-review, onboarding, and
tax-document cycles with owners, due dates, client-visible tasks, and automatic
rescheduling.

BetterTrack should place these inside Portfolio → Review rather than create a detached
task manager. Home may aggregate overdue cycles across portfolios for an advisor, while
the source record, evidence, proposal, and receipt remain portfolio-scoped.

### Addepar: private-market evidence and effective ownership

Sources:

- https://addepar.com/product-overview/alts-data-management
- https://addepar.com/family-offices

Addepar combines portal/inbox documents, extracted capital calls and distributions,
automated checks, human validation, and consolidated private-market obligations. It also
models percentage ownership through companies, trusts, foundations, people, and family
branches.

Origin already has recursive portfolios, document provenance, staged activity, and
Review. The next logical depth is certification state for extracted facts, a commitments
view within Cash flow, and explicit person/entity relationships that calculate effective
ownership at any selected scope.

### Wealthfolio: financing relationships and restore guarantees

Sources:

- https://wealthfolio.app/docs/guide/dashboards/
- https://wealthfolio.app/docs/guide/data-export/

Wealthfolio's hierarchical net-worth view links mortgages to the financed property,
shows stale-valuation warnings with direct fixes, and supports human-readable exports
alongside full backup and restore. BetterTrack should make financing a first-class
relationship: gross asset value, linked debt, and net equity are shown together inside
the property portfolio.

The new Origin Data Management workspace applies the portability lesson now: explicit
data ownership, verified checkpoints, restore previews, portable export manifests,
retention policy, and persistent receipts. It remains in Control Center because it is
operational infrastructure, not another daily-use root product.

### Kubera: financial continuity

Source:

- https://help.kubera.com/article/10-ensure-safe-transfer-portfolio-to-beneficiary

Kubera's inactivity workflow packages financial records and documents for a controlled
emergency handoff after repeated failed check-ins. This exposes Origin's largest remaining
domain gap: beneficiaries, insurance coverage, estate readiness, and an owner-unavailable
continuity plan.

BetterTrack should build **Protection & Continuity** inside Portfolio → Plan. It reuses
existing portfolio relationships, liabilities, Files, Workbench scenarios, collaborators,
Security, exports, and Review. It must include explicit consent, identity verification,
revocation, a package preview, and an attributable receipt; inactivity must never trigger
an opaque or irreversible action.

### Actual Budget and Expensify: local resilience and mobile capture

Sources:

- https://actualbudget.org/docs/getting-started/sync/
- https://use.expensify.com/receipt-scanning-app

Actual Budget demonstrates that optional encrypted sync need not weaken local ownership.
Expensify demonstrates the high-value mobile moment: capture evidence offline, extract
fields, detect duplicates, and reconcile when connectivity returns.

Origin's hosted, Drive, and local data homes already express the ownership boundary. A
future native/PWA mobile Create action should add **Scan evidence**: select the portfolio,
capture the receipt, statement, policy, or valuation, inspect extracted fields, and send
them to Files Inbox → Review. It must not silently create portfolio activity.

### Round-two implementation order

| Capability                                                         | BetterTrack placement                             | Outcome                  |
| ------------------------------------------------------------------ | ------------------------------------------------- | ------------------------ |
| Verified backups, restore preview, portable exports, retention     | Control Center → Data management                  | Built into demo          |
| Beneficiaries, insurance gaps, estate readiness, emergency handoff | Portfolio → Plan → Protection & Continuity        | Built into demo          |
| Persistent field-level checks                                      | Portfolio Overview → Data Health → Review         | Built into demo          |
| Advisor service cycles                                             | Portfolio → Review → Cycles                       | Extend after data health |
| Mortgage/property and entity ownership relationships               | Portfolio → Structure                             | Built into demo          |
| Private-market commitment extraction                               | Portfolio Files → Review; Cash flow → Commitments | Built into demo          |
| Offline camera evidence capture                                    | Mobile Create → Scan                              | Native/PWA follow-up     |

## 2026 depth pass three — portfolio operations after the data arrives

This pass tested what a serious owner still cannot do after Origin has imported,
reconciled, documented, analyzed, planned, and shared a portfolio.

### Sharesight: a corporate-actions task inbox

Sources:

- https://help.sharesight.com/tasks-tab/
- https://help.sharesight.com/au/recording-corporate-actions/

Sharesight groups dividends, reinvestments, splits, and capital returns by holding and
supports confirming one event, one holding, or a portfolio. Its corporate-action
guidance separates mechanically safe events from rights issues, mergers, spin-offs,
buybacks, transfers, and delistings that require assumptions or evidence.

BetterTrack should connect this entire lifecycle inside **Portfolio → Activity →
Events**: a Connection discovers the issuer event, Files keeps the notice, Data Health
checks the resulting position, Tax previews basis impact, and Review gates any
ambiguous write. Home should show only an outstanding count; this must not become a new
root product.

### Wealthfolio and Portfolio Performance: constraints before rebalancing

Sources:

- https://wealthfolio.app/changelog/
- https://help.portfolio-performance.info/en/reference/view/taxonomies/using-taxonomies/

A useful rebalance planner needs more than a target pie chart. It needs drift bands,
cash-only versus sell-and-buy modes, fractional or whole shares, minimum orders,
protected holdings, turnover and cash limits, tax awareness, custom classification
hierarchies, and an explainable current/after/target comparison.

Origin should place this in **Workbench → Rebalance**, launched contextually from Goals,
Analytics, or Automation. The calculated trade list is a branch until its exact diff is
submitted to Review.

### Addepar: commitments are obligations, not calendar decorations

Sources:

- https://addepar.com/investors
- https://addepar.com/navigator
- https://addepar.com/product-overview/alts-data-management

Private-market portfolios need committed, called, distributed, and unfunded amounts,
forecast calls and distributions, pacing, and liquidity stress alongside liquid assets.
BetterTrack should eventually place commitments in **Portfolio → Cash flow**, with Files
supplying notices, Data Health certifying extracted facts, Workbench testing funding
plans, and Review gating changes.

### RightCapital and Kubera: remaining specialist surfaces

Sources:

- https://help.rightcapital.com/knowledge-base/client-portal/rightexpress/express-module-risk
- https://help.rightcapital.com/module-overview/client-portal/more-menu/stock-plans-module
- https://www.kubera.com/proof-of-wealth

Risk alignment compares willingness, capacity, horizon, and goals with current and target
portfolio risk; this belongs inside Plan rather than becoming another volatility chart.
Equity compensation requires vesting, exercise, expiry, concentration, cash-flow, and
jurisdiction-aware tax semantics, so the demo should only preview its intended asset
workspace. A selective proof-of-wealth snapshot can reuse Reports, Documents, and Share,
but real signing and source attestation require production infrastructure.

### Round-three fit decisions

| Capability                                   | BetterTrack placement                   | Decision                    |
| -------------------------------------------- | --------------------------------------- | --------------------------- |
| Corporate actions and event confirmation     | Portfolio → Activity → Events → Review  | Built into demo             |
| Constraint-aware rebalance plan              | Workbench → Rebalance → Review          | Built into demo             |
| Private-market commitments and liquidity     | Portfolio → Cash flow → Private markets | Built into demo             |
| Human/portfolio risk alignment               | Portfolio → Plan                        | Plan next                   |
| Custom classification policies               | Portfolio metadata → Analysis/Workbench | Plan with rebalance         |
| Selective attested proof snapshot            | Reports → Share                         | Preview only                |
| Equity compensation and advanced instruments | Holdings/Assets specialist workspaces   | Preview until schema exists |
