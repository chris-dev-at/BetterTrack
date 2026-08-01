# PARANOID MODE — client-encrypted privacy mode design note (V5-P13, arc b)

**Status:** binding design, §16-logged 2026-07-21 (issue #651). The
implementation was **owner-approved before composition** under the 2026-07-24
briefs, culminating in the owner-authored `v5-p13-pd9-20260724` brief on issue
#733. That issue's 2026-07-28 owner audit also directs this note to adopt #896's
retired-recovery semantics; the amendment is recorded in PROJECTPLAN §16. The
older #654 gate is explicitly superseded and is not approval evidence. The
implementation issues in §14 build against this text; every "planner-defined"
point in the §13.5 spec row is decided here. Deviations found during
implementation go back through §16.

**The model in one paragraph.** A paranoid account's portfolio data lives in
ONE client-side encrypted **vault**: the client (web/PWA) holds the cleartext
in memory after local decryption, does all money math itself with the **same
audited domain code the server uses** (extracted to a shared package — never
reimplemented), and persists only ciphertext — a single versioned **blob** —
to the storage media the user picked: the BetterTrack server, the user's
Google Drive, both, or **Drive-only** (zero cleartext portfolio rows and no
active server-medium copy). A retired encrypted recovery copy can remain until
the separate signed purge in §5. The server keeps running everything that never
reads the portfolio — identity, auth, friends, chat, price alerts,
notifications, market data — and for the vault it is a **blind blob store with
compare-and-swap**, exactly as blind as Drive. The key never leaves the user's
devices; there is no escrow, no reset, no support backdoor: **lost key ⇒ lost
data, by design.** Day to day the app looks and feels like normal mode — same
pages, same components — because every portfolio-touching client feature reads
through one seam (`PortfolioStore`) with a vault-backed implementation behind
it.

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

`asset_identities` is the content-free server-side integrity seam between those
two sets. It stores exactly one opaque asset UUID plus a nullable opaque account
UUID claim (`NULL` for global catalog assets), and no name, symbol, provider,
category, price/value, portfolio relation, or other vault-derived field. The
claim is the authorization boundary for same-UUID restore; UUID secrecy is not.
The three kept consumers (`workboard_items`,
`conglomerate_positions`, and `alerts`) reference that key instead of the
content-bearing `assets` row. Paranoid purge may therefore detach a user's
custom `assets` row without rewriting or invalidating kept rows; strict
rehydration inserts the same UUID and reconnects them only for the claimed
account. Every retained identity must have either a live custom-asset fact or an
explicit tombstone in the restore document; tombstones retire the identity and
its kept references through the normal database cascade before the restore
source is cleared. Ordinary asset and account deletion still remove the identity
and cascade all consumers through database lifecycle triggers. The identity
table is explicitly server-classified and skipped by account export because it
contains no asset content; the completeness tests bind both decisions.

**The document's asset bucket is wider than the vault classification, and the
restore boundary narrows it back.** A client that computes valuations locally
(§10) must be able to name and price every asset a holding references, so the
vault document's `customAsset` bucket doubles as the client's LOCAL ASSET
TABLE: it also snapshots the market-catalog assets — under the same global
UUID, with the catalog `providerId`/`providerRef` the §11 autonomy seam will
need — because the client engine resolves every transaction, dividend and
standing order through that bucket. Those snapshots are **not** vault data: the
global `assets` row is `server`-classified, survives the enable purge untouched,
and rehydration re-resolves it from the database. They are therefore dropped
again on the way back (`toStrictRestoreDocument`), and the server refuses a
restore document that carries one: every `customAsset` entity it receives —
tombstones included — must be this account's own manual asset
(`providerId: 'manual'`, `providerRef` = the entity id, `ownerId` = the
account), which is also exactly the set the retained-identity check requires the
document to account for. Binding: the two derivable identity fields are
restated from the entity id at that boundary, never passed through, so a stale
or third-party-written value cannot block the account's only non-destructive
exit.

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
  decrypt). **COD 2026-07-24:** the exact complete serialized header remains
  AES-GCM AAD, so a passphrase change derives a fresh KEK/salt, re-wraps the
  same VK, and re-encrypts the unchanged document under that VK with a fresh
  content IV. Ciphertext identity is intentionally dropped; document identity
  is preserved. VK rotation (post-compromise) = full re-encrypt under a new VK +
  `keyId`, offered in settings but never forced.
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
   ⇒ the PATCH transaction atomically removes the blob + bounded history from
   the **active server medium** and moves those ciphertext versions into the
   **retired recovery set**. Drive-only begins immediately — active server blob
   and history reads are empty — while the recoverable ciphertext stays behind
   a separately authenticated signed purge gate for its seven-day minimum
   retention window. Only that later gate (matching the retired version, a
   fresh Drive readback, the server challenge, and client-held Ed25519 proof)
   destroys the retired bytes; a media PATCH or client attestation alone never
   does. Removing `drive` ⇒ the client best-effort deletes the Drive file (and
   tells the user if it could not; the leftover is their own ciphertext in
   their own Drive).
3. The last medium can never be removed (media set non-empty; the server
   validates the PATCH, the UI never offers it).

The §13.5 "media switching migrates the blob correctly" test follows the
shipped #896 sequence literally: enable on Drive → add server through an
inactive candidate (round trip verified) → force a Drive verification failure
and prove the active server source is retained → retry removal → probe zero
active/history server bytes plus the recoverable retired set → app fully
functional. Total server ciphertext reaches zero only through the separate
retention-qualified signed purge gate.

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
  guarantee: the server holds zero cleartext portfolio rows and zero active
  server-medium ciphertext, and has zero _capability_ to fetch the Drive copy.
  A separately gated retired recovery set can remain as described in §5; it is
  opaque ciphertext that only the client-held key can decrypt. Per-user consent
  is end-user OAuth (issue-confirmed: not owner setup); the only owner-provided
  item is the SPA client id env var.
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
2. Client reads the **capture revision token** (below), then pulls the
   account's full portfolio dataset through the existing read APIs, builds
   vault document v1, encrypts, writes the blob to every chosen medium, and
   runs the §5 verified round trip on each.
3. `POST /api/v1/account/paranoid/enable` — body
   `{ mediaSet, vaultVersion, normalDataRevision }`; the
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

**The capture↔commit CAS (PROJECTPLAN.md §16, 2026-08-01).** Step 2 is
entirely lock-free and takes seconds to minutes, while the account lock does
not exist until step 3 — so a write landing in between (a second session, or
the daily standing-order worker booking a period) is absent from the encrypted
document and is nonetheless hard-deleted by the purge, and disable restores
from the document ALONE. The capture therefore opens with
`GET /api/v1/account/paranoid/normal-revision`, **before its first row read**:
an opaque content digest over exactly the restore-classified §1 tables of this
account, derived from the same scope the purge and the zero-cleartext probe
use. Enable re-derives it inside the locked transaction, after the
preconditions and before the first destructive statement, and refuses the whole
transition with `409 NORMAL_DATA_CHANGED` — nothing deleted — when it
disagrees. The field is required, not optional: an absent token would silently
skip the guard on the one transition that cannot be undone. It is skipped only
on the idempotent-retry branch of §7's "never destroys gated state" rule, where
the vault rows are already gone and the original token could never match again.

**What step 2 must read (beyond the user-visible surfaces).** The document also
carries the `standing_order_runs` ledger under its real row ids. That ledger —
not an order's `last_period_key` watermark — is the authoritative exactly-once
record: a claim is written before booking and deliberately left behind when
booking fails, so the watermark cannot express a claimed-but-unbooked period.
Losing such a claim across enable→disable lets the scheduler re-book a period
that was intentionally tombstoned, i.e. book the same money twice.

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
are). In one account-locked database transaction the restore rows are written,
the mode flips back, and the server blob + history are deleted; any failure
rolls all three back together. Authoritative tax state is replayed through the
normal engine inside that transaction without historical side effects; only
after commit does the deterministic plan rebuild snapshots and invalidate
derived account/portfolio/expense/order/tax consumers. The client then wipes
its Drive file (best-effort) + local caches. Other devices notice the mode flip
on next sync and drop their vaults. Disable is idempotent-resumable: a crashed
rehydration can re-run (rows are re-created under fresh ids only after a full
wipe of the partial batch — no half-hydrated ghosts).

**Disable payload ceiling.** Disable is the only exit, so its request-body bound
is sized from the PLAINTEXT it carries, not from `BT_VAULT_MAX_BYTES`: the
envelope is deflate-compressed before encryption, so the restore JSON is always
at least as large as the stored blob and usually several-fold larger. The route
allows `BT_VAULT_MAX_BYTES × 8 + 64 KiB`
(`PARANOID_RESTORE_PLAINTEXT_FACTOR`) — with the 16 MiB default, a practical
plaintext ceiling of ~128 MiB. A document that both fits the storage bound
compressed and exceeds that expanded would be un-disable-able, which is why the
factor is deliberately generous rather than 1:1.

Enable is likewise one account-locked database transaction: media and
preconditions are re-read under the lock before sharing is revoked, every
vault-classified row is purged, and the mode is committed. Broad inbound friend
audiences use mode-dependent exclusion rows during revocation so an implicit
`all_friends`/friend-side `public_link` grant cannot silently reappear after
disable; a later deliberate owner audience edit clears that exclusion.

**The idempotent enable retry never destroys gated state.** A repeat call whose
media evidence matches the account's committed state is acknowledged with
`idempotent: true` and re-runs only operations that are already true (the
cleartext purge, revocation, derived-state retirement). It specifically does NOT
clear `paranoid_vault_server_candidates`, `paranoid_vault_retired` or
`paranoid_vault_retirements`, which a fresh `normal → paranoid` transition does
clear because they cannot exist yet. On an established account those rows are
the §5 retirement recovery set, destroyable only through the signed purge gate
(matching retired version + Ed25519 retirement proof + the minimum retention
window); a replayed enable satisfies none of those checks, and an account that
retired the server medium passes the retry's "no active server ciphertext"
test precisely because its recovery ciphertext lives outside the active
medium.

Revocation of INBOUND shares is permanent and one-directional: the account's
membership rows in other users' audiences and friend groups are deleted, and
disable restores none of them — each owner re-adds the account deliberately.
Keeping a restore list would mean holding the very social graph the mode exists
to remove, server-side, for the whole paranoid period. Logged as a plan
deviation in PROJECTPLAN.md §16 (2026-07-30), owner ack pending.

## 7.1 Severed-fork MIRRORCHAIN provenance (encrypted, versioned)

**The problem.** Leaving a chain with a fork (mirrorchain design §6) keeps rows the
chain force-applied to that copy. Replica apply deliberately waives the ordinary
solvency gate (`force: true`), because copy-local tax movements skew a source, so
a reachable fork ledger can carry a **negative prefix** no normal write path would
accept. Rehydration must preserve exactly those rows — and only those.

The identity that proves a row came from the chain lives in `mirror_rows`
(logical `mirror_id` ↔ copy-local `local_id`), and that table dies with the copy:
enable deletes the portfolio, so the map cascades away. The append-only oplog
keeps only the LOGICAL id, while the encrypted document keeps only the LOCAL id.
`local_id = mirror_id` holds at the origin _until_ a sanctioned financial
correction (delete + re-create + repoint, mirrorchain §2) replaces the local row —
after that the equality is false, and inferring the association from row values is
ambiguous. So the map itself must be captured while it still exists.

**Representation.** `vaultMirrorProvenanceSchema` (`packages/contracts/src/vault.ts`):
`{ chainId, membershipId, kind, mirrorId, portfolioId, localId }`, carried as the
additive `mirrorProvenance` array on vault document v1/v2 and on the strict restore
document. `membershipId` is the caller's OWN ended `mirror_chain_members` row:
**re-joining is a normal flow**, so one chain can hold two retained forks, each
with its own copy of the same logical entity and its own (higher) watermark. The
tombstone identity is the minimum needed to prove an older fork against the
membership that actually kept it — and to keep the two copies' entries from
colliding as a "duplicate logical identity". It is not a `mirror_rows` column, so
it is declared in `VAULT_MIRROR_PROVENANCE_PROOF_FIELDS` and the completeness gate
subtracts it before comparing columns. It is `.default([])`, so a document written before this section parses
unchanged and means "no severed fork" — no already-written `schemaVersion` is
reinterpreted, and an unsupported (higher) version still fails closed. The two
`mirror_rows` attribution columns are deliberately dropped
(`VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS`): they are a co-member's identity, the
vault must not carry it, and restore-time validation never needs it. That is also
why `mirror_rows` is NOT vault-classified and is never re-inserted on disable —
restoring it would require exactly the identity we refuse to carry, and the fork
is un-synced by definition.

**Capture** — `GET /account/paranoid/fork-provenance`: the caller's own
`mirror_rows`, joined to the ENDED membership that owns each copy
(`(chain_id, portfolio_id)` selects exactly one membership per account, because a
re-join mints a fresh copy rather than reviving the fork's). Active memberships
never match — they block enable anyway and would be live chain data — and no other
user's row is reachable, because the read is scoped by portfolio ownership.

The client calls it from `captureForkProvenanceIntoVault`
(`apps/web/src/user/vault/mirrorProvenance.ts`), and **every unlocked session runs
that fold** (`media/runtime.ts`, beside the retirement-proof material). That is
what guarantees the map is inside the ciphertext BEFORE `enable()` purges
`mirror_rows`, without the wizard having to remember a step: the fold is a
union-and-prune, so it is idempotent and a second session cannot duplicate or drop
an identity. Once paranoid mode is on, the read is empty and the fold no-ops (no
vault version is spent). A capture read that cannot be REACHED is skipped and
retried on the next unlock — an unreachable API must not block unlocking an
already-encrypted vault (Drive-only can be readable while the API is not) — but a
read that succeeded and produced new provenance must land durably, or unlock
fails: a fork whose identities never reached the ciphertext could not be restored.

**Merge / migration.** Provenance is content-addressed, not entity-atomic: the
CAS merge takes the deterministic UNION keyed by `(kind, membershipId, mirrorId)`,
and dominance requires the winner to already contain every entry of the loser, so a
merge can never silently drop it. Two entries claiming one logical identity with
different `localId`s, or one `localId` under two logical identities, are a
malformed document (fail closed) rather than a resolvable conflict.

**Pruning is part of the document lifecycle, not a one-off step.** An entry may
only name a row the document still keeps live; the server rejects one that names no
restored row, which would otherwise leave the account unable to disable paranoid
mode at all. So `pruneForkProvenance` runs in three places: inside the CAS merge
(against the MERGED entities, so a row one side deleted takes its provenance with
it instead of the union resurrecting it), in `encryptCandidate` — the single funnel
every committed or published document passes through, so a plain local deletion
prunes on the very next write — and in the disable carriage. Dominance prunes BOTH
sides before comparing, so a stale entry the loser still carries cannot force a
divergent merge on every reconcile. An ABSENT `mirrorProvenance` key stays absent
throughout (absent and `[]` mean the same thing), so re-encrypting a fork-free
vault keeps emitting byte-identical plaintext.

**Purge.** Enable purges the copy; `mirror_rows` cascades with the portfolio and
the account keeps ZERO cleartext alias rows — including Drive-only, which gains no
new server-side table, fingerprint, or portfolio-derived metadata. What survives
is chain-level and already retained by mirrorchain §2/§6: the append-only oplog
and the membership tombstone (with its `applied_seq` watermark). Those are the
proof surface; the user's own map is the encrypted half.

**Disable-time validation** (all of it BEFORE the mutation transaction opens):

1. Each entry resolves to a live document entity of the mapped kind and to that
   entity's portfolio, and the entries are unique by logical identity AND by local
   id — a duplicate is rejected, never merged.
2. Entries are grouped by `membershipId`, and that membership must be one the
   caller provably holds and that has ENDED — an unknown membership, another
   account's, or a still-active one is rejected — and its `chain_id` must equal the
   entry's. One membership names exactly one copy: a second `portfolioId` under one
   membership, or two memberships claiming one copy, is rejected.
3. The entity's authoritative op is the highest-seq op ≤ **that membership's**
   `applied_seq` (never a later copy's). Absent (no op for the logical id),
   beyond-watermark, wrong-kind (an op class that cannot produce that row kind) and
   stale (the authoritative op is a delete) are all rejected. A `cash.transfer` op
   speaks for BOTH minted leg ids, one of which is not its own `mirror_id` column.
4. **The restored row must be the full-state result of that op** (mirrorchain §3:
   the highest-seq op ≤ the watermark IS the entity's state), compared at the
   persisted column's own scale so `2.9` and `2.90000000` agree:
   - an external cash movement — append-only on every copy, so its state is the
     op's for good — binds `kind`, source, **`amountEur` through the write path's
     own `floorCents`**, `executedAt`, the transfer counterpart source, and the
     absence of a transaction/dividend/tax link. A genuine withdrawal therefore
     cannot authenticate a larger one;
   - a dividend (no in-place update surface exists) binds asset, gross amount,
     `executedAt` and cash source;
   - a transaction that carries a linked movement binds side, quantity, price, fee,
     `executedAt`, the uncovered pair and (from its create op) the asset. That is
     sound precisely because such a row refuses an in-place financial edit
     (`TRANSACTION_CASH_LINKED` / `TRANSACTION_TAXED`) and the sanctioned correction
     re-creates it under a NEW local id — so a row whose financials diverged can no
     longer be the row the entry names. A chain transaction with NO linked movement
     needs no waiver and stays locally editable, so nothing is bound and nothing is
     authenticated for it. Notes stay unbound (editable, and they cannot change a
     ledger outcome), as do a `cash_source`'s own columns (rename/archive/restore
     remain available locally after the fork).
   - **Derived legs keep the frozen-amount rule.** A buy/sell cash leg's amount and
     a tax movement's amount are copy-derived, not op fields: the leg is the write
     path's `floorCents` of the (now op-bound) cost/proceeds through that moment's
     FX, and a tax movement is this copy's own regime output. Re-deriving them would
     require an FX history the server no longer has, so `validateGraph` binds each to
     the row it belongs to (frozen tax amount, dividend gross, transfer pairing)
     exactly as it does outside a fork.
5. **Cash intent is bound to the op, never to a client tag.** A `buy` leg requires
   a buy op with `payFromCash: true`; a `sell_proceeds` leg requires a sell op with
   `addProceedsToCash: true`; the movement's source must equal the local source the
   op's `cashSourceMirrorId` resolves to (a `cash_source` entry of the SAME copy, or
   the copy's Main when null); and the row's write-path tag must be
   `sync:mirrorchain` or the entity's create-op `originSource` (a correction keeps
   the corrected row's tag). Errors name the exact field and value.
6. Only then is the solvency waiver granted, and it follows the authenticated
   MOVEMENTS — never their source. Replica apply force-applied exactly the chain's
   own writes, so an OUTFLOW may leave its source negative only when it is one of
   them: its own proven `cash_movement`, or a leg of a proven transaction/dividend.
   An inflow is never gated by any write path, so it may leave an already-negative
   source negative — that is the reachable recovery prefix — while every
   unauthenticated outflow stays exact, including one that follows a genuine chain
   movement on the same source (the normal `withdrawCash` rule refuses it whatever
   the prefix already is). The former `source === 'sync:mirrorchain'` test is gone:
   it was a client-authored string that waived overdraw for a whole source on
   request.

Reading the chain tables outside the restore transaction is sound: the oplog is
append-only, ops ≤ the watermark are immutable, and an ended membership cannot
reactivate without leaving paranoid mode first (re-joining is a normal-mode write).

**Successful rehydration and cleanup.** The provenance is proof material only: no
row is derived from it, `mirror_rows` is not re-created, and the restored fork
stays un-synced exactly as it was before enable. The document — provenance
included — is discarded with the vault once disable commits; the decrypted disable
request lives only for the already-approved request lifetime. The strict payload it
travels in is produced by `strictVaultDocumentForDisable`
(`apps/web/src/user/vault/paranoidDisable.ts`), which is also where the last prune
runs.

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
11. **The expense-tracking SURFACES (V5-P9) — absent for now, and this is a
    recorded deviation, not a design intent.** Every `/expenses/*` route is
    already refused under the `portfolioServer` capability (the enforcement
    registry, PD3b), so the pages that read them are hidden rather than left to
    401 into an empty shell: `/portfolio/cash-flow` and its transactions,
    budgets, categories and rules tabs are killed paths for a paranoid account.
    The DATA is not killed — §1 classifies the expense tables as `vault` and
    the enable migration carries every category, transaction, rule and budget
    into the blob, so the whole area returns intact on disable. What is missing
    is the client-side re-derivation of those five pages against the vault
    store; it is v6 follow-up work and is logged in PROJECTPLAN §16
    (2026-07-31) alongside the home board (item 13) and the contribution
    column (item 12).
12. **Series that need per-asset history — answered with the portfolio's own
    NET-WORTH curve, and labelled as such.** The client engine derives one
    value series per portfolio (holdings + cash, `netWorthSeries`); it has no
    equivalent of the server's `getAssetValueSeries`, which is what the
    analytics endpoint sums over the _visible_ assets (holdings only). Two
    surfaces read that quantity, and each answers with the client curve rather
    than with a relabelled approximation of the server's:
    - **Analytics** — the primary curve and its stats are the net-worth series.
      The per-asset/group visibility filters are NOT offered here, so the
      difference cannot show up as a filter that silently does nothing; the
      period-contribution column is dropped for the same reason (item 11's
      §16 row).
    - **Forecast** — the prefilled "historical average return" samples the same
      curve, so idle cash damps it relative to a normal account's figure. It is
      an editable starting point, and the projection's starting value is a
      net-worth figure too, so the two agree with each other.
      Normal accounts are untouched by both: they keep reading
      `analytics/…/series`, unchanged.
13. **The Home widget board — replaced by the portfolio page, and this is a
    recorded deviation too.** Every widget under
    `apps/web/src/user/home/widgets/` reads `portfolioApi` directly instead of
    the `PortfolioStore` seam (§10), so a paranoid board would mix server reads
    into an encrypted account. `/` therefore renders `<PortfolioPage />` while the mode is
    paranoid. The board's saved configuration is not touched — it lives in
    `localStorage`, never in the vault or on the server — so it comes back
    exactly as it was on disable. Porting the widgets to the store seam is the
    v6 follow-up; it is logged in PROJECTPLAN §16 (2026-07-31) with items 11
    and 12.

Kept, unchanged (the "fully functional" half): the full auth stack (password,
2FA, passkeys, PIN, sessions, admin-independent), friendships + chat +
profile icons, price alerts (§9) + the whole notification stack (matrix,
digest, quiet hours), watchlists (private), conglomerates/ideas + hypothetical
backtests (private), asset search/detail + asset-level market intel,
calculators (client-side already), Forecast (client-side already —
`apps/web/src/user/forecast/` is the precedent), discreet mode (composes:
discreet hides amounts the client just computed), i18n, announcements,
account export + deletion (§12).

**Kept ≠ reachable while LOCKED.** The unlock gate replaces the whole
authenticated subtree — exactly like the PIN gate it is modelled on — so every
kept surface above is reachable only _after_ the vault opens on that device.
That is deliberate (a gate that let arbitrary routes through would have to
reason about which of them can touch the store) and it costs one real
affordance: **`/oauth/authorize`**. A paranoid account with a locked vault must
unlock before it can grant an app even a scope §8 keeps, such as
`market:read`; once mounted, the consent page's own `portfolioScopeBlocked`
refusal still applies to the portfolio-scoped half. The single exception is
**`/account/delete`**, served directly from the locked branch (§12 names it
kept, it is the stable public URL the store listing points at, and it reads no
money data), so the gate is never a dead end. PD9 asserts both halves: consent
behind the gate, deletion in front of it.

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
  ("no active BetterTrack copy; an encrypted recovery copy stays retained until
  I explicitly delete it after the safety window"); (3) passphrase + forced
  recovery-kit download + the strong-rung acknowledgment: "If I lose my vault
  passphrase and my recovery kit, my data is gone forever. BetterTrack cannot
  recover it."; (4) migration progress → done. Three clicks on the main path;
  no expert corner.
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
   security), delivered across one reviewed seam: **PD3a** defines the strict
   restore document, media metadata, and transaction-bound rehydration
   primitive; **PD3b** owns both public transition routes, the account-locked
   purge orchestrator, the §8 registry enforcement, share/comment revocation,
   admin fields, and export/deletion interplay (§12). The public enable route
   does not ship without the complete disable route. Probe + kill-matrix tests
   land with PD3b.
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
   Drive-only PATCH semantics (active-copy retirement + signed purge gate),
   sync-chip Drive states.
7. **PD7 — Client valuation/stats/tax engine + client exports** (`diff:max`,
   money): the §10 engine on the shared domain, client tax reports +
   CSV/PDF, client cleartext export, standing-order client materialization
   (deterministic ids). Parity fixture tests vs the server engine.
8. **PD8 — Enable/disable UX + day-to-day surfaces** (`diff:hard`): the §13
   wizard, unlock gate, sync chip, killed-surface sweep, Settings → Privacy,
   EN + DE strings.
9. **PD9 — e2e + gate** (`diff:intermediate`): the §15 scenarios as
   Playwright specs (Drive mocked at the data-home boundary; the Drive-only
   round trip is the headline spec), joining the V5-P14 suite. Include the §8
   locked-reachability pair: `/oauth/authorize` sits behind the unlock gate,
   `/account/delete` in front of it.

Order: PD1 ∥ PD2 first; PD3 after PD2; PD4 → PD5 after PD2; PD6/PD7 after
PD5; PD8 after PD5 (PD3's server enforcement can land in parallel with
PD4–PD7); PD9 last.

## 15. Done-when traceability

| §13.5 "done when" criterion                                                                       | Decided by                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Design note §16-logged + owner-acked BEFORE code                                                  | Status + PROJECTPLAN §16 + owner-approved #733 brief        |
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
