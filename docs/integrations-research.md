# Broker & platform integration research

_Researched 2026-07-17 (Chief of Development), triggered by the owner's check-v4 order: read-only OAuth sync with George (Erste), Trade Republic, Raiffeisen, and a two-way Parqet integration. Binding conclusions live in PROJECTPLAN §16 (2026-07-17 row) and the V6-10/V6-11 scope rows; this file carries the facts._

## The one-paragraph result

Direct bank APIs (George/Erste, Raiffeisen, Trade Republic) are all PSD2/XS2A products: **sandboxes are open to anyone, but production access legally requires being a licensed AISP with an eIDAS QWAC certificate** — a regulatory undertaking (national-authority registration, insurance, audits) that is out of scope for BetterTrack. The practical, fully legal path is a **licensed aggregator** that fronts those banks (GoCardless Bank Account Data has a free live tier and covers Erste; final provider pick at v6 prep). Independently of access: **PSD2 only exposes payment (cash) accounts — depot/securities positions are not in PSD2 scope at any bank**, so live position sync from banks does not exist; depots stay on CSV import (V4-P8). **Parqet is the exception and the best target: an official developer platform (Parqet Connect) with OAuth 2.0 and read AND write scopes** — a true two-way sync is officially supported.

## Per provider

### George / Erste Bank Österreich

- Developer portal: https://developers.erstegroup.com — PSD2 v2 APIs for EBOE (Accounts, Consent, Funds-Confirmation, Payments, Signing-Baskets) + a planned-outages API. Open sandbox with test data.
- Consent model (PSD2 AIS): the user grants a **read-only account-information consent** through the bank's own SCA flow; consents expire and get renewed. Read-only is structural — an AIS consent cannot move money.
- **Production**: licensed TPP (AISP registration with the FMA) + eIDAS QWAC. Not attainable for us; sandbox-only without it.
- Data if accessed (via aggregator): payment-account balances + booked transactions (deposits, withdrawals, dividend cash postings). **No depot positions** — George depot data is not in the PSD2 API.
- Erste also markets **ErsteConnect** (corporate account aggregation, contract-based) — aimed at corporates, not consumer apps; not pursued.
- The Payments / Signing-Baskets APIs in the doc set are PIS (payment initiation). **Never implemented** (owner read-only mandate, §16).

### Trade Republic

- Official API = **PSD2 TPP interface only** (TPP Integration Guide v2.1; contact `open-banking@traderepublic.com`). Same license wall; AIS scope = cash account balances + transactions. No general developer program.
- Unofficial private APIs (pytr-class libraries) exist but require storing the user's TR phone number + PIN and driving their app-pairing/2FA — **rejected**: credential custody on our server + ToS-gray. Not negotiable per the §16 ground rules.
- Depot positions: no lawful API path. TR sync = **CSV import (shipped, V4-P8)** for trades/dividends; TR *cash* can arrive via the aggregator like any bank account.

### Raiffeisen (Austria)

- Developer portal: https://developer.raiffeisen.at — NextGenPSD2 XS2A framework (Berlin Group 1.3.x), documented sandbox test cases, live OAuth flow docs.
- Same structure as Erste: open sandbox; **production requires a valid eIDAS certificate** (licensed TPP). Payment accounts only.
- Practical path: the aggregator (Raiffeisen AT is standard coverage for the major aggregators; verify the exact institution list at v6 prep).

### Parqet (the good one)

- Official **Developer Hub**: https://developer.parqet.com — "Parqet Connect", OAuth 2.0, self-serve developer console (create an integration, set redirect URLs, pick scopes).
- Scopes: **read and write**. Read = holdings & valuation (positions, market values, weights) + activity history (buy/sell/dividend/transfer incl. tax, fee, broker fields — maps cleanly onto our transaction model). Write enables pushing activities — the basis for BetterTrack→Parqet sync.
- Integrations are **private by default** (only the creator can authorize) — perfect for building/testing; **publishing** to all Parqet users goes through Parqet support (client ID, description, test guide). No cost documented.
- They also ship an MCP server and openly court integrations — friendly ecosystem.

### Aggregator (the bank bridge)

- **GoCardless Bank Account Data** (ex-Nordigen): free live AIS tier, ~2,500+ EU banks, Erste Bank Österreich confirmed covered, up to 730 days of transaction history, simple REST + hosted end-user consent. The aggregator is the licensed AISP of record; BetterTrack integrates one API and never touches PSD2 certificates.
- Alternatives to compare at v6 prep: Tink, Salt Edge, finAPI (feature/limit/price check then).
- What it yields for BetterTrack: **cash-source auto-sync** — balances and transactions from George/Raiffeisen/TR cash accounts, landing source-tagged (`sync:george`, …) into cash sources with dedupe via the V4-P8 content-hash discipline.

## What BetterTrack gets, by data type

| Data | Live path | Fallback |
|---|---|---|
| Bank/broker **cash** balances + transactions | Aggregator (V6-10), read-only AIS consent | CSV import |
| **Depot positions / trades** (George, TR, Raiffeisen) | — none exists (PSD2 excludes depots; TR has no retail API) | **CSV import (V4-P8, shipped)** |
| **Parqet** portfolios (positions + full activity incl. tax/fees) | Parqet Connect OAuth, read | — |
| BetterTrack → **Parqet** export/sync | Parqet Connect OAuth, write scope | manual CSV |

## Owner to-dos (only when the arcs build — §15 items 5–6)

1. V6-10: create the aggregator account (free tier) and hand over the API keys.
2. V6-11: register the Parqet Connect integration in their developer console (self-serve; later publishing via Parqet support).

## Sources

- [Erste Developer Portal](https://developers.erstegroup.com/) · [Erste Open Banking](https://www.erstegroup.com/en/erste-open-banking) · [Erste PSD2 press note](https://www.erstegroup.com/en/news-media/press-releases/2019/06/07/psd2-api)
- [Trade Republic TPP API Guide (PDF)](https://assets.traderepublic.com/assets/files/TPP_API_Guide_v2.pdf) · [Trade Republic on OpenBankingTracker](https://www.openbankingtracker.com/provider/trade-republic)
- [Raiffeisen Developer Portal](https://developer.raiffeisen.at/en/home.html) · [Raiffeisen XS2A API](https://developer.raiffeisen.at/xs2a-api) · [sandbox test cases](https://developer.raiffeisen.at/test-case-documentation)
- [Parqet Developer Hub](https://developer.parqet.com/docs) · [Build your first Parqet integration](https://developer.parqet.com/docs/build-your-first-parqet-integration) · [Parqet integrations blog](https://parqet.com/en/blog/parqet-integrations)
- [GoCardless Bank Account Data](https://gocardless.com/open-banking) · [Nordigen→GoCardless](https://gocardless.com/g/gc-nordigen) · [Erste coverage check](https://www.openbankingtracker.com/gocardless/erste-group-bank-ag)
- PSD2 scope & certificates: [payment-account scope analysis](https://thepaypers.com/regulation/expert-views/access-to-payment-accounts-under-psd2-which-accounts-are-in-scope) · [eIDAS certificates under PSD2 FAQ](https://www.openbanking.exchange/wp-content/uploads/OBE-Europe-eIDAS-Qualified-Certificates-Under-PSD2.pdf)
