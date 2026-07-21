# PARANOID MODE — client-encrypted privacy mode design note (V5-P13, arc b)

**Status:** binding design, §16-logged 2026-07-21 (issue #651). Per the §13.5
design-note-first rule this note is merged BEFORE any paranoid feature code,
and — stricter than mirrorchain — implementation is **not even composed** until
the owner acks it (the spec says "§16-logged **and owner-acked** BEFORE any
code"; the ack gate is a filed `awaiting-owner` issue). The implementation
issues in §14 build against this text; every "planner-defined" point in the
§13.5 spec row is decided here. Deviations found during implementation go back
through §16.

**The model in one paragraph.** A paranoid account's portfolio data lives in
ONE client-side encrypted **vault**: the client (web/PWA) holds the cleartext
in memory after local decryption, does all money math itself with the **same
audited domain code the server uses** (extracted to a shared package — never
reimplemented), and persists only ciphertext — a single versioned **blob** —
to the storage media the user picked: the BetterTrack server, the user's
Google Drive, both, or **Drive-only** (zero portfolio bytes on our side). The
server keeps running everything that never reads the portfolio — identity,
auth, friends, chat, price alerts, notifications, market data — and for the
vault it is a **blind blob store with compare-and-swap**, exactly as blind as
Drive. The key never leaves the user's devices; there is no escrow, no reset,
no support backdoor: **lost key ⇒ lost data, by design.** Day to day the app
looks and feels like normal mode — same pages, same components — because every
portfolio-touching client feature reads through one seam (`PortfolioStore`)
with a vault-backed implementation behind it.

Glossary: _vault_ = the user's full portfolio dataset as one logical document;
_blob_ / _envelope_ = one encrypted serialization of the vault (header +
ciphertext); _medium_ = a place a blob syncs to (server / Drive); _media set_
= the user's chosen media (non-empty subset); _data home_ = a client-side
adapter that reads/writes one medium; _VK_ = vault key (the 256-bit content
key); _KEK_ = passphrase-derived key that wraps the VK; _recovery kit_ = the
downloadable raw-VK file; _purge sweep_ = the enable-time hard-delete of all
server-side portfolio rows; _rehydration_ = the disable-time re-creation of
server rows from the decrypted vault.

---

## 1. The vault — what moves client-side

Design choice — the boundary is **"does the row contain portfolio/money
content?"**, decided mechanically per table, not per feature. The
export manifest already forces every schema table through a completeness-
tested classification (`EXPORT_TABLE_CLASSIFICATION` over `schemaTableNames`,
`apps/api/src/services/export/manifest.ts`); paranoid adds a parallel binding
axis in the same file and style:

```
PARANOID_TABLE_CLASSIFICATION: Record<tableName, 'vault' | 'server'>
```

with the same "every table must be classified, CI fails otherwise" test. The
**enable-time purge sweep (§7), the zero-cleartext probe test, and disable
rehydration all iterate the `vault` set** — so a future table (e.g. the V5-P9
expense tables) cannot silently leak: adding it to the schema forces the
author to classify it, and classifying it `vault` automatically enrolls it in
purge + probe + rehydration. This is the rule that keeps the "zero portfolio
rows server-side" guarantee durable as the schema grows.

**`vault`-classified (client-only, encrypted; hard-deleted server-side at
enable):** portfolios and all their content — transactions, dividends, cash
sources + cash movements, per-portfolio settings (tax country/mode, default
pay-from source, sort/archive state), tax records/settlement rows (client-
recomputed anyway, §10), custom assets + value points (the user's house/car
ARE portfolio data), standing-order definitions (§8 item 9), import batches/
rows, snapshot + snapshot-state rows (derived data — purged, never rebuilt
server-side), and — binding forward — the V5-P9 expense tables (expenses,
categories, rules, budgets) when they land.

**`server`-classified (kept, unchanged):** identity + auth (email, password
hash, 2FA, passkeys, PIN, sessions, remembered devices), profile (username,
curated icon), friendships + chat, notification prefs/matrix/digest/quiet
hours + the notification inbox, price alerts (§9), watchlists, conglomerates +
ideas + backtest configs (hypothetical baskets — interest, not holdings; their
_sharing_ dies, §8), API keys/OAuth grants (portfolio scopes refuse, §8),
announcements, feature flags, audit log, usage-analytics counters, and the
vault blob rows themselves (ciphertext + version metadata only).

The account itself gains `users.privacy_mode` enum `normal | paranoid`
(default `normal`) plus the media-set record (§5) — account metadata, present
even in Drive-only mode (knowing THAT a user is paranoid is not portfolio
data; it is required to enforce §8).

## 2. Blob format + versioning

One file format for every medium, `packages/contracts/src/vault.ts` is its
single source of truth (zod schemas; client-validated — the server never
parses past the header it needs for CAS):

**Envelope bytes:** ASCII magic `BTVAULT1` · 4-byte big-endian header length ·
UTF-8 JSON header · ciphertext.

**Header (cleartext, and it must stay free of portfolio information — it
carries only counters, ids and crypto parameters):**

```
{
  formatVersion: 1,              // envelope layout
  cipher: 'A256GCM',
  iv: <base64, 96-bit, fresh CSPRNG per write>,
  keyId: <uuid of the active VK>,
  wrappedKeys: [{ keyId, kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1,
                  salt }, wrappedVk }],
  vaultVersion: <int, monotonic — the CAS token>,
  schemaVersion: 1,              // payload document version
  deviceId: <uuid of the writing device>,
  writeId: <uuid per write>,
  writtenAt: <ISO instant>
}
```

**Payload (AES-256-GCM ciphertext; the full header bytes are bound as GCM
additional authenticated data**, so any header tampering — including edits to
`vaultVersion` or the wrapped keys — fails decryption): deflate-compressed
JSON of the **vault document** — every `vault`-classified entity, each with
its uuidv7 `id`, a per-entity monotonic `rev` (bumped on every edit), an
`editedAt` instant + editing `deviceId`, and tombstones (`deletedAt`) kept
≥ 180 days so §4 merges stay correct across long-offline devices. A small
`mergeLog` (last 20 merge records) rides in the payload for diagnostics.

**Versioning rules (binding):** `formatVersion` governs the envelope,
`schemaVersion` the document. Clients migrate older documents forward with
pure `v(n)→v(n+1)` functions on load and write back at the current version. A
client that meets a NEWER version than it knows goes **read-only with an
"update the app" notice — never destructive, never "best effort" parsing**.
Size: ciphertext capped at 16 MiB (server-enforced on its medium,
env-tunable) — personal-finance scale (the mirrorchain sizing argument) keeps
real vaults far below this.

**Crypto choices, binding:** WebCrypto AES-256-GCM for content (native on
every target platform incl. iOS PWA); Argon2id via WASM for the KEK (m = 64
MiB, t = 3, p = 1 — the server's own argon2id cost family); VK wrap =
AES-256-GCM under the KEK with its own IV. No hand-rolled primitives
anywhere; test vectors + tamper tests are part of PD4 (§14).

## 3. Key derivation, custody, recovery

- **VK** — 256-bit CSPRNG, generated client-side at enable. It encrypts every
  blob and **never leaves a device unwrapped**: not to the BetterTrack server,
  not to Drive, not into exports, not into logs.
- **Vault passphrase** — a NEW secret, deliberately distinct from the login
  password: the login password transits to the server for argon2id
  verification, so it can never double as client-side key material. The enable
  flow says this in one plain sentence and applies the normal password-policy
  strength check locally. KEK = Argon2id(passphrase, salt); the KEK wraps the
  VK; `wrappedKeys` lives in the envelope header — **any medium's blob + the
  passphrase is a complete recovery path on a fresh device** (pull → unwrap →
  decrypt). Passphrase change = re-wrap the VK (new header entry, no content
  re-encryption); VK rotation (post-compromise) = full re-encrypt under a new
  VK + `keyId`, offered in settings but never forced.
- **Recovery kit** — at enable the client generates and **forces the download**
  of `bettertrack-recovery-kit.txt`: the raw VK (base64), the `keyId`, the
  format version, and plain instructions. Kit + any blob = recovery without
  the passphrase. The wizard requires the explicit "I have stored my recovery
  kit safely" confirmation before proceeding.
- **Device custody** — after unlock the VK is cached per device (IndexedDB,
  non-extractable `CryptoKey` where the platform allows) behind an optional
  "keep unlocked on this device". "Lock vault" is always one click; auto-lock
  follows the existing PIN idle-lock minutes when the user has PIN lock on
  (one mental model, no second timer setting — anti-bloat).
- **Recovery semantics — recorded verbatim and binding: lost key ⇒ lost data,
  by design.** If the passphrase, the recovery kit and every unlocked device
  are all gone, the vault is cryptographically unrecoverable. BetterTrack
  stores no escrow, has no reset path, and support cannot help. The only
  server-side "recovery" is destruction: a **"start fresh"** flow wipes the
  blob (and the user re-enters data, staying paranoid, or disables into an
  empty normal account). The enable flow makes the user acknowledge exactly
  this (§13) at the friction ladder's strong rung.

## 4. Sync media + the CAS/merge protocol

**Media set** ⊆ {`server`, `drive`}, non-empty, user-switchable (§5). The
§13.5 wording maps to: server = {server}, Drive-only = {drive}, both =
{server, drive}. Every device additionally keeps a **local encrypted cache**
of the last blob (IndexedDB/OPFS) for offline reads and writes — a cache, not
a medium (it syncs, it is not chosen).

**Both media are blind blob stores with compare-and-swap:**

- **Server medium:** `GET /api/v1/vault` (ciphertext + `ETag: <vaultVersion>`)
  and `PUT /api/v1/vault` with `If-Match: <vaultVersion>` → `412` on mismatch,
  atomically under the vault row's lock. The server reads nothing but the
  header's `vaultVersion` (+ size cap); ciphertext is a bytea it can never
  interpret. The server keeps a **bounded ciphertext history** (last 10
  versions or 30 days, env-tunable) with a restore picker in the client — the
  corruption/bad-write safety net. Vault PUTs ride a modest dedicated rate
  limit (env-tunable) like every other write family.
- **Drive medium (§6):** one file in `appDataFolder` with
  `appProperties: { vaultVersion, formatVersion }`. Drive offers no true CAS;
  the client approximates it (read `appProperties` + `headRevisionId`, then
  update) and accepts the small TOCTOU window because Drive-mode writers are
  exclusively the same user's own devices and §4's merge repairs any race.
  Drive's native revisions are the history net on that medium.

**Write path:** local commit (optimistic UI) → encrypt full vault (version =
last seen + 1) → CAS-push to the **primary** medium → replicate the identical
bytes to the secondary. **Primary = server whenever the media set contains
it** (it has real CAS), else Drive. On startup/reconnect the client reads all
media + the local cache, takes the highest `vaultVersion`, and merges if it
finds divergence.

**Conflict rule (binding — the multi-device case, e.g. phone edited offline
while the desktop kept writing):** on CAS failure or a divergent pull, merge
at **entity granularity, never field granularity** (a transaction is atomic;
a field merge could mint a financial row nobody ever reviewed — the
mirrorchain §3 rationale verbatim):

1. Per entity `id`: higher `rev` wins; equal `rev` → later `editedAt` wins;
   still equal → lexicographically higher writing `deviceId` (total
   determinism — two clients merging the same pair always agree).
2. Tombstone vs concurrent edit: **the edit wins** — a resurrected row the
   user can re-delete beats silently vanished money data.
3. Merged `vaultVersion` = max(parents) + 1; the merge is recorded in the
   payload `mergeLog`; the merged blob CAS-pushes normally (a lost race just
   re-merges — the rules are commutative and idempotent by construction).

Whole-blob fallback (unreadable/corrupt candidate): the readable blob with
the highest version wins; the corrupt bytes are kept locally for the restore
picker, never silently discarded.

## 5. Media-set switching + blob migration

Client-driven, **migrate-then-drop, verified before destructive** — binding
sequence for every switch:

1. **Add a medium:** write the current blob there → **verified round trip**
   (read back, decrypt, compare `writeId`/hash) → `PATCH
/api/v1/account/paranoid/media` records the new set. Only then is the
   medium live.
2. **Remove a medium:** allowed only while at least one OTHER medium holds a
   verified-fresh copy (same round-trip check, re-run now). Removing `server`
   ⇒ the PATCH transaction **hard-deletes the blob + its entire bounded
   history server-side** — this is the moment the Drive-only "zero portfolio
   bytes server-side" state begins. Removing `drive` ⇒ the client best-effort
   deletes the Drive file (and tells the user if it could not; the leftover is
   their own ciphertext in their own Drive).
3. The last medium can never be removed (media set non-empty; the server
   validates the PATCH, the UI never offers it).

The §13.5 "media switching migrates the blob correctly" test follows this
sequence literally: enable on server → add Drive (round trip verified) →
remove server → probe zero vault bytes server-side → app fully functional.

## 6. The Google Drive medium (end-user OAuth)

- **Scope: `https://www.googleapis.com/auth/drive.appdata` ONLY** — the
  hidden per-app data folder. BetterTrack can never see or touch the user's
  real Drive files; the vault file is invisible clutter-free storage that
  Google surfaces under "manage app data". Least privilege is binding; no
  broader Drive scope is ever requested.
- **The OAuth flow is entirely client-side** (Google Identity Services token
  client, SPA client id, env-provided like the existing Google-login client
  id): access tokens are minted in the browser, live only in memory/session,
  and are **never sent to, stored by, or refreshable by the BetterTrack
  server. There is no server-side Drive integration at all — no tokens, no
  file ids, no proxy endpoints.** Consequence, and the binding Drive-only
  guarantee: the server holds zero portfolio bytes AND zero _capability_ to
  fetch them — it cannot read the ciphertext even if compelled to try.
  Per-user consent is end-user OAuth (issue-confirmed: not owner setup); the
  only owner-provided item is the SPA client id env var.
- **Connections hub (V5-P0c):** the Drive connection renders as a Connections
  card (status, connect, disconnect) — state is client-attested metadata (the
  server only knows `drive ∈ mediaSet`). Disconnect = remove the medium per
  §5.
- **Token lifetime honesty:** GIS access tokens live ~1 h and re-minting can
  require a user gesture. Sync therefore runs during active sessions; offline
  or token-expired writes land in the local cache and push on the next
  unlock/gesture. The sync chip (§13) surfaces "sign in to Google to sync"
  when Drive is unreachable — never a silent stall.
- The autonomy consequence: because the Drive data home runs fully
  client-side, a Drive-only paranoid client already works with the
  BetterTrack server doing nothing but auth + market data — the §11 seams are
  real from day one.

## 7. Enable / disable transitions

**Enable (existing account) — the wizard (§13), then one server call:**

1. Client-side: review the §8 kill list; choose media; create the passphrase;
   download the recovery kit; give the §3 lost-key acknowledgment.
2. Client pulls the account's full portfolio dataset through the existing
   read APIs, builds vault document v1, encrypts, writes the blob to every
   chosen medium, and runs the §5 verified round trip on each.
3. `POST /api/v1/account/paranoid/enable { mediaSet, vaultVersion }` — the
   server, in one transaction: re-verifies preconditions, flips
   `privacy_mode`, runs the **purge sweep** (hard-deletes every
   `vault`-classified row keyed to the user — mechanically the V4-P2c
   deletion-sweep pattern, scoped to the §1 classification), revokes every
   share/audience/follow of the user's items (portfolio, watchlist,
   conglomerate, idea), deletes the user's authored comments/reactions,
   disables the public profile, and activates §8 enforcement. From the next
   request the account is paranoid.

**Preconditions (server-checked, refused with a clear error):** no active
mirrorchain membership (leave-with-fork first — the mirrorchain note §14 owns
the other side of this boundary); no in-flight import batch or export job.
**Ordering guarantee:** the purge runs only after the media writes are
verified — for a media set containing `server` the server verifies its own
blob row exists at `vaultVersion`; for Drive-only the client's attestation is
accepted (it is the user's own data, their own attestation, seconds after
they wrote it — and the wizard's round trip already proved the read path).
Enable is one-way destructive on the server by design; the vault holds
everything from step 2.

**New accounts:** the same wizard minus step 2's migration (empty vault) —
the fast path; paranoid can be enabled any time from Settings → Privacy, not
at registration (keeps registration modes untouched).

**Disable (paranoid → normal):** requires an unlocked vault + explicit
confirm. The client streams the decrypted vault to
`POST /api/v1/account/paranoid/disable` as a **rehydration** — rows re-created
through the normal services in dependency order (portfolios → cash sources →
transactions → dividends → movements → standing orders → expenses →
per-portfolio settings), with server-side tax/snapshots re-deriving through
the normal engines (the vault's derived rows are not trusted, the engines
are). Only after rehydration commits does the mode flip back, the server blob

- history delete, and the client wipe its Drive file (best-effort) + local
  caches. Other devices notice the mode flip on next sync and drop their
  vaults. Disable is idempotent-resumable: a crashed rehydration can re-run
  (rows are re-created under fresh ids only after a full wipe of the partial
  batch — no half-hydrated ghosts).

## 8. The feature-kill list (exact, binding)

Everything that depends on the server reading the portfolio is **absent by
design** — enforced server-side (a single guard driven by one registry,
mounted on route groups + the money-path services, answering
`403 PARANOID_MODE`) and hidden client-side (surfaces absent, not greyed
walls — anti-bloat). The matrix test iterates the registry × route table.

Killed for paranoid accounts:

1. **Public profile** — the page serves the existing no-leak not-found state;
   the setting is forced off at enable.
2. **All outbound sharing** — portfolio/watchlist/conglomerate/idea shares,
   share links, audiences (incl. friend groups as audiences of their items),
   "my shared items". Existing shares are revoked at enable (§7).
3. **All inbound sharing** — shares/follows targeting a paranoid account are
   refused server-side and the shared-with-me surfaces are absent. The social
   sharing surfaces are gone in BOTH directions: one crisp promise, one crisp
   matrix test. (Friendships and chat REMAIN — they carry no portfolio data
   and killing them would gut usability for nothing; §16 records this as the
   deliberate reading of "social/sharing surfaces".)
4. **Comments + reactions** (they exist only on shared items) — cannot author;
   previously authored ones are deleted at enable, one-way.
5. **Mirrorchain** — cannot create, join, or be invited (mirrorchain note §14
   records the same constraint from the other side); enable requires zero
   active memberships (§7).
6. **Every server-computed portfolio read** — summary/series/snapshot
   endpoints, analytics deep-dive, Live-Mode portfolio frames, projected
   portfolio dividend income, the portfolio news digest (asset-level news on
   asset pages stays), backtest **of a real portfolio** (conglomerate/
   hypothetical-basket backtests stay — public prices + user weights, no
   portfolio read), AI insights (P12 reads the portfolio; the NL conglomerate
   builder stays), the server tax engine + server tax report export. Client
   equivalents own all of it (§10).
7. **Broker/bank CSV imports** (V4-P8 and V5-P9's import arc) — server-side
   parsing of money data; absent. Manual entry stays; a client-side import
   engine is a v6 candidate (§16 non-goals), not silently promised.
8. **Portfolio-scoped API access** — bearer/OAuth scopes touching portfolio,
   tax or import data refuse with `PARANOID_MODE`; other scopes work.
   Webhooks (V5-P10) never fire portfolio-content events for these accounts
   (there are none server-side to fire).
9. **Standing-order server execution** — definitions move into the vault; the
   client materializes due rows on unlock/app-open, catch-up style, with
   **deterministic ids** (UUIDv5-style hash of `(orderId, dueDate)`) so two
   devices catching up independently produce identical rows and §4's merge
   dedupes them. `standing-order` source tags render as today.
10. **Server portfolio jobs & offsite backup of portfolio rows** — snapshot
    jobs, dividend/earnings scans keyed to holdings, etc. skip paranoid
    accounts (their input tables are empty by §7); the V4 offsite backup
    carries only ciphertext for them.

Kept, unchanged (the "fully functional" half): the full auth stack (password,
2FA, passkeys, PIN, sessions, admin-independent), friendships + chat +
profile icons, price alerts (§9) + the whole notification stack (matrix,
digest, quiet hours), watchlists (private), conglomerates/ideas + hypothetical
backtests (private), asset search/detail + asset-level market intel,
calculators (client-side already), Forecast (client-side already —
`apps/web/src/user/forecast/` is the precedent), discreet mode (composes:
discreet hides amounts the client just computed), i18n, announcements,
account export + deletion (§12).

## 9. Server-side price alerts with zero portfolio exposure

Alert rules are asset-price predicates — all six §14 kinds (`price_above`,
`price_below`, the `pct_*` movement kinds) store `(assetId, kind, threshold,
refPrice)` and nothing else (`packages/contracts/src/alerts.ts`). That is
public-market-data territory: **no quantities, no holdings, no portfolio
reference**. So for paranoid accounts alert rules stay ordinary server rows,
the evaluator and cooldown/lock machinery run untouched, and delivery rides
the normal notification matrix — the §13.5 "alerts still fire" criterion is
satisfied by the existing pipeline with zero paranoid-specific code.

Binding forward rule: any FUTURE alert kind whose predicate reads portfolio
state (e.g. "portfolio down X% today") is **vault-scoped and client-evaluated**
for paranoid accounts — the server evaluator stays price-only for them.
Honest residual, recorded: the alert list (like quote fetches, §11) reveals
which assets the user watches — an interest signal, not portfolio content;
accepted under the owner's "my data stays with just me" framing, which is
about the portfolio.

## 10. Client-side valuation / stats architecture

**Binding decision: the pure domain layer becomes isomorphic — physically
extracted to `packages/domain` (`@bettertrack/domain`).** `holdings.ts`,
`cashLedger.ts`, `tax.ts`, `seriesStats.ts`, `settingsScope.ts` and their test
suites move to the package; `apps/api/src/domain/*` become thin re-export
shims so server imports don't churn. The web client imports the **same
audited money math** — money math is NEVER reimplemented client-side (review-
blocking rule). The domain layer already imports nothing but types (the
standing architecture rule), so the extraction is mechanical, and parity
between server and client computation holds **by construction**, not by
maintenance.

On top of it a client engine (`apps/web/src/user/vault/engine/`) derives, from
vault entities + the `MarketDataSource` seam (§11): current holdings +
valuation, daily value/cost/P&L series (provider daily closes + the domain
carry-forward; the "today" point from live quotes), TWR, allocation,
cash-source balances, and per-year tax reports (the user's tax mode/country
live in the vault; AT/DE/custom parameter sets compute through the shared
`tax.ts` exactly as the server would). Derived series are cached in the local
cache keyed by `(vaultVersion, assetPriceWatermark, range)` — a vault edit
bumps the version, so invalidation is trivial and local; there is no client
clone of the #553 snapshot machinery (personal-finance scale, the mirrorchain
sizing argument, makes on-device recompute cheap).

The §13.5 "client computes correct stats from encrypted fixture data" test:
decrypt a fixture blob (fixed VK) + fixture price history → engine output
equals the server engine's output for the identical cleartext fixture,
number for number.

## 11. Autonomy-prep seams (architecture-binding beyond paranoid)

Owner 2026-07-17: clients must be structured to one day run fully autonomous
from BetterTrack servers. Three client-side interfaces are **binding
architecture from this note on** — every v5+ client feature that touches
portfolio data or market data goes through them (review criterion, both
apps):

1. **`PortfolioStore`** — the single read/write surface for portfolio data.
   Implementations: `apiPortfolioStore` (normal accounts — wraps today's
   endpoints/TanStack Query usage; introduced as a wrapper, not a rewrite of
   every page at once: pages migrate onto the store as PD5/PD8 touch them,
   new features start on it) and `vaultPortfolioStore` (paranoid — decrypted
   in-memory state + the §4 sync engine).
2. **`DataHome`** — blob persistence: `read()`, `write(envelope,
{ ifVersion })` (CAS), `info()`. Implementations: `serverBlobDataHome`,
   `driveDataHome`, `localDataHome` (the device cache — and the seam through
   which a future fully-local, server-less medium arrives).
3. **`MarketDataSource`** — `quote()`, `history()`, `search()`, `fx()`. The
   v5 implementation is the BetterTrack API (public market data; asset-level
   requests are an interest signal, not portfolio content — recorded,
   accepted). A Yahoo-direct client implementation is the distant-future
   autonomy piece: the interface is binding now, the implementation is
   explicitly NOT built in v5 (§16 non-goals).

Data home = local + market data = direct is exactly the server-less end
state; paranoid Drive-only mode already exercises seams 1–3 with the server
reduced to auth + quotes, which is why this arc is the right place to cut
them.

## 12. Interplay: exports, account deletion, admin

- **Account export (V4-P6):** for a paranoid account the zip contains the
  `server`-classified data as today plus — when the media set includes
  `server` — the current **ciphertext blob** and its manifest entry; never
  cleartext portfolio data, never key material. Separately, a **client-side
  cleartext export** (JSON + CSV zip, built in the browser from the decrypted
  vault, same entity shapes as the server export) hangs off the same export
  UI — the user can always take their own data out.
- **Account deletion (V4-P2c):** pipeline unchanged; the paranoid delta is
  that the sweep also deletes the vault blob + history rows. When deletion
  runs from an unlocked device the client offers to delete the Drive file
  first; otherwise the ciphertext remains in the user's own Drive as their
  own property (harmless by construction) — the deletion confirm says so, and
  that app access is revocable at Google's security settings.
- **Admin:** the user page shows the mode badge, media set, blob
  size/version/updatedAt and history count — there are no portfolio numbers
  to show, which IS the feature. Admin can delete the account and tune the
  size cap/rate env knobs; admin can NOT reset the passphrase, recover or
  wipe-and-keep-paranoid on the user's behalf (no custody — "start fresh" is
  a user-initiated flow). Problems page: vault endpoint errors capture
  PII-scrubbed as usual; ciphertext and headers are never logged. Usage
  analytics count paranoid accounts in DAU/WAU/MAU and feature counters as
  today (first-party counters carry no portfolio values).

## 13. UX (the high-usability mandate, anti-bloat-compliant)

- **Enable wizard** (Settings → Privacy → "Paranoid mode"): four plain-
  language steps — (1) what changes (the §8 kill list, compact); (2) where
  your encrypted data lives — default **server** ("encrypted on BetterTrack;
  only you can read it" — the simplest mental model), "also keep a copy in my
  Google Drive" as a checkbox, **Drive-only behind one "advanced" disclosure**
  ("nothing on BetterTrack servers — not even encrypted"); (3) passphrase +
  forced recovery-kit download + the strong-rung acknowledgment: "If I lose
  my vault passphrase and my recovery kit, my data is gone forever.
  BetterTrack cannot recover it."; (4) migration progress → done. Three
  clicks on the main path; no expert corner.
- **Unlock:** a vault gate visually analogous to the PIN gate (passphrase
  field, "keep unlocked on this device", lock action in the profile menu;
  auto-lock per §3). After unlock the app IS the normal app — same pages,
  same components, reading through the store seam.
- **Sync status:** one small shield chip in the header — synced ✓ / syncing /
  offline / needs attention (e.g. "sign in to Google to sync", restore
  picker) with last-write time and per-medium state in its popover. That chip
  is the entire day-to-day paranoid surface.
- **Killed surfaces are absent, not tombstoned** — no grey walls of disabled
  buttons (anti-bloat); Settings → Privacy shows the compact "what's off"
  summary for reference.
- Mobile/PWA (P13b): identical flows; the local cache makes offline-first
  natural. Every new user-facing string ships EN + DE keys (binding i18n
  rule).

## 14. Implementation decomposition (ordered; for the composer)

Composed ONLY after the owner acks this note (the filed `awaiting-owner` gate
issue).

1. **PD1 — `@bettertrack/domain` extraction** (`diff:hard`): move the §10
   pure modules + test suites to `packages/domain`, re-export shims in
   `apps/api/src/domain/*`, zero behavior change; CI proves api + web both
   consume it. (Module moves — flagged for the map regen.)
2. **PD2 — Vault contracts + server vault store + account mode**
   (`diff:intermediate`): `packages/contracts/src/vault.ts` (envelope header,
   vault document v1, media set, DTOs), `paranoid_vaults` (+ bounded history)
   schema + migration, `users.privacy_mode`, GET/PUT ETag CAS endpoints +
   size cap + rate limit, the `PARANOID_TABLE_CLASSIFICATION` axis + its
   completeness test.
3. **PD3 — Enable/disable pipeline + enforcement matrix** (`diff:hard`,
   security): the §7 purge sweep + preconditions + rehydration, the §8
   kill-registry guard (routes + services + scopes), share/comment revocation
   at enable, admin fields, export/deletion interplay (§12). Probe test +
   kill-matrix test land here.
4. **PD4 — Client crypto core + key custody** (`diff:max`, keystone):
   envelope encode/decode, AES-GCM + AAD, Argon2id KDF (WASM), VK
   wrap/unwrap + passphrase change + rotation, recovery kit, device key
   cache, lock/unlock. Test vectors incl. tamper + rollback cases.
5. **PD5 — Sync engine + data homes + the store seam** (`diff:max`,
   keystone): `DataHome` + server/local adapters, CAS push/pull, the §4
   entity merge, corruption/restore picker, `PortfolioStore` +
   `vaultPortfolioStore` + the `apiPortfolioStore` wrapper. Merge-matrix
   tests (offline-fork worked cases).
6. **PD6 — Drive data home + Connections card + media switching**
   (`diff:hard`): GIS token client, appdata adapter, §5 migrate-then-drop,
   Drive-only PATCH semantics (server blob hard-delete), sync-chip Drive
   states.
7. **PD7 — Client valuation/stats/tax engine + client exports** (`diff:max`,
   money): the §10 engine on the shared domain, client tax reports +
   CSV/PDF, client cleartext export, standing-order client materialization
   (deterministic ids). Parity fixture tests vs the server engine.
8. **PD8 — Enable/disable UX + day-to-day surfaces** (`diff:hard`): the §13
   wizard, unlock gate, sync chip, killed-surface sweep, Settings → Privacy,
   EN + DE strings.
9. **PD9 — e2e + gate** (`diff:intermediate`): the §15 scenarios as
   Playwright specs (Drive mocked at the data-home boundary; the Drive-only
   round trip is the headline spec), joining the V5-P14 suite.

Order: PD1 ∥ PD2 first; PD3 after PD2; PD4 → PD5 after PD2; PD6/PD7 after
PD5; PD8 after PD5 (PD3's server enforcement can land in parallel with
PD4–PD7); PD9 last.

## 15. Done-when traceability

| §13.5 "done when" criterion                                                                       | Decided by                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Design note §16-logged + owner-acked BEFORE code                                                  | This note's status block + the `awaiting-owner` gate        |
| Mode on ⇒ server stores no cleartext portfolio data (schema/probe test)                           | §1 (classification), §7 (purge sweep), §8 (enforcement)     |
| Drive-only round trip: zero portfolio rows server-side and the app remains fully functional (e2e) | §5 (removal semantics), §6 (guarantee), §8 (kept list), §10 |
| Media switching migrates the blob correctly (test)                                                | §5 (migrate-then-drop, verbatim sequence)                   |
| Social/sharing surfaces are absent for the account (matrix test)                                  | §8 (kill list items 1–5 + registry-driven matrix test)      |
| A client computes correct stats from encrypted fixture data (test)                                | §10 (shared domain + engine + the parity test)              |
| Alerts still fire (test)                                                                          | §9 (price-only rules on the untouched pipeline)             |

## 16. Constraints & non-goals

- **No key escrow, ever** — no owner/admin/support recovery path exists or
  will be added; "start fresh" (destructive) is the only server-side answer
  to a lost key. Lost key ⇒ lost data, by design.
- **Blob granularity is the v5 sync unit** — no per-entity server sync, no
  server-visible oplog (that would leak structure); entity granularity exists
  only inside the encrypted payload for §4 merges.
- **No client-side broker/bank import in v5** (§8 item 7) — a v6 candidate,
  not a silent promise. No native apps (the PWA is the mobile story, P13b).
- **Yahoo-direct client market data is interface-only in v5** (§11); the
  local (fully server-less) data home likewise arrives through the `DataHome`
  seam later — v5 ships server/Drive/local-cache.
- **Metadata honesty, recorded:** the server still sees that the account
  exists and is paranoid, login/session activity, the media set, blob sizes/
  versions/timestamps, alert rules and watchlists (asset-level interest), and
  market-data request patterns. None of it is portfolio content; the owner's
  mandate ("my data stays with just me") is about the portfolio, and this
  note keeps every portfolio byte client-encrypted.
- **Friendships + chat stay** (server-side, cleartext as today) — they carry
  no portfolio data; the §8 matrix defines "social/sharing surfaces" as the
  sharing-coupled set. Owner can veto at ack.
- **Mirrorchain × paranoid:** mutually exclusive by design — recorded here
  (§7 precondition, §8 item 5) and in `docs/mirrorchain-design.md` §14.
- Vault size cap 16 MiB, server history depth 10/30 days, rate limits — all
  env-tunable ops knobs, not product surface.
