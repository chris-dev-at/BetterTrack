# Broker CSV imports

BetterTrack imports broker **CSV exports** into a portfolio (PROJECTPLAN.md
§13.4 V4-P8): upload → broker autodetect (or manual pick) → normalized staging
→ preview with per-row flags → explicit confirm → apply into the chosen
portfolio + cash source.

> **Explicit non-goal:** automatic broker/bank **API** sync. Imports are always
> file-based and user-initiated (§13.4; §14 reserves account linking for a far
> release). Nothing here stores broker credentials or talks to a broker.

## How the pipeline works

1. **Upload** (`POST /imports`, multipart): the CSV plus the target
   `portfolioId` (and an optional `brokerId` override). The server sniffs the
   delimiter, fingerprints the header against each registered mapper, and the
   winning mapper normalizes every data row. Nothing portfolio-visible is
   written — the batch is pure staging.
2. **Preview**: every row carries one flag:
   - `mapped` — parsed and its instrument resolved; will be applied.
   - `unmapped` — parsed, but the instrument could not be resolved against the
     local asset catalog. Excluded from apply and reported — **never** silently
     matched to a similar-looking asset. Search for the instrument under
     _Assets_ first (search enriches the catalog from the provider), then
     re-upload.
   - `duplicate` — the row's content hash (`date + instrument + qty + price`,
     where the trade side and cash direction are part of the instrument
     identity, so a same-day flat round-trip — a buy and a sell at equal
     quantity and price — never self-dedupes) matches something already
     recorded (an existing transaction, dividend or external cash movement) or
     an earlier row of the same file. Skipped on apply, so re-importing the
     same file is a no-op.
   - `error` — the row itself is malformed (unknown type, unparseable
     date/number, non-EUR cash row …). Reported with its line number while the
     rest of the file still lands — never all-or-nothing. The framework
     enforces this boundary itself, independently of the mapper, for every
     value its staging columns constrain: a currency token that is not a
     three-letter code, or a numeric beyond the staging magnitude (quantities
     below 10^12, prices/fees/amounts below 10^14 — derived from the column
     precision/scale), fails its **row** even when a mapper let it through, so
     no mapper can ever take a whole upload down with one malformed value.
3. **Apply** (`POST /imports/:batchId/apply`): rows apply **chronologically**,
   each through the existing services — buys/sells via the portfolio service
   (oversell semantics and, when enabled, cash linkage included), dividends via
   the V3-P4 tax engine (the user's tax mode applies at recording time, e.g.
   Austrian KESt withholding), deposits/withdrawals via the cash ledger. Each
   row lands atomically together with its linked cash/tax legs; a row the
   owning service rejects (e.g. `INSUFFICIENT_CASH`, `OVERSELL`,
   `DIVIDEND_ASSET_NOT_HELD`) is reported as `failed` and the remaining rows
   continue. The batch is claimed atomically (`pending` → `applied`) before the
   first row books, so a concurrent or repeated apply is a
   `409 IMPORT_ALREADY_APPLIED`; retrying clients (the mobile offline queue)
   should send an `Idempotency-Key` header — like every portfolio mutation, the
   route then replays the recorded response instead. `mapped` rows are
   re-checked against live data at apply time; rows the preview already flagged
   `duplicate` keep that verdict — deleting a mis-imported entity makes the row
   importable again via a **fresh upload**, not by re-applying an old preview.
   - `cashSourceId` picks the cash source for dividends and cash rows (the
     portfolio's Main when omitted).
   - `linkCashOnTrades` additionally funds buys from / credits sell proceeds to
     that source. Off by default: a partial export would otherwise overdraw a
     ledger that never saw the broker's deposits.

### Instrument resolution

Resolution goes through the local search catalog (§6.2) and accepts **exact
matches only**, in this order: the file's ticker symbol, its ISIN used as a
catalog symbol (custom assets are often keyed that way), then the exact
security name (case/whitespace-insensitive, whole string). When the first pass
misses and the search triggered a background provider enrichment, the importer
waits for it once and retries. Anything less exact stays `unmapped`.

A trade whose resolved listing is quoted in a different currency than the file
row (e.g. the file trades Apple in EUR but the catalog resolved the USD
listing) is flagged `error` — record it via the matching listing instead;
prices are never converted silently.

## Adding a broker

Adding a broker is **one mapper module + one anonymized fixture** — zero
framework changes (the V4-P8 pluggability criterion; George/Flatex/IBKR are the
follow-up issue):

1. `apps/api/src/services/imports/mappers/<broker>.ts` implementing
   `BrokerMapper` (`id`, `label`, `detect` — a header fingerprint returning a
   0..1 confidence — and `map` — pure rows-in/normalized-rows-out with per-row
   errors).
2. An anonymized fixture CSV + golden test under
   `apps/api/src/services/imports/__tests__/`.
3. Register the mapper in `mappers/index.ts` (`ALL_MAPPERS`).

Broker ids are plain strings end-to-end (no enum, no migration); the web picker
lists whatever `GET /imports/brokers` returns.

## Per-broker quirks

### Trade Republic (`trade_republic`)

Expected export: the app's transaction CSV — semicolon-separated, German
headers:

```
Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung
```

- **No ticker symbols.** TR identifies instruments by ISIN + security name
  only, so resolution falls to the exact-name match (or an ISIN-keyed custom
  asset). If a row stays `unmapped`, search the instrument under _Assets_ once
  and re-upload.
- **`Typ` values:** `Kauf` and `Sparplan` (savings-plan execution) → buy;
  `Verkauf` → sell; `Dividende` → dividend; `Einzahlung` / `Auszahlung` →
  cash deposit / withdrawal; `Zinsen` (interest on the cash balance) → a plain
  cash **deposit** with an "Interest payment" note — it has no instrument, so
  it is not modeled as a dividend. Anything else (tax corrections, saveback,
  …) is reported per row as unsupported.
- **Numbers are German notation** (`1.234,56`); plain `1234.56` also parses.
  A grouping-dot integer with **no** decimal comma (`1.000`) is ambiguous —
  German grouping reads 1000, plain notation reads 1.0 — so it is refused as a
  per-row error rather than guessed (a wrong guess would book the quantity
  ~1000× off). TR amounts virtually always carry a `,xx` decimal, so real
  exports are unaffected. Dates are ISO (`2024-01-15`) or German
  (`15.01.2024`), day precision — rows are anchored at 12:00 UTC so the
  calendar day survives every European timezone and the Vienna tax year.
- **`Betrag` is not trusted for trades.** Trade economics are re-derived from
  `Anzahl × Kurs + Gebühr`; the signed `Betrag` is only used for cash rows
  (its magnitude) — TR occasionally nets FX effects into it.
- **EUR only.** TR settles everything in EUR; non-EUR cash/dividend rows are
  flagged `error` (the cash ledger is EUR-only, §14). A `Währung` token that
  is not a three-letter code (`EURO`, `EUR/USD`) fails its row too — both in
  the mapper and again in the framework's staging boundary (which also bounds
  numeric magnitudes — see the pipeline section above), so no mapper can ever
  take the whole upload down with a malformed value.
- **Dividends need the holding.** The tax engine only records a dividend on an
  asset the portfolio has transacted (V3-P4c). Import the buys in the same file
  (or before), otherwise the dividend row fails with
  `DIVIDEND_ASSET_NOT_HELD`.

Fixture: `apps/api/src/services/imports/__tests__/fixtures/trade-republic.csv`
(anonymized — invented ISINs/names, no real account data).

### George (Erste), Flatex, IBKR

Follow-up issue (§13.4) — mappers land against this frozen framework; this
section grows one subsection per broker as they ship.
